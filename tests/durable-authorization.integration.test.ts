import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mandateFingerprint } from "../src/canonical.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
import type {
  AgentPassport,
  Mandate,
  Principal,
  TransactionProposal,
} from "../src/domain.js";
import { PostgresTrustRepository } from "../src/persistence.js";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

run("Milestone 2B durable authorization", () => {
  let repo: PostgresTrustRepository;
  let service: DurableAuthorizationService;
  const now = "2026-10-09T12:00:00.000Z";
  const principal: Principal = { id: "p1", displayName: "Principal" };
  const agent: AgentPassport = {
    id: "a1",
    principalId: "p1",
    displayName: "Agent",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    status: "ACTIVE",
    capabilities: ["CREATE_ORDER"],
  };
  const baseMandate: Mandate = {
    id: "m1",
    principalId: "p1",
    authorizedAgentId: "a1",
    purpose: "keyboard",
    category: "KEYBOARD",
    currency: "USD",
    maxSingleTransactionMinor: 10000,
    cumulativeLimitMinor: 10000,
    allowedConditions: ["NEW"],
    merchantRiskCeiling: "MEDIUM",
    autonomousPurchaseThresholdMinor: 10000,
    humanApprovalThresholdMinor: 10000,
    allowedCapabilities: ["CREATE_ORDER"],
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    version: 1,
    nonce: "mandate-nonce-0001",
  };

  function proposal(
    id: string,
    amountMinor: number,
    nonce = `proposal-nonce-${id.padEnd(8, "0")}`,
    mandate = baseMandate,
  ): TransactionProposal {
    return {
      id,
      agentId: "a1",
      mandateId: mandate.id,
      mandateFingerprint: mandateFingerprint(mandate),
      amount: { currency: "USD", minor: amountMinor },
      merchant: { id: "shop", displayName: "Shop" },
      category: "KEYBOARD",
      condition: "NEW",
      requestedCapability: "CREATE_ORDER",
      proposedAt: now,
      nonce,
      metadata: {},
    };
  }

  async function saveProposal(p: TransactionProposal): Promise<void> {
    await repo.saveProposal(p);
  }

  beforeAll(async () => {
    repo = PostgresTrustRepository.connect(url!);
    await repo.sql`drop schema public cascade`;
    await repo.sql`create schema public`;
    await repo.migrate(
      await readFile(
        "db/migrations/001_milestone_2a_durable_foundation.sql",
        "utf8",
      ),
    );
  });

  afterAll(async () => repo.close());

  beforeEach(async () => {
    await repo.sql`truncate evidence_events,payment_attempts,authorization_reservations,approvals,decision_receipts,transaction_proposals,replay_keys,mandates,agent_passports,principals restart identity cascade`;
    await repo.savePrincipal(principal);
    await repo.saveAgent(agent);
    await repo.saveMandate(baseMandate);
    service = new DurableAuthorizationService(repo, 60_000);
  });

  it("durably ALLOWs and creates an active reservation", async () => {
    await saveProposal(proposal("allow", 7000));
    const result = await service.authorizeProposal("allow", "LOW", now);
    expect(result.receipt.decision).toBe("ALLOW");
    expect(result.reservation?.status).toBe("AUTHORIZED");
    expect(
      (await repo.authorityAccounting("m1", 10000)).activeReservedMinor,
    ).toBe(7000);
  });

  it("durably DENYs without creating a reservation", async () => {
    await saveProposal(proposal("deny", 10001));
    const result = await service.authorizeProposal("deny", "LOW", now);
    expect(result.receipt.decision).toBe("DENY");
    expect(result.reservation).toBeNull();
    expect(await repo.getReservationByProposal("deny")).toBeNull();
  });

  it("persists ESCALATE without executable authority until principal approval", async () => {
    const escalating = {
      ...baseMandate,
      id: "m2",
      autonomousPurchaseThresholdMinor: 7500,
      nonce: "mandate-nonce-0002",
    } satisfies Mandate;
    await repo.saveMandate(escalating);
    await saveProposal(
      proposal("escalate", 8000, "proposal-nonce-escalate", escalating),
    );
    const result = await service.authorizeProposal("escalate", "LOW", now);
    expect(result.receipt.decision).toBe("ESCALATE");
    expect(result.reservation).toBeNull();
    await expect(
      service.approveEscalation(result.receipt.receiptId, "wrong", now),
    ).rejects.toThrow("APPROVAL_PRINCIPAL_MISMATCH");
    const approved = await service.approveEscalation(
      result.receipt.receiptId,
      "p1",
      now,
    );
    expect(approved.approval.proposalId).toBe("escalate");
    expect(approved.reservation.status).toBe("AUTHORIZED");
    expect((await repo.getReceipt(result.receipt.receiptId))?.decision).toBe(
      "ESCALATE",
    );
  });

  it("rejects duplicate proposal IDs, nonces and repeated authorization", async () => {
    const first = proposal("dup", 1000, "proposal-nonce-duplicate");
    await saveProposal(first);
    await expect(saveProposal({ ...first, id: "dup2" })).rejects.toThrow();
    await service.authorizeProposal("dup", "LOW", now);
    await expect(service.authorizeProposal("dup", "LOW", now)).rejects.toThrow(
      "AUTHORIZATION_ALREADY_EVALUATED",
    );
  });

  it("enforces cumulative authority using active reservations", async () => {
    await saveProposal(proposal("a", 6000));
    await saveProposal(proposal("b", 5000));
    expect(
      (await service.authorizeProposal("a", "LOW", now)).receipt.decision,
    ).toBe("ALLOW");
    expect(
      (await service.authorizeProposal("b", "LOW", now)).receipt.decision,
    ).toBe("DENY");
  });

  it("releases capacity for RELEASED, EXPIRED and FAILED but not COMMITTED", async () => {
    for (const [id, terminal] of [
      ["released", "RELEASED"],
      ["expired", "EXPIRED"],
      ["failed", "FAILED"],
    ] as const) {
      await saveProposal(proposal(id, 7000));
      const result = await service.authorizeProposal(id, "LOW", now);
      await service.transitionReservation(
        result.reservation!.id,
        terminal,
        now,
      );
      expect((await repo.authorityAccounting("m1", 10000)).consumedMinor).toBe(
        0,
      );
    }
    await saveProposal(proposal("committed", 7000));
    const committed = await service.authorizeProposal("committed", "LOW", now);
    await service.transitionReservation(
      committed.reservation!.id,
      "EXECUTING",
      now,
    );
    await service.transitionReservation(
      committed.reservation!.id,
      "COMMITTED",
      now,
    );
    const accounting = await repo.authorityAccounting("m1", 10000);
    expect(accounting.committedMinor).toBe(7000);
    expect(accounting.activeReservedMinor).toBe(0);
    expect(accounting.availableMinor).toBe(3000);
  });

  it("rejects illegal reservation transitions", async () => {
    await saveProposal(proposal("state", 1000));
    const result = await service.authorizeProposal("state", "LOW", now);
    await service
      .transitionReservation(result.reservation!.id, "COMMITTED", now)
      .then(
        () => {
          throw new Error("unexpected transition success");
        },
        (error: unknown) =>
          expect(String(error)).toContain("INVALID_RESERVATION_TRANSITION"),
      );
  });

  it("fails closed on malformed persisted receipts and reservations", async () => {
    await saveProposal(proposal("malformed", 1000));
    const result = await service.authorizeProposal("malformed", "LOW", now);
    await repo.sql`update decision_receipts set document=jsonb_set(document,'{decision}','\"BOGUS\"'::jsonb) where id=${result.receipt.receiptId}`;
    await expect(repo.getReceipt(result.receipt.receiptId)).rejects.toThrow();
    await repo.sql`update authorization_reservations set expires_at='infinity' where id=${result.reservation!.id}`;
    await expect(repo.getReservationByProposal("malformed")).rejects.toThrow();
  });

  it("serializes real concurrent $80 + $80 attempts against $100 authority", async () => {
    await saveProposal(proposal("race-a", 8000));
    await saveProposal(proposal("race-b", 8000));
    const settled = await Promise.allSettled([
      service.authorizeProposal("race-a", "LOW", now),
      service.authorizeProposal("race-b", "LOW", now),
    ]);
    const results = settled
      .filter(
        (
          x,
        ): x is PromiseFulfilledResult<
          Awaited<ReturnType<DurableAuthorizationService["authorizeProposal"]>>
        > => x.status === "fulfilled",
      )
      .map((x) => x.value);
    expect(results.filter((x) => x.receipt.decision === "ALLOW")).toHaveLength(
      1,
    );
    expect(results.filter((x) => x.receipt.decision === "DENY")).toHaveLength(
      1,
    );
    const accounting = await repo.authorityAccounting("m1", 10000);
    expect(accounting.consumedMinor).toBe(8000);
    const reservations =
      await repo.sql`select count(*)::int count from authorization_reservations`;
    expect(Number(reservations[0]?.count)).toBe(1);
  });

  it("prevents concurrent duplicate authorization from double-authorizing", async () => {
    await saveProposal(proposal("same", 4000));
    const settled = await Promise.allSettled([
      service.authorizeProposal("same", "LOW", now),
      service.authorizeProposal("same", "LOW", now),
    ]);
    expect(settled.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await repo.authorityAccounting("m1", 10000)).consumedMinor).toBe(
      4000,
    );
  });

  it("preserves authoritative state across service/repository recreation", async () => {
    await saveProposal(proposal("restart", 4000));
    await service.authorizeProposal("restart", "LOW", now);
    const second = PostgresTrustRepository.connect(url!);
    const recreated = new DurableAuthorizationService(second);
    expect((await second.authorityAccounting("m1", 10000)).consumedMinor).toBe(
      4000,
    );
    await expect(
      recreated.authorizeProposal("restart", "LOW", now),
    ).rejects.toThrow("AUTHORIZATION_ALREADY_EVALUATED");
    await second.close();
  });

  it("rolls back receipt, replay, reservation and evidence when reservation persistence fails", async () => {
    await saveProposal(proposal("rollback", 3000));
    await repo.sql.unsafe(
      `create function reject_rollback_reservation() returns trigger language plpgsql as $$ begin if NEW.proposal_id='rollback' then raise exception 'forced rollback'; end if; return NEW; end $$; create trigger reject_rollback before insert on authorization_reservations for each row execute function reject_rollback_reservation();`,
    );
    const before = (await repo.evidence()).length;
    await expect(
      service.authorizeProposal("rollback", "LOW", now),
    ).rejects.toThrow();
    expect(await repo.getReservationByProposal("rollback")).toBeNull();
    expect(
      (
        await repo.sql`select count(*)::int count from decision_receipts where proposal_id='rollback'`
      )[0]?.count,
    ).toBe(0);
    expect(
      (
        await repo.sql`select count(*)::int count from replay_keys where replay_key in ('rollback','proposal-nonce-rollback')`
      )[0]?.count,
    ).toBe(0);
    expect((await repo.evidence()).length).toBe(before);
    await repo.sql`drop trigger reject_rollback on authorization_reservations; drop function reject_rollback_reservation()`;
  });

  it("expires stale reservations idempotently and restores capacity", async () => {
    await saveProposal(proposal("stale", 7000));
    await service.authorizeProposal("stale", "LOW", now);
    expect(
      await service.expireStaleReservations("2026-10-09T12:02:00.000Z"),
    ).toBe(1);
    expect(
      await service.expireStaleReservations("2026-10-09T12:02:00.000Z"),
    ).toBe(0);
    expect((await repo.authorityAccounting("m1", 10000)).availableMinor).toBe(
      10000,
    );
  });
});
