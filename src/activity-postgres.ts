import { z } from "zod";
import { OperationTraceService } from "./operation-trace.js";
import { activityItem, type ActivityItem } from "./activity-projection.js";
import type { PublicKeyResolver } from "./execution-grant.js";
import { persistedDate, type PostgresTrustRepository } from "./persistence.js";
import type { ConsoleRequest, ConsoleSessionPort } from "./console-session.js";
/** Bounded, owner-scoped read adapter. No provider or execution capability. */
export class ConsoleActivity {
  readonly #trace: OperationTraceService;
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly sessions: ConsoleSessionPort,
    keys: PublicKeyResolver,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.#trace = new OperationTraceService(repo, keys);
  }
  async read(req: ConsoleRequest, raw: unknown) {
    const q = z
      .object({ operationId: z.string().min(1).max(128).optional() })
      .strict()
      .parse(raw);
    const context = await this.sessions.read(req),
      principal = await this.sessions.requirePrincipal(context);
    const rows = q.operationId
      ? await this.repo
          .sql`select p.id,p.mandate_id,p.agent_id,p.proposed_at from transaction_proposals p join mandates m on m.id=p.mandate_id where m.principal_id=${principal} and p.id=${q.operationId} limit 1`
      : await this.repo
          .sql`select p.id,p.mandate_id,p.agent_id,p.proposed_at from transaction_proposals p join mandates m on m.id=p.mandate_id where m.principal_id=${principal} order by p.proposed_at desc,p.id desc limit 20`;
    if (q.operationId && !rows.length) throw new Error("UNAVAILABLE");
    const items: ActivityItem[] = [];
    for (const row of rows) {
      const operationId = String(row.id),
        now = this.clock().toISOString();
      const t = await this.#trace.project({ proposalId: operationId }, now);
      // Trace independently resolves its own snapshot. Bind both snapshots before disclosure.
      if (
        t.references.principalId !== principal ||
        t.references.mandateId !== row.mandate_id ||
        t.references.agentId !== row.agent_id
      )
        throw new Error("UNAVAILABLE");
      const agent = await this.repo.getAgent(
        String(row.agent_id),
        undefined,
        false,
      );
      if (!agent || agent.principalId !== principal)
        throw new Error("UNAVAILABLE");
      const receipt = t.references.receiptId
        ? await this.repo.getReceipt(t.references.receiptId)
        : null;
      if (
        receipt &&
        (receipt.proposalId !== operationId ||
          receipt.mandateId !== row.mandate_id ||
          receipt.agentId !== row.agent_id)
      )
        throw new Error("UNAVAILABLE");
      items.push(
        activityItem(t, {
          operationId,
          mandateId: String(row.mandate_id),
          agentId: agent.id,
          agentName: agent.displayName,
          occurredAt: persistedDate(row.proposed_at).toISOString(),
          observedAt: now,
          decision: receipt?.decision ?? null,
          reasonCodes: receipt?.reasonCodes ?? [],
        }),
      );
    }
    await this.sessions.requirePrincipal(context);
    return { version: "payflow.activity.v1", items, limit: 20 };
  }
}
