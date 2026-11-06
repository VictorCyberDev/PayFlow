import {
  selectKey,
  verifyPortableProof,
} from "../../packages/verifier/src/index.js";
import {
  GatewayAccessError,
  type ExternalAgentAccess,
} from "../network/access.js";
import { GatewayRequestError } from "../network/gateway.js";
import type { ExecutingGateway } from "../network/gateway-execution.js";
import {
  McpToolError,
  type McpAuthorityServices,
  type PayFlowMcpToolName,
} from "./mcp.js";

export interface GatewayMcpDependencies {
  readonly gateway: ExecutingGateway;
  /** The verified credential of THIS caller. Never taken from tool arguments. */
  readonly access: ExternalAgentAccess;
  readonly now: () => string;
  /** Signed portable Proof for an operation the caller owns; used to return Proof with the decision. */
  readonly issuePortableProof?: (
    access: ExternalAgentAccess,
    proposalId: string,
  ) => Promise<object | "NOT_ISSUABLE" | null>;
  /** Offer only tools that cannot start a payment. The payment tool is then absent, not merely refused. */
  readonly verifyOnly?: boolean;
  /** Public verification keys (public by design). */
  readonly publicKeys?: () => object | Promise<object>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

/**
 * MCP is only a protocol adapter. `request_authorized_action` calls the SAME `ExecutingGateway.requestPurchase`
 * that REST uses (credential → canonical action → Authority → Trust Kernel → reservation → one-time grant →
 * Execution Boundary → rail → reconciliation → Proof). There is no second policy engine and no model judgement.
 * Only the tools this gateway genuinely backs are advertised.
 */
export function createGatewayMcpServices(
  deps: GatewayMcpDependencies,
): McpAuthorityServices {
  const supports = new Set<PayFlowMcpToolName>([
    ...(deps.verifyOnly ? [] : (["request_authorized_action"] as const)),
    ...(deps.publicKeys ? (["verify_financial_proof"] as const) : []),
  ]);
  const unsupported = () =>
    Promise.reject(new McpToolError("MCP_TOOL_NOT_SUPPORTED", {}));

  return {
    supports,
    checkFinancialAuthority: unsupported,
    verifyAuthority: unsupported,
    reconcileFinancialAction: unsupported,
    requestAuthorizedAction: async (args) => {
      // Defence in depth: the verify-only profile must never reach the payment path even if a caller bypasses
      // the tool filter.
      if (deps.verifyOnly) throw new McpToolError("MCP_TOOL_NOT_SUPPORTED", {});
      try {
        const response = await deps.gateway.requestPurchase(
          deps.access,
          asRecord(args).action,
        );
        let portableProof: object | "NOT_ISSUABLE" | null = null;
        const proposalId = response.proof?.proposalId;
        if (proposalId && deps.issuePortableProof) {
          try {
            portableProof = await deps.issuePortableProof(
              deps.access,
              proposalId,
            );
          } catch {
            portableProof = null;
          }
        }
        return { ...response, portableProof };
      } catch (error) {
        if (error instanceof GatewayAccessError)
          throw new McpToolError(error.code, {
            decision: "DENY",
            effectCount: 0,
            recoverable: false,
            nextAction: "USE_A_VALID_CREDENTIAL",
          });
        if (error instanceof GatewayRequestError)
          throw new McpToolError(error.code, {
            decision: "DENY",
            effectCount: 0,
            recoverable: error.code === "REQUEST_MALFORMED",
            nextAction:
              error.code === "REQUEST_MALFORMED"
                ? "FIX_REQUEST_AND_RETRY_WITH_NEW_NONCE"
                : "USE_THE_AGENT_CREDENTIAL_FOR_THIS_AUTHORITY",
          });
        // Unknown failure after acceptance: never claim zero effect.
        throw new McpToolError("GATEWAY_INTERNAL_ERROR", {
          decision: "DENY",
          effectCount: null,
          doNotRetry: true,
          nextAction: "DO_NOT_RETRY_CHECK_PROOF",
        });
      }
    },
    verifyFinancialProof: async (args) => {
      const proof = asRecord(asRecord(args).proof);
      const keyId = typeof proof.keyId === "string" ? proof.keyId : "";
      const document = deps.publicKeys ? await deps.publicKeys() : {};
      const key = selectKey(document, keyId);
      if (!key) return { valid: false, reason: "UNKNOWN_SIGNING_KEY" };
      // Historical evidence: authenticity only, so an old payment stays verifiable.
      const result = verifyPortableProof(proof, key, deps.now(), null);
      return {
        valid: result.valid,
        reason: result.reason,
        ...(result.proof
          ? {
              outcome: result.proof.outcome,
              effectCount: result.proof.effectCount,
              actionId: result.proof.actionId,
            }
          : {}),
      };
    },
  };
}
