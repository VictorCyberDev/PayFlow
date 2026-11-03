import {
  sign as cryptoSign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import {
  portableProofPayloadBytes,
  proofDigest,
  type PortableProof,
  type PortableProofPayload,
} from "../../packages/verifier/src/index.js";
import type { PostgresTrustRepository } from "../persistence.js";
import { isSimulatedOrder } from "../simulated-rail.js";
import type { ProofReader } from "./proof-read.js";

/**
 * Issues a signed, portable `payflow-proof/v1` from the EXISTING verified operation trace. It adds
 * no second Proof system and no new decision: it only attests to what the trace already proved,
 * so a separate party can verify the outcome offline with a public key and no PayFlow session.
 *
 * Outcome mapping is conservative:
 *   VERIFIED + CAPTURED                  -> SUCCEEDED, effectCount 1
 *   UNKNOWN_FINANCIAL_OUTCOME            -> UNKNOWN,   effectCount null (never 0)
 *   VERIFIED + DENIED                    -> FAILED,    effectCount 0
 *   anything else (incomplete/invalid)   -> not issuable
 */
export class PortableProofIssuer {
  constructor(
    private readonly proofs: ProofReader,
    private readonly repo: PostgresTrustRepository,
    private readonly signing: {
      readonly issuer: string;
      readonly keyId: string;
      readonly privateKey: KeyObject;
    },
  ) {}

  async issue(
    rawAccess: unknown,
    proposalId: string,
    now: string,
  ): Promise<PortableProof | "NOT_ISSUABLE" | null> {
    const trace = await this.proofs.read(rawAccess, proposalId, now);
    if (!trace) return null;
    let outcome: PortableProofPayload["outcome"];
    let effectCount: PortableProofPayload["effectCount"];
    if (trace.status === "VERIFIED" && trace.financialOutcome === "CAPTURED") {
      [outcome, effectCount] = ["SUCCEEDED", 1];
    } else if (trace.status === "UNKNOWN_FINANCIAL_OUTCOME") {
      [outcome, effectCount] = ["UNKNOWN", null];
    } else if (
      trace.status === "VERIFIED" &&
      trace.financialOutcome === "DENIED"
    ) {
      [outcome, effectCount] = ["FAILED", 0];
    } else {
      return "NOT_ISSUABLE";
    }
    const mandateId = trace.references.mandateId;
    if (!mandateId) return "NOT_ISSUABLE";
    // Bind the signed proof to the durable facts of the action: agent, amount, merchant, currency.
    const proposal = await this.repo.getProposal(proposalId);
    const mandate = proposal
      ? await this.repo.getMandate(proposal.mandateId)
      : null;
    const subject =
      proposal && mandate
        ? {
            principalId: mandate.principalId,
            agentId: proposal.agentId,
            capability: proposal.requestedCapability,
            amountMinor: proposal.amount.minor,
            currency: proposal.amount.currency,
            merchantId: proposal.merchant.id,
            rail: isSimulatedOrder(trace.references.providerOrderId)
              ? ("SIMULATED" as const)
              : ("PAYPAL_SANDBOX" as const),
          }
        : undefined;
    const payload: PortableProofPayload = {
      version: "payflow-proof/v1",
      issuer: this.signing.issuer,
      keyId: this.signing.keyId,
      authorityId: mandateId,
      actionId: proposalId,
      outcome,
      effectCount,
      observedAt: now,
      evidenceDigest: proofDigest(trace),
      ...(subject ? { subject } : {}),
    };
    const signature = cryptoSign(
      null,
      portableProofPayloadBytes(payload),
      this.signing.privateKey,
    ).toString("base64url");
    return { ...payload, signature };
  }
}

export type PublicKeyDocument = Readonly<{
  issuer: string;
  keys: ReadonlyArray<{ keyId: string; jwk: JsonWebKey }>;
}>;
