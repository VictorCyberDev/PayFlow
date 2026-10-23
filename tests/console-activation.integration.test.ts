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
import { PostgresAuthorityViewReader } from "../src/authority-postgres.js";
import { ConsoleSessions } from "../src/console-session.js";
import {
  ConsoleActivation,
  type PendingAuthoritySchema,
} from "../src/console-activation.js";
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
const bootstrap = "test-bootstrap-only-".repeat(4);
run(
  "M5C actual session HTTP -> exact durable activation -> fresh Authority (isolated PostgreSQL)",
  () => {
    let repo: PostgresTrustRepository,
      server: Server,
      origin: string,
      directory: string,
      time: Date;
    let auth: { cookie: string; csrf: string };
    let sessions: ConsoleSessions;
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
      extra: Record<string, string> = {},
    ) =>
      fetch(origin + path, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: auth.cookie,
          "x-payflow-csrf": auth.csrf,
          ...extra,
        },
        body: JSON.stringify(body),
      });
    const prepare = async () => {
      const r = await post("/api/activation/reviews", {
        source: f.context.source.text,
      });
      expect(r.status).toBe(200);
      return (await r.json()) as Pending;
    };
    const confirm = (p: Pending, extra: Record<string, unknown> = {}) =>
      post("/api/activation/confirm", {
        action: "CONFIRM_EXACT_TERMS",
        reviewId: p.reviewId,
        displayHash: p.displayHash,
        ...extra,
      });
    const count = async () =>
      Number((await repo.sql`select count(*) n from mandates`)[0]!.n);
    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const name of (await readdir("db/migrations"))
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile("db/migrations/" + name, "utf8"));
      directory = await mkdtemp(join(tmpdir(), "payflow-m5c-"));
      await writeFile(
        join(directory, "index.html"),
        "<p>Non-production console</p>",
      );
    });
    beforeEach(async () => {
      time = new Date("2026-10-23T10:00:00.000Z");
      await repo.sql`truncate principals cascade`;
      await repo.sql`truncate evidence_events restart identity`;
      await repo.savePrincipal({ id: "p", displayName: "Human" });
      await repo.savePrincipal({ id: "other", displayName: "Other" });
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
          capabilities: [
            "SEARCH_PRODUCTS",
            "EVALUATE_PRODUCTS",
            "CREATE_ORDER",
            "CAPTURE_PAYMENT",
          ],
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
      server = createServer((req, res) => {
        void handler(req, res);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      sessions = new ConsoleSessions(
        { principalId: "p", origin, bootstrapKey: bootstrap },
        clock,
      );
      const app = new ConsoleActivation(
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
      });
      const login = await fetch(origin + "/api/activation/session", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ bootstrapCode: bootstrap }),
      });
      expect(login.status).toBe(200);
      const s = (await login.json()) as { csrfToken: string };
      auth = {
        cookie: login.headers.get("set-cookie")!.split(";")[0]!,
        csrf: s.csrfToken,
      };
    });
    afterEach(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    afterAll(async () => {
      await repo.close();
      await rm(directory, { recursive: true });
    });
    it("activates exactly one existing Mandate and fresh owner-bound Authority; no payment or optimistic projection", async () => {
      const p = await prepare();
      expect(p.authority).toBe("NOT_YET_AUTHORIZED");
      expect(p.terms.map((t) => t.label)).toContain("Cumulative limit");
      expect(await count()).toBe(0);
      expect(JSON.stringify(p)).not.toMatch(
        /challenge|reviewedHash|authenticatedAt|bootstrap|csrfToken|privateKey|signedToken/,
      );
      const result = await confirm(p);
      expect(result.status).toBe(200);
      const activated = (await result.json()) as {
        status: string;
        mandateId: string;
      };
      expect(Object.keys(activated).sort()).toEqual(["mandateId", "status"]);
      expect(activated.status).toBe("ACTIVATED");
      expect(await count()).toBe(1);
      const response = await fetch(
        origin + "/api/activation/authority?mandateId=" + activated.mandateId,
        { headers: { cookie: auth.cookie } },
      );
      const a = (await response.json()) as {
        state: string;
        remainingMinor: number;
      };
      expect(response.status).toBe(200);
      expect(a.state).toBe("ACTIVE");
      expect(a.remainingMinor).toBe(9999);
      const m = await repo.getMandate(activated.mandateId);
      expect(m?.principalId).toBe("p");
      expect(m?.authorizedAgentId).toBe("a");
      const before =
        await repo.sql`select type,data from evidence_events order by sequence`;
      for (let i = 0; i < 3; i++)
        expect(
          (
            await fetch(
              origin +
                "/api/activation/authority?mandateId=" +
                activated.mandateId,
              { headers: { cookie: auth.cookie } },
            )
          ).status,
        ).toBe(200);
      expect(
        await repo.sql`select type,data from evidence_events order by sequence`,
      ).toEqual(before);
      expect(before.map((e) => String(e.type))).toEqual([
        "INTENT_REVIEW_CREATED",
        "HUMAN_CONFIRMATION_ACCEPTED",
        "INTENT_MANDATE_ACTIVATED",
      ]);
      expect(JSON.stringify(before)).not.toContain(bootstrap);
      expect(JSON.stringify(before)).not.toContain(auth.cookie);
      expect(JSON.stringify(before)).not.toContain(auth.csrf);
      for (const table of [
        "payment_attempts",
        "authorization_reservations",
        "execution_grants",
        "transaction_proposals",
      ])
        expect(
          Number(
            (await repo.sql.unsafe(`select count(*) n from ${table}`))[0]!.n,
          ),
        ).toBe(0);
    });
    it("replay and two concurrent confirmations activate at most once", async () => {
      const p = await prepare();
      const results = await Promise.all([confirm(p), confirm(p)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await confirm(p)).status).toBe(409);
      expect(await count()).toBe(1);
    });
    it.each([
      "principalId",
      "agentId",
      "maximumMinor",
      "merchantIds",
      "allowedCapabilities",
      "state",
      "challenge",
      "reviewedHash",
      "draftFingerprint",
    ])("rejects client %s substitution before activation", async (field) => {
      const p = await prepare();
      expect(
        (await confirm(p, { [field]: "untrusted-secret-marker" })).status,
      ).not.toBe(200);
      expect(await count()).toBe(0);
      expect(
        JSON.stringify(await repo.sql`select data from evidence_events`),
      ).not.toContain("untrusted-secret-marker");
    });
    it.each(["displayHash", "reviewId"])(
      "rejects tampered %s handle",
      async (field) => {
        const p = await prepare();
        expect(
          (
            await confirm({
              ...p,
              [field]:
                field === "displayHash" ? "f".repeat(64) : "other-review",
            })
          ).status,
        ).toBe(409);
        expect(await count()).toBe(0);
      },
    );
    it.each(["draft_fingerprint", "reviewed_hash", "challenge_hash"])(
      "core rejects corrupted durable %s",
      async (field) => {
        const p = await prepare();
        await repo.sql.unsafe(
          `update intent_reviews set ${field}=$1 where id=$2`,
          ["f".repeat(64), p.reviewId],
        );
        expect((await confirm(p)).status).toBe(409);
        expect(await count()).toBe(0);
      },
    );
    it.each(["principal", "agent", "policy"])(
      "core rejects changed %s epoch",
      async (field) => {
        const p = await prepare();
        if (field === "principal")
          await repo.sql`update principals set status='ACTIVE' where id='p'`;
        if (field === "agent")
          await repo.sql`update agent_passports set display_name=display_name where id='a'`;
        if (field === "policy")
          await repo.sql`update intent_activation_policies set status=status where principal_id='p'`;
        expect((await confirm(p)).status).toBe(409);
        expect(await count()).toBe(0);
      },
    );
    it.each(["SUSPENDED", "REVOKED", "EXPIRED"])(
      "core rejects %s passport",
      async (status) => {
        const p = await prepare();
        if (status === "EXPIRED")
          await repo.sql`update agent_passports set expires_at='2026-10-22T00:00:00.000Z' where id='a'`;
        else
          await repo.sql`update agent_passports set status=${status} where id='a'`;
        expect((await confirm(p)).status).toBe(409);
        expect(await count()).toBe(0);
      },
    );
    it("rejects disabled principal and expired review", async () => {
      const p = await prepare();
      time = new Date(time.getTime() + 300000);
      expect((await confirm(p)).status).toBe(409);
      expect(await count()).toBe(0);
    });
    it("rejects disabled principal", async () => {
      const p = await prepare();
      await repo.sql`update principals set status='DISABLED' where id='p'`;
      expect((await confirm(p)).status).toBe(409);
      expect(await count()).toBe(0);
    });
    it.each(["principal", "agent"])(
      "core rejects changed durable review %s owner binding",
      async (field) => {
        const p = await prepare();
        if (field === "principal")
          await repo.sql`update intent_reviews set principal_id='other' where id=${p.reviewId}`;
        else
          await repo.sql`update intent_reviews set agent_id='othera' where id=${p.reviewId}`;
        expect((await confirm(p)).status).toBe(409);
        expect(await count()).toBe(0);
      },
    );
    it.each(["csrf", "origin", "cookie", "logout", "expiry"])(
      "session %s failure prevents confirmation",
      async (kind) => {
        const p = await prepare();
        if (kind === "logout")
          expect((await post("/api/activation/logout", {})).status).toBe(200);
        if (kind === "expiry") time = new Date(time.getTime() + 900000);
        const headers: Record<string, string> =
          kind === "csrf"
            ? { "x-payflow-csrf": "wrong" }
            : kind === "origin"
              ? { origin: "https://attacker.invalid" }
              : kind === "cookie"
                ? { cookie: "payflow_session=" + "a".repeat(43) }
                : {};
        const r = await post(
          "/api/activation/confirm",
          {
            action: "CONFIRM_EXACT_TERMS",
            reviewId: p.reviewId,
            displayHash: p.displayHash,
          },
          headers,
        );
        expect(r.status).not.toBe(200);
        expect(await count()).toBe(0);
      },
    );
    it("another valid session cannot consume the first session review", async () => {
      const p = await prepare();
      const login = await fetch(origin + "/api/activation/session", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ bootstrapCode: bootstrap }),
      });
      const s = (await login.json()) as { csrfToken: string };
      auth = {
        cookie: login.headers.get("set-cookie")!.split(";")[0]!,
        csrf: s.csrfToken,
      };
      expect((await confirm(p)).status).toBe(409);
      expect(await count()).toBe(0);
    });
    it("fresh read reflects revocation, expiry and session boundaries rather than browser claims", async () => {
      const p = await prepare();
      const a = (await (await confirm(p)).json()) as { mandateId: string };
      await repo.revokeMandate(a.mandateId, time.toISOString());
      const read = await fetch(
        origin + "/api/activation/authority?mandateId=" + a.mandateId,
        { headers: { cookie: auth.cookie } },
      );
      expect(((await read.json()) as { state: string }).state).toBe("REVOKED");
      expect(
        (
          await fetch(
            origin +
              "/api/activation/authority?mandateId=" +
              a.mandateId +
              "&state=ACTIVE",
            { headers: { cookie: auth.cookie } },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(
            origin + "/api/activation/authority?mandateId=" + a.mandateId,
          )
        ).status,
      ).not.toBe(200);
    });
    it("older pending reviews follow existing semantics: creating another is not an epoch change", async () => {
      const first = await prepare();
      await prepare();
      expect((await confirm(first)).status).toBe(200);
      expect(await count()).toBe(1);
    });
    it("fresh SQL projection cannot read another principal's mandate", async () => {
      const p = await prepare();
      const result = (await (await confirm(p)).json()) as { mandateId: string };
      const reader = new PostgresAuthorityViewReader(repo, clock);
      expect(await reader.readOwned("other", result.mandateId)).toBeNull();
      expect(await reader.readOwned("p", "unknown-mandate")).toBeNull();
      const owned = (await reader.readOwned("p", result.mandateId)) as {
        state: string;
      };
      expect(owned.state).toBe("ACTIVE");
    });
    it.each(["principal", "passport", "expiry"])(
      "fresh SQL projection reflects current %s state",
      async (kind) => {
        const p = await prepare();
        const result = (await (await confirm(p)).json()) as {
          mandateId: string;
        };
        if (kind === "principal")
          await repo.sql`update principals set status='DISABLED' where id='p'`;
        if (kind === "passport")
          await repo.sql`update agent_passports set status='SUSPENDED' where id='a'`;
        if (kind === "expiry") time = new Date("2026-11-02T00:00:00.000Z");
        const view = (await new PostgresAuthorityViewReader(
          repo,
          clock,
        ).readOwned("p", result.mandateId)) as {
          state: string;
          freshDispatchBlocked: boolean;
        };
        expect(view.state).toBe(kind === "expiry" ? "EXPIRED" : "UNAVAILABLE");
        expect(view.freshDispatchBlocked).toBe(true);
      },
    );
  },
);
