import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MerchantRiskSchema,
  CapabilitySchema,
  MandateSchema,
  type Mandate,
} from "./domain.js";
import {
  compileIntentDraft,
  IntentCompileContextSchema,
  IntentInterpretationSchema,
  type IntentCompileContext,
} from "./intent.js";
import { semanticIntentIssues } from "./intent-semantics.js";
import type { PostgresTrustRepository } from "./persistence.js";
import { persistedDate } from "./persistence.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function reviewHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
export const ActivationPolicySchema = z
  .object({
    version: z.literal("payflow.activation-policy.v1"),
    maximumMinor: z.number().int().safe().positive(),
    maximumQuantity: z.number().int().positive().max(1000),
    currencies: z
      .array(z.enum(["USD", "EUR", "GBP", "AUD", "CAD", "JPY"]))
      .min(1),
    capabilities: z.array(CapabilitySchema).min(1),
    merchantIds: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/))
      .min(1),
    merchantRiskCeiling: MerchantRiskSchema,
    maximumLifetimeSeconds: z
      .number()
      .int()
      .positive()
      .max(86400 * 30),
  })
  .strict();
export type ActivationPolicy = z.infer<typeof ActivationPolicySchema>;
const BindingSchema = z
  .object({
    action: z.enum(["CREATE_INTENT_REVIEW", "CONFIRM_EXACT_TERMS"]),
    reviewId: id.optional(),
    agentId: id,
    draftFingerprint: digest.optional(),
    reviewedHash: digest.optional(),
    challengeHash: digest.optional(),
  })
  .strict();
