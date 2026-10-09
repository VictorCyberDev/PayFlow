import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mandateFingerprint } from "../src/canonical.js";
import { DurableAuthorizationService } from "../src/durable-service.js";
import {
  ExecutionBoundary,
  StaticPublicKeyRing,
  ExecutionGrantIssuer,
  type ExecutionGrantClaims,
} from "../src/execution-grant.js";
import type {
  AgentPassport,
  Mandate,
  Principal,
  TransactionProposal,
} from "../src/domain.js";
import {
  PayPalExecutionRail,
  PayPalProviderError,
  type PaymentProvider,
  type PayPalOrderView,
} from "../src/paypal.js";
import { ExecutionQuarantinedError } from "../src/execution-outcome.js";
import { PostgresTrustRepository } from "../src/persistence.js";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
class LostResponseProvider implements PaymentProvider {
  createCalls = 0;
  captureCalls = 0;
  order: PayPalOrderView | undefined;
  async createOrder(): Promise<PayPalOrderView> {
    await Promise.resolve();
    this.createCalls++;
    this.order = {
      id: "PAYPAL-ORDER-1",
      status: "APPROVED",
      purchaseUnits: [
        { referenceId: "proposal-2d", amountValue: "89.00", currency: "USD" },
      ],
      captures: [],
    };
    return this.order;
  }
  async captureOrder(): Promise<PayPalOrderView> {
    await Promise.resolve();
    this.captureCalls++;
    this.order = {
      id: "PAYPAL-ORDER-1",
      status: "COMPLETED",
      purchaseUnits: [
        { referenceId: "proposal-2d", amountValue: "89.00", currency: "USD" },
      ],
      captures: [
        {
          id: "CAPTURE-1",
          status: "COMPLETED",
          amountValue: "89.00",
          currency: "USD",
        },
      ],
    };
    throw new PayPalProviderError("AMBIGUOUS", "SIMULATED_RESPONSE_LOSS");
  }
  async getOrder(): Promise<PayPalOrderView> {
    await Promise.resolve();
    if (!this.order) throw new Error("ORDER_NOT_FOUND");
    return this.order;
  }
}

class RecoveryProvider implements PaymentProvider {
  createIds: string[] = [];
  captureIds: string[] = [];
  calls: string[] = [];
  logicalOrders = 0;
  financialSideEffects = 0;
  createLosses = 0;
  captureLosses = 1;
  captureDespiteLoss = true;
  order: PayPalOrderView | undefined;
  afterGet?: () => Promise<void>;
  captureResult?: (order: PayPalOrderView) => PayPalOrderView;
  checkNetworkBoundary?: () => Promise<void>;
  afterCreate?: () => Promise<void>;
  afterCapture?: () => Promise<void>;
  readonly capturedByKey = new Map<string, PayPalOrderView>();
  async createOrder(
    input: Parameters<PaymentProvider["createOrder"]>[0],
  ): Promise<PayPalOrderView> {
    await this.checkNetworkBoundary?.();
    this.calls.push("CREATE");
    const newKey = !this.createIds.includes(input.requestId);
    this.createIds.push(input.requestId);
    if (newKey) {
      this.logicalOrders++;
      this.order = {
        id:
          this.logicalOrders === 1
            ? "RECOVERED-ORDER"
            : `RECOVERED-ORDER-${this.logicalOrders}`,
        status: "APPROVED",
        purchaseUnits: [
          {
            referenceId: input.merchantReference,
            amountValue: input.amountValue,
            currency: input.currency,
          },
        ],
        captures: [],
      };
    }
    await this.afterCreate?.();
    if (this.createLosses-- > 0)
      throw new PayPalProviderError("AMBIGUOUS", "CREATE_RESPONSE_LOST");
    if (!this.order) throw new Error("ORDER_NOT_FOUND");
    return this.order;
  }
  async getOrder(id: string): Promise<PayPalOrderView> {
    await this.checkNetworkBoundary?.();
    this.calls.push("GET");
    if (!this.order || this.order.id !== id) throw new Error("ORDER_NOT_FOUND");
    await this.afterGet?.();
    return this.order;
  }
  async captureOrder(id: string, requestId: string): Promise<PayPalOrderView> {
    await this.checkNetworkBoundary?.();
    this.calls.push("CAPTURE");
    this.captureIds.push(requestId);
    const prior = this.capturedByKey.get(requestId);
    if (prior) return prior;
    if (!this.order || this.order.id !== id) throw new Error("ORDER_NOT_FOUND");
    const lost = this.captureLosses-- > 0;
    if ((!lost || this.captureDespiteLoss) && !this.order.captures.length) {
      this.financialSideEffects++;
      this.order = {
        ...this.order,
        status: "COMPLETED",
        captures: [
          {
            id: "RECOVERED-CAPTURE",
            status: "COMPLETED",
            amountValue: "89.00",
            currency: "USD",
          },
        ],
      };
    }
    if (this.order.captures.length)
      this.capturedByKey.set(requestId, this.order);
    await this.afterCapture?.();
    if (lost)
      throw new PayPalProviderError("AMBIGUOUS", "CAPTURE_RESPONSE_LOST");
    return this.captureResult ? this.captureResult(this.order) : this.order;
  }
}

