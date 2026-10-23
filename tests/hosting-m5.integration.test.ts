import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { PostgresTrustRepository } from "../src/persistence.js";
import { VerticalSession } from "./m4-vertical-fixture.js";

const url = process.env.TEST_DATABASE_URL;
const run = promisify(execFile);
const bootstrap = "m5e-adapter-private-bootstrap-".repeat(2);
const withDatabase = (base: string, name: string) => {
  const u = new URL(base);
  u.pathname = "/" + name;
  return u.toString();
};
const provision = (databaseUrl: string) =>
  run("node", ["--import", "tsx", "hosting/operator/provision-m5.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PAYFLOW_M5_PRINCIPAL_ID: "m5-owner",
      PAYFLOW_M5_AGENT_ID: "m5-agent",
    },
  }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({
      code: e.code ?? 1,
      out: String(e.stdout) + String(e.stderr),
    }),
  );

(url ? describe : describe.skip)(
  "M5E-HOST operator provisioning and the thin Vercel adapter (isolated PostgreSQL)",
  () => {
    let admin: PostgresTrustRepository;
    const created: string[] = [];
    const freshDatabase = async () => {
      const name = "m5_prov_" + randomBytes(4).toString("hex");
      await admin.sql.unsafe(`create database ${name}`);
      created.push(name);
      return withDatabase(url!, name);
    };
    beforeAll(() => {
      admin = PostgresTrustRepository.connect(url!);
    });
    afterAll(async () => {
      for (const name of created)
        await admin.sql.unsafe(`drop database if exists ${name} with (force)`);
      await admin.close();
    });

    it("provisions an empty database once, idempotently: migrations 001-010, one principal, one passport, one policy", async () => {
      const target = await freshDatabase();
      const first = await provision(target);
      expect(first.code).toBe(0);
      expect(first.out).toMatch(/applied migrations: 10/);
      expect(first.out).not.toContain(target);
      const second = await provision(target);
      expect(second.code).toBe(0);
      expect(second.out).not.toMatch(/applied migrations/);
      const repo = PostgresTrustRepository.connect(target);
      try {
        const count = async (t: string) =>
          Number((await repo.sql.unsafe(`select count(*) n from ${t}`))[0]!.n);
        expect(await count("principals")).toBe(1);
        expect(await count("agent_passports")).toBe(1);
        expect(await count("intent_activation_policies")).toBe(1);
        for (const t of [
          "mandates",
          "payment_attempts",
          "authorization_reservations",
          "execution_grants",
          "transaction_proposals",
          "console_demo_sessions",
          "console_pending_actions",
        ])
          expect(await count(t)).toBe(0);
      } finally {
        await repo.close();
      }
    });
    it("adds only migration 010 to a database that already has 001-009, and leaves historical rows untouched", async () => {
      const target = await freshDatabase();
      const repo = PostgresTrustRepository.connect(target);
      try {
        for (const n of (await readdir("db/migrations"))
          .filter((n) => n.endsWith(".sql") && !n.startsWith("010_"))
          .sort())
          await repo.migrate(await readFile("db/migrations/" + n, "utf8"));
        await repo.savePrincipal({ id: "existing", displayName: "Existing" });
        const out = await provision(target);
        expect(out.code).toBe(0);
        expect(out.out).toMatch(/applied migration: 010/);
        expect(
          (
            await repo.sql`select count(*) n from principals where id='existing'`
          )[0]!.n,
        ).toBe("1");
      } finally {
        await repo.close();
      }
    });
    it("REFUSES a database holding financial history, so historical M4 evidence is never reused", async () => {
      const target = await freshDatabase();
      const repo = PostgresTrustRepository.connect(target);
      try {
        for (const n of (await readdir("db/migrations"))
          .filter((n) => n.endsWith(".sql"))
          .sort())
          await repo.migrate(await readFile("db/migrations/" + n, "utf8"));
        const s = new VerticalSession(repo);
        await s.provision();
        await s.seal();
        const before = JSON.stringify(
          await repo.sql`select (select count(*) from transaction_proposals) p, (select count(*) from principals) pr`,
        );
        const out = await provision(target);
        expect(out.code).toBe(3);
        expect(out.out).toMatch(/REFUSED/);
        expect(
          JSON.stringify(
            await repo.sql`select (select count(*) from transaction_proposals) p, (select count(*) from principals) pr`,
          ),
        ).toBe(before);
      } finally {
        await repo.close();
      }
    });

    describe("Vercel function adapter", () => {
      const keep = { ...process.env };
      let server: Server;
      let origin: string;
      afterAll(() => {
        process.env = keep;
        server?.close();
      });
      const load = async () => {
        vi.resetModules();
        return (await import("../hosting/m5/api/host.js")).default;
      };
      const listen = async (
        handler: (req: never, res: never) => Promise<void>,
      ) => {
        server = createServer((req, res) => {
          void handler(req as never, res as never);
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      };
      it("fails closed with a fixed 503 and logs no configuration value when misconfigured", async () => {
        process.env = {
          ...keep,
          DATABASE_URL: "postgres://u:very-secret-password@h/db",
          PAYFLOW_M5_BOOTSTRAP_KEY: "short",
        };
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        await listen(await load());
        const r = await fetch(origin + "/api/activation/session");
        expect(r.status).toBe(503);
        const body = await r.text();
        expect(body).toBe('{"status":"UNAVAILABLE"}');
        expect(r.headers.get("x-content-type-options")).toBe("nosniff");
        const logged = JSON.stringify(spy.mock.calls);
        expect(logged).toContain("M5_HOST_CONFIGURATION_INVALID");
        expect(logged).not.toContain("very-secret-password");
        expect(logged).not.toContain("short");
        spy.mockRestore();
        await new Promise<void>((r2) => server.close(() => r2()));
      });
      it("serves the product API from a provisioned database through the real function entrypoint", async () => {
        const target = await freshDatabase();
        expect((await provision(target)).code).toBe(0);
        // Bind the configured origin to the server we start next.
        const probe = createServer();
        await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
        const port = (probe.address() as AddressInfo).port;
        await new Promise<void>((r) => probe.close(() => r()));
        process.env = {
          ...keep,
          PAYFLOW_M5_DEMO: "true",
          DATABASE_URL: target,
          PAYFLOW_M5_PRINCIPAL_ID: "m5-owner",
          PAYFLOW_M5_AGENT_ID: "m5-agent",
          PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
          PAYFLOW_M5_ORIGIN: `http://127.0.0.1:${port}`,
        };
        const handler = await load();
        server = createServer((req, res) => {
          void handler(req, res);
        });
        await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
        origin = `http://127.0.0.1:${port}`;
        const login = await fetch(origin + "/api/activation/session", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ bootstrapCode: bootstrap }),
        });
        expect(login.status).toBe(200);
        const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
        const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
        const list = await fetch(origin + "/api/activation/authorities", {
          headers: { cookie },
        });
        expect(list.status).toBe(200);
        expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
        // Vercel's trailingSlash redirect delivers /api/* with a slash; the adapter restores the path.
        const slashed = await fetch(origin + "/api/activation/authorities/", {
          headers: { cookie },
        });
        expect(slashed.status).toBe(200);
        const sample = (await (
          await fetch(origin + "/api/intent-review/sample", {
            headers: { cookie },
          })
        ).json()) as { sample: string };
        const prepared = await fetch(origin + "/api/activation/reviews", {
          method: "POST",
          headers: {
            origin,
            cookie,
            "x-payflow-csrf": csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify({ source: sample.sample }),
        });
        expect(prepared.status).toBe(200);
        expect(await prepared.text()).not.toMatch(
          /challenge|reviewedHash|DATABASE_URL|very-secret/i,
        );
        // No static file exposure from the function (Vercel serves the static console itself).
        expect((await fetch(origin + "/")).status).toBe(404);
      });
    });
  },
);
