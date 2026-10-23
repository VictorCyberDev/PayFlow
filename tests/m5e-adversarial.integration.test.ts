import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
} from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresTrustRepository } from "../src/persistence.js";
import { ConsoleSessions } from "../src/console-session.js";
import {
  ConsoleActivation,
  type PendingAuthoritySchema,
} from "../src/console-activation.js";
import { ConsoleControls } from "../src/console-controls.js";
import { ConsoleActivity } from "../src/activity-postgres.js";
import { StaticPublicKeyRing } from "../src/execution-grant.js";
import { activationHttpHandler } from "../src/console-activation-host.js";
import { IntentReviewService } from "../src/intent-review.js";
import {
  IntentActivationService,
  HumanConfirmationBoundary,
} from "../src/intent-activation.js";
import { activationFixture } from "./activation-fixture.js";
import type { IntentModelProvider } from "../src/intent-model.js";
import type { z } from "zod";
const url = process.env.TEST_DATABASE_URL,
  run = url ? describe : describe.skip;
const bootstrap = "m5e-private-test-bootstrap-".repeat(3);
const PAYMENT_TABLES = [
  "payment_attempts",
  "authorization_reservations",
  "execution_grants",
  "transaction_proposals",
  "paypal_provider_observations",
];
run(
  "M5E adversarial acceptance over the actual HTTP host (isolated PostgreSQL)",
  () => {
    let repo: PostgresTrustRepository,
      server: Server,
      origin: string,
      directory: string,
      time: Date,
      sessions: ConsoleSessions,
      app: ConsoleActivation;
    let auth: { cookie: string; csrf: string };
    const clock = () => new Date(time);
    const f = activationFixture();
    const policy = {
      version: "payflow.activation-policy.v1",
      maximumMinor: 10000,
      maximumQuantity: 1,
      currencies: ["USD"],
      capabilities: [
        "SEARCH_PRODUCTS",
        "EVALUATE_PRODUCTS",
        "CREATE_ORDER",
        "CAPTURE_PAYMENT",
      ],
      merchantIds: ["Amazon"],
      merchantRiskCeiling: "LOW",
      maximumLifetimeSeconds: 86400 * 30,
    };
    const provider: IntentModelProvider = {
      interpretIntent(s) {
        return Promise.resolve({
          status: "INTERPRETED",
          candidate: { ...f.candidate, sourceReference: s.reference },
        });
      },
    };
    type Pending = z.infer<typeof PendingAuthoritySchema>;
    const post = (
      path: string,
      body: unknown,
      extra: Record<string, string | undefined> = {},
    ) => {
      const headers: Record<string, string> = {
        origin,
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-payflow-csrf": auth.csrf,
      };
      for (const [k, v] of Object.entries(extra))
        if (v === undefined) delete headers[k];
        else headers[k] = v;
      return fetch(origin + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    };
    const get = (path: string, cookie: string | undefined = auth.cookie) =>
      fetch(origin + path, cookie ? { headers: { cookie } } : {});
    const prepare = async () => {
      const r = await post("/api/activation/reviews", {
        source: f.context.source.text,
      });
      expect(r.status).toBe(200);
      return (await r.json()) as Pending;
    };
    const confirmBody = (p: Pending) => ({
      action: "CONFIRM_EXACT_TERMS",
      reviewId: p.reviewId,
      displayHash: p.displayHash,
    });
    const activate = async () => {
      const p = await prepare();
      const r = await post("/api/activation/confirm", confirmBody(p));
      expect(r.status).toBe(200);
      return ((await r.json()) as { mandateId: string }).mandateId;
    };
    const mandates = async () =>
      Number((await repo.sql`select count(*) n from mandates`)[0]!.n);
    const evidence = async () =>
      JSON.stringify(
        await repo.sql`select sequence,type,data from evidence_events order by sequence`,
      );
    const durable = async () =>
      JSON.stringify(
        await repo.sql`select (select jsonb_agg(to_jsonb(m)) from mandates m) mandates,(select count(*) from evidence_events) events`,
      );
    const paymentRows = async () => {
      const out: Record<string, number> = {};
      for (const t of PAYMENT_TABLES)
        out[t] = Number(
          (await repo.sql.unsafe(`select count(*) n from ${t}`))[0]!.n,
        );
      return out;
    };
    const login = async () => {
      const r = await fetch(origin + "/api/activation/session", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ bootstrapCode: bootstrap }),
      });
      expect(r.status).toBe(200);
      const s = (await r.json()) as { csrfToken: string };
      return {
        raw: r,
        auth: {
          cookie: r.headers.get("set-cookie")!.split(";")[0]!,
          csrf: s.csrfToken,
        },
      };
    };
    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const name of (await readdir("db/migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile("db/migrations/" + name, "utf8"));
      directory = await mkdtemp(join(tmpdir(), "payflow-m5e-"));
      await writeFile(join(directory, "index.html"), "<p>console</p>");
    });
    beforeEach(async () => {
      time = new Date("2026-10-23T10:00:00.000Z");
      await repo.sql`truncate principals cascade`;
      await repo.sql`truncate evidence_events restart identity`;
      for (const [id, name] of [
        ["p", "Human"],
        ["other", "Other"],
      ])
        await repo.savePrincipal({ id: id!, displayName: name! });
      for (const [id, principalId] of [
        ["a", "p"],
        ["othera", "other"],
      ])
        await repo.saveAgent({
          id: id!,
          principalId: principalId!,
          displayName: "Shopping Agent",
          issuedAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-11-15T00:00:00.000Z",
          status: "ACTIVE",
          capabilities: policy.capabilities as never,
        });
      const provisioning = new IntentActivationService(
        repo,
        new HumanConfirmationBoundary(
          { verify: () => Promise.reject(new Error("NO_TEST_AUTH_BYPASS")) },
          clock,
        ),
        clock,
      );
      await provisioning.provisionPolicy("p", policy);
      await provisioning.provisionPolicy("other", policy);
      server = createServer((req, res) => {
        void handler(req, res);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      sessions = new ConsoleSessions(
        { principalId: "p", origin, bootstrapKey: bootstrap },
        clock,
      );
      app = new ConsoleActivation(
        repo,
        sessions,
        { agentId: "a", provider, bounds: () => f.context.reviewBounds },
        clock,
      );
      const handler = activationHttpHandler(app, {
        sample: f.context.source.text,
        review: new IntentReviewService(
          provider,
          () => f.context.reviewBounds,
          clock,
        ),
        outputDirectory: directory,
        controls: new ConsoleControls(repo, sessions, clock),
        activity: new ConsoleActivity(
          repo,
          sessions,
          new StaticPublicKeyRing(new Map()),
          clock,
        ),
      });
      auth = (await login()).auth;
    });
    afterEach(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    });
    afterAll(async () => {
      await repo.close();
      await rm(directory, { recursive: true });
    });

    // A. Client authority tampering --------------------------------------
    it.each([
      "amountMinor",
      "maximumMinor",
      "cumulativeMaximumMinor",
      "maximumQuantity",
      "quantity",
      "merchant",
      "merchantIds",
      "condition",
      "conditions",
      "capabilities",
      "allowedCapabilities",
      "expiresAt",
      "source",
    ])("A1-A5 confirm with injected %s cannot affect terms", async (field) => {
      const p = await prepare();
      const r = await post("/api/activation/confirm", {
        ...confirmBody(p),
        [field]: field.includes("apab")
          ? ["TRANSFER_FUNDS"]
          : field === "merchant" || field === "merchantIds"
            ? ["Evil"]
            : 999999,
      });
      expect(r.status).not.toBe(200);
      expect(await mandates()).toBe(0);
      // Untampered confirm of the same review still yields the exact reviewed terms.
      const ok = await post("/api/activation/confirm", confirmBody(p));
      expect(ok.status).toBe(200);
      const id = ((await ok.json()) as { mandateId: string }).mandateId;
      const m = await repo.getMandate(id);
      expect(m?.maxSingleTransactionMinor).toBe(9999);
      expect(JSON.stringify(m?.merchantScope)).toContain("Amazon");
      expect(JSON.stringify(m?.merchantScope)).not.toContain("Evil");
      expect(m?.allowedCapabilities).not.toContain("TRANSFER_FUNDS");
      expect(await mandates()).toBe(1);
    });
    it.each(["maximumMinor", "merchantIds", "principalId", "agentId"])(
      "A1-A5 review request with client %s is rejected before any review exists",
      async (field) => {
        const r = await post("/api/activation/reviews", {
          source: f.context.source.text,
          [field]: field === "maximumMinor" ? 999999 : ["x"],
        });
        expect(r.status).not.toBe(200);
        expect(
          Number((await repo.sql`select count(*) n from intent_reviews`)[0]!.n),
        ).toBe(0);
      },
    );
    it("A6/A7 injected ACTIVE state and remaining budget are rejected; durable accounting wins", async () => {
      const id = await activate();
      await repo.revokeMandate(id, time.toISOString());
      for (const q of [
        "&state=ACTIVE",
        "&remainingMinor=999999",
        "&freshDispatchBlocked=false",
      ])
        expect(
          (await get("/api/activation/authority?mandateId=" + id + q)).status,
        ).toBe(400);
      for (const headers of [
        { "x-payflow-state": "ACTIVE" },
        { "x-remaining-minor": "999999" },
      ]) {
        const r = await fetch(
          origin + "/api/activation/authority?mandateId=" + id,
          {
            headers: { cookie: auth.cookie, ...headers },
          },
        );
        expect(((await r.json()) as { state: string }).state).toBe("REVOKED");
      }
      const list = (await (
        await get("/api/activation/authorities")
      ).json()) as {
        items: { state: string }[];
      };
      expect(list.items.map((i) => i.state)).toEqual(["REVOKED"]);
    });
    it("A7 remaining budget is the durable accounting value, not a client value", async () => {
      const id = await activate();
      const r = (await (
        await get("/api/activation/authority?mandateId=" + id)
      ).json()) as { remainingMinor: number; state: string };
      expect(r.state).toBe("ACTIVE");
      expect(r.remainingMinor).toBe(9999);
      await repo.sql`update mandates set reserved_minor=reserved_minor`.catch(
        () => undefined,
      );
      expect(
        (
          (await (
            await get("/api/activation/authority?mandateId=" + id)
          ).json()) as { remainingMinor: number }
        ).remainingMinor,
      ).toBe(9999);
    });

    // B. Owner / session attacks -----------------------------------------
    it("B1 a single changed character in a valid session cookie fails every route", async () => {
      const id = await activate();
      const [name, value] = auth.cookie.split("=") as [string, string];
      const flipped = `${name}=${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
      for (const path of [
        "/api/activation/session",
        "/api/activation/authorities",
        "/api/activation/activity",
        "/api/activation/authority?mandateId=" + id,
      ])
        expect((await get(path, flipped)).status).toBeGreaterThanOrEqual(400);
      expect(
        (
          await post(
            "/api/activation/revoke",
            { action: "REVOKE_AUTHORITY", mandateId: id },
            { cookie: flipped },
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          (await (
            await get("/api/activation/authority?mandateId=" + id)
          ).json()) as { state: string }
        ).state,
      ).toBe("ACTIVE");
    });
    it("B2 expired session fails reads and every mutation", async () => {
      const id = await activate();
      time = new Date(time.getTime() + 900000);
      expect((await get("/api/activation/authorities")).status).toBe(400);
      for (const [path, body] of [
        ["/api/activation/reviews", { source: f.context.source.text }],
        [
          "/api/activation/revoke",
          { action: "REVOKE_AUTHORITY", mandateId: id },
        ],
      ] as const)
        expect((await post(path, body)).status).toBe(400);
      time = new Date("2026-10-23T10:00:00.000Z");
      expect(
        (await repo.getMandate(id)) &&
          (await get("/api/activation/authority?mandateId=" + id)).status,
      ).toBe(200);
    });
    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["wrong", "x".repeat(43)],
    ])("B3/B4 %s CSRF fails review, confirm and revoke", async (_n, csrf) => {
      const p = await prepare();
      const id = await activate();
      for (const [path, body] of [
        ["/api/activation/reviews", { source: f.context.source.text }],
        ["/api/activation/confirm", confirmBody(p)],
        [
          "/api/activation/revoke",
          { action: "REVOKE_AUTHORITY", mandateId: id },
        ],
        ["/api/activation/logout", {}],
      ] as const)
        expect(
          (await post(path, body, { "x-payflow-csrf": csrf })).status,
        ).toBeGreaterThanOrEqual(400);
      expect(await mandates()).toBe(1);
      expect(
        (
          (await (
            await get("/api/activation/authority?mandateId=" + id)
          ).json()) as { state: string }
        ).state,
      ).toBe("ACTIVE");
    });
    it.each([
      ["foreign origin", { origin: "https://attacker.invalid" }],
      ["missing origin", { origin: undefined }],
      ["null origin", { origin: "null" }],
      ["sibling port", { origin: "http://127.0.0.1:1" }],
    ])("B5 cross-origin mutation (%s) is rejected", async (_n, headers) => {
      const id = await activate();
      for (const [path, body] of [
        ["/api/activation/reviews", { source: f.context.source.text }],
        [
          "/api/activation/revoke",
          { action: "REVOKE_AUTHORITY", mandateId: id },
        ],
      ] as const)
        expect((await post(path, body, headers)).status).toBe(400);
      expect(
        (
          (await (
            await get("/api/activation/authority?mandateId=" + id)
          ).json()) as { state: string }
        ).state,
      ).toBe("ACTIVE");
    });
    it("B5 no CORS grant on any response, including preflight and errors", async () => {
      const responses = [
        await get("/api/activation/session"),
        await get("/api/activation/authorities", undefined),
        await fetch(origin + "/api/activation/revoke", {
          method: "OPTIONS",
          headers: {
            origin: "https://attacker.invalid",
            "access-control-request-method": "POST",
          },
        }),
        await post(
          "/api/activation/revoke",
          {},
          { origin: "https://attacker.invalid" },
        ),
      ];
      for (const r of responses) {
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
        expect(r.headers.get("access-control-allow-credentials")).toBeNull();
      }
    });
    it("B6 client-supplied principal in body, query or header never changes owner", async () => {
      const id = await activate();
      for (const field of ["principalId", "principal", "ownerId", "userId"]) {
        expect(
          (
            await post("/api/activation/revoke", {
              action: "REVOKE_AUTHORITY",
              mandateId: id,
              [field]: "other",
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await post("/api/activation/reviews", {
              source: f.context.source.text,
              [field]: "other",
            })
          ).status,
        ).not.toBe(200);
        expect(
          (await get(`/api/activation/authorities?${field}=other`)).status,
        ).toBe(400);
        expect(
          (await get(`/api/activation/activity?${field}=other`)).status,
        ).toBe(400);
        expect(
          (
            await get(
              `/api/activation/authority?mandateId=${id}&${field}=other`,
            )
          ).status,
        ).toBe(400);
      }
      expect(
        (
          await post(
            "/api/activation/session",
            { bootstrapCode: bootstrap, principalId: "other" },
            {
              cookie: undefined,
              "x-payflow-csrf": undefined,
            },
          )
        ).status,
      ).toBe(400);
      // A header claiming another owner is ignored: still the configured owner.
      const r = await fetch(origin + "/api/activation/authorities", {
        headers: { cookie: auth.cookie, "x-principal-id": "other" },
      });
      expect(
        ((await r.json()) as { items: { mandateId?: string }[] }).items.length,
      ).toBe(1);
      expect(await repo.getMandate(id).then((m) => m?.principalId)).toBe("p");
    });
    it("B7 another principal's mandate id: no disclosure, no mutation, indistinguishable from unknown", async () => {
      // Mandate owned by `other`, created through the accepted activation path.
      const otherSessions = new ConsoleSessions(
        { principalId: "other", origin, bootstrapKey: bootstrap },
        clock,
      );
      const otherApp = new ConsoleActivation(
        repo,
        otherSessions,
        { agentId: "othera", provider, bounds: () => f.context.reviewBounds },
        clock,
      );
      const lg = otherSessions.login(
        { host: new URL(origin).host, origin },
        { bootstrapCode: bootstrap },
      );
      const oreq = {
        host: new URL(origin).host,
        origin,
        cookie: lg.cookie.split(";")[0],
        csrf: lg.view.csrfToken,
      };
      const op = await otherApp.prepare(oreq, {
        source: f.context.source.text,
      });
      const done = await otherApp.confirm(oreq, {
        action: "CONFIRM_EXACT_TERMS",
        reviewId: op.reviewId,
        displayHash: op.displayHash,
      });
      expect(done.status).toBe("ACTIVATED");
      const foreignId = (done as { mandateId: string }).mandateId;
      const before = await durable();
      const read = await get(
        "/api/activation/authority?mandateId=" + foreignId,
      );
      const unknown = await get("/api/activation/authority?mandateId=nope");
      expect(read.status).toBe(unknown.status);
      expect(await read.text()).toBe(await unknown.text());
      const rev = await post("/api/activation/revoke", {
        action: "REVOKE_AUTHORITY",
        mandateId: foreignId,
      });
      const revUnknown = await post("/api/activation/revoke", {
        action: "REVOKE_AUTHORITY",
        mandateId: "nope",
      });
      expect(rev.status).toBe(revUnknown.status);
      expect(await rev.text()).toBe(await revUnknown.text());
      expect(
        (await get("/api/activation/activity?operationId=" + foreignId)).status,
      ).toBe(400);
      const list = (await (
        await get("/api/activation/authorities")
      ).json()) as {
        items: unknown[];
      };
      expect(list.items).toHaveLength(0);
      expect(await durable()).toBe(before);
      expect((await repo.getMandate(foreignId))?.principalId).toBe("other");
    });

    // C. Replay / concurrency (HTTP, full set) ---------------------------
    it("C2/C3 many concurrent confirmations still create exactly one Mandate", async () => {
      const p = await prepare();
      const rs = await Promise.all(
        Array.from({ length: 8 }, () =>
          post("/api/activation/confirm", confirmBody(p)),
        ),
      );
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await mandates()).toBe(1);
      expect(
        (
          await repo.sql`select count(*) n from evidence_events where type='INTENT_MANDATE_ACTIVATED'`
        )[0]!.n,
      ).toBe("1");
    });
    it("C1 expired review cannot activate after clock passes its deadline", async () => {
      const p = await prepare();
      time = new Date(time.getTime() + 301000);
      const t = new Date(time);
      // fresh session needed because the prior one is still valid (15 min); confirm fails on review expiry
      expect(
        (await post("/api/activation/confirm", confirmBody(p))).status,
      ).toBe(409);
      expect(t.getTime()).toBeGreaterThan(0);
      expect(await mandates()).toBe(0);
    });

    // D / E. Full journey: revoke, stale correction, read-only, zero payment
    it("D1-D6/E1-E5 activate, read, revoke, repeat/concurrent revoke, reload: durable truth, read-only, zero payment rows", async () => {
      const zero = await paymentRows();
      expect(Object.values(zero).every((n) => n === 0)).toBe(true);
      const id = await activate();
      const reads = [
        "/api/activation/authorities",
        "/api/activation/activity",
        "/api/activation/authority?mandateId=" + id,
        "/api/activation/session",
      ];
      let before = await evidence();
      const beforeDurable = await durable();
      for (let i = 0; i < 5; i++)
        for (const path of reads) expect((await get(path)).status).toBe(200);
      expect(await evidence()).toBe(before); // E1-E4
      expect(await durable()).toBe(beforeDurable);
      const stale = (await (
        await get("/api/activation/authority?mandateId=" + id)
      ).json()) as { state: string };
      expect(stale.state).toBe("ACTIVE"); // what an old tab still shows
      const body = { action: "REVOKE_AUTHORITY", mandateId: id };
      const rs = await Promise.all([
        post("/api/activation/revoke", body),
        post("/api/activation/revoke", body),
        post("/api/activation/revoke", body),
      ]);
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(Object.keys((await rs[0].json()) as object).sort()).toEqual([
        "mandateId",
        "status",
      ]);
      expect((await post("/api/activation/revoke", body)).status).toBe(200); // D4 repeat
      expect(
        (
          await repo.sql`select count(*) n from evidence_events where type='MANDATE_REVOKED'`
        )[0]!.n,
      ).toBe("1");
      // D2/D3: reload and the "old tab" poll both observe the durable truth.
      for (let i = 0; i < 2; i++) {
        const v = (await (
          await get("/api/activation/authority?mandateId=" + id)
        ).json()) as { state: string; freshDispatchBlocked: boolean };
        expect(v.state).toBe("REVOKED");
        expect(v.freshDispatchBlocked).toBe(true);
      }
      before = await evidence();
      for (const path of reads.slice(0, 3)) await get(path); // E5
      expect(await evidence()).toBe(before);
      // Nothing can restore ACTIVE: re-confirming consumed review and re-revoking are inert.
      expect(
        (await repo.sql`select revoked_at from mandates where id=${id}`)[0]!
          .revoked_at,
      ).not.toBeNull();
      expect(await paymentRows()).toEqual(zero); // D6 and zero-payment closure
    });
    it("D5 wrong principal's session cannot revoke this owner's Authority", async () => {
      const id = await activate();
      const otherSessions = new ConsoleSessions(
        { principalId: "other", origin, bootstrapKey: bootstrap },
        clock,
      );
      const lg = otherSessions.login(
        { host: new URL(origin).host, origin },
        { bootstrapCode: bootstrap },
      );
      const controls = new ConsoleControls(repo, otherSessions, clock);
      await expect(
        controls.revoke(
          {
            host: new URL(origin).host,
            origin,
            cookie: lg.cookie.split(";")[0],
            csrf: lg.view.csrfToken,
          },
          { action: "REVOKE_AUTHORITY", mandateId: id },
        ),
      ).rejects.toThrow();
      expect(
        (await repo.sql`select revoked_at from mandates where id=${id}`)[0]!
          .revoked_at,
      ).toBeNull();
    });

    // Host surface -------------------------------------------------------
    it("no debug/environment endpoint, no stack traces, fixed safe error text", async () => {
      for (const path of [
        "/api/env",
        "/api/debug",
        "/api/health",
        "/api/config",
        "/api/activation/debug",
        "/api/activation/provision",
        "/api/activation/mandates",
      ]) {
        for (const r of [await get(path), await post(path, {})]) {
          expect(r.status).toBeGreaterThanOrEqual(400);
          const text = await r.text();
          expect(text).not.toMatch(
            /at .*\.(ts|js):\d+|node_modules|DATABASE_URL|postgres:\/\//,
          );
        }
      }
      const bad = await post("/api/activation/confirm", { junk: true });
      const text = await bad.text();
      expect(text).toMatch(/could not be verified/);
      expect(text).not.toMatch(/ZodError|stack|Error:/);
    });
    it("unauthenticated visitors can mutate nothing", async () => {
      const anon = { origin, "content-type": "application/json" };
      for (const path of [
        "/api/activation/reviews",
        "/api/activation/confirm",
        "/api/activation/revoke",
        "/api/activation/logout",
      ]) {
        const r = await fetch(origin + path, {
          method: "POST",
          headers: anon,
          body: "{}",
        });
        expect(r.status).toBeGreaterThanOrEqual(400);
      }
      expect(await mandates()).toBe(0);
    });
    it("session cookie attributes and no secret/raw challenge in login or review output", async () => {
      const { raw } = await login();
      const cookie = raw.headers.get("set-cookie")!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Max-Age=900/);
      const p = await prepare();
      const surfaces = JSON.stringify(p) + cookie;
      expect(surfaces).not.toContain(bootstrap);
      expect(surfaces).not.toMatch(
        /challenge|reviewedHash|DATABASE_URL|grant|resume|privateKey/i,
      );
    });
    it("a lone review (no confirmation) leaves no Mandate and no payment rows; reload creates none", async () => {
      await prepare();
      await get("/api/activation/authorities");
      expect(await mandates()).toBe(0);
      expect(Object.values(await paymentRows()).every((n) => n === 0)).toBe(
        true,
      );
    });
  },
);
