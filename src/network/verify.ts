import {
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { mandateFingerprint } from "../canonical.js";
import type { AgentPassport, Mandate, TransactionProposal } from "../domain.js";
import { authorize } from "../kernel.js";

const AuthorityPresentationPayloadSchema = z
  .object({
    version: z.literal("payflow-authority-presentation/v1"),
    issuer: z.string().min(1),
    keyId: z.string().min(1),
    authorityId: z.string().min(1),
    authorityFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    principalId: z.string().min(1),
    agentId: z.string().min(1),
    audience: z.string().min(1),
    challenge: z.string().min(16),
    nonce: z.string().min(16),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type AuthorityPresentationPayload = Readonly<
  z.infer<typeof AuthorityPresentationPayloadSchema>
>;

export const SignedAuthorityPresentationSchema = z
  .object({
    payload: AuthorityPresentationPayloadSchema,
    signature: z.string().min(32),
  })
  .strict();
export type SignedAuthorityPresentation = Readonly<
  z.infer<typeof SignedAuthorityPresentationSchema>
>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function presentationBytes(payload: AuthorityPresentationPayload): Buffer {
  return Buffer.from(JSON.stringify(stable(payload)), "utf8");
}

export function signAuthorityPresentation(
  payload: AuthorityPresentationPayload,
  privateKey: KeyObject,
): SignedAuthorityPresentation {
  const validated = AuthorityPresentationPayloadSchema.parse(payload);
  return {
    payload: validated,
    signature: cryptoSign(
      null,
      presentationBytes(validated),
      privateKey,
    ).toString("base64url"),
  };
}

export type AuthorityLifecycleState = "ACTIVE" | "SUSPENDED" | "REVOKED";

export interface VerificationDependencies {
  resolvePublicKey(issuer: string, keyId: string): Promise<KeyObject | null>;
  loadAuthority(
    authorityId: string,
  ): Promise<{ mandate: Mandate; state: AuthorityLifecycleState } | null>;
  /** Atomic. Returns true only for the first presentation of this nonce/challenge. */
  claimPresentationReplayKey(scope: string, key: string): Promise<boolean>;
}

export type VerificationVerdict =
  | "VALID"
  | "INVALID"
  | "EXPIRED"
  | "REVOKED"
  | "WRONG_AUDIENCE"
  | "TAMPERED"
  | "REPLAYED";

export interface VerificationResult {
  readonly verdict: VerificationVerdict;
  readonly authorityId?: string;
  readonly agentId?: string;
  readonly expiresAt?: string;
  readonly reason: string;
}

export async function verifyAuthorityPresentation(
  raw: unknown,
  expected: { audience: string; challenge: string; now: string },
  deps: VerificationDependencies,
): Promise<VerificationResult> {
  const parsed = SignedAuthorityPresentationSchema.safeParse(raw);
  if (!parsed.success || !Number.isFinite(Date.parse(expected.now))) {
    return { verdict: "INVALID", reason: "MALFORMED_PRESENTATION" };
  }
  const presentation = parsed.data;
  const { payload } = presentation;
  const publicKey = await deps.resolvePublicKey(payload.issuer, payload.keyId);
  if (!publicKey) {
    return {
      verdict: "INVALID",
      authorityId: payload.authorityId,
      agentId: payload.agentId,
      expiresAt: payload.expiresAt,
      reason: "UNKNOWN_SIGNING_KEY",
    };
  }
  const authentic = cryptoVerify(
    null,
    presentationBytes(payload),
    publicKey,
    Buffer.from(presentation.signature, "base64url"),
  );
  if (!authentic) {
    return {
      verdict: "TAMPERED",
      authorityId: payload.authorityId,
      agentId: payload.agentId,
      expiresAt: payload.expiresAt,
      reason: "SIGNATURE_INVALID",
    };
  }
  if (
    payload.audience !== expected.audience ||
    payload.challenge !== expected.challenge
  ) {
    return {
      verdict: "WRONG_AUDIENCE",
      authorityId: payload.authorityId,
      agentId: payload.agentId,
      expiresAt: payload.expiresAt,
      reason: "REQUEST_BINDING_MISMATCH",
    };
  }
  const now = Date.parse(expected.now);
  if (
    now < Date.parse(payload.issuedAt) ||
    now >= Date.parse(payload.expiresAt)
  ) {
    return {
      verdict: "EXPIRED",
      authorityId: payload.authorityId,
      agentId: payload.agentId,
      expiresAt: payload.expiresAt,
      reason: "PRESENTATION_EXPIRED",
    };
  }
  const authority = await deps.loadAuthority(payload.authorityId);
  if (!authority) {
    return {
      verdict: "INVALID",
      authorityId: payload.authorityId,
      agentId: payload.agentId,
      expiresAt: payload.expiresAt,
      reason: "AUTHORITY_NOT_FOUND",
    };
  }
  if (authority.state !== "ACTIVE") {
    return {
      verdict: "REVOKED",
      authorityId: payload.authorityId,
      agentId: payload.agentId,
      expiresAt: payload.expiresAt,
      reason:
        authority.state === "REVOKED"
          ? "AUTHORITY_REVOKED"
          : "AUTHORITY_SUSPENDED",
    };
  }
  if (
    authority.mandate.principalId !== payload.principalId ||
    authority.mandate.authorizedAgentId !== payload.agentId ||
    mandateFingerprint(authority.mandate) !== payload.authorityFingerprint
  ) {
    return {
      verdict: "TAMPERED",
      authorityId: payload.authorityId,
      agentId: payload.agentId,
      expiresAt: payload.expiresAt,
      reason: "AUTHORITY_BINDING_MISMATCH",
    };
  }
  if (now >= Date.parse(authority.mandate.expiresAt)) {
    return {
      verdict: "EXPIRED",
      authorityId: payload.authorityId,
      agentId: payload.agentId,
      expiresAt: payload.expiresAt,
      reason: "AUTHORITY_EXPIRED",
    };
  }
  const firstPresentation = await deps.claimPresentationReplayKey(
    `verify:${payload.audience}:${payload.challenge}`,
    payload.nonce,
  );
  if (!firstPresentation) {
    return {
      verdict: "REPLAYED",
      authorityId: payload.authorityId,
      agentId: payload.agentId,
      expiresAt: payload.expiresAt,
      reason: "PRESENTATION_REPLAYED",
    };
  }
  return {
    verdict: "VALID",
    authorityId: payload.authorityId,
    agentId: payload.agentId,
    expiresAt: payload.expiresAt,
    reason: "AUTHORITY_PRESENTATION_VALID",
  };
}

/**
 * Read-only fit evaluation. It deliberately calls the same Trust Kernel but
 * never reserves authority, issues a grant, contacts a rail, or moves money.
 */
export function verifyProposedActionFit(
  mandate: Mandate,
  agent: AgentPassport,
  proposal: TransactionProposal,
  context: {
    now: string;
    merchantRisk: "LOW" | "MEDIUM" | "HIGH" | "EXCESSIVE";
    cumulativeSpentMinor: number;
    consumedQuantity?: number;
  },
) {
  return authorize(mandate, agent, proposal, {
    ...context,
    replaySeen: false,
  });
}
