import { z } from "zod";
import type { ConsoleRequest, ConsoleSessions } from "./console-session.js";
import type { PostgresTrustRepository } from "./persistence.js";
import { AuthorityViewService } from "./authority-projection.js";
import { PostgresAuthorityViewReader } from "./authority-postgres.js";
const id = z.string().min(1).max(128);
/** Trusted control adapter. Accepted repository revocation is the sole mutation. */
export class ConsoleControls {
  readonly #views: AuthorityViewService;
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly sessions: ConsoleSessions,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.#views = new AuthorityViewService(
      sessions,
      new PostgresAuthorityViewReader(repo, clock),
    );
  }
  async list(req: ConsoleRequest, raw: unknown) {
    z.object({}).strict().parse(raw);
    const context = this.sessions.read(req);
    const principal = await this.sessions.requirePrincipal(context);
    const rows = await this.repo
      .sql`select id from mandates where principal_id=${principal} order by created_at desc,id desc limit 20`;
    const items = [];
    for (const row of rows) {
      const view = await this.#views.read(context, {
        mandateId: String(row.id),
      });
      if (!view) throw new Error("UNAVAILABLE");
      items.push(view);
    }
    // Recheck absolute session lifetime after potentially slow database reads.
    await this.sessions.requirePrincipal(context);
    return { version: "payflow.authorities.v1", items, limit: 20 };
  }
  async revoke(req: ConsoleRequest, raw: unknown) {
    const context = this.sessions.mutation(req);
    const principal = await this.sessions.requirePrincipal(context);
    const q = z
      .object({ action: z.literal("REVOKE_AUTHORITY"), mandateId: id })
      .strict()
      .parse(raw);
    const owned = async () => {
      const [row] = await this.repo
        .sql`select revoked_at from mandates where id=${q.mandateId} and principal_id=${principal}`;
      const m = row ? await this.repo.getMandate(q.mandateId) : null;
      if (!row || !m || m.principalId !== principal)
        throw new Error("UNAVAILABLE");
      return row;
    };
    const row = await owned();
    await this.sessions.requirePrincipal(context);
    if (!row.revoked_at) {
      try {
        await this.repo.revokeMandate(q.mandateId, this.clock().toISOString());
      } catch {
        // Concurrent duplicate: accepted method appends evidence only for the winner.
        if (!(await owned()).revoked_at) throw new Error("UNAVAILABLE");
      }
    }
    // Acknowledgement never supplies browser state; clients must GET a fresh view.
    return { status: "REVOKE_RECORDED", mandateId: q.mandateId };
  }
}
