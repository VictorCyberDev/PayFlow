import { GatewayAccessError, type ExternalAgentAccess } from "./access.js";
import { GatewayRequestError } from "./gateway.js";
import type { ExecutingGateway } from "./gateway-execution.js";
import type { RestRequest, RestResponse } from "./rest.js";

export interface ExecutingRestDependencies {
  authenticate(authorization: string | undefined): Promise<ExternalAgentAccess>;
  /** Reads Proof for an operation owned by the caller; null when absent or not theirs. */
  /** Signed portable Proof; "NOT_ISSUABLE" when the trace cannot yet support one. */
  issuePortableProof?(
    access: ExternalAgentAccess,
    proposalId: string,
  ): Promise<object | "NOT_ISSUABLE" | null>;
  /** Public verification keys. Public by design: they verify, they cannot sign. */
  publicKeys?(): object | Promise<object>;
  /**
   * The key transparency log. Public by design, and for the same reason the keys are: a log only an issuer can read
   * proves nothing to anyone who might doubt the issuer. It contains digests and public key ids, never key material.
   */
  keyTransparencyLog?(): object | Promise<object>;
  readProof?(
    access: ExternalAgentAccess,
    proposalId: string,
  ): Promise<object | null>;
}

const json = (
  status: number,
  requestId: string,
  body: unknown,
): RestResponse => ({
  status,
  headers: {
    "content-type": "application/json",
    "x-payflow-request-id": requestId,
    "cache-control": "no-store",
  },
  body,
});

/**
 * POST /v1/actions/execute — the protocol adapter for real execution. It only translates HTTP
 * into the canonical Gateway request; every decision happens in the one Authority path.
 * Failures return a structured, actionable body, never a bare status code.
 */