export type HumanActionBinding = Readonly<z.infer<typeof BindingSchema>>;
const IdentitySchema = z
  .object({
    principalId: id,
    actor: z.literal("HUMAN"),
    authenticatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
/** Trusted external session/WebAuthn boundary: verify authentication, human action,
 * CSRF/origin/audience and EXACT binding. No permissive production implementation. */
export interface HumanActionAuthenticator {
  verify(assertion: unknown, binding: HumanActionBinding): Promise<unknown>;
}
export interface AuthenticatedHumanContext {
  readonly kind: "AUTHENTICATED_HUMAN_ACTION";
}
type Verified = {
  identity: z.infer<typeof IdentitySchema>;
  binding: HumanActionBinding;
};
export class HumanConfirmationBoundary {
  readonly #contexts = new WeakMap<object, Verified>();
  constructor(
    private readonly authenticator: HumanActionAuthenticator,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async authenticate(
    assertion: unknown,
    rawBinding: unknown,
  ): Promise<AuthenticatedHumanContext> {
    const binding = BindingSchema.parse(rawBinding);
    // Clone before calling external code; neither its caller nor verifier may mutate it.
    const immutableBinding = Object.freeze({ ...binding });
    const identity = Object.freeze(
      IdentitySchema.parse(
        await this.authenticator.verify(assertion, immutableBinding),
      ),
    );
    const now = this.clock().getTime();
    if (
      Date.parse(identity.authenticatedAt) > now ||
      now >= Date.parse(identity.expiresAt) ||
      Date.parse(identity.expiresAt) - Date.parse(identity.authenticatedAt) >
        300000
    )
      throw new Error("AUTHENTICATION_EXPIRED");
    const context = Object.freeze({
      kind: "AUTHENTICATED_HUMAN_ACTION" as const,
    });
    this.#contexts.set(
      context,
      Object.freeze({ identity, binding: immutableBinding }),
    );
    return context;
  }
  require(context: unknown, expected: HumanActionBinding): Verified {
    const verified =
      typeof context === "object" && context !== null
        ? this.#contexts.get(context)
        : undefined;
    if (!verified || canonical(verified.binding) !== canonical(expected))
      throw new Error("AUTHENTICATION_REQUIRED");
    if (this.clock().getTime() >= Date.parse(verified.identity.expiresAt))
      throw new Error("AUTHENTICATION_EXPIRED");
    return verified;
  }
}
const StoredReviewSchema = z
  .object({
    version: z.literal("payflow.review.v1"),
    principalId: id,
    agentId: id,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    interpretation: IntentInterpretationSchema,
    context: IntentCompileContextSchema,
    principalEpoch: z.string().regex(/^\d+$/),
    agentEpoch: z.string().regex(/^\d+$/),
    policyEpoch: z.string().regex(/^\d+$/),
    passportHash: digest,
    policyHash: digest,
    draftFingerprint: digest,
  })
  .strict();
const ConfirmationSchema = z
  .object({
    action: z.literal("CONFIRM_EXACT_TERMS"),
    reviewId: id,
    agentId: id,
    draftFingerprint: digest,
    reviewedHash: digest,
    challenge: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ActivationResult =
  | { status: "ACTIVATED"; mandate: Mandate }
  | { status: "REJECTED"; code: string };
const knownFailures = new Set([
  "AUTHENTICATION_REQUIRED",
  "AUTHENTICATION_EXPIRED",
  "REVIEW_MISSING",
  "REVIEW_EXPIRED",
  "REVIEW_STALE",
  "CONFIRMATION_REPLAY",
  "PRINCIPAL_MISMATCH",
  "PASSPORT_MISMATCH",
  "PASSPORT_INACTIVE",
  "PRINCIPAL_INACTIVE",
  "ACTIVATION_REQUIREMENTS_UNSATISFIED",
  "REVIEW_BINDING_MISMATCH",
  "ACTIVATION_POLICY_INVALID",
  "TRANSITION_FAILED",
]);
/** No model imports, authentication implementation, provider calls or signing keys. */
export class IntentActivationService {
  constructor(
    private readonly repository: PostgresTrustRepository,
    private readonly boundary: HumanConfirmationBoundary,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  /** Trusted operator provisioning only; never expose this as an unauthenticated API. */
  async provisionPolicy(principalId: string, raw: unknown): Promise<void> {
    const policy = ActivationPolicySchema.parse(raw);
    await this.repository
      .sql`insert into intent_activation_policies(principal_id,document,document_hash,status) values(${principalId},${this.repository.sql.json(policy)},${reviewHash(policy)},'ACTIVE') on conflict(principal_id) do update set document=excluded.document,document_hash=excluded.document_hash,status='ACTIVE'`;
  }
  async createReview(
    context: unknown,
    agentId: string,
    interpretation: unknown,
    trustedIntake: IntentCompileContext,
  ): Promise<{
    status: "REVIEW_CREATED";
    reviewId: string;
    draftFingerprint: string;
    reviewedHash: string;
    challenge: string;
    expiresAt: string;
    draft: unknown;
  }> {
    id.parse(agentId);
    const verified = this.boundary.require(context, {
      action: "CREATE_INTENT_REVIEW",
      agentId,
    });
    // Intake bounds MUST be supplied by the trusted server, not copied from model output.
    const intake = IntentCompileContextSchema.parse({
      ...trustedIntake,
      now: this.clock().toISOString(),
    });
    const compiled = compileIntentDraft(interpretation, intake);
    if (
      compiled.status !== "VALID_DRAFT" ||
      semanticIntentIssues(
        IntentInterpretationSchema.parse(interpretation),
        intake.source.text,
      ).length
    )
      throw new Error("ACTIVATION_REQUIREMENTS_UNSATISFIED");
    return this.repository.sql.begin(async (tx) => {
      const [a] =
        await tx`select * from agent_passports where id=${agentId} for update`;
      const [p] =
        await tx`select * from principals where id=${verified.identity.principalId} for update`;
      const [policyRow] =
        await tx`select * from intent_activation_policies where principal_id=${verified.identity.principalId} for update`;
      if (!a || !p || !policyRow) throw new Error("ACTIVATION_POLICY_INVALID");
      const passport = await this.repository.getAgent(agentId, tx);
      if (!passport) throw new Error("PASSPORT_MISMATCH");
      const policy = ActivationPolicySchema.parse(policyRow.document);
      if (p.status !== "ACTIVE") throw new Error("PRINCIPAL_INACTIVE");
      if (passport.principalId !== p.id) throw new Error("PASSPORT_MISMATCH");
      if (
        passport.status !== "ACTIVE" ||
        Date.parse(passport.issuedAt) > this.clock().getTime() ||
        Date.parse(passport.expiresAt) <= this.clock().getTime()
      )
        throw new Error("PASSPORT_INACTIVE");
      if (
        policyRow.status !== "ACTIVE" ||
        policyRow.document_hash !== reviewHash(policy)
      )
        throw new Error("ACTIVATION_POLICY_INVALID");
      this.validatePolicy(compiled.draft, passport.capabilities, policy);
      const now = this.clock();
      const expiresAt = new Date(
        Math.min(
          now.getTime() + 300000,
          Date.parse(compiled.draft.proposedMandateTerms.expiresAt),
          Date.parse(passport.expiresAt),
          Date.parse(verified.identity.expiresAt),
        ),
      ).toISOString();
      if (Date.parse(expiresAt) <= now.getTime())
        throw new Error("REVIEW_EXPIRED");
      const stored = StoredReviewSchema.parse({
        version: "payflow.review.v1",
        principalId: verified.identity.principalId,
        agentId,
        createdAt: now.toISOString(),
        expiresAt,
        interpretation: compiled.draft.provenance.interpretation,
        context: intake,
        principalEpoch: String(p.security_epoch),
        agentEpoch: String(a.security_epoch),
        policyEpoch: String(policyRow.security_epoch),
        passportHash: reviewHash(passport),
        policyHash: reviewHash(policy),
        draftFingerprint: compiled.draft.fingerprint,
      });
      const reviewId = randomUUID(),
        challenge = randomBytes(32).toString("hex"),
        hash = reviewHash(stored);
      await tx`insert into intent_reviews(id,principal_id,agent_id,draft_fingerprint,reviewed_document,reviewed_hash,challenge_hash,created_at,expires_at) values(${reviewId},${verified.identity.principalId},${agentId},${compiled.draft.fingerprint},${tx.json(stored)},${hash},${reviewHash(challenge)},${now.toISOString()},${expiresAt})`;
      await this.repository.appendEvidenceInTransaction(
        tx,
        "INTENT_REVIEW_CREATED",
        {
          reviewId,
          principalId: verified.identity.principalId,
          agentId,
          draftFingerprint: compiled.draft.fingerprint,
          reviewedHash: hash,
        },
        now.toISOString(),
      );
      this.boundary.require(context, {
        action: "CREATE_INTENT_REVIEW",
        agentId,
      });
      if (this.clock().getTime() >= Date.parse(expiresAt))
        throw new Error("REVIEW_EXPIRED");
      return {
        status: "REVIEW_CREATED" as const,
        reviewId,
        draftFingerprint: compiled.draft.fingerprint,
        reviewedHash: hash,
        challenge,
        expiresAt,
        draft: compiled.draft,
      };
    });
  }
  /** Authentication network work occurs BEFORE the activation transaction. */
  async confirmReviewedIntent(
    raw: unknown,
    assertion: unknown,
  ): Promise<ActivationResult> {
    try {
      const request = ConfirmationSchema.parse(raw);
      const binding = {
        action: request.action,
        reviewId: request.reviewId,
        agentId: request.agentId,
        draftFingerprint: request.draftFingerprint,
        reviewedHash: request.reviewedHash,
        challengeHash: reviewHash(request.challenge),
      };
      const context = await this.boundary.authenticate(assertion, binding);
      return await this.activateReviewedIntent(context, binding);
    } catch (error) {
      const code = this.safeCode(error);
      await this.repository.appendEvidence(
        "INTENT_CONFIRMATION_REJECTED",
        { code },
        this.clock().toISOString(),
      );
      return { status: "REJECTED", code };
    }
  }
  async activateReviewedIntent(
    context: unknown,
    rawBinding: unknown,
  ): Promise<ActivationResult> {
    let reviewId: string | undefined;
    try {
      const binding = BindingSchema.parse(rawBinding);
      if (
        binding.action !== "CONFIRM_EXACT_TERMS" ||
        !binding.reviewId ||
        !binding.draftFingerprint ||
        !binding.reviewedHash ||
        !binding.challengeHash
      )
        throw new Error("AUTHENTICATION_REQUIRED");
      reviewId = binding.reviewId;
      const verified = this.boundary.require(context, binding);
      const mandate = await this.repository.sql.begin(async (tx) => {
        const [review] =
          await tx`select * from intent_reviews where id=${binding.reviewId!} for update`;
        if (!review) throw new Error("REVIEW_MISSING");
        if (review.principal_id !== verified.identity.principalId)
          throw new Error("PRINCIPAL_MISMATCH");
        if (review.agent_id !== binding.agentId)
          throw new Error("PASSPORT_MISMATCH");
        if (review.status !== "PENDING") throw new Error("CONFIRMATION_REPLAY");
        if (
          this.clock().getTime() >= persistedDate(review.expires_at).getTime()
        )
          throw new Error("REVIEW_EXPIRED");
        if (
          review.draft_fingerprint !== binding.draftFingerprint ||
          review.reviewed_hash !== binding.reviewedHash ||
          review.challenge_hash !== binding.challengeHash ||
          reviewHash(review.reviewed_document) !== review.reviewed_hash
        )
          throw new Error("REVIEW_BINDING_MISMATCH");
        const stored = StoredReviewSchema.parse(review.reviewed_document);
        if (
          stored.principalId !== review.principal_id ||
          stored.agentId !== review.agent_id ||
          Date.parse(stored.createdAt) !==
            persistedDate(review.created_at).getTime() ||
          Date.parse(stored.expiresAt) !==
            persistedDate(review.expires_at).getTime() ||
          Date.parse(stored.createdAt) > this.clock().getTime()
        )
          throw new Error("REVIEW_BINDING_MISMATCH");
        const [a] =
          await tx`select * from agent_passports where id=${binding.agentId} for update`;
        const [p] =
          await tx`select * from principals where id=${verified.identity.principalId} for update`;
        const [policyRow] =
          await tx`select * from intent_activation_policies where principal_id=${verified.identity.principalId} for update`;
        if (!a || !p || !policyRow) throw new Error("REVIEW_STALE");
        const passport = await this.repository.getAgent(binding.agentId, tx);
        if (!passport) throw new Error("PASSPORT_MISMATCH");
        const policy = ActivationPolicySchema.parse(policyRow.document);
        if (p.status !== "ACTIVE") throw new Error("PRINCIPAL_INACTIVE");
        if (passport.principalId !== p.id || a.principal_id !== p.id)
          throw new Error("PASSPORT_MISMATCH");
        if (
          passport.status !== "ACTIVE" ||
          Date.parse(passport.issuedAt) > this.clock().getTime() ||
          Date.parse(passport.expiresAt) <= this.clock().getTime()
        )
          throw new Error("PASSPORT_INACTIVE");
        if (
          stored.principalEpoch !== String(p.security_epoch) ||
          stored.agentEpoch !== String(a.security_epoch) ||
          stored.policyEpoch !== String(policyRow.security_epoch) ||
          stored.passportHash !== reviewHash(passport) ||
          stored.policyHash !== reviewHash(policy) ||
          policyRow.document_hash !== stored.policyHash ||
          policyRow.status !== "ACTIVE"
        )
          throw new Error("REVIEW_STALE");
        const compiled = compileIntentDraft(
          stored.interpretation,
          stored.context,
        );
        if (
          compiled.status !== "VALID_DRAFT" ||
          semanticIntentIssues(
            stored.interpretation,
            stored.context.source.text,
          ).length > 0 ||
          compiled.draft.fingerprint !== binding.draftFingerprint ||
          stored.draftFingerprint !== binding.draftFingerprint
        )
          throw new Error("REVIEW_BINDING_MISMATCH");
        this.validatePolicy(compiled.draft, passport.capabilities, policy);
        const terms = compiled.draft.proposedMandateTerms,
          now = this.clock();
        if (Date.parse(terms.expiresAt) <= now.getTime())
          throw new Error("REVIEW_EXPIRED");
        const satisfied = new Set([
          "AUTHENTICATED_HUMAN_CONFIRMATION",
          "TRUSTED_PRINCIPAL_AGENT_AND_RISK_POLICY",
          "QUANTITY_ENFORCEMENT",
          "MERCHANT_ALLOWLIST_ENFORCEMENT",
        ]);
        if (
          compiled.draft.activationRequirements.some((r) => !satisfied.has(r))
        )
          throw new Error("ACTIVATION_REQUIREMENTS_UNSATISFIED");
        const trusted = MandateSchema.parse({
          ...terms,
          id: randomUUID(),
          principalId: verified.identity.principalId,
          authorizedAgentId: passport.id,
          merchantRiskCeiling: policy.merchantRiskCeiling,
          createdAt: now.toISOString(),
          version: 1,
          nonce: randomBytes(32).toString("hex"),
          quantityLimit: compiled.draft.quantity,
          merchantScope: compiled.draft.merchants,
        });
        await this.repository.saveMandate(trusted, tx);
        const transitioned =
          await tx`update intent_reviews set status='ACTIVATED',mandate_id=${trusted.id},confirmed_at=${now.toISOString()} where id=${binding.reviewId!} and status='PENDING' returning id`;
        const linked =
          await tx`update mandates set intent_review_id=${binding.reviewId!} where id=${trusted.id} and intent_review_id is null returning id`;
        if (transitioned.length !== 1 || linked.length !== 1)
          throw new Error("TRANSITION_FAILED");
        await this.repository.appendEvidenceInTransaction(
          tx,
          "HUMAN_CONFIRMATION_ACCEPTED",
          {
            reviewId: binding.reviewId!,
            principalId: verified.identity.principalId,
            agentId: passport.id,
            draftFingerprint: binding.draftFingerprint,
            reviewedHash: binding.reviewedHash!,
          },
          now.toISOString(),
        );
        await this.repository.appendEvidenceInTransaction(
          tx,
          "INTENT_MANDATE_ACTIVATED",
          {
            reviewId: binding.reviewId!,
            mandateId: trusted.id,
            quantityLimit: trusted.quantityLimit!,
            merchantScope: trusted.merchantScope!.mode,
          },
          now.toISOString(),
        );
        this.boundary.require(context, binding);
        if (
          this.clock().getTime() >=
            persistedDate(review.expires_at).getTime() ||
          this.clock().getTime() >= Date.parse(trusted.expiresAt)
        )
          throw new Error("REVIEW_EXPIRED");
        return trusted;
      });
      return { status: "ACTIVATED", mandate };
    } catch (error) {
      const code = this.safeCode(error);
      if (reviewId)
        await this.repository.appendEvidence(
          "INTENT_ACTIVATION_REJECTED",
          { reviewId, code },
          this.clock().toISOString(),
        );
      return { status: "REJECTED", code };
    }
  }
  private safeCode(error: unknown): string {
    return error instanceof Error && knownFailures.has(error.message)
      ? error.message
      : "ACTIVATION_REQUIREMENTS_UNSATISFIED";
  }
  private validatePolicy(
    draft: Extract<
      ReturnType<typeof compileIntentDraft>,
      { status: "VALID_DRAFT" }
    >["draft"],
    capabilities: readonly string[],
    policy: ActivationPolicy,
  ): void {
    const t = draft.proposedMandateTerms;
    if (
      t.maxSingleTransactionMinor > policy.maximumMinor ||
      draft.quantity > policy.maximumQuantity ||
      !policy.currencies.includes(t.currency) ||
      t.allowedCapabilities.some(
        (c) => !capabilities.includes(c) || !policy.capabilities.includes(c),
      ) ||
      (draft.merchants.mode === "ONLY" &&
        draft.merchants.ids.some((m) => !policy.merchantIds.includes(m))) ||
      Date.parse(t.expiresAt) >
        this.clock().getTime() + policy.maximumLifetimeSeconds * 1000
    )
      throw new Error("ACTIVATION_REQUIREMENTS_UNSATISFIED");
  }
}
