import type { PublicKeyResolver } from "../execution-grant.js";
import { OperationTraceService } from "../operation-trace.js";
import type { PostgresTrustRepository } from "../persistence.js";
import { requireAgentAccess, type ExternalAgentAccess } from "./access.js";
import { GATEWAY_AUDIENCE } from "./gateway.js";

/**
 * Reuses the existing Proof architecture (OperationTraceService: a read-only REPEATABLE READ
 * projection verified from durable records). This adds only the access check: the credential's
 * agent and principal must own the operation's Authority. Anything else is indistinguishable
 * from absence.
 */
export class ProofReader {
  private readonly trace: OperationTraceService;
  constructor(
    private readonly repo: PostgresTrustRepository,
    keys: PublicKeyResolver,
  ) {
    this.trace = new OperationTraceService(repo, keys);
  }

  async read(rawAccess: unknown, proposalId: string, now: string) {
    const access: ExternalAgentAccess = requireAgentAccess(
      rawAccess,
      "proof:read",
      now,
      GATEWAY_AUDIENCE,
    );
    const rows = await this.repo.sql`
      select m.authorized_agent_id, m.principal_id
      from transaction_proposals p join mandates m on m.id = p.mandate_id
      where p.id = ${proposalId}`;
    const row = rows[0];
    if (
      !row ||
      row.authorized_agent_id !== access.agentId ||
      row.principal_id !== access.principalId
    )
      return null;
    return this.trace.project({ proposalId }, now);
  }
}