export function createExecutingRestHandler(
  gateway: ExecutingGateway,
  deps: ExecutingRestDependencies,
) {
  return async (request: RestRequest): Promise<RestResponse> => {
    const requestId = `req_${crypto.randomUUID()}`;
    if (
      request.method === "GET" &&
      request.path === "/v1/keys" &&
      deps.publicKeys
    ) {
      try {
        return json(200, requestId, {
          requestId,
          ...(await deps.publicKeys()),
        });
      } catch {
        // Fail closed: if the key registry refuses (a reused key id, a revoked key), publish
        // nothing rather than a verification document that does not match what is being signed.
        return json(500, requestId, {
          requestId,
          reason: "SIGNING_KEY_UNAVAILABLE",
          recoverable: false,
          humanSummary:
            "Verification keys are unavailable. No Proof can be trusted until this is fixed.",
          nextAction: "CONTACT_THE_OPERATOR",
        });
      }
    }
    if (
      request.method === "GET" &&
      request.path === "/v1/transparency/keys" &&
      deps.keyTransparencyLog
    ) {
      try {
        return json(200, requestId, {
          requestId,
          ...(await deps.keyTransparencyLog()),
        });
      } catch {
        // Fail closed, like the key document: saying nothing is honest, while serving a log that may be
        // incomplete invites someone to conclude a key change never happened.
        return json(500, requestId, {
          requestId,
          reason: "TRANSPARENCY_LOG_UNAVAILABLE",
          recoverable: false,
          humanSummary:
            "The key transparency log cannot be read, so no claim about which key was valid when can be checked right now.",
          nextAction: "CONTACT_THE_OPERATOR",
        });
      }
    }
    const portableMatch = request.path.match(
      /^\/v1\/proofs\/([A-Za-z0-9._:-]{1,128})\/portable$/u,
    );
    if (
      request.method === "GET" &&
      portableMatch?.[1] &&
      deps.issuePortableProof
    ) {
      try {
        const access = await deps.authenticate(request.authorization);
        const portable = await deps.issuePortableProof(
          access,
          portableMatch[1],
        );
        if (portable === "NOT_ISSUABLE")
          return json(409, requestId, {
            requestId,
            reason: "PROOF_NOT_ISSUABLE",
            recoverable: true,
            humanSummary:
              "The outcome isn't verified yet, so no portable Proof can be signed. Try again after reconciliation.",
            nextAction: "READ_PROOF_AND_RETRY_LATER",
          });
        return portable
          ? json(200, requestId, { requestId, proof: portable })
          : json(404, requestId, {
              requestId,
              reason: "PROOF_NOT_FOUND",
              recoverable: false,
              humanSummary: "No Proof is available for that operation.",
              nextAction: "CHECK_THE_OPERATION_ID",
            });
      } catch (error) {
        if (error instanceof GatewayAccessError)
          return json(
            error.code === "ACCESS_SCOPE_DENIED" ? 403 : 401,
            requestId,
            {
              requestId,
              reason: error.code,
              recoverable: false,
              humanSummary: "This credential cannot read Proof.",
              nextAction: "USE_A_VALID_CREDENTIAL",
            },
          );
        return json(500, requestId, { requestId, reason: "INTERNAL_ERROR" });
      }
    }
    const proofMatch = request.path.match(
      /^\/v1\/proofs\/([A-Za-z0-9._:-]{1,128})$/u,
    );
    if (request.method === "GET" && proofMatch?.[1] && deps.readProof) {
      try {
        const access = await deps.authenticate(request.authorization);
        const proof = await deps.readProof(access, proofMatch[1]);
        return proof
          ? json(200, requestId, { requestId, proof })
          : json(404, requestId, {
              requestId,
              reason: "PROOF_NOT_FOUND",
              recoverable: false,
              humanSummary: "No Proof is available for that operation.",
              nextAction: "CHECK_THE_OPERATION_ID",
            });
      } catch (error) {
        if (error instanceof GatewayAccessError)
          return json(
            error.code === "ACCESS_SCOPE_DENIED" ? 403 : 401,
            requestId,
            {
              requestId,
              reason: error.code,
              recoverable: false,
              humanSummary: "This credential cannot read Proof.",
              nextAction: "USE_A_VALID_CREDENTIAL",
            },
          );
        return json(500, requestId, { requestId, reason: "INTERNAL_ERROR" });
      }
    }
    if (request.method !== "POST" || request.path !== "/v1/actions/execute")
      return json(404, requestId, {
        requestId,
        decision: "DENY",
        reason: "ROUTE_NOT_FOUND",
        recoverable: false,
        humanSummary: "That route does not exist.",
        nextAction: "CHECK_DOCUMENTATION",
      });
    try {
      const access = await deps.authenticate(request.authorization);
      const result = await gateway.requestPurchase(access, request.body);
      return json(200, requestId, result);
    } catch (error) {
      if (error instanceof GatewayAccessError)
        return json(
          error.code === "ACCESS_SCOPE_DENIED" ? 403 : 401,
          requestId,
          {
            requestId,
            decision: "DENY",
            effectCount: 0,
            reason: error.code,
            recoverable: false,
            humanSummary: "This credential cannot make this request. $0 moved.",
            nextAction: "USE_A_VALID_CREDENTIAL",
          },
        );
      if (error instanceof GatewayRequestError) {
        const malformed = error.code === "REQUEST_MALFORMED";
        return json(
          malformed ? 400 : error.code.endsWith("NOT_FOUND") ? 404 : 403,
          requestId,
          {
            requestId,
            decision: "DENY",
            effectCount: 0,
            reason: error.code,
            recoverable: malformed,
            humanSummary: malformed
              ? "The request is not valid. $0 moved."
              : "This credential does not match that Authority. $0 moved.",
            nextAction: malformed
              ? "FIX_REQUEST_AND_RETRY_WITH_NEW_NONCE"
              : "USE_THE_AGENT_CREDENTIAL_FOR_THIS_AUTHORITY",
          },
        );
      }
      // Unknown failure after a request was accepted: do not claim zero effect.
      return json(500, requestId, {
        requestId,
        decision: "DENY",
        effectCount: null,
        reason: "INTERNAL_ERROR",
        recoverable: false,
        doNotRetry: true,
        humanSummary:
          "We couldn't complete this request. If a payment was started we're confirming whether money moved.",
        nextAction: "DO_NOT_RETRY_CHECK_PROOF",
      });
    }
  };
}
