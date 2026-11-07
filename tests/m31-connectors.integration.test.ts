import { describe, expect, it } from "vitest";
import { hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";
import {
  ConnectorRegistry,
  ConnectorResultSchema,
  OBSERVE_CAPABILITIES,
  builtinRegistry,
  demoCatalogConnector,
  validateDefinition,
  type ConnectorDefinition,
} from "../src/missions/connectors.js";
import { ConnectorService } from "../src/missions/connector-service.js";

/**
 * V3 M31 — connectors, against the real Gateway on PostgreSQL. A connector may only OBSERVE, only inside a mission's rules, and
 * whatever it returns is untrusted. The only production-registry connector is the sandbox demo catalogue; the doubles below
 * exist in this test file alone, are labelled, and are never part of any registry a host builds by itself.
 */
const url = process.env.TEST_DATABASE_URL;
const iso = () => "2026-10-23T10:00:00.000Z";

/** A test double with scripted behaviour. NEVER registered outside this file. */
type Behaviour =
  | "ok"
  | "throw"
  | "hang"
  | "badshape"
  | "huge"
  | "toomany"
  | "httpurl"
  | "userinfo";
const script = { behaviour: "ok" as Behaviour, calls: 0 };
const record = (n: number, over: Record<string, unknown> = {}) => ({
  recordId: `r${n}`,
  kind: "OFFER" as const,
  title: `Scripted offer ${n}`,
  priceObservation: { minor: 1000 + n, currency: "USD" },
  availableQuantity: 3,
  url: "https://supplier.example/item/" + n,
  observedAt: "2026-10-23T09:59:00.000Z",
  claims: { grade: "A" },
  ...over,
});
function scriptedConnector(
  over: Partial<ConnectorDefinition> = {},
): ConnectorDefinition {
  return {
    id: "test-scripted-feed",
    displayName: "TEST DOUBLE: scripted supplier feed",
    providerTypes: ["DIRECT_SUPPLIER"],
    mode: "LIVE",
    capabilities: ["SEARCH", "READ"],
    credential: "REQUIRED",
    dataUse: "Test double used only by the M31 integration tests.",
    limits: {
      maxRecords: 5,
      maxResultBytes: 4096,
      timeoutMs: 150,
      callsPerHour: 3,
    },
    adapter: {
      observe: (_req, signal) => {
        script.calls++;
        switch (script.behaviour) {
          case "throw":
            return Promise.reject(new Error("SECRET-INTERNAL-DETAIL"));
          case "hang":
            return new Promise((_, reject) =>
              signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            );
          case "badshape":
            return Promise.resolve({ records: [{ nope: "INJECTED-TEXT" }] });
          case "huge":
            return Promise.resolve({
              records: [
                record(1, {
                  title: "x".repeat(150),
                  claims: Object.fromEntries(
                    Array.from({ length: 16 }, (_, i) => [
                      `k${i}`,
                      "y".repeat(200),
                    ]),
                  ),
                }),
                record(2, {
                  claims: Object.fromEntries(
                    Array.from({ length: 16 }, (_, i) => [
                      `k${i}`,
                      "y".repeat(200),
                    ]),
                  ),
                }),
              ],
            });
          case "toomany":
            return Promise.resolve({
              records: [1, 2, 3, 4, 5, 6].map((n) => record(n)),
            });
          case "httpurl":
            return Promise.resolve({
              records: [record(1, { url: "http://supplier.example/x" })],
            });
          case "userinfo":
            return Promise.resolve({
              records: [
                record(1, { url: "https://user:pw@supplier.example/x" }),
              ],
            });
          default:
            return Promise.resolve({ records: [record(1), record(2)] });
        }
      },
    },
    ...over,
  };
}

describe("M31 connector definitions (pure)", () => {
  it("only observe capabilities exist, and definitions that claim anything else, or are unsafe, are refused", () => {
    expect([...OBSERVE_CAPABILITIES]).toEqual([
      "SEARCH",
      "READ",
      "COMPARE",
      "STATUS",
      "VERIFY",
    ]);
    for (const bad of [
      "PURCHASE",
      "COMMUNICATE",
      "NEGOTIATE",
      "CONTRACT",
      "RESERVE",
      "REFUND_REQUEST",
      "DRAFT",
      "REQUEST_APPROVAL",
    ]) {
      expect(
        validateDefinition(scriptedConnector({ capabilities: [bad as never] })),
        bad,
      ).toContain("NOT_OBSERVE_ONLY");
    }
    const cases: [Partial<ConnectorDefinition>, string][] = [
      [{ id: "Bad Id" }, "BAD_ID"],
      [{ displayName: " " }, "BAD_NAME"],
      [{ providerTypes: [] }, "NO_PROVIDER_TYPE"],
      [{ providerTypes: ["NOT_A_TYPE" as never] }, "UNKNOWN_PROVIDER_TYPE"],
      [{ capabilities: [] }, "NO_CAPABILITY"],
      [{ dataUse: "tbd" }, "DATA_USE_UNSTATED"],
      [
        {
          limits: {
            maxRecords: 0,
            maxResultBytes: 4096,
            timeoutMs: 100,
            callsPerHour: 1,
          },
        },
        "BAD_LIMITS",
      ],
      [
        {
          limits: {
            maxRecords: 5,
            maxResultBytes: 4096,
            timeoutMs: 999_999,
            callsPerHour: 1,
          },
        },
        "BAD_LIMITS",
      ],
      [
        {
          limits: {
            maxRecords: 5,
            maxResultBytes: 4096,
            timeoutMs: 100,
            callsPerHour: 0,
          },
        },
        "BAD_LIMITS",
      ],
    ];
    for (const [over, problem] of cases)
      expect(validateDefinition(scriptedConnector(over)), problem).toContain(
        problem,
      );
    expect(validateDefinition(scriptedConnector())).toEqual([]);
    const r = new ConnectorRegistry().register(scriptedConnector());
    expect(() => r.register(scriptedConnector())).toThrow(
      "CONNECTOR_DUPLICATE",
    );
    expect(() =>
      new ConnectorRegistry().register(
        scriptedConnector({ capabilities: ["PURCHASE" as never] }),
      ),
    ).toThrow("NOT_OBSERVE_ONLY");
  });

  it("the built-in registry holds only the labelled sandbox catalogue, whose output passes the strict result schema", async () => {
    const reg = builtinRegistry(iso);
    expect(reg.list().map((c) => [c.id, c.mode, c.credential])).toEqual([
      ["payflow-demo-catalog", "SANDBOX", "NONE"],
    ]);
    const demo = demoCatalogConnector(iso);
    const out = ConnectorResultSchema.parse(
      await demo.adapter.observe(
        { capability: "SEARCH", query: { text: "brown black new", limit: 10 } },
        new AbortController().signal,
      ),
    );
    expect(out.records.map((r) => r.recordId)).toEqual([
      "pf.offer.brown.black.new",
    ]);
    expect(out.records[0]!.priceObservation).toEqual({
      minor: 8400,
      currency: "USD",
    });
    const none = ConnectorResultSchema.parse(
      await demo.adapter.observe(
        { capability: "SEARCH", query: { text: "guitar", limit: 10 } },
        new AbortController().signal,
      ),
    );
    expect(none.records).toEqual([]);
  });
});

(url ? describe : describe.skip)(
  "M31 connectors (PostgreSQL + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates,connector_installs,connector_calls",
      connectors: () =>
        builtinRegistry(() => new Date().toISOString()).register(
          scriptedConnector(),
        ),
    });
    const CONNECTORS = "/v1/admin/org/connectors";
    type Obs = {
      callId: string;
      replayed: boolean;
      observation: {
        trust: string;
        notice: string;
        mode: string;
        records: { recordId: string; title: string }[];
      };
    };
    const post = (token: string, path: string, body: unknown = {}) =>
      h.call(token, "POST", path, body);
    const ack = { acknowledgedDataUse: true };
    const buy = (over: Record<string, unknown> = {}) =>
      contract({
        approvedProviderTypes: ["COMMERCE_MARKETPLACE", "DIRECT_SUPPLIER"],
        agents: [
          {
            agentId: "a",
            capabilities: ["SEARCH", "READ", "COMPARE", "DRAFT"],
          },
          { agentId: "b", capabilities: ["NEGOTIATE", "COMPARE"] },
          { agentId: "c", capabilities: ["PURCHASE", "REQUEST_APPROVAL"] },
        ],
        ...over,
      });
    const invokePath = (id: string) =>
      `/v1/agent/missions/${id}/connectors/invoke`;
    const call = (
      token: string,
      id: string,
      over: Record<string, unknown> = {},
    ) =>
      post(token, invokePath(id), {
        connectorId: "payflow-demo-catalog",
        capability: "SEARCH",
        query: { text: "brown black new" },
        idempotencyKey: idemKey("call"),
        ...over,
      });
    const reason = async (r: Response) =>
      ((await r.json()) as { reason: string }).reason;
    const statusOf = async (owner: string, connectorId: string) =>
      (
        (await (await h.call(owner, "GET", CONNECTORS)).json()) as {
          connectors: { connectorId: string; status: string }[];
        }
      ).connectors.find((c) => c.connectorId === connectorId)!.status;
    const setup = async (c: unknown = buy()) => {
      script.behaviour = "ok";
      script.calls = 0;
      return activeMission(h, c);
    };

    it("the catalogue starts empty of installs; installing needs the data-use acknowledgement and a manage role; installs are idempotent and never echo a credential reference", async () => {
      const { owner } = await setup();
      const listed = (await (
        await h.call(owner, "GET", CONNECTORS)
      ).json()) as {
        connectors: {
          connectorId: string;
          status: string;
          dataUse: string;
          mode: string;
        }[];
      };
      expect(
        listed.connectors.map((c) => [c.connectorId, c.status, c.mode]),
      ).toEqual([
        ["payflow-demo-catalog", "NOT_INSTALLED", "SANDBOX"],
        ["test-scripted-feed", "NOT_INSTALLED", "LIVE"],
      ]);
      expect(listed.connectors.every((c) => c.dataUse.length > 10)).toBe(true);

      const dev = await h.member("DEVELOPER");
      const sec = await h.member("SECURITY_ADMIN");
      for (const who of [dev, sec])
        expect(
          (await post(who, `${CONNECTORS}/payflow-demo-catalog/install`, ack))
            .status,
        ).toBe(403);
      expect(
        (await post(owner, `${CONNECTORS}/payflow-demo-catalog/install`, {}))
          .status,
      ).toBe(400);
      expect(
        (
          await post(owner, `${CONNECTORS}/payflow-demo-catalog/install`, {
            acknowledgedDataUse: false,
          })
        ).status,
      ).toBe(400);
      expect(
        (await post(owner, `${CONNECTORS}/no-such-connector/install`, ack))
          .status,
      ).toBe(404);

      const first = await post(
        owner,
        `${CONNECTORS}/payflow-demo-catalog/install`,
        ack,
      );
      expect(first.status).toBe(201);
      const again = await post(
        owner,
        `${CONNECTORS}/payflow-demo-catalog/install`,
        ack,
      );
      expect(again.status).toBe(200);
      expect(((await again.json()) as { replayed: boolean }).replayed).toBe(
        true,
      );
      expect(await statusOf(owner, "payflow-demo-catalog")).toBe("READY");

      // A connector that needs a credential cannot be installed without a reference, and the reference is never returned.
      const noCred = await post(
        owner,
        `${CONNECTORS}/test-scripted-feed/install`,
        ack,
      );
      expect(noCred.status).toBe(409);
      expect(await reason(noCred)).toBe("CREDENTIAL_REQUIRED");
      const withCred = await post(
        owner,
        `${CONNECTORS}/test-scripted-feed/install`,
        { ...ack, credentialRef: "vault/supplier-feed" },
      );
      expect(withCred.status).toBe(201);
      expect(JSON.stringify(await withCred.json())).not.toContain(
        "vault/supplier-feed",
      );
      expect(
        JSON.stringify(await (await h.call(owner, "GET", CONNECTORS)).json()),
      ).not.toContain("vault/supplier-feed");
      expect(
        (
          await post(owner, `${CONNECTORS}/payflow-demo-catalog/install`, {
            ...ack,
            extra: 1,
          })
        ).status,
      ).toBe(400);
    });

    it("state: disable, re-enable (needs the acknowledgement again), suspend by security, lift by an admin; each is audited", async () => {
      const { owner } = await setup();
      const fin = await h.member("FINANCE_ADMIN");
      const sec = await h.member("SECURITY_ADMIN");
      const dev = await h.member("DEVELOPER");
      const base = `${CONNECTORS}/payflow-demo-catalog`;
      await post(owner, `${base}/install`, ack);
      expect((await post(dev, `${base}/disable`)).status).toBe(403);
      expect((await post(owner, `${base}/disable`)).status).toBe(200);
      expect(await statusOf(owner, "payflow-demo-catalog")).toBe("DISABLED");
      expect((await post(owner, `${base}/enable`)).status).toBe(400);
      expect((await post(owner, `${base}/enable`, ack)).status).toBe(200);
      expect((await post(sec, `${base}/suspend`)).status).toBe(200);
      expect(await statusOf(owner, "payflow-demo-catalog")).toBe("SUSPENDED");
      // Security can contain but not restore; a finance admin lifts a suspension without re-reading the terms.
      expect((await post(sec, `${base}/enable`)).status).toBe(403);
      expect((await post(fin, `${base}/enable`)).status).toBe(200);
      expect(await statusOf(owner, "payflow-demo-catalog")).toBe("READY");
      expect(
        (
          await post(owner, `${CONNECTORS}/payflow-demo-catalog/enable`, {
            expectedRowVersion: 1,
          })
        ).status,
      ).toBe(400);
      const actions = (
        await h.repo
          .sql`select action from organization_audit_events where subject_kind = 'CONNECTOR' order by sequence`
      ).map((r) => String(r.action));
      expect(actions).toEqual([
        "CONNECTOR_INSTALLED",
        "CONNECTOR_DISABLED",
        "CONNECTOR_ENABLED",
        "CONNECTOR_SUSPENDED",
        "CONNECTOR_ENABLED",
      ]);
    });

    it("a sandbox connector can never be installed or used in PRODUCTION", async () => {
      const svc = new ConnectorService({
        sql: h.repo.sql,
        audit: { append: () => Promise.resolve() } as never,
        missions: {} as never,
        registry: builtinRegistry(iso),
        now: iso,
      });
      const r = await svc.install(
        {
          organizationId: "org-prod",
          environment: "PRODUCTION",
          id: "m1",
          kind: "MEMBER",
        },
        "payflow-demo-catalog",
        ack,
      );
      expect(r).toEqual({ ok: false, refusal: "ENVIRONMENT_MISMATCH" });
      expect(
        (
          await svc.catalogFor({
            organizationId: "org-prod",
            environment: "PRODUCTION",
          })
        ).supports("COMMERCE_MARKETPLACE", "SEARCH"),
      ).toBe(false);
    });

    it("an agent can only observe, and only inside the mission: every gate refuses before anything is fetched", async () => {
      const { owner, id, a, b, c } = await setup(buy());
      // not installed yet
      let r = await call(a, id);
      expect(r.status).toBe(409);
      expect(await reason(r)).toBe("CONNECTOR_NOT_INSTALLED");
      await post(owner, `${CONNECTORS}/payflow-demo-catalog/install`, ack);

      // happy path: an observation, labelled as one
      r = await call(a, id);
      expect(r.status).toBe(200);
      const ok = (await r.json()) as Obs;
      expect(ok.observation).toMatchObject({
        trust: "UNTRUSTED_OBSERVATION",
        mode: "SANDBOX",
      });
      expect(ok.observation.notice).toContain("not a quote");
      expect(ok.observation.records.map((x) => x.recordId)).toEqual([
        "pf.offer.brown.black.new",
      ]);

      // money-moving and messaging capabilities are not in the vocabulary at all
      for (const cap of [
        "PURCHASE",
        "COMMUNICATE",
        "NEGOTIATE",
        "CONTRACT",
        "RESERVE",
      ])
        expect((await call(a, id, { capability: cap })).status, cap).toBe(400);
      // an agent without the SEARCH grant (b) or without any observe grant (c) is refused by the mission itself
      for (const t of [b, c]) {
        r = await call(t, id);
        expect(r.status).toBe(403);
        expect(await reason(r)).toBe("CAPABILITY_REFUSED");
      }
      // a connector that does not offer the capability
      r = await call(a, id, { capability: "VERIFY" });
      expect(r.status).toBe(403);
      expect(await reason(r)).toBe("CAPABILITY_NOT_OBSERVABLE");
      // unknown connector, malformed query, unknown field
      expect((await call(a, id, { connectorId: "nope" })).status).toBe(404);
      expect((await call(a, id, { query: {} })).status).toBe(400);
      expect(
        (await call(a, id, { query: { text: "x", limit: 999 } })).status,
      ).toBe(400);
      expect((await call(a, id, { extra: true })).status).toBe(400);
      // a member cannot use the agent route; an unauthenticated caller cannot either
      expect((await post(owner, invokePath(id), {})).status).toBe(401);
      expect((await h.call("", "POST", invokePath(id), {})).status).toBe(401);
      // another organization sees none of this: not the install, not the calls
      const stranger = await h.ownerOf("org-other");
      expect(await statusOf(stranger, "payflow-demo-catalog")).toBe(
        "NOT_INSTALLED",
      );
      const theirs = (await (
        await h.call(
          stranger,
          "GET",
          `/v1/admin/org/connector-calls?missionId=${id}`,
        )
      ).json()) as { calls: unknown[] };
      expect(theirs.calls).toEqual([]);

      // a provider type the contract did not approve
      const narrow = await activeMission(
        h,
        buy({ approvedProviderTypes: ["DIRECT_SUPPLIER"] }),
      );
      r = await call(narrow.a, narrow.id);
      expect(r.status).toBe(403);
      expect(await reason(r)).toBe("PROVIDER_TYPE_NOT_APPROVED");

      // a paused or stopped mission stops observing at once
      for (const [action, label] of [
        ["pause", "MISSION_PAUSED"],
        ["cancel", "MISSION_CANCELLED"],
      ] as const) {
        const m = await activeMission(h, buy());
        expect(
          (
            await post(m.owner, `${MISSIONS}/${m.id}/${action}`, {
              reason: "t",
            })
          ).status,
        ).toBe(200);
        r = await call(m.a, m.id);
        expect(r.status).toBe(403);
        expect(((await r.json()) as { detail: string }).detail).toBe(label);
      }
      // the agent catalogue shows what exists, not how it is installed
      const cat = (await (
        await h.call(a, "GET", "/v1/agent/connectors")
      ).json()) as {
        connectors: Record<string, unknown>[];
      };
      expect(cat.connectors.map((x) => x.connectorId)).toEqual([
        "payflow-demo-catalog",
        "test-scripted-feed",
      ]);
      expect(
        cat.connectors.every((x) => !("install" in x) && !("limits" in x)),
      ).toBe(true);
    });

    it("disabled and suspended connectors stop agents immediately, and an organization pause stops them too", async () => {
      const { owner, id, a } = await setup();
      const sec = await h.member("SECURITY_ADMIN");
      const base = `${CONNECTORS}/payflow-demo-catalog`;
      await post(owner, `${base}/install`, ack);
      expect((await call(a, id)).status).toBe(200);
      await post(sec, `${base}/suspend`);
      let r = await call(a, id);
      expect([r.status, await reason(r)]).toEqual([423, "CONNECTOR_SUSPENDED"]);
      await post(owner, `${base}/enable`, ack);
      expect((await call(a, id)).status).toBe(200);
      await post(owner, `${base}/disable`);
      r = await call(a, id);
      expect([r.status, await reason(r)]).toEqual([409, "CONNECTOR_DISABLED"]);
      await post(owner, `${base}/enable`, ack);
      expect(
        (await post(owner, "/v1/admin/org/pause", { reason: "t" })).status,
      ).toBe(200);
      r = await call(a, id);
      expect([r.status, await reason(r)]).toEqual([423, "ORGANIZATION_PAUSED"]);
      await post(owner, "/v1/admin/org/resume", {});
    });

    it("idempotency: a repeat returns the stored result without calling out; the same key for a different request is refused; concurrent repeats call out once", async () => {
      const { owner, id, a } = await setup();
      await post(owner, `${CONNECTORS}/test-scripted-feed/install`, {
        ...ack,
        credentialRef: "vault/x",
      });
      const key = idemKey("same");
      const q = {
        connectorId: "test-scripted-feed",
        query: { text: "anything" },
      };
      const first = (await (
        await call(a, id, { ...q, idempotencyKey: key })
      ).json()) as Obs;
      expect(first.replayed).toBe(false);
      const second = (await (
        await call(a, id, { ...q, idempotencyKey: key })
      ).json()) as Obs;
      expect(second.replayed).toBe(true);
      expect(second.callId).toBe(first.callId);
      expect(second.observation).toEqual(first.observation);
      expect(script.calls).toBe(1);
      const clash = await call(a, id, {
        ...q,
        query: { text: "different" },
        idempotencyKey: key,
      });
      expect([clash.status, await reason(clash)]).toEqual([
        409,
        "IDEMPOTENCY_KEY_REUSED",
      ]);

      script.calls = 0;
      const k2 = idemKey("race");
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          call(a, id, { ...q, idempotencyKey: k2 }),
        ),
      );
      expect(script.calls).toBe(1);
      for (const r of results) expect([200, 409]).toContain(r.status);
      expect(
        results.filter((r) => r.status === 200).length,
      ).toBeGreaterThanOrEqual(1);
      const again = await call(a, id, { ...q, idempotencyKey: k2 });
      expect(again.status).toBe(200);
      expect(script.calls).toBe(1);
    });

    it("the hourly allowance holds under concurrency and renews with time", async () => {
      const { owner, id, a } = await setup();
      await post(owner, `${CONNECTORS}/test-scripted-feed/install`, {
        ...ack,
        credentialRef: "vault/x",
      });
      const q = { connectorId: "test-scripted-feed", query: { text: "x" } };
      const burst = await Promise.all(
        Array.from({ length: 9 }, () => call(a, id, { ...q })),
      );
      const codes = burst.map((r) => r.status).sort();
      expect(codes.filter((c) => c === 200).length).toBe(3);
      expect(codes.filter((c) => c === 429).length).toBe(6);
      expect(script.calls).toBe(3);
      h.advance(61 * 60_000);
      // The clock moved an hour, so the agent's credential has expired: a member read settles that, then a fresh one is issued.
      await h.call(owner, "GET", `${MISSIONS}/${id}/plans`);
      const fresh = await h.agentToken("a");
      expect((await call(fresh, id, { ...q })).status).toBe(200);
    });

    it("a connector that fails, hangs or answers badly is contained: nothing it said is shown, failures are recorded, and repeated failure opens a circuit", async () => {
      const { owner, id, a } = await setup();
      await post(owner, `${CONNECTORS}/test-scripted-feed/install`, {
        ...ack,
        credentialRef: "vault/x",
      });
      // callsPerHour is 3 on the double: use fresh missions' budgets by raising nothing - spread failures over missions instead
      const q = {
        connectorId: "test-scripted-feed",
        query: { text: "x", limit: 5 },
      };
      const expectFailure = async (
        b: Behaviour,
        status: number,
        code: string,
        tok: string,
        mid: string,
      ) => {
        script.behaviour = b;
        const r = await call(tok, mid, q);
        const text = await r.text();
        expect(
          [r.status, (JSON.parse(text) as { reason: string }).reason],
          b,
        ).toEqual([status, code]);
        for (const leak of [
          "SECRET-INTERNAL-DETAIL",
          "INJECTED-TEXT",
          "supplier.example",
          "pw@",
        ])
          expect(text, `${b} leaked ${leak}`).not.toContain(leak);
      };
      await expectFailure("throw", 502, "CONNECTOR_FAILED", a, id);
      await expectFailure("hang", 504, "CONNECTOR_TIMEOUT", a, id);
      await expectFailure("badshape", 502, "CONNECTOR_INVALID_OUTPUT", a, id);
      // the circuit is open after three consecutive failures: no further call reaches the adapter
      const before = script.calls;
      script.behaviour = "ok";
      const blocked = await call(a, id, q);
      expect([blocked.status, await reason(blocked)]).toEqual([
        503,
        "CONNECTOR_DEGRADED",
      ]);
      expect(script.calls).toBe(before);
      expect(await statusOf(owner, "test-scripted-feed")).toBe("DEGRADED");
      // after the cool-down it is READY again; one success clears the count
      h.advance(6 * 60_000);
      await h.call(owner, "GET", `${MISSIONS}/${id}/plans`);
      expect(await statusOf(owner, "test-scripted-feed")).toBe("READY");
      // one success clears the failure count
      const m2 = await setup();
      expect((await call(m2.a, m2.id, q)).status).toBe(200);
      const [inst] = await h.repo
        .sql`select consecutive_failures, breaker_open_until from connector_installs where connector_id = 'test-scripted-feed'`;
      expect([
        Number(inst!.consecutive_failures),
        inst!.breaker_open_until,
      ]).toEqual([0, null]);
      for (const [b, label] of [
        ["huge", "oversized"],
        ["toomany", "too many records"],
        ["httpurl", "non-https url"],
        ["userinfo", "credentials in url"],
      ] as const) {
        const fresh = await setup();
        await post(fresh.owner, `${CONNECTORS}/test-scripted-feed/install`, {
          ...ack,
          credentialRef: "vault/x",
        });
        script.behaviour = b;
        const r = await call(fresh.a, fresh.id, q);
        expect([r.status, await reason(r)], label).toEqual([
          502,
          "CONNECTOR_INVALID_OUTPUT",
        ]);
        h.advance(6 * 60_000);
      }
      // failed calls are recorded, with no result body and no error text
      const log = (await (
        await h.call(
          owner,
          "GET",
          `/v1/admin/org/connector-calls?missionId=${id}`,
        )
      ).json()) as {
        calls: { outcome: string; errorCode: string | null }[];
      };
      expect(log.calls.map((x) => x.outcome).sort()).toEqual([
        "ERROR",
        "INVALID_OUTPUT",
        "TIMEOUT",
      ]);
      expect(JSON.stringify(log)).not.toContain("SECRET-INTERNAL-DETAIL");
      // a failed key replays as the same failure without calling out
      const rows = await h.repo
        .sql`select idempotency_key, outcome from connector_calls where mission_id = ${id} and outcome = 'ERROR'`;
      const callsBefore = script.calls;
      script.behaviour = "ok";
      const replay = await call(a, id, {
        ...q,
        idempotencyKey: String(rows[0]!.idempotency_key),
      });
      expect([replay.status, await reason(replay)]).toEqual([
        502,
        "CONNECTOR_FAILED",
      ]);
      expect(script.calls).toBe(callsBefore);
    });

    it("planning sees only connectors that are READY: a plan proposed after installing is executable, after suspending it is not", async () => {
      const { owner, id } = await setup(
        buy({ approvedProviderTypes: ["COMMERCE_MARKETPLACE"] }),
      );
      const sec = await h.member("SECURITY_ADMIN");
      const base = `${CONNECTORS}/payflow-demo-catalog`;
      type Plan = { tasks: { key: string; readiness: string }[] };
      const readinessOf = async () => {
        const r = await post(owner, `${MISSIONS}/${id}/plans`, {
          source: "TEMPLATE",
          idempotencyKey: idemKey("p"),
        });
        expect(r.status).toBe(201);
        const cur = (await (
          await h.call(owner, "GET", `${MISSIONS}/${id}/plans`)
        ).json()) as {
          plans: { planVersion: number }[];
        };
        const v = Math.max(...cur.plans.map((p) => p.planVersion));
        const tasks = (await (
          await h.call(owner, "GET", `${MISSIONS}/${id}/plans/${v}`)
        ).json()) as Plan;
        return tasks.tasks.find((t) => t.key === "source-offers")!.readiness;
      };
      expect(await readinessOf()).toBe("PREPARED_HANDOFF");
      await post(owner, `${base}/install`, ack);
      expect(await readinessOf()).toBe("EXECUTABLE");
      await post(sec, `${base}/suspend`);
      expect(await readinessOf()).toBe("PREPARED_HANDOFF");
    });

    it("the call log is append-only at the database: a finished call cannot be edited or deleted", async () => {
      const { owner, id, a } = await setup();
      await post(owner, `${CONNECTORS}/payflow-demo-catalog/install`, ack);
      const r = (await (await call(a, id)).json()) as Obs;
      await expect(
        h.repo
          .sql`update connector_calls set outcome = 'ERROR' where call_id = ${r.callId}`,
      ).rejects.toThrow();
      await expect(
        h.repo
          .sql`update connector_calls set result = '{}'::jsonb where call_id = ${r.callId}`,
      ).rejects.toThrow();
      await expect(
        h.repo.sql`delete from connector_calls where call_id = ${r.callId}`,
      ).rejects.toThrow();
      const [row] = await h.repo
        .sql`select outcome, record_count from connector_calls where call_id = ${r.callId}`;
      expect([row!.outcome, Number(row!.record_count)]).toEqual(["OK", 1]);
      const audit = (
        await h.repo
          .sql`select action from organization_audit_events where subject_id = ${r.callId}`
      ).map((x) => String(x.action));
      expect(audit).toEqual(["CONNECTOR_CALLED"]);
    });
  },
);
