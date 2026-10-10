import {
  createHash,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import {
  ExecutionQuarantinedError,
  ExecutionRejectedError,
} from "./execution-outcome.js";
import { mandateFingerprint, proposalDigest } from "./canonical.js";
import { CapabilitySchema } from "./domain.js";
import {
  persistedDate,
  DurableApprovalSchema,
  ReservationSchema,
  type PostgresTrustRepository,
  type Reservation,
} from "./persistence.js";

export const EXECUTION_GRANT_VERSION = "payflow.execution-grant.v1" as const;
export const DEFAULT_EXECUTION_GRANT_TTL_MS = 120_000;
export const MAX_EXECUTION_GRANT_TTL_MS = 300_000;

export const ExecutionGrantClaimsSchema = z
  .object({
    version: z.literal(EXECUTION_GRANT_VERSION),
    jti: z.string().uuid(),
    kid: z.string().min(1),
    principalId: z.string().min(1),
    agentId: z.string().min(1),
    mandateId: z.string().min(1),
    mandateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    proposalId: z.string().min(1),
    proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receiptId: z.string().min(1),
    reservationId: z.string().min(1),
    capability: CapabilitySchema,
    amountMinor: z.number().int().safe().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    merchantId: z.string().min(1),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    authorizationEngineVersion: z.string().min(1),
    audience: z.string().min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (Date.parse(v.issuedAt) >= Date.parse(v.expiresAt))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid grant lifetime",
      });
  });
export type ExecutionGrantClaims = Readonly<
  z.infer<typeof ExecutionGrantClaimsSchema>
>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}
function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function dbRow(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object")
    throw new Error("MALFORMED_PERSISTED_ROW");
  return value as Record<string, unknown>;
}
function reservationFromRow(value: unknown): Reservation {
  const r = dbRow(value);
  return ReservationSchema.parse({
    id: r.id,
    mandateId: r.mandate_id,
    proposalId: r.proposal_id,
    receiptId: r.receipt_id,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    status: r.status,
    expiresAt: persistedDate(r.expires_at).toISOString(),
  });
}

export interface PublicKeyResolver {
  resolve(kid: string): KeyObject | undefined;
}
export class StaticPublicKeyRing implements PublicKeyResolver {
  constructor(private readonly keys: ReadonlyMap<string, KeyObject>) {}
  resolve(kid: string): KeyObject | undefined {
    return this.keys.get(kid);
  }
}
export interface ExecutionSink {
  readonly finalizesAuthority?: boolean;
  readonly requiredCapability?: ExecutionGrantClaims["capability"];
  execute(
    claims: ExecutionGrantClaims,
  ): Promise<{ readonly executionId: string }>;
}
export class FakeExecutionSink implements ExecutionSink {
  calls = 0;
  constructor(private readonly fail = false) {}
  execute(
    claims: ExecutionGrantClaims,
  ): Promise<{ readonly executionId: string }> {
    this.calls += 1;
    return this.fail
      ? Promise.reject(new ExecutionRejectedError("FAKE_PROVIDER_FAILURE"))
      : Promise.resolve({ executionId: `fake:${claims.jti}` });
  }
}

