import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { hostHarness } from "./helpers/host-harness.js";

/**
 * R5 — the hosted TOPOLOGY, not just the code. `hosting/m6/vercel.json` is the deployment contract: a static export for pages, one
 * function (`api/host`) for `/v1/*`, `/api/*` and now `/workspace`, `trailingSlash: true`. This test reads that file and reproduces
 * its routing in front of the REAL function handler and the REAL static export, then drives a signup/login/mission journey through
 * it by plain HTTP, including direct navigation without the trailing slash. It does not prove Vercel behaves as modelled: a real
 * deployment must still be fetched (HOSTED_ACCEPTED). It does prove the contract itself is complete and self-consistent.
 */
const url = process.env.TEST_DATABASE_URL;
const out = resolve("apps/console/out");
const have = existsSync(resolve(out, "index.html"));
if (process.env.REQUIRE_BROWSER === "1" && !have)
  throw new Error("console build missing");
interface Config {
  trailingSlash: boolean;
  rewrites: { source: string; destination: string }[];
}
const cfg = JSON.parse(
  readFileSync(resolve("hosting/m6/vercel.json"), "utf8"),
) as Config;
const toRegex = (src: string) =>
  new RegExp(
    "^" +
      src
        .split("(.*)")
        .map((part) =>
          part
            .replace(/[.+?^${}|[\]\\]/gu, "\\$&")
            .replace(/:[A-Za-z]+/gu, "[^/]+"),
        )
        .join("(.*)") +
      "$",
    "u",
  );
const rules = cfg.rewrites.map((r) => ({
  re: toRegex(r.source),
  to: r.destination,
}));
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

