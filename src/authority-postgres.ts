import {
  AuthorityProjectionSchema,
  type AuthorityViewReader,
} from "./authority-projection.js";
import type { PostgresTrustRepository } from "./persistence.js";
/** Read-only repeatable snapshot. Uses accepted accounting, never authorizes dispatch. */
export class PostgresAuthorityViewReader implements AuthorityViewReader {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async readOwned(principalId: string, mandateId: string): Promise<unknown> {
    return this.repo.sql.begin(
      "isolation level repeatable read read only",
      async (db) => {
        const [owned] =
          await db`select revoked_at from mandates where id=${mandateId} and principal_id=${principalId}`;
        if (!owned) return null;
        const m = await this.repo.getMandate(mandateId, db);
        if (!m || m.principalId !== principalId) return null;
        const a = await this.repo.getAgent(m.authorizedAgentId, db, false);
        const [p] =
          await db`select status from principals where id=${principalId}`;
        if (!a || a.principalId !== principalId || !p) return null;
        const now = this.clock(),
          time = now.getTime();
        const agentState =
          time >= Date.parse(a.expiresAt) ? "EXPIRED" : a.status;
        const state = owned.revoked_at
          ? "REVOKED"
          : time >= Date.parse(m.expiresAt)
            ? "EXPIRED"
            : p.status !== "ACTIVE" ||
                agentState !== "ACTIVE" ||
                time < Date.parse(a.issuedAt) ||
                time < Date.parse(m.createdAt)
              ? "UNAVAILABLE"
              : "ACTIVE";
        const accounting = await this.repo.authorityAccounting(
          m.id,
          m.cumulativeLimitMinor,
          db,
        );
        const consumed = await this.repo.quantityAccounting(m, db);
        return AuthorityProjectionSchema.parse({
          version: "payflow.authority-view.v1",
          mandateId: m.id,
          principalId: m.principalId,
          agent: { id: a.id, displayName: a.displayName, status: agentState },
          purpose: m.purpose,
          currency: m.currency,
          singleMaximumMinor: m.maxSingleTransactionMinor,
          cumulativeLimitMinor: m.cumulativeLimitMinor ?? null,
          committedMinor: accounting.committedMinor,
          reservedMinor: accounting.activeReservedMinor,
          remainingMinor: accounting.availableMinor,
          quantityLimit: m.quantityLimit ?? null,
          quantityRemaining:
            m.quantityLimit !== undefined && consumed !== undefined
              ? m.quantityLimit - consumed
              : null,
          merchantScopeSummary:
            m.merchantScope?.mode === "ONLY"
              ? `Only ${m.merchantScope.ids.join(", ")}`
              : "Any merchant, subject to existing policy",
          allowedConditions: [...m.allowedConditions],
          allowedCapabilities: [...m.allowedCapabilities],
          autonomousThresholdMinor: m.autonomousPurchaseThresholdMinor,
          humanApprovalThresholdMinor: m.humanApprovalThresholdMinor,
          createdAt: m.createdAt,
          expiresAt: new Date(
            Math.min(Date.parse(m.expiresAt), Date.parse(a.expiresAt)),
          ).toISOString(),
          observedAt: now.toISOString(),
          state,
          freshDispatchBlocked: state === "ACTIVE" ? null : true,
        });
      },
    );
  }
}