export class ExecutionGrantIssuer {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly kid: string,
    private readonly privateKey: KeyObject,
    private readonly audience = "payflow.payment-execution",
    private readonly ttlMs = DEFAULT_EXECUTION_GRANT_TTL_MS,
  ) {
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("ED25519_SIGNING_KEY_REQUIRED");
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > MAX_EXECUTION_GRANT_TTL_MS
    )
      throw new Error("INVALID_GRANT_TTL");
  }

  async issue(reservationId: string, now: string): Promise<string> {
    if (!Number.isFinite(Date.parse(now)))
      throw new Error("INVALID_ISSUANCE_TIME");
    now = persistedDate(now).toISOString();
    return this.repo.sql.begin(async (tx) => {
      const rows =
        await tx`select * from authorization_reservations where id=${reservationId} for update`;
      if (!rows[0]) throw new Error("RESERVATION_NOT_FOUND");
      const reservation = reservationFromRow(rows[0]);
      if (
        reservation.status !== "AUTHORIZED" ||
        Date.parse(reservation.expiresAt) <= Date.parse(now)
      )
        throw new Error("RESERVATION_NOT_EXECUTABLE");

      const mandate = await this.repo.getMandate(
        reservation.mandateId,
        tx,
        true,
      );
      await this.repo.assertMandateActive(reservation.mandateId, tx);
      const proposal = await this.repo.getProposal(
        reservation.proposalId,
        tx,
        true,
      );
      const receipt = await this.repo.getReceipt(reservation.receiptId, tx);
      if (!mandate || !proposal || !receipt)
        throw new Error("AUTHORITY_STATE_MISSING");
      await this.repo.assertReceiptProposal(receipt.receiptId, proposal, tx);
      const agent = await this.repo.getAgent(proposal.agentId, tx);
      if (!agent) throw new Error("AGENT_NOT_FOUND");
      await this.repo.assertPrincipalActive(mandate.principalId, tx);
      await this.repo.assertCommerceRestrictions(
        mandate,
        proposal,
        reservation.id,
        tx,
      );
      if (
        Date.parse(mandate.createdAt) > Date.parse(now) ||
        Date.parse(mandate.expiresAt) <= Date.parse(now)
      )
        throw new Error("MANDATE_NOT_EXECUTABLE");
      if (
        Date.parse(agent.issuedAt) > Date.parse(now) ||
        agent.status !== "ACTIVE" ||
        Date.parse(agent.expiresAt) <= Date.parse(now)
      )
        throw new Error("AGENT_NOT_EXECUTABLE");
      if (
        mandate.authorizedAgentId !== agent.id ||
        agent.principalId !== mandate.principalId ||
        !mandate.allowedCapabilities.includes(proposal.requestedCapability) ||
        !agent.capabilities.includes(proposal.requestedCapability)
      )
        throw new Error("AUTHORITY_BINDING_MISMATCH");
      if (
        reservation.proposalId !== proposal.id ||
        reservation.receiptId !== receipt.receiptId ||
        reservation.mandateId !== mandate.id ||
        reservation.amountMinor !== proposal.amount.minor ||
        reservation.currency !== proposal.amount.currency
      )
        throw new Error("RESERVATION_BINDING_MISMATCH");
      if (
        receipt.proposalId !== proposal.id ||
        receipt.mandateId !== mandate.id ||
        receipt.agentId !== agent.id ||
        receipt.amount.minor !== proposal.amount.minor ||
        receipt.amount.currency !== proposal.amount.currency ||
        receipt.mandateFingerprint !== mandateFingerprint(mandate)
      )
        throw new Error("RECEIPT_BINDING_MISMATCH");
      if (receipt.decision === "DENY")
        throw new Error("DENIED_RECEIPT_NOT_EXECUTABLE");
      if (receipt.decision === "ESCALATE") {
        const approval = await this.repo.getApprovalByReceipt(
          receipt.receiptId,
          tx,
        );
        if (
          !approval ||
          approval.status !== "APPROVED" ||
          Date.parse(approval.approvedAt) > Date.parse(now) ||
          approval.principalId !== mandate.principalId ||
          approval.proposalId !== proposal.id
        )
          throw new Error("VALID_APPROVAL_REQUIRED");
      }
      if (receipt.decision !== "ALLOW" && receipt.decision !== "ESCALATE")
        throw new Error("RECEIPT_NOT_EXECUTABLE");

      const claims = ExecutionGrantClaimsSchema.parse({
        version: EXECUTION_GRANT_VERSION,
        jti: randomUUID(),
        kid: this.kid,
        principalId: mandate.principalId,
        agentId: agent.id,
        mandateId: mandate.id,
        mandateFingerprint: mandateFingerprint(mandate),
        proposalId: proposal.id,
        proposalDigest: proposalDigest(proposal),
        receiptId: receipt.receiptId,
        reservationId: reservation.id,
        capability: proposal.requestedCapability,
        amountMinor: proposal.amount.minor,
        currency: proposal.amount.currency,
        merchantId: proposal.merchant.id,
        issuedAt: now,
        expiresAt: new Date(Date.parse(now) + this.ttlMs).toISOString(),
        authorizationEngineVersion: receipt.authorizationEngineVersion,
        audience: this.audience,
      });
      const payload = stable(claims);
      const token = `${b64url(payload)}.${b64url(sign(null, Buffer.from(payload), this.privateKey))}`;
      await tx`insert into execution_grants(id,kid,version,audience,principal_id,agent_id,mandate_id,proposal_id,receipt_id,reservation_id,proposal_digest,mandate_fingerprint,capability,amount_minor,currency,merchant_id,issued_at,expires_at) values(${claims.jti},${claims.kid},${claims.version},${claims.audience},${claims.principalId},${claims.agentId},${claims.mandateId},${claims.proposalId},${claims.receiptId},${claims.reservationId},${claims.proposalDigest},${claims.mandateFingerprint},${claims.capability},${claims.amountMinor},${claims.currency},${claims.merchantId},${claims.issuedAt},${claims.expiresAt})`;
      const frozen =
        await tx`update execution_grants g set authority_snapshot=to_jsonb(g)-ARRAY['status','claimed_at','consumed_at','failed_at','authority_snapshot'] where id=${claims.jti} returning id`;
      if (frozen.length !== 1) throw new Error("GRANT_PERSISTENCE_FAILED");
      await this.repo.appendEvidenceInTransaction(
        tx,
        "EXECUTION_GRANT_ISSUED",
        {
          grantId: claims.jti,
          reservationId: claims.reservationId,
          proposalDigest: claims.proposalDigest,
        },
        now,
      );
      return token;
    });
  }
}