run("Milestone 2D durable PayPal execution", () => {
  let repo: PostgresTrustRepository;
  let auth: DurableAuthorizationService;
  let issuer: ExecutionGrantIssuer;
  const now = "2026-10-09T12:00:00.000Z";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const principal: Principal = { id: "p2d", displayName: "Principal" };
  const agent: AgentPassport = {
    id: "a2d",
    principalId: principal.id,
    displayName: "Agent",
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-11-01T00:00:00.000Z",
    status: "ACTIVE",
    capabilities: ["CREATE_ORDER"],
  };
  const mandate: Mandate = {
    id: "m2d",
    principalId: principal.id,
    authorizedAgentId: agent.id,
    purpose: "Keyboard",
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
    nonce: "mandate-2d-nonce",
  };
  const proposal: TransactionProposal = {
    id: "proposal-2d",
    agentId: agent.id,
    mandateId: mandate.id,
    mandateFingerprint: mandateFingerprint(mandate),
    amount: { currency: "USD", minor: 8900 },
    merchant: { id: "merchant-2d", displayName: "Merchant" },
    category: "KEYBOARD",
    condition: "NEW",
    requestedCapability: "CREATE_ORDER",
    proposedAt: now,
    nonce: "proposal-2d-nonce",
    metadata: { sku: "keyboard" },
  };
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
    await repo.migrate(
      await readFile(
        "db/migrations/002_milestone_2c_execution_grants.sql",
        "utf8",
      ),
    );
    await repo.migrate(
      await readFile(
        "db/migrations/003_milestone_2d_paypal_execution.sql",
        "utf8",
      ),
    );
    await repo.migrate(
      await readFile(
        "db/migrations/004_milestone_2e_security_boundary.sql",
        "utf8",
      ),
    );
  });
  afterAll(async () => repo.close());
  beforeEach(async () => {
    await repo.sql`truncate execution_grants,evidence_events,payment_attempts,authorization_reservations,approvals,decision_receipts,transaction_proposals,replay_keys,mandates,agent_passports,principals restart identity cascade`;
    await repo.savePrincipal(principal);
    await repo.saveAgent(agent);
    await repo.saveMandate(mandate);
    auth = new DurableAuthorizationService(repo, 15 * 60_000);
    issuer = new ExecutionGrantIssuer(repo, "2d-key", privateKey);
  });
  async function claimed(): Promise<{
    claims: ExecutionGrantClaims;
    reservationId: string;
  }> {
    await repo.saveProposal(proposal);
    const decision = await auth.authorizeProposal(proposal.id, "LOW", now);
    const reservationId = decision.reservation!.id;
    const token = await issuer.issue(reservationId, now);
    const claims = JSON.parse(
      Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
    ) as ExecutionGrantClaims;
    const crashBoundary = new ExecutionBoundary(
      repo,
      new StaticPublicKeyRing(new Map([["2d-key", publicKey]])),
      {
        execute: () =>
          Promise.reject(
            new ExecutionQuarantinedError("SIMULATED_CRASH_BEFORE_PROVIDER"),
          ),
      },
    );
    await expect(crashBoundary.execute(token, now)).rejects.toThrow(
      "SIMULATED_CRASH_BEFORE_PROVIDER",
    );
    return { claims, reservationId };
  }

  it("quarantines unknown capture and restart reconciliation discovers the existing capture exactly once", async () => {
    const { claims, reservationId } = await claimed();
    const provider = new LostResponseProvider();
    const rail = new PayPalExecutionRail(repo, provider, () => now);
    await expect(rail.execute(claims)).rejects.toThrow(
      "PAYPAL_CAPTURE_UNKNOWN",
    );
    const attempts = await repo.sql`select * from payment_attempts`;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("CAPTURE_UNKNOWN");
    expect(provider.createCalls).toBe(1);
    expect(provider.captureCalls).toBe(1);
    const restarted = PostgresTrustRepository.connect(url!);
    const recovered = new PayPalExecutionRail(restarted, provider);
    expect(
      await recovered.reconcile(
        String(attempts[0]!.id),
        "2026-10-09T12:01:00.000Z",
      ),
    ).toBe("CAPTURED");
    expect(provider.captureCalls).toBe(1);
    const finalAttempt =
      await restarted.sql`select status,provider_capture_id from payment_attempts`;
    expect(finalAttempt[0]!.status).toBe("CAPTURED");
    expect(finalAttempt[0]!.provider_capture_id).toBe("CAPTURE-1");
    const reservation =
      await restarted.sql`select status from authorization_reservations where id=${reservationId}`;
    const grant =
      await restarted.sql`select status from execution_grants where id=${claims.jti}`;
    expect(reservation[0]!.status).toBe("COMMITTED");
    expect(grant[0]!.status).toBe("CONSUMED");
    await restarted.close();
  });

  it("concurrent duplicate rail invocation creates one logical attempt", async () => {
    const { claims } = await claimed();
    const provider = new LostResponseProvider();
    const rail = new PayPalExecutionRail(repo, provider, () => now);
    await Promise.allSettled([rail.execute(claims), rail.execute(claims)]);
    const attempts = await repo.sql`select id from payment_attempts`;
    expect(attempts).toHaveLength(1);
  });
  const recoveryTime = "2026-10-09T12:01:00.000Z";
  async function unknown(provider: RecoveryProvider): Promise<{
    id: string;
    claims: ExecutionGrantClaims;
    reservationId: string;
  }> {
    const { claims, reservationId } = await claimed();
    await expect(
      new PayPalExecutionRail(repo, provider, () => now).execute(claims),
    ).rejects.toThrow("UNKNOWN");
    const rows = await repo.sql`select * from payment_attempts`;
    expect(rows).toHaveLength(1);
    const id = String(rows[0]!.id);
    // Fixed fixture clock, including the original retry-window origin.
    await repo.sql`update payment_attempts set created_at=${now} where id=${id}`;
    return { id, claims, reservationId };
  }
  async function quarantined(id: string, status: string): Promise<void> {
    const rows =
      await repo.sql`select a.status, g.status grant_status, r.status reservation_status
      from payment_attempts a join execution_grants g on g.id=a.grant_id
      join authorization_reservations r on r.id=a.reservation_id where a.id=${id}`;
    expect(rows[0]).toMatchObject({
      status,
      grant_status: "CLAIMED",
      reservation_status: "EXECUTING",
    });
    expect(
      (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
    ).toHaveLength(0);
    expect(
      (await repo.authorityAccounting(mandate.id, mandate.cumulativeLimitMinor))
        .activeReservedMinor,
    ).toBe(8900);
  }
  async function restartRecovery(
    provider: RecoveryProvider,
    id: string,
  ): Promise<string> {
    const restarted = PostgresTrustRepository.connect(url!);
    try {
      return await new PayPalExecutionRail(restarted, provider).reconcile(
        id,
        recoveryTime,
      );
    } finally {
      await restarted.close();
    }
  }

  it("recovers a lost create response after restart using the identical persisted key and one logical order", async () => {
    const provider = new RecoveryProvider();
    provider.createLosses = 1;
    provider.captureLosses = 0;
    const { id } = await unknown(provider);
    await quarantined(id, "ORDER_CREATE_UNKNOWN");
    const before =
      await repo.sql`select create_order_request_id from payment_attempts where id=${id}`;
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    const after = await repo.sql`select * from payment_attempts where id=${id}`;
    expect(provider.createIds).toEqual([
      before[0]!.create_order_request_id,
      before[0]!.create_order_request_id,
    ]);
    expect(after[0]!.create_order_request_id).toBe(
      before[0]!.create_order_request_id,
    );
    expect(after[0]!.provider_order_id).toBe("RECOVERED-ORDER");
    expect(provider.logicalOrders).toBe(1);
    expect(provider.financialSideEffects).toBe(1);
    expect(await repo.sql`select id from payment_attempts`).toHaveLength(1);
  });

  it("repeated create ambiguity keeps the same key and quarantines authority", async () => {
    const provider = new RecoveryProvider();
    provider.createLosses = 3;
    const { id } = await unknown(provider);
    expect(await restartRecovery(provider, id)).toBe("ORDER_CREATE_UNKNOWN");
    expect(await restartRecovery(provider, id)).toBe("ORDER_CREATE_UNKNOWN");
    expect(new Set(provider.createIds).size).toBe(1);
    expect(provider.logicalOrders).toBe(1);
    expect(provider.captureIds).toHaveLength(0);
    await quarantined(id, "ORDER_CREATE_UNKNOWN");
  });

  it("recovered create requiring payer action persists the original order without capturing", async () => {
    const provider = new RecoveryProvider();
    provider.createLosses = 1;
    const { id } = await unknown(provider);
    provider.order = {
      ...provider.order!,
      status: "CREATED",
      payerActionUrl:
        "https://www.sandbox.paypal.com/checkoutnow?token=RECOVERED-ORDER",
    };
    expect(await restartRecovery(provider, id)).toBe("PAYER_ACTION_REQUIRED");
    expect(provider.captureIds).toHaveLength(0);
    expect(provider.logicalOrders).toBe(1);
    const rows =
      await repo.sql`select provider_order_id,payer_action_url from payment_attempts where id=${id}`;
    expect(rows[0]!.provider_order_id).toBe("RECOVERED-ORDER");
    expect(rows[0]!.payer_action_url).toBe(provider.order.payerActionUrl);
    await quarantined(id, "PAYER_ACTION_REQUIRED");
  });

  it("provider DID capture: restart GET discovers capture, never recaptures, side-effect count is exactly 1", async () => {
    const provider = new RecoveryProvider();
    const { id } = await unknown(provider);
    await quarantined(id, "CAPTURE_UNKNOWN");
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    expect(provider.calls).toEqual(["CREATE", "GET", "CAPTURE", "GET"]);
    expect(provider.captureIds).toHaveLength(1);
    expect(provider.financialSideEffects).toBe(1);
  });

  it("provider DID NOT capture: GET proves APPROVED with no capture, retry uses identical persisted key", async () => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    const { id } = await unknown(provider);
    expect(provider.financialSideEffects).toBe(0);
    const before =
      await repo.sql`select capture_request_id from payment_attempts where id=${id}`;
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    expect(provider.calls).toEqual([
      "CREATE",
      "GET",
      "CAPTURE",
      "GET",
      "CAPTURE",
    ]);
    expect(provider.captureIds).toEqual([
      before[0]!.capture_request_id,
      before[0]!.capture_request_id,
    ]);
    const after =
      await repo.sql`select capture_request_id from payment_attempts where id=${id}`;
    expect(after[0]!.capture_request_id).toBe(before[0]!.capture_request_id);
    expect(provider.financialSideEffects).toBe(1);
  });

  it("repeated ambiguous capture retries remain quarantined with no false success", async () => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    provider.captureLosses = 3;
    const { id } = await unknown(provider);
    expect(await restartRecovery(provider, id)).toBe("CAPTURE_UNKNOWN");
    expect(await restartRecovery(provider, id)).toBe("CAPTURE_UNKNOWN");
    expect(provider.calls).toEqual([
      "CREATE",
      "GET",
      "CAPTURE",
      "GET",
      "CAPTURE",
      "GET",
      "CAPTURE",
    ]);
    expect(new Set(provider.captureIds).size).toBe(1);
    expect(provider.financialSideEffects).toBe(0);
    await quarantined(id, "CAPTURE_UNKNOWN");
  });

  it.each(["CREATED", "COMPLETED", "PAYER_ACTION_REQUIRED"])(
    "does not retry an empty capture in unsafe order state %s",
    async (status) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      provider.order = { ...provider.order!, status };
      expect(await restartRecovery(provider, id)).toBe("CAPTURE_UNKNOWN");
      expect(provider.captureIds).toHaveLength(1);
      await quarantined(id, "CAPTURE_UNKNOWN");
    },
  );

  it("failed GET never retries capture and remains quarantined", async () => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    const { id } = await unknown(provider);
    provider.afterGet = () =>
      Promise.reject(new PayPalProviderError("TRANSIENT", "GET_FAILED"));
    expect(await restartRecovery(provider, id)).toBe("CAPTURE_UNKNOWN");
    expect(provider.captureIds).toHaveLength(1);
    await quarantined(id, "CAPTURE_UNKNOWN");
  });

  it.each(["order", "reference", "amount", "currency", "capture", "multiple"])(
    "rejects substituted %s before committing or retrying",
    async (binding) => {
      const provider = new RecoveryProvider();
      const { id } = await unknown(provider);
      const order = provider.order!;
      if (binding === "order") provider.order = { ...order, id: "OTHER-ORDER" };
      if (binding === "reference")
        provider.order = {
          ...order,
          purchaseUnits: [
            {
              referenceId: "OTHER-PROPOSAL",
              amountValue: "89.00",
              currency: "USD",
            },
          ],
        };
      if (binding === "amount")
        provider.order = {
          ...order,
          purchaseUnits: [
            { referenceId: proposal.id, amountValue: "90.00", currency: "USD" },
          ],
        };
      if (binding === "currency")
        provider.order = {
          ...order,
          purchaseUnits: [
            { referenceId: proposal.id, amountValue: "89.00", currency: "EUR" },
          ],
        };
      if (binding === "capture")
        provider.order = {
          ...order,
          captures: [{ ...order.captures[0]!, amountValue: "90.00" }],
        };
      if (binding === "multiple")
        provider.order = {
          ...order,
          captures: [
            ...order.captures,
            { ...order.captures[0]!, id: "OTHER-CAPTURE" },
          ],
        };
      if (binding === "order") {
        // Return a substituted ID rather than a lookup error.
        provider.getOrder = () => Promise.resolve(provider.order!);
      }
      await expect(restartRecovery(provider, id)).rejects.toThrow("MISMATCH");
      expect(provider.captureIds).toHaveLength(1);
      await quarantined(id, "CAPTURE_UNKNOWN");
    },
  );

  it.each([
    "grant state",
    "reservation state",
    "grant binding",
    "reservation binding",
  ])(
    "rolls back finalization for wrong %s even when corrupted after GET",
    async (corruption) => {
      const provider = new RecoveryProvider();
      const { id, claims, reservationId } = await unknown(provider);
      provider.afterGet = async () => {
        if (corruption === "grant state")
          await repo.sql`update execution_grants set status='ISSUED' where id=${claims.jti}`;
        if (corruption === "reservation state")
          await repo.sql`update authorization_reservations set status='AUTHORIZED' where id=${reservationId}`;
        if (corruption === "grant binding")
          await repo.sql`update execution_grants set merchant_id='OTHER-MERCHANT' where id=${claims.jti}`;
        if (corruption === "reservation binding")
          await repo.sql`update authorization_reservations set amount_minor=8901 where id=${reservationId}`;
      };
      await expect(restartRecovery(provider, id)).rejects.toThrow(
        corruption.includes("state")
          ? "FINALIZATION_STATE_INVALID"
          : "AUTHORITY_BINDING_MISMATCH",
      );
      const rows =
        await repo.sql`select status,provider_capture_id from payment_attempts where id=${id}`;
      expect(rows[0]).toMatchObject({
        status: "CAPTURE_UNKNOWN",
        provider_capture_id: null,
      });
      const grants =
        await repo.sql`select status from execution_grants where id=${claims.jti}`;
      const reservations =
        await repo.sql`select status from authorization_reservations where id=${reservationId}`;
      expect(grants[0]!.status).toBe(
        corruption === "grant state" ? "ISSUED" : "CLAIMED",
      );
      expect(reservations[0]!.status).toBe(
        corruption === "reservation state" ? "AUTHORIZED" : "EXECUTING",
      );
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(0);
      expect(provider.financialSideEffects).toBe(1);
      expect(provider.captureIds).toHaveLength(1);
    },
  );

  it("verifies affected grant rows and rolls the entire transaction back on a suppressed transition", async () => {
    const provider = new RecoveryProvider();
    const { id } = await unknown(provider);
    await repo.sql.unsafe(
      "create function suppress_grant_transition() returns trigger language plpgsql as $$ begin return null; end $$",
    );
    await repo.sql.unsafe(
      "create trigger suppress_grant before update on execution_grants for each row execute function suppress_grant_transition()",
    );
    try {
      await expect(restartRecovery(provider, id)).rejects.toThrow(
        "PAYMENT_FINALIZATION_STATE_INVALID",
      );
      await quarantined(id, "CAPTURE_UNKNOWN");
      const rows =
        await repo.sql`select provider_capture_id from payment_attempts where id=${id}`;
      expect(rows[0]!.provider_capture_id).toBeNull();
    } finally {
      await repo.sql.unsafe("drop trigger suppress_grant on execution_grants");
      await repo.sql.unsafe("drop function suppress_grant_transition()");
    }
  });

  it.each([true, false])(
    "serializes concurrent restart reconciliation (provider captured=%s) and finalizes once",
    async (captured) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = captured;
      const { id, claims, reservationId } = await unknown(provider);
      const results = await Promise.all([
        restartRecovery(provider, id),
        restartRecovery(provider, id),
      ]);
      expect(results).toEqual(["CAPTURED", "CAPTURED"]);
      expect(provider.financialSideEffects).toBe(1);
      expect(provider.captureIds).toHaveLength(captured ? 1 : 2);
      expect(new Set(provider.captureIds).size).toBe(1);
      const events = await repo.evidence();
      expect(events.filter((e) => e.type === "PAYMENT_COMMITTED")).toHaveLength(
        1,
      );
      expect(
        events.filter((e) => e.type === "PAYPAL_RECONCILIATION_RESOLVED"),
      ).toHaveLength(1);
      expect(
        (
          await repo.sql`select status from execution_grants where id=${claims.jti}`
        )[0]!.status,
      ).toBe("CONSUMED");
      expect(
        (
          await repo.sql`select status from authorization_reservations where id=${reservationId}`
        )[0]!.status,
      ).toBe("COMMITTED");
      expect(
        (await repo.sql`select status from payment_attempts where id=${id}`)[0]!
          .status,
      ).toBe("CAPTURED");
    },
  );

  it("holds no PostgreSQL transaction during recovery provider requests", async () => {
    const provider = new RecoveryProvider();
    provider.createLosses = 1;
    provider.captureLosses = 0;
    const { id } = await unknown(provider);
    provider.checkNetworkBoundary = async () => {
      const rows =
        await repo.sql`select pid from pg_stat_activity where datname=current_database() and state='idle in transaction'`;
      expect(rows).toHaveLength(0);
    };
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    expect(provider.calls).toEqual(["CREATE", "CREATE", "GET", "CAPTURE"]);
  });

  it.each(["create", "capture"])(
    "does not retry %s beyond the conservative provider idempotency window",
    async (operation) => {
      const provider = new RecoveryProvider();
      provider.createLosses = operation === "create" ? 1 : 0;
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      expect(
        await new PayPalExecutionRail(repo, provider, () => now).reconcile(
          id,
          "2026-10-09T18:00:00.000Z",
        ),
      ).toBe(
        operation === "create" ? "ORDER_CREATE_UNKNOWN" : "CAPTURE_UNKNOWN",
      );
      expect(provider.createIds).toHaveLength(1);
      expect(provider.captureIds).toHaveLength(operation === "create" ? 0 : 1);
      await quarantined(
        id,
        operation === "create" ? "ORDER_CREATE_UNKNOWN" : "CAPTURE_UNKNOWN",
      );
    },
  );
  it.each(["order", "reference", "amount", "currency", "order status"])(
    "strictly revalidates %s after safe capture retry",
    async (binding) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      provider.captureResult = (order) => {
        if (binding === "order") return { ...order, id: "OTHER-ORDER" };
        if (binding === "reference")
          return {
            ...order,
            purchaseUnits: [{ referenceId: "OTHER-PROPOSAL" }],
          };
        if (binding === "amount")
          return {
            ...order,
            captures: [{ ...order.captures[0]!, amountValue: "90.00" }],
          };
        if (binding === "currency")
          return {
            ...order,
            captures: [{ ...order.captures[0]!, currency: "EUR" }],
          };
        return { ...order, status: "APPROVED" };
      };
      await expect(restartRecovery(provider, id)).rejects.toThrow("MISMATCH");
      expect(provider.calls).toEqual([
        "CREATE",
        "GET",
        "CAPTURE",
        "GET",
        "CAPTURE",
      ]);
      expect(provider.captureIds[1]).toBe(provider.captureIds[0]);
      expect(provider.financialSideEffects).toBe(1);
      await quarantined(id, "CAPTURE_UNKNOWN");
    },
  );

  it.each(["PENDING", "UNRECOGNIZED"])(
    "does not report success for capture retry status %s",
    async (status) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      provider.captureResult = (order) => ({
        ...order,
        captures: [{ ...order.captures[0]!, status }],
      });
      const expected =
        status === "PENDING" ? "CAPTURE_PENDING_PROVIDER" : "CAPTURE_UNKNOWN";
      expect(await restartRecovery(provider, id)).toBe(expected);
      expect(provider.captureIds[1]).toBe(provider.captureIds[0]);
      await quarantined(id, expected);
    },
  );
  it.each(["unavailable", "missing", "substituted"])(
    "does not falsely report successful repeated reconciliation when finalized provider capture is %s",
    async (problem) => {
      const provider = new RecoveryProvider();
      const { id } = await unknown(provider);
      expect(await restartRecovery(provider, id)).toBe("CAPTURED");
      if (problem === "unavailable")
        provider.afterGet = () => Promise.reject(new Error("GET_FAILED"));
      if (problem === "missing")
        provider.order = { ...provider.order!, captures: [] };
      if (problem === "substituted")
        provider.order = {
          ...provider.order!,
          captures: [{ ...provider.order!.captures[0]!, id: "OTHER-CAPTURE" }],
        };
      await expect(restartRecovery(provider, id)).rejects.toThrow(
        problem === "unavailable" ? "UNVERIFIED" : "MISMATCH",
      );
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(1);
      expect(provider.financialSideEffects).toBe(1);
      expect(provider.captureIds).toHaveLength(1);
    },
  );

  async function issued(): Promise<string> {
    await repo.saveProposal(proposal);
    const result = await auth.authorizeProposal(proposal.id, "LOW", now);
    return issuer.issue(result.reservation!.id, now);
  }
  function boundary(
    provider: RecoveryProvider,
    repository = repo,
  ): ExecutionBoundary {
    return new ExecutionBoundary(
      repository,
      new StaticPublicKeyRing(new Map([["2d-key", publicKey]])),
      new PayPalExecutionRail(repository, provider, () => now),
    );
  }
  async function states(): Promise<void> {
    const rows =
      await repo.sql`select g.status grant_status,r.status reservation_status from execution_grants g join authorization_reservations r on r.id=g.reservation_id`;
    expect(rows[0]).toMatchObject({
      grant_status: "CLAIMED",
      reservation_status: "EXECUTING",
    });
    expect(
      (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
    ).toHaveLength(0);
  }
  it("2E complete signed flow commits all three objects once, including concurrent callers and post-response restart", async () => {
    const token = await issued(),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    const second = PostgresTrustRepository.connect(url!);
    try {
      const results = await Promise.allSettled([
        boundary(provider).execute(token, now),
        boundary(provider, second).execute(token, now),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(provider.financialSideEffects).toBe(1);
      expect(provider.logicalOrders).toBe(1);
      const rows = await repo.sql`select * from payment_attempts`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("CAPTURED");
      expect(
        await new PayPalExecutionRail(second, provider).reconcile(
          String(rows[0]?.id),
          recoveryTime,
        ),
      ).toBe("CAPTURED");
      expect(provider.captureIds).toHaveLength(1);
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(1);
      expect(
        PostgresTrustRepository.verifyEvidence(await repo.evidence()),
      ).toBe(true);
    } finally {
      await second.close();
    }
  });
  it("2E finalization failure after provider success rolls back every local transition and preserves a valid evidence chain", async () => {
    const token = await issued(),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    const original = repo.appendEvidenceInTransaction.bind(repo);
    const spy = vi
      .spyOn(repo, "appendEvidenceInTransaction")
      .mockImplementation(async (db, type, data, time) => {
        if (type === "PAYMENT_COMMITTED")
          throw new Error("INJECTED_COMMIT_FAILURE");
        return original(db, type, data, time);
      });
    try {
      await expect(boundary(provider).execute(token, now)).rejects.toThrow(
        "INVESTIGATION",
      );
    } finally {
      spy.mockRestore();
    }
    await states();
    expect(provider.financialSideEffects).toBe(1);
    const rows = await repo.sql`select * from payment_attempts`;
    expect(rows[0]?.status).toBe("CAPTURE_IN_FLIGHT");
    expect(await restartRecovery(provider, String(rows[0]?.id))).toBe(
      "CAPTURED",
    );
    expect(provider.captureIds).toHaveLength(1);
    expect(provider.financialSideEffects).toBe(1);
    expect(PostgresTrustRepository.verifyEvidence(await repo.evidence())).toBe(
      true,
    );
  });
  it("2E lost response followed by grant replay cannot start another independent operation", async () => {
    const token = await issued(),
      provider = new RecoveryProvider();
    await expect(boundary(provider).execute(token, now)).rejects.toThrow(
      "UNKNOWN",
    );
    await expect(boundary(provider).execute(token, now)).rejects.toThrow(
      "CONSUMED",
    );
    const ids = await new PayPalExecutionRail(
      repo,
      provider,
    ).reconciliationCandidates();
    expect(ids).toHaveLength(1);
    expect(await restartRecovery(provider, ids[0]!)).toBe("CAPTURED");
    expect(provider.financialSideEffects).toBe(1);
    expect(provider.captureIds).toHaveLength(1);
  });
  it.each([
    "SUSPENDED",
    "REVOKED",
    "EXPIRED",
    "MANDATE_REVOKED",
    "GRANT_EXPIRED",
  ])("2E %s after GET prevents a new financial retry", async (change) => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    const { id } = await unknown(provider);
    provider.afterGet = async () => {
      if (change === "MANDATE_REVOKED")
        await repo.revokeMandate(mandate.id, recoveryTime);
      else if (change === "GRANT_EXPIRED") {
        /* Natural expiration uses the reconciliation clock below. */
      } else if (change === "EXPIRED")
        await repo.sql`update agent_passports set expires_at=${recoveryTime} where id=${agent.id}`;
      else
        await repo.sql`update agent_passports set status=${change} where id=${agent.id}`;
    };
    await expect(
      change === "GRANT_EXPIRED"
        ? new PayPalExecutionRail(repo, provider).reconcile(
            id,
            "2026-10-09T12:03:00.000Z",
          )
        : restartRecovery(provider, id),
    ).rejects.toThrow();
    await quarantined(id, "CAPTURE_UNKNOWN");
    expect(provider.captureIds).toHaveLength(1);
    expect(provider.financialSideEffects).toBe(0);
  });
  it.each([
    "SUSPENDED",
    "REVOKED",
    "EXPIRED",
    "MANDATE_REVOKED",
    "GRANT_EXPIRED",
  ])(
    "2E %s after completed provider effect cannot undo it and does not prevent truthful finalization",
    async (change) => {
      const provider = new RecoveryProvider();
      const { id } = await unknown(provider);
      if (change === "MANDATE_REVOKED")
        await repo.revokeMandate(mandate.id, recoveryTime);
      else if (change === "GRANT_EXPIRED") {
        /* Natural expiration uses the reconciliation clock below. */
      } else if (change === "EXPIRED")
        await repo.sql`update agent_passports set expires_at=${recoveryTime} where id=${agent.id}`;
      else
        await repo.sql`update agent_passports set status=${change} where id=${agent.id}`;
      expect(
        await (change === "GRANT_EXPIRED"
          ? new PayPalExecutionRail(repo, provider).reconcile(
              id,
              "2026-10-09T12:03:00.000Z",
            )
          : restartRecovery(provider, id)),
      ).toBe("CAPTURED");
      expect(provider.financialSideEffects).toBe(1);
      expect(provider.captureIds).toHaveLength(1);
    },
  );
  it("2E suspension after create dispatch prevents capture without releasing authority", async () => {
    const token = await issued(),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    provider.afterCreate = async () => {
      await repo.sql`update agent_passports set status='SUSPENDED' where id=${agent.id}`;
    };
    await expect(boundary(provider).execute(token, now)).rejects.toThrow(
      "INVESTIGATION",
    );
    await states();
    expect(provider.captureIds).toHaveLength(0);
    expect(provider.financialSideEffects).toBe(0);
  });
  it("2E authority claimed before process death resumes the same grant and never reissues it", async () => {
    const { claims } = await claimed(),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    expect(await repo.sql`select id from payment_attempts`).toHaveLength(0);
    await expect(issuer.issue(claims.reservationId, now)).rejects.toThrow(
      "NOT_EXECUTABLE",
    );
    const result = await new PayPalExecutionRail(
      repo,
      provider,
      () => now,
    ).execute(claims);
    expect(result.executionId).toBe("RECOVERED-CAPTURE");
    expect(provider.financialSideEffects).toBe(1);
    expect(await repo.sql`select id from execution_grants`).toHaveLength(1);
  });
  it("2E create uncertainty after revocation cannot retry the create operation", async () => {
    const provider = new RecoveryProvider();
    provider.createLosses = 1;
    const { id } = await unknown(provider);
    await repo.revokeMandate(mandate.id, recoveryTime);
    await expect(restartRecovery(provider, id)).rejects.toThrow("REVOKED");
    expect(provider.createIds).toHaveLength(1);
    await quarantined(id, "ORDER_CREATE_UNKNOWN");
  });
  it.each(["RELEASED", "FAILED"])(
    "2E reservation APIs cannot turn executing uncertainty into %s",
    async (status) => {
      const provider = new RecoveryProvider();
      const { id, reservationId } = await unknown(provider);
      await expect(
        repo.transitionReservation(
          reservationId,
          status as "RELEASED" | "FAILED",
        ),
      ).rejects.toThrow("INVALID_RESERVATION_TRANSITION");
      await expect(
        auth.transitionReservation(
          reservationId,
          status as "RELEASED" | "FAILED",
          recoveryTime,
        ),
      ).rejects.toThrow("INVALID_RESERVATION_TRANSITION");
      expect(
        await auth.expireStaleReservations("2026-11-02T00:00:00.000Z"),
      ).toBe(0);
      await quarantined(id, "CAPTURE_UNKNOWN");
    },
  );
  it("2E GET-to-retry race relies on the identical key when capture becomes visible after the GET snapshot", async () => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    const { id } = await unknown(provider);
    const get = provider.getOrder.bind(provider);
    provider.getOrder = async (orderId) => {
      const snapshot = structuredClone(await get(orderId));
      // Another in-flight delivery of this same operation completes at PayPal.
      provider.captureLosses = 0;
      await provider.captureOrder(orderId, provider.captureIds[0]!);
      return snapshot;
    };
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    expect(provider.captureIds).toHaveLength(3);
    expect(new Set(provider.captureIds).size).toBe(1);
    expect(provider.financialSideEffects).toBe(1);
  });
  it("2E delayed capture visibility still converges using the persisted key without another financial effect", async () => {
    const provider = new RecoveryProvider();
    const { id } = await unknown(provider);
    const completed = structuredClone(provider.order!);
    provider.order = { ...completed, status: "APPROVED", captures: [] };
    expect(await restartRecovery(provider, id)).toBe("CAPTURED");
    expect(provider.captureIds[1]).toBe(provider.captureIds[0]);
    expect(provider.financialSideEffects).toBe(1);
  });
  it.each(["id", "amount", "currency", "reference", "status", "multiple"])(
    "2E malformed %s capture response during normal execution never releases authority or commits",
    async (field) => {
      const token = await issued(),
        provider = new RecoveryProvider();
      provider.captureLosses = 0;
      provider.captureResult = (order) => {
        const value = structuredClone(order);
        if (field === "id") return { ...value, id: "SUBSTITUTED-ORDER" };
        if (field === "reference")
          return {
            ...value,
            purchaseUnits: [
              {
                ...value.purchaseUnits[0]!,
                referenceId: "SUBSTITUTED-PROPOSAL",
              },
            ],
          };
        if (field === "status") return { ...value, status: "UNRECOGNIZED" };
        if (field === "multiple")
          return {
            ...value,
            captures: [
              ...value.captures,
              { ...value.captures[0]!, id: "SECOND" },
            ],
          };
        return {
          ...value,
          captures: [
            {
              ...value.captures[0]!,
              ...(field === "amount"
                ? { amountValue: "0.01" }
                : { currency: "EUR" }),
            },
          ],
        };
      };
      await expect(boundary(provider).execute(token, now)).rejects.toThrow(
        "INVESTIGATION",
      );
      await states();
      expect(provider.financialSideEffects).toBe(1);
      const rows = await repo.sql`select id from payment_attempts`;
      expect(await restartRecovery(provider, String(rows[0]?.id))).toBe(
        "CAPTURED",
      );
      expect(provider.captureIds).toHaveLength(1);
    },
  );
  it.each([
    "principal_id",
    "agent_id",
    "capability",
    "merchant_id",
    "proposal_digest",
    "mandate_fingerprint",
  ])(
    "2E corrupted persisted grant %s cannot drive a provider retry",
    async (field) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      if (field === "principal_id")
        await repo.savePrincipal({
          id: "other-principal",
          displayName: "Other",
        });
      if (field === "agent_id")
        await repo.saveAgent({ ...agent, id: "other-agent" });
      const value =
        field === "principal_id"
          ? "other-principal"
          : field === "agent_id"
            ? "other-agent"
            : field === "capability"
              ? "SEARCH_PRODUCTS"
              : field.endsWith("fingerprint") || field.endsWith("digest")
                ? "0".repeat(64)
                : "other-merchant";
      await repo.sql`update execution_grants set ${repo.sql(field)}=${value} where status='CLAIMED'`;
      await expect(restartRecovery(provider, id)).rejects.toThrow("MISMATCH");
      expect(provider.financialSideEffects).toBe(0);
      expect(provider.captureIds).toHaveLength(1);
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(0);
    },
  );
  it("2E changing a proposal merchant after authorization cannot acquire a newly signed grant", async () => {
    await repo.saveProposal(proposal);
    const result = await auth.authorizeProposal(proposal.id, "LOW", now);
    await repo.sql`update transaction_proposals set document=jsonb_set(document,'{merchant,id}','"OTHER-MERCHANT"'::jsonb) where id=${proposal.id}`;
    await expect(issuer.issue(result.reservation!.id, now)).rejects.toThrow(
      "AUTHORIZATION_PROPOSAL_CHANGED",
    );
    expect(await repo.sql`select id from execution_grants`).toHaveLength(0);
  });
  it("2E valid-schema receipt corruption cannot change authorization", async () => {
    await repo.saveProposal(proposal);
    const result = await auth.authorizeProposal(proposal.id, "LOW", now);
    await repo.sql`update decision_receipts set document=jsonb_set(document,'{amount,minor}','1'::jsonb) where id=${result.receipt.receiptId}`;
    await expect(issuer.issue(result.reservation!.id, now)).rejects.toThrow(
      "MALFORMED_PERSISTED_RECEIPT",
    );
  });
  it("2E receipt snapshots retain history while changed ESCALATE proposals cannot acquire approval", async () => {
    const escalated = { ...mandate, autonomousPurchaseThresholdMinor: 1000 };
    await repo.sql`update mandates set document=${repo.sql.json(escalated)},fingerprint=${mandateFingerprint(escalated)} where id=${mandate.id}`;
    await repo.saveProposal({
      ...proposal,
      mandateFingerprint: mandateFingerprint(escalated),
    });
    const result = await auth.authorizeProposal(proposal.id, "LOW", now);
    expect(result.receipt.decision).toBe("ESCALATE");
    await repo.sql`update transaction_proposals set document=jsonb_set(document,'{merchant,id}','"OTHER-MERCHANT"'::jsonb) where id=${proposal.id}`;
    await expect(
      auth.approveEscalation(result.receipt.receiptId, principal.id, now),
    ).rejects.toThrow("AUTHORIZATION_PROPOSAL_CHANGED");
    expect((await repo.getReceipt(result.receipt.receiptId))?.decision).toBe(
      "ESCALATE",
    );
    expect(
      await repo.sql`select id from authorization_reservations`,
    ).toHaveLength(0);
  });
  it("2E evidence insertion rollback neither consumes authority nor breaks the next hash-chain sequence", async () => {
    await expect(
      repo.sql.begin(async (tx) => {
        await repo.appendEvidenceInTransaction(
          tx,
          "INJECTED_ROLLBACK",
          { test: true },
          now,
        );
        throw new Error("CRASH");
      }),
    ).rejects.toThrow("CRASH");
    await repo.appendEvidence("AFTER_RESTART", { test: true }, now);
    const entries = await repo.evidence();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sequence).toBe(1);
    expect(PostgresTrustRepository.verifyEvidence(entries)).toBe(true);
  });
  it("2E a corrupt evidence chain cannot be extended into false payment commitment", async () => {
    const token = await issued(),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    await repo.sql`update evidence_events set data='{"corrupt":true}'::jsonb where sequence=1`;
    await expect(boundary(provider).execute(token, now)).rejects.toThrow(
      "EVIDENCE_INTEGRITY_FAILURE",
    );
    expect(provider.financialSideEffects).toBe(0);
    expect(provider.logicalOrders).toBe(0);
    expect(PostgresTrustRepository.verifyEvidence(await repo.evidence())).toBe(
      false,
    );
  });

  it("2E an unclassified sink failure is quarantined and redacted rather than releasing authority", async () => {
    const token = await issued();
    let effects = 0;
    const raw = "SYNTHETIC_SECRET_FROM_PROVIDER";
    const execution = new ExecutionBoundary(
      repo,
      new StaticPublicKeyRing(new Map([["2d-key", publicKey]])),
      {
        execute: () => {
          effects++;
          return Promise.reject(new Error(raw));
        },
      },
    );
    await expect(execution.execute(token, now)).rejects.toThrow(
      "EXECUTION_OUTCOME_UNPROVEN",
    );
    expect(effects).toBe(1);
    await states();
    expect(JSON.stringify(await repo.evidence())).not.toContain(raw);
  });

  async function escalation(): Promise<string> {
    const m = { ...mandate, autonomousPurchaseThresholdMinor: 1000 };
    await repo.sql`update mandates set document=${repo.sql.json(m)},fingerprint=${mandateFingerprint(m)} where id=${mandate.id}`;
    await repo.saveProposal({
      ...proposal,
      mandateFingerprint: mandateFingerprint(m),
    });
    const result = await auth.authorizeProposal(proposal.id, "LOW", now);
    await auth.approveEscalation(result.receipt.receiptId, principal.id, now);
    return issuer.issue(
      (await repo.getReservationByProposal(proposal.id))!.id,
      now,
    );
  }
  it.each([
    "principalId",
    "agentId",
    "mandateId",
    "proposalId",
    "receiptId",
    "reservationId",
    "capability",
    "amountMinor",
    "currency",
    "merchantId",
    "proposalDigest",
    "mandateFingerprint",
  ])("2E signed payload %s substitution stops before PayPal", async (field) => {
    const token = await issued(),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    const payload = JSON.parse(
      Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    payload[field] =
      field === "amountMinor"
        ? 1
        : field === "capability"
          ? "CAPTURE_PAYMENT"
          : field === "currency"
            ? "EUR"
            : field.endsWith("Digest") || field.endsWith("Fingerprint")
              ? "0".repeat(64)
              : "SUBSTITUTED";
    const altered =
      Buffer.from(JSON.stringify(payload)).toString("base64url") +
      "." +
      token.split(".")[1]!;
    await expect(boundary(provider).execute(altered, now)).rejects.toThrow();
    expect(provider.logicalOrders).toBe(0);
    expect(provider.financialSideEffects).toBe(0);
  });
  it.each(["before authorization", "before issuance", "before claim"])(
    "2E durable mandate revocation %s blocks provider execution",
    async (stage) => {
      const provider = new RecoveryProvider();
      provider.captureLosses = 0;
      await repo.saveProposal(proposal);
      if (stage === "before authorization") {
        await repo.revokeMandate(mandate.id, now);
        await expect(
          auth.authorizeProposal(proposal.id, "LOW", now),
        ).rejects.toThrow("REVOKED");
        expect(await repo.getReservationByProposal(proposal.id)).toBeNull();
      } else {
        const result = await auth.authorizeProposal(proposal.id, "LOW", now);
        const token =
          stage === "before claim"
            ? await issuer.issue(result.reservation!.id, now)
            : undefined;
        await repo.revokeMandate(mandate.id, now);
        if (token)
          await expect(boundary(provider).execute(token, now)).rejects.toThrow(
            "REVOKED",
          );
        else
          await expect(
            issuer.issue(result.reservation!.id, now),
          ).rejects.toThrow("REVOKED");
      }
      expect(provider.logicalOrders).toBe(0);
      expect(provider.financialSideEffects).toBe(0);
    },
  );
  it.each(["SUSPENDED", "REVOKED", "EXPIRED"])(
    "2E passport %s between reservation and grant issuance cannot execute",
    async (status) => {
      await repo.saveProposal(proposal);
      const result = await auth.authorizeProposal(proposal.id, "LOW", now);
      if (status === "EXPIRED")
        await repo.sql`update agent_passports set expires_at=${now} where id=${agent.id}`;
      else
        await repo.sql`update agent_passports set status=${status} where id=${agent.id}`;
      await expect(issuer.issue(result.reservation!.id, now)).rejects.toThrow(
        "AGENT_NOT_EXECUTABLE",
      );
      expect(await repo.sql`select id from execution_grants`).toHaveLength(0);
    },
  );
  it.each(["REVOKED", "EXPIRED", "PRINCIPAL", "PROPOSAL"])(
    "2E approval %s after claim and before capture blocks the financial operation",
    async (change) => {
      const token = await escalation(),
        provider = new RecoveryProvider();
      provider.captureLosses = 0;
      if (change === "PRINCIPAL")
        await repo.savePrincipal({
          id: "other-principal",
          displayName: "Other",
        });
      if (change === "PROPOSAL")
        await repo.saveProposal({
          ...proposal,
          id: "other-proposal",
          nonce: "other-proposal-nonce",
          mandateFingerprint: mandateFingerprint({
            ...mandate,
            autonomousPurchaseThresholdMinor: 1000,
          }),
        });
      provider.afterCreate = async () => {
        if (change === "PRINCIPAL")
          await repo.sql`update approvals set principal_id='other-principal'`;
        else if (change === "PROPOSAL")
          await repo.sql`update approvals set proposal_id='other-proposal'`;
        else await repo.sql`update approvals set status=${change}`;
      };
      await expect(boundary(provider).execute(token, now)).rejects.toThrow(
        "INVESTIGATION",
      );
      await states();
      expect(provider.captureIds).toHaveLength(0);
      expect(provider.financialSideEffects).toBe(0);
    },
  );
  it("2E duplicate approval concurrency reserves only once and retains the historical ESCALATE decision", async () => {
    const m = { ...mandate, autonomousPurchaseThresholdMinor: 1000 };
    await repo.sql`update mandates set document=${repo.sql.json(m)},fingerprint=${mandateFingerprint(m)} where id=${mandate.id}`;
    await repo.saveProposal({
      ...proposal,
      mandateFingerprint: mandateFingerprint(m),
    });
    const result = await auth.authorizeProposal(proposal.id, "LOW", now);
    const second = PostgresTrustRepository.connect(url!);
    try {
      const results = await Promise.allSettled([
        auth.approveEscalation(result.receipt.receiptId, principal.id, now),
        new DurableAuthorizationService(second).approveEscalation(
          result.receipt.receiptId,
          principal.id,
          now,
        ),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await repo.sql`select id from approvals`).toHaveLength(1);
      expect(
        await repo.sql`select id from authorization_reservations`,
      ).toHaveLength(1);
      expect((await repo.getReceipt(result.receipt.receiptId))?.decision).toBe(
        "ESCALATE",
      );
    } finally {
      await second.close();
    }
  });
  it.each(["amount", "currency", "merchant", "capability"])(
    "2E %s mutation after human approval cannot become a signed execution grant",
    async (change) => {
      const m = { ...mandate, autonomousPurchaseThresholdMinor: 1000 };
      await repo.sql`update mandates set document=${repo.sql.json(m)},fingerprint=${mandateFingerprint(m)} where id=${mandate.id}`;
      const p = { ...proposal, mandateFingerprint: mandateFingerprint(m) };
      await repo.saveProposal(p);
      const result = await auth.authorizeProposal(p.id, "LOW", now);
      const approved = await auth.approveEscalation(
        result.receipt.receiptId,
        principal.id,
        now,
      );
      const altered = structuredClone(p);
      if (change === "amount") altered.amount = { ...altered.amount, minor: 1 };
      if (change === "currency")
        altered.amount = { ...altered.amount, currency: "EUR" };
      if (change === "merchant")
        altered.merchant = { ...altered.merchant, id: "OTHER" };
      if (change === "capability")
        altered.requestedCapability = "CAPTURE_PAYMENT";
      await repo.sql`update transaction_proposals set document=${repo.sql.json(altered)},amount_minor=${altered.amount.minor},currency=${altered.amount.currency} where id=${p.id}`;
      await expect(issuer.issue(approved.reservation.id, now)).rejects.toThrow(
        "AUTHORIZATION_PROPOSAL_CHANGED",
      );
      expect((await repo.getReceipt(result.receipt.receiptId))?.decision).toBe(
        "ESCALATE",
      );
    },
  );
  it("2E grant issuance failure after signing and insertion rolls back the grant/evidence while retaining a recoverable reservation", async () => {
    await repo.saveProposal(proposal);
    const result = await auth.authorizeProposal(proposal.id, "LOW", now);
    const original = repo.appendEvidenceInTransaction.bind(repo);
    const spy = vi
      .spyOn(repo, "appendEvidenceInTransaction")
      .mockImplementation(async (db, type, data, time) => {
        const event = await original(db, type, data, time);
        if (type === "EXECUTION_GRANT_ISSUED")
          throw new Error("SIMULATED_ISSUANCE_CRASH");
        return event;
      });
    try {
      await expect(issuer.issue(result.reservation!.id, now)).rejects.toThrow(
        "ISSUANCE_CRASH",
      );
    } finally {
      spy.mockRestore();
    }
    expect(await repo.sql`select id from execution_grants`).toHaveLength(0);
    expect((await repo.getReservationByProposal(proposal.id))?.status).toBe(
      "AUTHORIZED",
    );
    const token = await issuer.issue(result.reservation!.id, now),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    await boundary(provider).execute(token, now);
    expect(provider.financialSideEffects).toBe(1);
    expect(PostgresTrustRepository.verifyEvidence(await repo.evidence())).toBe(
      true,
    );
  });
  it.each([
    "create_order_request_id",
    "capture_request_id",
    "expires_at",
    "created_at",
  ])(
    "2E corrupted recovery %s remains quarantined without another provider dispatch",
    async (field) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { id, claims } = await unknown(provider);
      if (field === "expires_at")
        await repo.sql`update execution_grants set expires_at='2026-11-01T00:00:00Z' where id=${claims.jti}`;
      else if (field === "created_at")
        await repo.sql`update payment_attempts set created_at='infinity' where id=${id}`;
      else
        await repo.sql`update payment_attempts set ${repo.sql(field)}='SUBSTITUTED-KEY' where id=${id}`;
      await expect(restartRecovery(provider, id)).rejects.toThrow();
      expect(provider.captureIds).toHaveLength(1);
      expect(provider.financialSideEffects).toBe(0);
      await states();
    },
  );
  it.each(["RELEASED", "FAILED", "COMMITTED"])(
    "2E corrupted executing reservation %s cannot free capacity for another financial authorization",
    async (status) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { reservationId } = await unknown(provider);
      await repo.sql`update authorization_reservations set status=${status} where id=${reservationId}`;
      const another = {
        ...proposal,
        id: "another",
        nonce: "another-proposal-nonce",
        amount: { currency: "USD", minor: 10000 },
      };
      await repo.saveProposal(another);
      await expect(
        auth.authorizeProposal(another.id, "LOW", now),
      ).rejects.toThrow("CORRUPT_AUTHORITY_ACCOUNTING");
      expect(await repo.getReservationByProposal(another.id)).toBeNull();
      expect(provider.financialSideEffects).toBe(0);
    },
  );
  it("2E stale worker snapshot cannot finalize peer-updated state after a provider operation", async () => {
    const token = await issued(),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    provider.afterCapture = async () => {
      await repo.sql`update payment_attempts set status='CAPTURE_UNKNOWN'`;
    };
    await expect(boundary(provider).execute(token, now)).rejects.toThrow(
      "INVESTIGATION",
    );
    await states();
    const rows = await repo.sql`select id from payment_attempts`;
    expect(await restartRecovery(provider, String(rows[0]?.id))).toBe(
      "CAPTURED",
    );
    expect(provider.financialSideEffects).toBe(1);
    expect(provider.captureIds).toHaveLength(1);
  });
  it("2E equivalent timestamp forms are normalized before evidence hashing", async () => {
    await repo.appendEvidence(
      "CANONICAL_TIME",
      { test: true },
      "2026-10-09T12:00:00Z",
    );
    await repo.appendEvidence("NEXT_EVENT", { test: true }, now);
    expect(PostgresTrustRepository.verifyEvidence(await repo.evidence())).toBe(
      true,
    );
  });
  it("2E millisecond timestamps survive the entire signed PostgreSQL/provider flow", async () => {
    const time = "2026-10-09T12:00:00.123Z";
    await repo.saveProposal({ ...proposal, proposedAt: time });
    const result = await auth.authorizeProposal(proposal.id, "LOW", time);
    const token = await issuer.issue(result.reservation!.id, time),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    const execution = new ExecutionBoundary(
      repo,
      new StaticPublicKeyRing(new Map([["2d-key", publicKey]])),
      new PayPalExecutionRail(repo, provider, () => time),
    );
    await execution.execute(token, time);
    expect(provider.financialSideEffects).toBe(1);
    expect(PostgresTrustRepository.verifyEvidence(await repo.evidence())).toBe(
      true,
    );
  });

  it.each([
    "grant_id",
    "proposal_id",
    "mandate_id",
    "principal_id",
    "amount_minor",
    "currency",
    "merchant_reference",
    "create_order_request_id",
    "capture_request_id",
  ])(
    "2E missing Payment Attempt %s cannot authorize recovery",
    async (field) => {
      const provider = new RecoveryProvider();
      provider.captureDespiteLoss = false;
      const { id } = await unknown(provider);
      await repo.sql`update payment_attempts set ${repo.sql(field)}=null where id=${id}`;
      await expect(restartRecovery(provider, id)).rejects.toThrow();
      expect(provider.financialSideEffects).toBe(0);
      expect(provider.captureIds).toHaveLength(1);
      await states();
    },
  );
  it("2E a CAPTURED attempt with uncommitted grant authority is corruption, never successful reconciliation", async () => {
    const token = await issued(),
      provider = new RecoveryProvider();
    provider.captureLosses = 0;
    await boundary(provider).execute(token, now);
    await repo.sql`update execution_grants set status='CLAIMED'`;
    const rows = await repo.sql`select id from payment_attempts`;
    await expect(
      restartRecovery(provider, String(rows[0]?.id)),
    ).rejects.toThrow("GRANT_FINALIZATION_STATE_INVALID");
    expect(provider.financialSideEffects).toBe(1);
    expect(provider.captureIds).toHaveLength(1);
    expect(
      (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
    ).toHaveLength(1);
  });
  it("2E revocation racing authorization-to-reservation is serialized and prevents subsequent grant issuance", async () => {
    await repo.saveProposal(proposal);
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = repo.createReservation.bind(repo);
    const spy = vi
      .spyOn(repo, "createReservation")
      .mockImplementation(async (reservation, tx) => {
        reached();
        await gate;
        return original(reservation, tx);
      });
    const second = PostgresTrustRepository.connect(url!);
    const authorization = auth.authorizeProposal(proposal.id, "LOW", now);
    let revocation: Promise<unknown> | undefined;
    try {
      await entered;
      revocation =
        second.sql`update agent_passports /*2e_revocation_race*/ set status='REVOKED' where id=${agent.id}`.then(
          (result) => result,
        );
      let blocked = false;
      for (let probe = 0; probe < 100 && !blocked; probe++) {
        const rows =
          await repo.sql`select pid from pg_stat_activity where query like ${"%2e_revocation_race%"} and wait_event_type='Lock'`;
        blocked = rows.length === 1;
      }
      expect(blocked).toBe(true);
      release();
      const result = await authorization;
      await revocation;
      expect(result.reservation?.status).toBe("AUTHORIZED");
      await expect(issuer.issue(result.reservation!.id, now)).rejects.toThrow(
        "AGENT_NOT_EXECUTABLE",
      );
      expect(await repo.sql`select id from payment_attempts`).toHaveLength(0);
    } finally {
      release();
      spy.mockRestore();
      await authorization.catch(() => undefined);
      await revocation;
      await second.close();
    }
  });

  it("2E mutually FAILED grant/reservation cannot release an unresolved Payment Attempt's authority", async () => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    const { id } = await unknown(provider);
    await repo.sql`update execution_grants set status='FAILED',failed_at=${now}`;
    await repo.sql`update authorization_reservations set status='FAILED'`;
    await expect(
      repo.authorityAccounting(mandate.id, mandate.cumulativeLimitMinor),
    ).rejects.toThrow("CORRUPT_PAYMENT_ACCOUNTING");
    await expect(restartRecovery(provider, id)).rejects.toThrow(
      "GRANT_FINALIZATION_STATE_INVALID",
    );
    expect(provider.financialSideEffects).toBe(0);
    expect(provider.captureIds).toHaveLength(1);
  });

  it.each(["captured_at", "consumed_at", "commit evidence"])(
    "2E corrupted finalized %s cannot be reported as successful reconciliation",
    async (field) => {
      const token = await issued(),
        provider = new RecoveryProvider();
      provider.captureLosses = 0;
      await boundary(provider).execute(token, now);
      const rows = await repo.sql`select id from payment_attempts`;
      if (field === "captured_at")
        await repo.sql`update payment_attempts set captured_at='infinity'`;
      else if (field === "consumed_at")
        await repo.sql`update execution_grants set consumed_at='infinity'`;
      else
        await repo.sql`delete from evidence_events where type='PAYMENT_COMMITTED'`;
      await expect(
        restartRecovery(provider, String(rows[0]?.id)),
      ).rejects.toThrow();
      expect(provider.financialSideEffects).toBe(1);
      expect(provider.captureIds).toHaveLength(1);
    },
  );

  it("2E ledger API rejects PAYMENT_COMMITTED while financial authority is unresolved", async () => {
    const provider = new RecoveryProvider();
    provider.captureDespiteLoss = false;
    const { id } = await unknown(provider);
    await expect(
      repo.appendEvidence(
        "PAYMENT_COMMITTED",
        { paymentAttemptId: id, paypalCaptureId: "FORGED" },
        now,
      ),
    ).rejects.toThrow("PAYMENT_EVIDENCE_STATE_INVALID");
    await states();
    expect(provider.financialSideEffects).toBe(0);
    expect(PostgresTrustRepository.verifyEvidence(await repo.evidence())).toBe(
      true,
    );
  });
  it.each(["duplicate", "substituted capture"])(
    "2E ledger API rejects a %s commitment without another logical event",
    async (change) => {
      const token = await issued(),
        provider = new RecoveryProvider();
      provider.captureLosses = 0;
      await boundary(provider).execute(token, now);
      const rows =
        await repo.sql`select id,provider_capture_id from payment_attempts`;
      await expect(
        repo.appendEvidence(
          "PAYMENT_COMMITTED",
          {
            paymentAttemptId: String(rows[0]?.id),
            paypalCaptureId:
              change === "duplicate"
                ? String(rows[0]?.provider_capture_id)
                : "FORGED",
          },
          now,
        ),
      ).rejects.toThrow("PAYMENT_EVIDENCE_STATE_INVALID");
      expect(
        (await repo.evidence()).filter((e) => e.type === "PAYMENT_COMMITTED"),
      ).toHaveLength(1);
      expect(provider.financialSideEffects).toBe(1);
      expect(
        PostgresTrustRepository.verifyEvidence(await repo.evidence()),
      ).toBe(true);
    },
  );
});