(url && have ? describe : describe.skip)(
  "R5 hosting topology (vercel.json routing + real function handler + real static export)",
  () => {
    const h = hostHarness({
      extraTruncate: "user_sessions,user_memberships,user_accounts",
    });
    let site: Server;
    let origin = "";
    let handler: (req: unknown, res: unknown) => Promise<void>;
    beforeAll(async () => {
      site = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        const path = u.pathname;
        const rewrite = rules.find((r) => r.re.test(path));
        // Vercel serves an existing static file first, then applies rewrites, and applies trailingSlash to page-like paths.
        const staticFile = resolve(out, "." + decodeURIComponent(path));
        const isFile =
          staticFile.startsWith(out) &&
          existsSync(staticFile) &&
          statSync(staticFile).isFile();
        if (!isFile && !rewrite) {
          if (cfg.trailingSlash && !path.endsWith("/") && !extname(path)) {
            res.writeHead(308, { location: path + "/" + u.search });
            return void res.end();
          }
          const dir = resolve(
            out,
            "." + decodeURIComponent(path),
            "index.html",
          );
          if (dir.startsWith(out) && existsSync(dir)) {
            res.writeHead(200, { "content-type": "text/html" });
            return void res.end(readFileSync(dir));
          }
          res.writeHead(404, { "content-type": "text/html" });
          return void res.end(readFileSync(resolve(out, "404.html")));
        }
        if (rewrite && !isFile) return void handler(req, res);
        res.writeHead(200, {
          "content-type":
            TYPES[extname(staticFile)] ?? "application/octet-stream",
        });
        res.end(readFileSync(staticFile));
      });
      await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
      const pem = generateKeyPairSync("ed25519").privateKey.export({
        type: "pkcs8",
        format: "pem",
      }) as string;
      Object.assign(process.env, {
        PAYFLOW_M5_DEMO: "true",
        DATABASE_URL: url!,
        PAYFLOW_M5_PRINCIPAL_ID: "p",
        PAYFLOW_M5_AGENT_ID: "a",
        PAYFLOW_M5_BOOTSTRAP_KEY: "topology-test-private-bootstrap-".repeat(3),
        PAYFLOW_M5_ORIGIN: origin,
        PAYFLOW_M6_DEMO_AGENT: "true",
        PAYFLOW_M6_SIGNING_KEY: pem,
        PAYFLOW_M6_SIGNING_KID: "topology-test",
      });
      handler = (await import("../hosting/m6/api/host.js"))
        .default as typeof handler;
    });
    afterAll(async () => {
      site?.closeAllConnections();
      await new Promise((r) => site?.close(r));
    });
    void h;

    const get = (path: string, init: RequestInit = {}) =>
      fetch(origin + path, { redirect: "manual", ...init });

    it("the public pages are served from the static export, and a page without a trailing slash is redirected to the slashed form", async () => {
      const home = await get("/");
      expect(home.status).toBe(200);
      expect(await home.text()).toMatch(/<html/iu);
      const direct = await get("/product");
      expect([direct.status, direct.headers.get("location")]).toEqual([
        308,
        "/product/",
      ]);
      expect((await get("/product/")).status).toBe(200);
      expect((await get("/definitely-not-a-page/")).status).toBe(404);
    });

    it("the customer app is reachable at /workspace and /workspace/ (direct navigation), with its own strict CSP and no loose files needed", async () => {
      for (const p of [
        "/workspace",
        "/workspace/",
        "/workspace/app.js",
        "/workspace/app.css",
      ]) {
        const r = p === "/workspace" ? await get(p) : await get(p);
        // /workspace is rewritten to the function before any slash redirect; every path answers 200 from the embedded assets
        expect(r.status, p).toBe(200);
      }
      const page = await get("/workspace/");
      expect(page.headers.get("content-security-policy")).toContain(
        "script-src 'self'",
      );
      expect(page.headers.get("content-security-policy")).not.toContain(
        "unsafe-inline'; style",
      );
      expect(await page.text()).toContain("/workspace/app.js");
      expect((await get("/workspace/../v1/app/me")).status).not.toBe(200);
      expect((await get("/workspace/secret.txt")).status).toBe(404);
    });

    it("the API is reachable through the rewrite, including with a trailing slash, and refuses an anonymous caller", async () => {
      const me = await get("/v1/app/me");
      expect(me.status).toBe(401);
      const keys = await get("/v1/keys/");
      expect([200, 404, 503]).toContain(keys.status);
      // NO operator token is configured in this topology (as in a public deployment): member routes still exist and refuse anonymous
      expect((await get("/v1/admin/org/missions/")).status).toBe(401);
      expect(
        (
          await get("/v1/admin/sandbox/authority/", {
            method: "POST",
            body: "{}",
          })
        ).status,
      ).toBe(401);
    });

    it("a full sign-up → sign-in → agent → mission journey works through the topology with cookies", async () => {
      const j = { "content-type": "application/json", origin };
      const su = await get("/v1/app/signup", {
        method: "POST",
        headers: j,
        body: JSON.stringify({
          email: "topo@example.com",
          password: "a long enough passphrase",
          displayName: "Topo",
          organizationName: "Topology",
        }),
      });
      expect(su.status, await su.clone().text()).toBe(201);
      const li = await get("/v1/app/login", {
        method: "POST",
        headers: j,
        body: JSON.stringify({
          email: "topo@example.com",
          password: "a long enough passphrase",
        }),
      });
      expect(li.status).toBe(200);
      const cookie = /pf_session=[^;]+/u.exec(
        li.headers.get("set-cookie")!,
      )![0];
      expect(li.headers.get("set-cookie")).not.toMatch(/;\s*Secure/iu); // http test origin only; https origins set Secure (tested in R1a)
      const csrf = ((await li.json()) as { csrfToken: string }).csrfToken;
      const me = await get("/v1/app/me", { headers: { cookie } });
      expect(me.status).toBe(200);
      const ag = await get("/v1/app/agents", {
        method: "POST",
        headers: { ...j, cookie, "x-pf-csrf": csrf },
        body: JSON.stringify({ displayName: "Buyer" }),
      });
      expect(ag.status).toBe(201);
      const list = await get("/v1/admin/org/missions", { headers: { cookie } });
      expect(list.status).toBe(200);
      // the same state change without the token is refused through the topology too
      const noCsrf = await get("/v1/app/agents", {
        method: "POST",
        headers: { ...j, cookie },
        body: JSON.stringify({ displayName: "Sneaky" }),
      });
      expect(noCsrf.status).toBe(403);
    });
  },
);