export class ExecutionBoundary {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly keys: PublicKeyResolver,
    private readonly sink: ExecutionSink,
    private readonly audience = "payflow.payment-execution",
  ) {}

  private async verificationFailure(
    token: string,
    reason: string,
    now: string,
  ): Promise<never> {
    await this.repo.appendEvidence(
      "EXECUTION_GRANT_VERIFICATION_FAILED",
      { tokenDigest: tokenDigest(token), reason },
      now,
    );
    throw new Error(reason);
  }

  async execute(
    token: string,
    now: string,
  ): Promise<{ readonly executionId: string }> {
    if (!Number.isFinite(Date.parse(now)))
      throw new Error("INVALID_EXECUTION_TIME");
    const parts = token.split(".");
    if (parts.length !== 2)
      return this.verificationFailure(token, "MALFORMED_EXECUTION_GRANT", now);
    let claims: ExecutionGrantClaims;
    let signature: Buffer;
    try {
      claims = ExecutionGrantClaimsSchema.parse(
        JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")),
      );
      signature = Buffer.from(parts[1]!, "base64url");
    } catch {
      return this.verificationFailure(token, "MALFORMED_EXECUTION_GRANT", now);
    }
    if (claims.audience !== this.audience)
      return this.verificationFailure(token, "WRONG_GRANT_AUDIENCE", now);
    if (
      Date.parse(claims.issuedAt) > Date.parse(now) ||
      Date.parse(claims.expiresAt) <= Date.parse(now)
    )
      return this.verificationFailure(token, "EXECUTION_GRANT_EXPIRED", now);
    const publicKey = this.keys.resolve(claims.kid);
    if (!publicKey)
      return this.verificationFailure(token, "UNKNOWN_GRANT_KID", now);
    if (publicKey.asymmetricKeyType !== "ed25519")
      return this.verificationFailure(
        token,
        "ED25519_VERIFICATION_KEY_REQUIRED",
        now,
      );
    if (!verify(null, Buffer.from(stable(claims)), publicKey, signature))
      return this.verificationFailure(token, "INVALID_GRANT_SIGNATURE", now);

    if (
      this.sink.requiredCapability &&
      claims.capability !== this.sink.requiredCapability
    ) {
      await this.repo.appendEvidence(
        "EXECUTION_CAPABILITY_REJECTED",
        {
          grantId: claims.jti,
          reservationId: claims.reservationId,
          requestedCapability: claims.capability,
          requiredCapability: this.sink.requiredCapability,
          reason: "PAYMENT_CAPABILITY_REQUIRED",
        },
        now,
      );
      throw new Error("PAYMENT_CAPABILITY_REQUIRED");
    }

    try {
      await this.repo.sql.begin(async (tx) => {
        const grantRows =
          await tx`select * from execution_grants where id=${claims.jti} for update`;
        if (!grantRows[0]) throw new Error("GRANT_STATE_NOT_FOUND");
        const grant = dbRow(grantRows[0]);
        if (grant.status !== "ISSUED")
          throw new Error("EXECUTION_GRANT_CONSUMED");
        const persisted: Record<string, unknown> = {
          kid: grant.kid,
          version: grant.version,
          audience: grant.audience,
          principalId: grant.principal_id,
          agentId: grant.agent_id,
          mandateId: grant.mandate_id,
          proposalId: grant.proposal_id,
          receiptId: grant.receipt_id,
          reservationId: grant.reservation_id,
          proposalDigest: grant.proposal_digest,
          mandateFingerprint: grant.mandate_fingerprint,
          capability: grant.capability,
          amountMinor: Number(grant.amount_minor),
          currency: grant.currency,
          merchantId: grant.merchant_id,
          issuedAt: persistedDate(grant.issued_at).toISOString(),
          expiresAt: persistedDate(grant.expires_at).toISOString(),
        };
        for (const [name, value] of Object.entries(persisted))
          if (value !== claims[name as keyof ExecutionGrantClaims])
            throw new Error("MALFORMED_PERSISTED_GRANT");

        await this.repo.assertGrantSnapshot(claims.jti, tx);
        const reservationRows =
          await tx`select * from authorization_reservations where id=${claims.reservationId} for update`;
        if (!reservationRows[0]) throw new Error("RESERVATION_NOT_FOUND");
        const reservation = reservationFromRow(reservationRows[0]);
        if (
          reservation.status !== "AUTHORIZED" ||
          Date.parse(reservation.expiresAt) <= Date.parse(now)
        )
          throw new Error("RESERVATION_NOT_EXECUTABLE");
        if (
          reservation.proposalId !== claims.proposalId ||
          reservation.receiptId !== claims.receiptId ||
          reservation.mandateId !== claims.mandateId ||
          reservation.amountMinor !== claims.amountMinor ||
          reservation.currency !== claims.currency
        )
          throw new Error("RESERVATION_BINDING_MISMATCH");

        const mandateRows =
          await tx`select id from mandates where id=${claims.mandateId} for update`;
        if (!mandateRows[0]) throw new Error("MANDATE_NOT_FOUND");
        await this.repo.assertMandateActive(claims.mandateId, tx);
        const mandate = await this.repo.getMandate(claims.mandateId, tx);
        const proposal = await this.repo.getProposal(
          claims.proposalId,
          tx,
          true,
        );
        const agent = await this.repo.getAgent(claims.agentId, tx);
        const receipt = await this.repo.getReceipt(claims.receiptId, tx);
        if (!mandate || !proposal || !agent || !receipt)
          throw new Error("EXECUTION_STATE_MISSING");
        await this.repo.assertPrincipalActive(mandate.principalId, tx);
        await this.repo.assertCommerceRestrictions(
          mandate,
          proposal,
          reservation.id,
          tx,
        );
        if (
          mandateFingerprint(mandate) !== claims.mandateFingerprint ||
          proposalDigest(proposal) !== claims.proposalDigest
        )
          throw new Error("EXECUTION_DIGEST_MISMATCH");
        if (
          mandate.principalId !== claims.principalId ||
          mandate.authorizedAgentId !== claims.agentId ||
          Date.parse(mandate.createdAt) > Date.parse(now) ||
          Date.parse(mandate.expiresAt) <= Date.parse(now) ||
          !mandate.allowedCapabilities.includes(claims.capability)
        )
          throw new Error("MANDATE_REVALIDATION_FAILED");
        if (
          agent.principalId !== claims.principalId ||
          Date.parse(agent.issuedAt) > Date.parse(now) ||
          agent.status !== "ACTIVE" ||
          Date.parse(agent.expiresAt) <= Date.parse(now) ||
          !agent.capabilities.includes(claims.capability)
        )
          throw new Error("AGENT_REVALIDATION_FAILED");
        if (
          proposal.agentId !== claims.agentId ||
          proposal.mandateId !== claims.mandateId ||
          proposal.amount.minor !== claims.amountMinor ||
          proposal.amount.currency !== claims.currency ||
          proposal.merchant.id !== claims.merchantId ||
          proposal.requestedCapability !== claims.capability
        )
          throw new Error("PROPOSAL_BINDING_MISMATCH");
        if (
          receipt.proposalId !== claims.proposalId ||
          receipt.mandateId !== claims.mandateId ||
          receipt.agentId !== claims.agentId ||
          receipt.amount.minor !== claims.amountMinor ||
          receipt.amount.currency !== claims.currency ||
          receipt.receiptId !== claims.receiptId ||
          receipt.authorizationEngineVersion !==
            claims.authorizationEngineVersion ||
          receipt.mandateFingerprint !== claims.mandateFingerprint
        )
          throw new Error("RECEIPT_BINDING_MISMATCH");
        await this.repo.assertReceiptProposal(claims.receiptId, proposal, tx);
        if (receipt.decision === "DENY")
          throw new Error("DENIED_RECEIPT_NOT_EXECUTABLE");
        if (receipt.decision === "ESCALATE") {
          const approvalRows =
            await tx`select * from approvals where receipt_id=${claims.receiptId} for update`;
          if (!approvalRows[0]) throw new Error("VALID_APPROVAL_REQUIRED");
          const approvalRow = dbRow(approvalRows[0]);
          const approval = DurableApprovalSchema.parse({
            id: approvalRow.id,
            receiptId: approvalRow.receipt_id,
            proposalId: approvalRow.proposal_id,
            principalId: approvalRow.principal_id,
            status: approvalRow.status,
            approvedAt: persistedDate(approvalRow.approved_at).toISOString(),
          });
          if (
            approval.status !== "APPROVED" ||
            Date.parse(approval.approvedAt) > Date.parse(now) ||
            approval.principalId !== claims.principalId ||
            approval.proposalId !== claims.proposalId
          )
            throw new Error("VALID_APPROVAL_REQUIRED");
        } else if (receipt.decision !== "ALLOW") {
          throw new Error("RECEIPT_NOT_EXECUTABLE");
        }

        const executing =
          await tx`update authorization_reservations set status='EXECUTING',updated_at=${now} where id=${claims.reservationId} and status='AUTHORIZED' returning id`;
        const claimed =
          await tx`update execution_grants set status='CLAIMED',claimed_at=${now} where id=${claims.jti} and status='ISSUED' returning id`;
        if (executing.length !== 1 || claimed.length !== 1)
          throw new Error("EXECUTION_CLAIM_STATE_INVALID");
        await this.repo.appendEvidenceInTransaction(
          tx,
          "EXECUTION_AUTHORITY_CLAIMED",
          { grantId: claims.jti, reservationId: claims.reservationId },
          now,
        );
        await this.repo.appendEvidenceInTransaction(
          tx,
          "PAYMENT_EXECUTION_STARTED",
          { grantId: claims.jti },
          now,
        );
      });
    } catch (error) {
      await this.repo.appendEvidence(
        "EXECUTION_REVALIDATION_FAILED",
        {
          grantId: claims.jti,
          reason: "EXECUTION_REVALIDATION_FAILED",
        },
        now,
      );
      throw error;
    }

    let providerReturned = false;
    try {
      const result = await this.sink.execute(claims);
      providerReturned = true;
      if (this.sink.finalizesAuthority) {
        const rows = await this.repo
          .sql`select g.status grant_status,r.status reservation_status,p.status attempt_status,p.provider_capture_id from execution_grants g join authorization_reservations r on r.id=g.reservation_id join payment_attempts p on p.grant_id=g.id and p.reservation_id=r.id where g.id=${claims.jti}`;
        if (
          rows.length !== 1 ||
          rows[0]?.grant_status !== "CONSUMED" ||
          rows[0]?.reservation_status !== "COMMITTED" ||
          rows[0]?.attempt_status !== "CAPTURED" ||
          rows[0]?.provider_capture_id !== result.executionId
        )
          throw new Error("PAYMENT_FINALIZATION_STATE_INVALID");
        return result;
      }
      await this.repo.sql.begin(async (tx) => {
        const rows =
          await tx`select * from execution_grants where id=${claims.jti} for update`;
        if (!rows[0] || dbRow(rows[0]).status !== "CLAIMED")
          throw new Error("GRANT_FINALIZATION_STATE_INVALID");
        const reservationRows =
          await tx`select * from authorization_reservations where id=${claims.reservationId} for update`;
        const g = dbRow(rows[0]),
          r = reservationRows[0]
            ? reservationFromRow(reservationRows[0])
            : null;
        if (
          !r ||
          r.status !== "EXECUTING" ||
          g.reservation_id !== r.id ||
          g.proposal_id !== claims.proposalId ||
          r.proposalId !== claims.proposalId ||
          g.receipt_id !== claims.receiptId ||
          r.receiptId !== claims.receiptId ||
          g.mandate_id !== claims.mandateId ||
          r.mandateId !== claims.mandateId ||
          g.principal_id !== claims.principalId ||
          Number(g.amount_minor) !== claims.amountMinor ||
          r.amountMinor !== claims.amountMinor ||
          g.currency !== claims.currency ||
          r.currency !== claims.currency ||
          g.merchant_id !== claims.merchantId
        )
          throw new Error("EXECUTION_FINALIZATION_BINDING_MISMATCH");
        const consumed =
          await tx`update execution_grants set status='CONSUMED',consumed_at=${now} where id=${claims.jti} and status='CLAIMED' returning id`;
        if (consumed.length !== 1)
          throw new Error("GRANT_FINALIZATION_STATE_INVALID");
        const updated =
          await tx`update authorization_reservations set status='COMMITTED',updated_at=${now} where id=${claims.reservationId} and status='EXECUTING' returning id`;
        if (updated.length !== 1)
          throw new Error("RESERVATION_FINALIZATION_STATE_INVALID");
        await this.repo.appendEvidenceInTransaction(
          tx,
          "PAYMENT_EXECUTION_SUCCEEDED",
          { grantId: claims.jti, executionId: result.executionId },
          now,
        );
      });
      return result;
    } catch (error) {
      if (providerReturned || !(error instanceof ExecutionRejectedError)) {
        await this.repo.appendEvidence(
          "PAYMENT_EXECUTION_QUARANTINED",
          { grantId: claims.jti, reason: "EXTERNAL_OUTCOME_UNPROVEN" },
          now,
        );
        throw error instanceof ExecutionQuarantinedError
          ? error
          : new ExecutionQuarantinedError("EXECUTION_OUTCOME_UNPROVEN");
      }
      await this.repo.sql.begin(async (tx) => {
        await tx`update execution_grants set status='FAILED',failed_at=${now} where id=${claims.jti} and status='CLAIMED'`;
        await tx`update authorization_reservations set status='FAILED',updated_at=${now} where id=${claims.reservationId} and status='EXECUTING'`;
        await this.repo.appendEvidenceInTransaction(
          tx,
          "PAYMENT_EXECUTION_FAILED",
          { grantId: claims.jti },
          now,
        );
      });
      throw error;
    }
  }
}
