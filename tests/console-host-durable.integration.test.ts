import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
} from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  hostedSample,
  parseHostedConfig,
  type HostedConfig,
} from "../src/console-hosted.js";
import {
  DurableConsoleSessions,
  deriveHostKeys,
} from "../src/console-session-durable.js";
import {
  protectChallenge,
  unprotectChallenge,
} from "../src/console-pending.js";
import {
  IntentActivationService,
  HumanConfirmationBoundary,
} from "../src/intent-activation.js";

const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m5e-host-private-bootstrap-".repeat(3);
const PAYMENT_TABLES = [
  "payment_attempts",
  "authorization_reservations",
  "execution_grants",
  "transaction_proposals",
  "paypal_provider_observations",
];
type Hosted = ReturnType<typeof createHostedConsole>;
type Auth = { cookie: string; csrf: string };
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const policy = {
  version: "payflow.activation-policy.v1",
  maximumMinor: 10000,
  maximumQuantity: 1,
  currencies: ["USD"],
  capabilities,
  merchantIds: ["payflow.demo.merchant"],
  merchantRiskCeiling: "LOW",
  maximumLifetimeSeconds: 86400 * 30,
};

(url ? describe : describe.skip)(
  "M5E-HOST durable host state across independent host instances (PostgreSQL + actual HTTP)",
  () => {
    let repo: PostgresTrustRepository,
      front: Server,
      origin: string,
      time: Date;
    const fleet = new Map<string, Hosted>();
    const clock = () => new Date(time);
    const config = (): HostedConfig =>
      parseHostedConfig({
        PAYFLOW_M5_DEMO: "true",
        DATABASE_URL: url,
        PAYFLOW_M5_PRINCIPAL_ID: "p",
        PAYFLOW_M5_AGENT_ID: "a",
        PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
        PAYFLOW_M5_ORIGIN: origin,
      });
    /** Start a brand-new host instance: new connection pool, new objects, no shared memory. */
    const spawn = (name: string) => {
      const h = createHostedConsole(config(), { clock });
      fleet.set(name, h);
      return h;
    };
    /** Destroy an instance: close its pool and drop every object it held. */
    const kill = async (name: string) => {
      await fleet.get(name)?.close();
      fleet.delete(name);
    };
    const call = (
      via: string,
      path: string,
      init: {
        method?: string;
        body?: unknown;
        auth?: Auth | undefined;
        headers?: Record<string, string | undefined>;
      } = {},
    ) => {
      const headers: Record<string, string> = {
        "x-test-instance": via,
        origin,
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...(init.auth
          ? { cookie: init.auth.cookie, "x-payflow-csrf": init.auth.csrf }
          : {}),
      };
      for (const [k, v] of Object.entries(init.headers ?? {}))
        if (v === undefined) delete headers[k];
        else headers[k] = v;
      return fetch(origin + path, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    };
    const login = async (via: string) => {
      const r = await call(via, "/api/activation/session", {
        body: { bootstrapCode: bootstrap },
      });
      expect(r.status).toBe(200);
      const v = (await r.json()) as { csrfToken: string };
      return {
        auth: {
          cookie: r.headers.get("set-cookie")!.split(";")[0]!,
          csrf: v.csrfToken,
        },
        setCookie: r.headers.get("set-cookie")!,
      };
    };
    const sampleText = async (via: string, auth: Auth) =>
      (
        (await (
          await call(via, "/api/intent-review/sample", { auth })
        ).json()) as { sample: string }
      ).sample;
    type Pending = { reviewId: string; displayHash: string };
    const prepare = async (via: string, auth: Auth) => {
      const r = await call(via, "/api/activation/reviews", {
        auth,
        body: { source: await sampleText(via, auth) },
      });
      expect(r.status).toBe(200);
      return (await r.json()) as Pending;
    };
    const confirmBody = (p: Pending, extra: object = {}) => ({
      action: "CONFIRM_EXACT_TERMS",
      reviewId: p.reviewId,
      displayHash: p.displayHash,
      ...extra,
    });
    const confirm = (via: string, auth: Auth, p: Pending, extra?: object) =>
      call(via, "/api/activation/confirm", {
        auth,
        body: confirmBody(p, extra),
      });
    const authority = async (via: string, auth: Auth, id: string) =>
      (await (
        await call(via, "/api/activation/authority?mandateId=" + id, { auth })
      ).json()) as { state: string; remainingMinor: number };
    const mandates = async () =>
      Number((await repo.sql`select count(*) n from mandates`)[0]!.n);
    const paymentRows = async () => {
      const out: Record<string, number> = {};
      for (const t of PAYMENT_TABLES)
        out[t] = Number(
          (await repo.sql.unsafe(`select count(*) n from ${t}`))[0]!.n,
        );
      return out;
    };

    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const n of (await readdir("db/migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile("db/migrations/" + n, "utf8"));
      // One stable public origin in front of independently created host instances.
      front = createServer((req, res) => {
        const inst = fleet.get(String(req.headers["x-test-instance"] ?? ""));
        if (!inst) return void res.writeHead(502).end();
        void inst.handler(req, res);
      });
      await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
    });
    beforeEach(async () => {
      time = new Date("2026-10-23T10:00:00.000Z");
      await repo.sql`truncate principals cascade`;
      await repo.sql`truncate evidence_events restart identity`;
      await repo.sql`truncate console_demo_sessions cascade`;
      await repo.sql`update console_demo_login_window set window_started_at='epoch', attempts=0`;
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
          capabilities,
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
    });
    afterEach(async () => {
      for (const name of [...fleet.keys()]) await kill(name);
    });
    afterAll(async () => {
      await new Promise<void>((r) => front.close(() => r()));
      await repo.close();
    });

    // --- The blocker, proven fixed -------------------------------------------------
    it("REQUIRED restart pattern: login, destroy, session valid, pending review, destroy, one confirmation, destroy, replay fails", async () => {
      const zero = await paymentRows();
      spawn("i1");
      const { auth } = await login("i1"); // request 1
      await kill("i1"); // process instance destroyed
      spawn("i2");
      const s = await call("i2", "/api/activation/session", { auth }); // request 2
      expect(s.status).toBe(200);
      expect(((await s.json()) as { csrfToken: string }).csrfToken).toBe(
        auth.csrf,
      );
      const pending = await prepare("i2", auth); // request 3
      expect(await mandates()).toBe(0);
      await kill("i2");
      spawn("i3");
      const done = await confirm("i3", auth, pending); // request 4
      expect(done.status).toBe(200);
      const { mandateId } = (await done.json()) as { mandateId: string };
      expect(await mandates()).toBe(1);
      await kill("i3");
      spawn("i4");
      expect((await confirm("i4", auth, pending)).status).toBe(409); // request 5
      expect(await mandates()).toBe(1);
      const view = await authority("i4", auth, mandateId);
      expect(view.state).toBe("ACTIVE");
      expect(view.remainingMinor).toBe(10000);
      expect(await paymentRows()).toEqual(zero);
    });
    it("a pending review created before an instance dies is still consumable once by any later instance", async () => {
      spawn("a");
      const { auth } = await login("a");
      const p = await prepare("a", auth);
      await kill("a");
      spawn("b");
      spawn("c");
      const results = await Promise.all([
        confirm("b", auth, p),
        confirm("c", auth, p),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await mandates()).toBe(1);
    });

    // --- Multi-instance -------------------------------------------------------------
    it("two instances share one database: A creates session, B reads it; A prepares, B confirms; concurrent A/B confirmations activate at most once; B revoke is visible to A", async () => {
      spawn("A");
      spawn("B");
      const { auth } = await login("A");
      expect(
        (await call("B", "/api/activation/session", { auth })).status,
      ).toBe(200);
      const first = await prepare("A", auth);
      expect((await confirm("B", auth, first)).status).toBe(200);
      expect(await mandates()).toBe(1);
      // Concurrent confirmation of a second review across both instances.
      const second = await prepare("A", auth);
      const raced = await Promise.all([
        confirm("A", auth, second),
        confirm("B", auth, second),
        confirm("A", auth, second),
        confirm("B", auth, second),
      ]);
      expect(raced.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await mandates()).toBe(2);
      const mid = (
        (await (await confirm("A", auth, first)).json()) as { status: string }
      ).status;
      expect(mid).toBe("REJECTED");
      const id = String(
        (
          await repo.sql`select id from mandates order by created_at limit 1`
        )[0]!.id,
      );
      expect((await authority("A", auth, id)).state).toBe("ACTIVE");
      const rev = await call("B", "/api/activation/revoke", {
        auth,
        body: { action: "REVOKE_AUTHORITY", mandateId: id },
      });
      expect(rev.status).toBe(200);
      expect((await authority("A", auth, id)).state).toBe("REVOKED");
      const list = (await (
        await call("A", "/api/activation/authorities", { auth })
      ).json()) as { items: { state: string }[] };
      expect(list.items.filter((i) => i.state === "REVOKED")).toHaveLength(1);
      expect(
        (
          await repo.sql`select count(*) n from evidence_events where type='MANDATE_REVOKED'`
        )[0]!.n,
      ).toBe("1");
    });
    it("logout on one instance revokes the session on every instance", async () => {
      spawn("A");
      spawn("B");
      const { auth } = await login("A");
      expect(
        (await call("B", "/api/activation/logout", { auth, body: {} })).status,
      ).toBe(200);
      for (const via of ["A", "B"]) {
        expect(
          (await call(via, "/api/activation/session", { auth })).status,
        ).toBe(400);
        expect(
          (
            await call(via, "/api/activation/reviews", {
              auth,
              body: { source: "x" },
            })
          ).status,
        ).toBe(400);
      }
    });
    it("login guessing window and per-session mutation budget are shared across instances (not per process)", async () => {
      spawn("A");
      spawn("B");
      const wrong = (via: string) =>
        call(via, "/api/activation/session", {
          body: { bootstrapCode: "wrong-code-".repeat(4) },
        });
      for (const via of ["A", "B", "A", "B", "A"])
        expect((await wrong(via)).status).toBe(400);
      // The 6th attempt in the window is refused even with the correct code, on either instance.
      expect(
        (
          await call("B", "/api/activation/session", {
            body: { bootstrapCode: bootstrap },
          })
        ).status,
      ).toBe(400);
      time = new Date(time.getTime() + 61000);
      const { auth } = await login("A");
      // 30 charged mutations split across instances; the 31st is refused wherever it lands.
      const bad = { action: "REVOKE_AUTHORITY", mandateId: "none" };
      for (let i = 0; i < 30; i++)
        await call(i % 2 ? "A" : "B", "/api/activation/revoke", {
          auth,
          body: bad,
        });
      expect(
        Number(
          (
            await repo.sql`select window_requests n from console_demo_sessions`
          )[0]!.n,
        ),
      ).toBe(30);
      const p = await prepare("A", auth).catch(() => null);
      expect(p).toBeNull(); // 31st charged request: SESSION_RATE_LIMIT
    });

    // --- Session security regression (durable store) -------------------------------
    it("stores only the token hash, derives CSRF, and persists no secret in any host-state table", async () => {
      spawn("A");
      const { auth, setCookie } = await login("A");
      const raw = auth.cookie.split("=")[1]!;
      const [row] = await repo.sql`select * from console_demo_sessions`;
      expect(row!.session_hash).toBe(
        createHash("sha256").update(raw).digest("hex"),
      );
      expect(Object.keys(row!).sort()).toEqual([
        "created_at",
        "expires_at",
        "principal_id",
        "revoked_at",
        "session_hash",
        "window_requests",
        "window_started_at",
      ]);
      await prepare("A", auth);
      const dump = JSON.stringify([
        await repo.sql`select * from console_demo_sessions`,
        await repo.sql`select * from console_demo_login_window`,
        await repo.sql`select * from console_pending_actions`,
      ]);
      expect(dump).not.toContain(raw);
      expect(dump).not.toContain(auth.csrf);
      expect(dump).not.toContain(bootstrap);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Strict/);
      expect(setCookie).toMatch(/Path=\//);
      expect(setCookie).toMatch(/Max-Age=900/);
    });
    it("rejects tampered cookie, expired session, wrong/missing CSRF, wrong origin/host, and principal injection", async () => {
      spawn("A");
      spawn("B");
      const { auth } = await login("A");
      const [name, value] = auth.cookie.split("=") as [string, string];
      const flipped = `${name}=${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
      for (const via of ["A", "B"]) {
        expect(
          (
            await call(via, "/api/activation/session", {
              auth: { ...auth, cookie: flipped },
            })
          ).status,
        ).toBe(400);
        for (const csrf of [undefined, "", "x".repeat(43)])
          expect(
            (
              await call(via, "/api/activation/reviews", {
                auth,
                body: { source: "x" },
                headers: { "x-payflow-csrf": csrf },
              })
            ).status,
          ).toBe(400);
        for (const o of ["https://attacker.invalid", "null", undefined])
          expect(
            (
              await call(via, "/api/activation/reviews", {
                auth,
                body: { source: "x" },
                headers: { origin: o },
              })
            ).status,
          ).toBe(400);
      }
      expect(
        (
          await call("A", "/api/activation/session", {
            body: { bootstrapCode: bootstrap, principalId: "other" },
          })
        ).status,
      ).toBe(400);
      for (const field of ["principalId", "ownerId", "userId"])
        expect(
          (
            await call("B", "/api/activation/reviews", {
              auth,
              body: { source: "x", [field]: "other" },
            })
          ).status,
        ).toBe(400);
      time = new Date(time.getTime() + 900000);
      for (const via of ["A", "B"]) {
        expect(
          (await call(via, "/api/activation/session", { auth })).status,
        ).toBe(400);
        expect(
          (await call(via, "/api/activation/authorities", { auth })).status,
        ).toBe(400);
      }
    });
    it("a second session cannot consume the first session's pending review; owner is fixed server-side", async () => {
      spawn("A");
      spawn("B");
      const one = await login("A");
      const p = await prepare("A", one.auth);
      const two = await login("B");
      expect((await confirm("B", two.auth, p)).status).toBe(409);
      expect(await mandates()).toBe(0);
      expect((await confirm("A", one.auth, p)).status).toBe(200);
      const m = await repo.sql`select principal_id from mandates`;
      expect(m[0]!.principal_id).toBe("p");
    });
    it("expired sessions and pending actions are pruned without affecting live ones", async () => {
      spawn("A");
      const old = await login("A");
      await prepare("A", old.auth);
      time = new Date(time.getTime() + 901000);
      await repo.sql`update console_demo_login_window set window_started_at='epoch', attempts=0`;
      const fresh = await login("A"); // login prunes expired sessions (cascading their pending rows)
      expect(
        Number(
          (await repo.sql`select count(*) n from console_demo_sessions`)[0]!.n,
        ),
      ).toBe(1);
      expect(
        Number(
          (await repo.sql`select count(*) n from console_pending_actions`)[0]!
            .n,
        ),
      ).toBe(0);
      expect(
        (await call("A", "/api/activation/session", { auth: fresh.auth }))
          .status,
      ).toBe(200);
    });

    // --- Exact-action regression (through the durable store) -----------------------
    it("expired review fails; failed display-hash tamper does not consume it; client term injection fails", async () => {
      spawn("A");
      spawn("B");
      const { auth } = await login("A");
      const p = await prepare("A", auth);
      expect(
        (await confirm("B", auth, { ...p, displayHash: "f".repeat(64) }))
          .status,
      ).toBe(409);
      expect(
        (await confirm("B", auth, { ...p, reviewId: "other-review" })).status,
      ).toBe(409);
      for (const field of [
        "challenge",
        "reviewedHash",
        "draftFingerprint",
        "maximumMinor",
        "merchantIds",
        "allowedCapabilities",
        "principalId",
        "agentId",
      ])
        expect(
          (await confirm("B", auth, p, { [field]: "untrusted-secret-marker" }))
            .status,
        ).not.toBe(200);
      expect(await mandates()).toBe(0);
      time = new Date(time.getTime() + 301000);
      expect((await confirm("A", auth, p)).status).toBe(409);
      expect(await mandates()).toBe(0);
    });
    it("untampered confirmation still succeeds after failed attempts", async () => {
      spawn("A");
      const { auth } = await login("A");
      const p = await prepare("A", auth);
      expect(
        (await confirm("A", auth, { ...p, displayHash: "e".repeat(64) }))
          .status,
      ).toBe(409);
      expect((await confirm("A", auth, p)).status).toBe(200);
      expect(await mandates()).toBe(1);
    });
    it.each(["draft_fingerprint", "reviewed_hash", "challenge_hash"])(
      "core rejects corrupted durable %s",
      async (field) => {
        spawn("A");
        const { auth } = await login("A");
        const p = await prepare("A", auth);
        await repo.sql.unsafe(
          `update intent_reviews set ${field}=$1 where id=$2`,
          ["f".repeat(64), p.reviewId],
        );
        expect((await confirm("A", auth, p)).status).toBe(409);
        expect(await mandates()).toBe(0);
      },
    );
    it("tampered stored host-state ciphertext fails closed and never activates", async () => {
      spawn("A");
      const { auth } = await login("A");
      const p = await prepare("A", auth);
      await repo.sql`update console_pending_actions set challenge_protected='v1.AAAA.AAAA.AAAA' where review_id=${p.reviewId}`;
      expect((await confirm("A", auth, p)).status).toBe(400);
      expect(await mandates()).toBe(0);
    });
    it.each(["principal", "agent", "policy"])(
      "core rejects changed %s epoch",
      async (field) => {
        spawn("A");
        spawn("B");
        const { auth } = await login("A");
        const p = await prepare("A", auth);
        if (field === "principal")
          await repo.sql`update principals set status='ACTIVE' where id='p'`;
        if (field === "agent")
          await repo.sql`update agent_passports set display_name=display_name where id='a'`;
        if (field === "policy")
          await repo.sql`update intent_activation_policies set status=status where principal_id='p'`;
        expect((await confirm("B", auth, p)).status).toBe(409);
        expect(await mandates()).toBe(0);
      },
    );
    it.each(["SUSPENDED", "REVOKED", "EXPIRED"])(
      "core rejects %s passport",
      async (status) => {
        spawn("A");
        const { auth } = await login("A");
        const p = await prepare("A", auth);
        if (status === "EXPIRED")
          await repo.sql`update agent_passports set expires_at='2026-10-22T00:00:00.000Z' where id='a'`;
        else
          await repo.sql`update agent_passports set status=${status} where id='a'`;
        expect((await confirm("A", auth, p)).status).toBe(409);
        expect(await mandates()).toBe(0);
      },
    );

    // --- Hosted adapter surface and determinism ------------------------------------
    it("recorded sample is identical on every instance and across the previous hour bucket; other text is refused", async () => {
      spawn("A");
      spawn("B");
      const { auth } = await login("A");
      const a = await sampleText("A", auth),
        b = await sampleText("B", auth);
      expect(a).toBe(b);
      const bucket = Math.floor(time.getTime() / 3600000);
      expect(a).toBe(hostedSample(bucket).text);
      // Sample fetched in the previous hour is still accepted after the hour rolls over.
      time = new Date(time.getTime() + 3600000);
      const crossed = await call("B", "/api/activation/reviews", {
        auth: (
          await (async () => {
            await repo.sql`update console_demo_login_window set window_started_at='epoch', attempts=0`;
            return login("B");
          })()
        ).auth,
        body: { source: a },
      });
      expect(crossed.status).toBe(200);
      const refused = await call("A", "/api/activation/reviews", {
        auth,
        body: { source: "buy me something unspecified" },
      });
      expect(refused.status).not.toBe(200);
    });
    it("serves only the product routes: no debug, config, provisioning or static file exposure", async () => {
      spawn("A");
      const { auth } = await login("A");
      for (const path of [
        "/api/env",
        "/api/debug",
        "/api/health",
        "/api/activation/provision",
        "/api/activation/mandates",
        "/api/activation/sessions",
        "/index.html",
        "/",
      ])
        for (const r of [
          await call("A", path, { auth }),
          await call("A", path, { auth, body: {} }),
        ]) {
          expect(r.status).toBeGreaterThanOrEqual(400);
          const text = await r.text();
          expect(text).not.toMatch(
            /postgres:\/\/|DATABASE_URL|node_modules|at .*\.(ts|js):\d+/,
          );
        }
      const bad = await call("A", "/api/activation/confirm", {
        auth,
        body: { junk: true },
      });
      expect(await bad.text()).not.toMatch(/ZodError|stack|Error:/);
      const headers = (await call("A", "/api/activation/session", { auth }))
        .headers;
      expect(headers.get("access-control-allow-origin")).toBeNull();
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("cache-control")).toBe("no-store");
    });
    it("full hosted journey on durable state: zero payment rows, read-only reloads, fresh REVOKED across instances", async () => {
      const zero = await paymentRows();
      spawn("A");
      spawn("B");
      const { auth } = await login("A");
      const p = await prepare("B", auth);
      const { mandateId } = (await (await confirm("A", auth, p)).json()) as {
        mandateId: string;
      };
      const before = JSON.stringify(
        await repo.sql`select sequence,type,data from evidence_events order by sequence`,
      );
      for (let i = 0; i < 4; i++)
        for (const via of ["A", "B"])
          for (const path of [
            "/api/activation/authorities",
            "/api/activation/activity",
            "/api/activation/authority?mandateId=" + mandateId,
          ])
            expect((await call(via, path, { auth })).status).toBe(200);
      expect(
        JSON.stringify(
          await repo.sql`select sequence,type,data from evidence_events order by sequence`,
        ),
      ).toBe(before);
      const stale = await authority("A", auth, mandateId);
      expect(stale.state).toBe("ACTIVE");
      await call("B", "/api/activation/revoke", {
        auth,
        body: { action: "REVOKE_AUTHORITY", mandateId },
      });
      expect((await authority("A", auth, mandateId)).state).toBe("REVOKED");
      expect(await paymentRows()).toEqual(zero);
    });

    it("pending claim is atomic at the store itself: many concurrent claimants across separate pools, exactly one wins", async () => {
      spawn("A");
      const { auth } = await login("A");
      const p = await prepare("A", auth);
      const owner = String(
        (
          await repo.sql`select owner_session_hash h from console_pending_actions`
        )[0]!.h,
      );
      const pools = Array.from({ length: 4 }, () =>
        PostgresTrustRepository.connect(url!),
      );
      try {
        const { PostgresPendingStore } =
          await import("../src/console-pending.js");
        const key = deriveHostKeys(bootstrap).pending;
        const stores = pools.map((r) => new PostgresPendingStore(r.sql, key));
        const claims = await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            stores[i % 4]!.claim(
              {
                reviewId: p.reviewId,
                ownerRef: owner,
                displayHash: p.displayHash,
              },
              clock(),
            ),
          ),
        );
        expect(claims.filter((c) => c !== null)).toHaveLength(1);
        // A claim by the wrong owner or hash never consumes anything.
        const q = await prepare("A", auth);
        expect(
          await stores[0]!.claim(
            {
              reviewId: q.reviewId,
              ownerRef: "0".repeat(64),
              displayHash: q.displayHash,
            },
            clock(),
          ),
        ).toBeNull();
        expect(
          await stores[1]!.claim(
            {
              reviewId: q.reviewId,
              ownerRef: owner,
              displayHash: "0".repeat(64),
            },
            clock(),
          ),
        ).toBeNull();
        expect(
          await stores[2]!.claim(
            {
              reviewId: q.reviewId,
              ownerRef: owner,
              displayHash: q.displayHash,
            },
            clock(),
          ),
        ).not.toBeNull();
      } finally {
        await Promise.all(pools.map((r) => r.close()));
      }
    });

    // --- Configuration and cryptography units --------------------------------------
    it("rejects unsafe hosted configuration without echoing values", () => {
      const ok = {
        PAYFLOW_M5_DEMO: "true",
        DATABASE_URL: "postgres://u:secret-password@h/db",
        PAYFLOW_M5_PRINCIPAL_ID: "p",
        PAYFLOW_M5_AGENT_ID: "a",
        PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
        PAYFLOW_M5_ORIGIN: "https://m5.example.test",
      };
      expect(() => parseHostedConfig(ok)).not.toThrow();
      for (const bad of [
        { PAYFLOW_M5_DEMO: "false" },
        { PAYFLOW_M5_BOOTSTRAP_KEY: "short" },
        { PAYFLOW_M5_ORIGIN: "not a url" },
        { DATABASE_URL: undefined },
        { PAYFLOW_M5_PRINCIPAL_ID: "" },
      ]) {
        let message = "";
        try {
          parseHostedConfig({ ...ok, ...bad });
        } catch (e) {
          message = String(e);
        }
        expect(message).not.toBe("");
        expect(message).not.toContain("secret-password");
        expect(message).not.toContain(bootstrap);
      }
      for (const origin of [
        "http://m5.example.test",
        "https://m5.example.test/x",
      ])
        expect(
          () =>
            new DurableConsoleSessions(repo.sql, {
              principalId: "p",
              origin,
              bootstrapKey: bootstrap,
            }),
        ).toThrow("INVALID_HOST_ORIGIN");
      expect(
        () =>
          new DurableConsoleSessions(repo.sql, {
            principalId: "p",
            origin: "https://m5.example.test",
            bootstrapKey: "short",
          }),
      ).toThrow("BOOTSTRAP_CONFIGURATION_REQUIRED");
    });
    it("HTTPS audience yields Secure __Host- cookie; challenge encryption is authenticated and bound to its review", async () => {
      const https = new DurableConsoleSessions(
        repo.sql,
        {
          principalId: "p",
          origin: "https://m5.example.test",
          bootstrapKey: bootstrap,
        },
        clock,
      );
      const r = await https.login(
        { origin: "https://m5.example.test", host: "m5.example.test" },
        { bootstrapCode: bootstrap },
      );
      expect(r.cookie).toMatch(/^__Host-payflow_session=/);
      expect(r.cookie).toMatch(/; Secure/);
      expect(r.cookie).toMatch(/HttpOnly; SameSite=Strict/);
      const { pending } = deriveHostKeys(bootstrap);
      const sealed = protectChallenge(
        pending,
        "review-1",
        "raw-challenge-value",
      );
      expect(sealed).not.toContain("raw-challenge-value");
      expect(unprotectChallenge(pending, "review-1", sealed)).toBe(
        "raw-challenge-value",
      );
      expect(() => unprotectChallenge(pending, "review-2", sealed)).toThrow();
      expect(() =>
        unprotectChallenge(
          deriveHostKeys("z".repeat(40)).pending,
          "review-1",
          sealed,
        ),
      ).toThrow();
      expect(
        protectChallenge(pending, "review-1", "raw-challenge-value"),
      ).not.toBe(sealed);
    });
  },
);
