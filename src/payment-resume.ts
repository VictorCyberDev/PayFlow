import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type {
  HumanConfirmationBoundary,
  HumanActionBinding,
} from "./intent-activation.js";
import { persistedDate, type PostgresTrustRepository } from "./persistence.js";
import type { PayPalExecutionRail } from "./paypal.js";

const requestSchema = z
  .object({
    resumeSecret: z.string().regex(/^[a-f0-9]{64}$/),
    returnedOrderId: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/)
      .optional(),
  })
  .strict();
export function paymentResumeDigest(secret: string): string {
  return createHash("sha256")
    .update("payflow.payment-resume.v1\0")
    .update(secret)
    .digest("hex");
}
/** Navigation safety for this controlled Sandbox demo; not financial authority.
 * Other provider origins are unavailable until explicitly reviewed by the host. */
export function sandboxPayerActionUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048)
    throw new Error("PAYMENT_PAYER_URL_INVALID");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("PAYMENT_PAYER_URL_INVALID");
  }
  if (
    u.origin !== "https://www.sandbox.paypal.com" ||
    u.username ||
    u.password ||
    u.hash
  )
    throw new Error("PAYMENT_PAYER_URL_INVALID");
  return u.href;
}
/** Trusted host service. Browser data never supplies a financial fact. Authentication
 * verifies exact local action/CSRF/origin through the existing M3C interface. */
export class PaymentResumeService {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly boundary: HumanConfirmationBoundary,
    private readonly rail: Pick<PayPalExecutionRail, "reconcile">,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private now(): string {
    return this.clock().toISOString();
  }
  private binding(
    a: Record<string, unknown>,
    action: "PREPARE_PAYMENT_RESUME" | "RESUME_PAYMENT",
    challengeHash?: string,
  ): HumanActionBinding {
    return {
      action,
      agentId: String(a.agent_id),
      paymentAttemptId: String(a.id),
      proposalId: String(a.proposal_id),
      paypalOrderId: String(a.provider_order_id),
      ...(challengeHash ? { challengeHash } : {}),
    };
  }
  private async attempt(id: string) {
    z.string().uuid().parse(id);
    const [a] = await this.repo
      .sql`select p.*,g.agent_id from payment_attempts p join execution_grants g on g.id=p.grant_id where p.id=${id} and p.provider='PAYPAL'`;
    if (!a || !a.provider_order_id)
      throw new Error("PAYMENT_RESUME_UNAVAILABLE");
    return a;
  }
  /** Issue once, after durable payer-action state. No renewal and no secret recovery.
   * Host keeps the returned secret in its protected local session, never at PayPal. */
  async prepare(
    paymentAttemptId: string,
    assertion: unknown,
  ): Promise<{
    resumeSecret: string;
    expiresAt: string;
    payerActionUrl: string;
  }> {
    const a = await this.attempt(paymentAttemptId);
    const binding = this.binding(a, "PREPARE_PAYMENT_RESUME");
    const context = await this.boundary.authenticate(assertion, binding);
    const verified = this.boundary.require(context, binding);
    if (verified.identity.principalId !== a.principal_id)
      throw new Error("PAYMENT_RESUME_PRINCIPAL_MISMATCH");
    const payerActionUrl = sandboxPayerActionUrl(a.payer_action_url);
    const resumeSecret = randomBytes(32).toString("hex");
    const createdAt = this.now(),
      expiresAt = new Date(Date.parse(createdAt) + 600000).toISOString();
    await this.repo.sql.begin(async (tx) => {
      const [current] =
        await tx`select * from payment_attempts where id=${paymentAttemptId} for update`;
      if (
        !current ||
        current.status !== "PAYER_ACTION_REQUIRED" ||
        current.provider_order_id !== a.provider_order_id ||
        current.proposal_id !== a.proposal_id ||
        current.principal_id !== a.principal_id ||
        String(current.failure_classification).startsWith("COMMERCE_")
      )
        throw new Error("PAYMENT_RESUME_UNAVAILABLE");
      const inserted =
        await tx`insert into payment_resume_capabilities(payment_attempt_id,principal_id,proposal_id,paypal_order_id,secret_digest,created_at,expires_at) values(${paymentAttemptId},${String(a.principal_id)},${String(a.proposal_id)},${String(a.provider_order_id)},${paymentResumeDigest(resumeSecret)},${createdAt},${expiresAt}) on conflict(payment_attempt_id) do nothing returning payment_attempt_id`;
      if (inserted.length !== 1)
        throw new Error("PAYMENT_RESUME_ALREADY_PREPARED");
      this.boundary.require(context, binding);
      if (Date.parse(this.now()) >= Date.parse(expiresAt))
        throw new Error("PAYMENT_RESUME_EXPIRED");
    });
    return { resumeSecret, expiresAt, payerActionUrl };
  }
  /** Reusable within bounded lifetime for safe refresh/recovery. The attempt lock,
   * current authority and stable provider keys, not secret consumption, stop replay. */
  async resume(raw: unknown, assertion: unknown): Promise<string> {
    try {
      const request = requestSchema.parse(raw);
      const digest = paymentResumeDigest(request.resumeSecret);
      const [r] = await this.repo
        .sql`select * from payment_resume_capabilities where secret_digest=${digest}`;
      if (!r) throw new Error("PAYMENT_RESUME_INVALID");
      if (
        Date.parse(this.now()) < persistedDate(r.created_at).getTime() ||
        Date.parse(this.now()) >= persistedDate(r.expires_at).getTime()
      )
        throw new Error("PAYMENT_RESUME_EXPIRED");
      const a = await this.attempt(String(r.payment_attempt_id));
      if (
        a.principal_id !== r.principal_id ||
        a.proposal_id !== r.proposal_id ||
        a.provider_order_id !== r.paypal_order_id
      )
        throw new Error("PAYMENT_RESUME_BINDING_INVALID");
      const binding = this.binding(a, "RESUME_PAYMENT", digest);
      const context = await this.boundary.authenticate(assertion, binding);
      const verified = this.boundary.require(context, binding);
      if (verified.identity.principalId !== r.principal_id)
        throw new Error("PAYMENT_RESUME_PRINCIPAL_MISMATCH");
      if (
        request.returnedOrderId !== undefined &&
        request.returnedOrderId !== a.provider_order_id
      )
        throw new Error("PAYMENT_RESUME_ORDER_MISMATCH");
      if (Date.parse(this.now()) >= persistedDate(r.expires_at).getTime())
        throw new Error("PAYMENT_RESUME_EXPIRED");
      await this.repo.appendEvidence(
        "PAYMENT_RESUME_AUTHENTICATED",
        {
          paymentAttemptId: String(a.id),
          principalId: String(a.principal_id),
          paypalOrderId: String(a.provider_order_id),
        },
        this.now(),
      );
      // Rail performs mandatory GET of this persisted order, M4C conformance and
      // current authority checks under its existing independent PostgreSQL lock.
      this.boundary.require(context, binding);
      return await this.rail.reconcile(String(a.id), this.now());
    } catch {
      await this.repo.appendEvidence(
        "PAYMENT_RESUME_REJECTED",
        { code: "SECURE_RESUME_REJECTED" },
        this.now(),
      );
      throw new Error("SECURE_RESUME_REJECTED");
    }
  }
}
