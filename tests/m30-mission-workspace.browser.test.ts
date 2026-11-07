import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createRequire } from "node:module";
import type * as Playwright from "../apps/console/node_modules/playwright-core/index.js";
import type {
  Browser,
  Page,
  Route,
} from "../apps/console/node_modules/playwright-core/index.js";
import { hostHarness } from "./helpers/host-harness.js";
import {
  activeMission,
  contract,
  idemKey,
  MISSIONS,
} from "./helpers/mission-fixtures.js";

/**
 * V3 M30 — the Mission Workspace in a real browser, reading a real Gateway on PostgreSQL.
 *
 * The static console is served from its production export. The browser is pointed at the Gateway's address and every request is
 * forwarded to the real Gateway (the forwarding adds only the CORS headers a cross-origin test needs); no response is invented.
 * Checked at six widths: nothing overflows sideways, one h1, axe WCAG A+AA finds nothing, and the numbers on screen are the
 * numbers the API holds. A section that fails to load says so and shows nothing in its place.
 */
const url = process.env.TEST_DATABASE_URL;
const out = resolve("apps/console/out");
const pw = resolve("apps/console/node_modules/playwright-core/index.mjs");
const have = existsSync(out) && existsSync(pw);
const required = process.env.REQUIRE_BROWSER === "1";
if (required && !have) throw new Error("console build or Playwright missing");
interface Axe {
  run(
    d: Document,
    o: object,
  ): Promise<{ violations: { id: string; nodes: { target: unknown }[] }[] }>;
}
const WIDTHS = [320, 375, 430, 768, 1024, 1440];
const chromePath = [
  process.env.PLAYWRIGHT_CHROMIUM,
  "/opt/pw-browsers/chromium",
].find((p) => p && existsSync(p));

(url && have ? describe : describe.skip)(
  "M30 Mission Workspace (real browser + real Gateway)",
  () => {
    const h = hostHarness({
      extraTruncate:
        "missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates",
    });
    const require_ = createRequire(import.meta.url);
    const axeSource = readFileSync(
      require_.resolve("../apps/console/node_modules/axe-core/axe.min.js"),
      "utf8",
    );
    let site: Server;
    let siteOrigin = "";
    let browser: Browser;

    beforeAll(async () => {
      site = createServer((req, res) => {
        try {
          const u = new URL(req.url ?? "/", "http://x");
          let file = resolve(out, "." + decodeURIComponent(u.pathname));
          if (!file.startsWith(out)) throw new Error("path");
          if (statSync(file).isDirectory()) file += "/index.html";
          const types: Record<string, string> = {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
            ".txt": "text/plain",
            ".json": "application/json",
          };
          res.setHeader(
            "content-type",
            types[extname(file)] ?? "application/octet-stream",
          );
          res.end(readFileSync(file));
        } catch {
          res.statusCode = 404;
          res.end("not found");
        }
      });
      await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
      siteOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
      const { chromium } = (await import(pw)) as typeof Playwright;
      browser = await chromium.launch({
        headless: true,
        ...(chromePath ? { executablePath: chromePath } : {}),
      });
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
      await new Promise((r) => site?.close(r));
    });

    /** A page whose requests to the Gateway are forwarded for real; `block` lets a test fail one endpoint. */
    const openPage = async (width: number, block: RegExp | null = null) => {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      const seen: string[] = [];
      await page.route(`${h.origin}/**`, async (route: Route) => {
        const req = route.request();
        const cors = {
          "access-control-allow-origin": siteOrigin,
          "access-control-allow-headers": "authorization, accept",
          "access-control-allow-methods": "GET",
        };
        if (req.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers: cors });
        seen.push(new URL(req.url()).pathname);
        if (block && block.test(req.url()))
          return route.fulfill({ status: 503, headers: cors, body: "{}" });
        const r = await fetch(req.url(), {
          method: req.method(),
          headers: { authorization: req.headers()["authorization"] ?? "" },
        });
        return route.fulfill({
          status: r.status,
          headers: { ...cors, "content-type": "application/json" },
          body: await r.text(),
        });
      });
      return { ctx, page, seen };
    };
    const connect = async (page: Page, token: string) => {
      await page.goto(`${siteOrigin}/missions/`);
      await page.getByLabel("Host address", { exact: false }).fill(h.origin);
      await page.getByLabel("Member API key").fill(token);
      await page.getByRole("button", { name: "Open missions" }).click();
    };
    const audit = async (page: Page, where: string) => {
      const m = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        h1: document.querySelectorAll("h1").length,
      }));
      expect(m.overflow, `${where}: horizontal overflow`).toBeLessThanOrEqual(
        0,
      );
      expect(m.h1, `${where}: exactly one h1`).toBe(1);
      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(() =>
        (window as unknown as { axe: Axe }).axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
          },
        }),
      );
      expect(
        axe.violations.map((v) => `${v.id}: ${String(v.nodes[0]?.target)}`),
        `${where}: axe`,
      ).toEqual([]);
    };

    const seed = async () => {
      const m = await activeMission(
        h,
        contract({ expiresAt: "2026-11-23T10:00:00.000Z" }),
      );
      const post = (path: string, body: unknown) =>
        h.call(m.owner, "POST", path, body);
      expect(
        (
          await post(`${MISSIONS}/${m.id}/plans`, {
            source: "TEMPLATE",
            idempotencyKey: idemKey("p"),
          })
        ).status,
      ).toBe(201);
      await post(`${MISSIONS}/${m.id}/plans/1/activate`, {});
      const ids: string[] = [];
      for (const [label, amountMinor] of [
        ["Quiet keyboard", 12_345],
        ["Standing desk", 40_000],
      ] as const) {
        const created = await post(`${MISSIONS}/${m.id}/ledger/items`, {
          kind: "GOODS",
          label,
          amountMinor,
          currency: "USD",
          stage: "QUOTED",
          idempotencyKey: idemKey("i"),
        });
        expect(created.status).toBe(201);
        ids.push(
          ((await created.json()) as { item: { itemId: string } }).item.itemId,
        );
      }
      // Only the keyboard is approved: a quote on its own holds no budget.
      expect(
        (
          await post(`/v1/admin/org/ledger/items/${ids[0]}/transition`, {
            to: "APPROVED",
            idempotencyKey: idemKey("t"),
          })
        ).status,
      ).toBe(200);
      return m;
    };

    it("shows the mission, its budget, plan, authority and history exactly as the API holds them, at six widths, accessibly", async () => {
      const m = await seed();
      const ledger = (await (
        await h.call(m.owner, "GET", `${MISSIONS}/${m.id}/ledger`)
      ).json()) as { summary: { exposureMinor: number } };
      expect(ledger.summary.exposureMinor).toBe(12_345);
      for (const width of WIDTHS) {
        const { ctx, page } = await openPage(width);
        try {
          await connect(page, m.owner);
          await page
            .getByRole("link", {
              name: "Find and buy equipment for the studio",
            })
            .waitFor();
          await audit(page, `list@${width}`);
          await page
            .getByRole("link", {
              name: "Find and buy equipment for the studio",
            })
            .click();
          await page
            .getByRole("heading", {
              level: 1,
              name: "Find and buy equipment for the studio",
            })
            .waitFor();
          await page.getByRole("region", { name: /Commitments/u }).waitFor();
          const text = await page.locator("main").innerText();
          // Each labelled figure on screen is the number the API holds (not merely present somewhere on the page).
          const facts = await page.evaluate(() =>
            Object.fromEntries(
              [...document.querySelectorAll(".mission-facts > div")].map(
                (d) => [
                  d.querySelector("dt")!.textContent,
                  d.querySelector("dd")!.textContent,
                ],
              ),
            ),
          );
          expect(facts).toEqual({
            Ceiling: "$1,500.00",
            "Committed or spent": "$123.45", // 12_345 minor: only the approved keyboard holds budget
            "Still available": "$1,376.55",
            "Of that, outcome unknown": "$0.00",
            "Of that, not independently verified": "$123.45", // nothing independent has confirmed it yet
            Refunded: "$0.00",
          });
          expect(text).toContain("Quiet keyboard");
          expect(text).toContain("Standing desk");
          expect(text).toContain("never quotes");
          expect(text).toContain("Version 1 in force");
          await audit(page, `detail@${width}`);
          // The key never reaches the address bar or browser storage.
          const leaked = await page.evaluate(
            (k: string) =>
              location.href.includes(k) ||
              JSON.stringify({ ...localStorage, ...sessionStorage }).includes(
                k,
              ),
            m.owner,
          );
          expect(leaked).toBe(false);
        } finally {
          await ctx.close();
        }
      }
    }, 240_000);

    it("a section that cannot load says so and shows nothing in its place; the others still show", async () => {
      const m = await seed();
      const { ctx, page } = await openPage(375, /\/ledger(\?|$)/u);
      try {
        await connect(page, m.owner);
        await page
          .getByRole("link", { name: "Find and buy equipment for the studio" })
          .click();
        await page.getByRole("heading", { name: "History" }).waitFor();
        await page.getByRole("heading", { name: "Budget" }).waitFor();
        const text = await page.locator("main").innerText();
        expect(text).toContain("This section is unavailable right now");
        expect(text).not.toContain("Committed or spent");
        expect(text.toLowerCase()).not.toContain("still available");
        await page
          .getByRole("heading", { name: "Spending authority" })
          .waitFor();
        await audit(page, "degraded@375");
      } finally {
        await ctx.close();
      }
    }, 60_000);

    it("a wrong key is refused without showing anything; another organization sees none of this mission", async () => {
      const m = await seed();
      const bad = await openPage(375);
      try {
        await connect(bad.page, "not-a-real-key-at-all");
        await bad.page
          .getByRole("alert")
          .filter({ hasText: "was not accepted" })
          .waitFor();
        expect(await bad.page.locator("main").innerText()).not.toContain(
          "Find and buy equipment",
        );
      } finally {
        await bad.ctx.close();
      }
      const other = await h.ownerOf("org-other");
      expect(other).not.toBe(m.owner);
      const { ctx, page } = await openPage(375);
      try {
        await connect(page, other);
        await page.getByRole("heading", { name: "No missions yet" }).waitFor();
        expect(await page.locator("main").innerText()).not.toContain(
          "Find and buy equipment",
        );
        // Opening the other tenant's mission by id is a clean refusal, not a leak.
        await page.goto(`${siteOrigin}/missions/?id=${m.id}`);
        await page.getByLabel("Host address", { exact: false }).fill(h.origin);
        await page.getByLabel("Member API key").fill(other);
        await page.getByRole("button", { name: "Open missions" }).click();
        await page.getByText("We couldn't find that mission.").waitFor();
      } finally {
        await ctx.close();
      }
    }, 60_000);

    it("a pending change that widens the contract is shown as waiting for an owner and not in force", async () => {
      const m = await seed();
      const r = await h.call(m.owner, "POST", `${MISSIONS}/${m.id}/revisions`, {
        baseVersion: 1,
        contract: contract({
          totalBudgetMinor: 900_000,
          maxCommitmentMinor: 60_000,
          expiresAt: "2026-11-23T10:00:00.000Z",
        }),
        idempotencyKey: idemKey("r"),
      });
      expect(r.status).toBeLessThan(300);
      const { mission } = (await r.json()) as {
        mission: { pendingVersion: number | null };
      };
      expect(mission.pendingVersion).toBe(2);
      const { ctx, page } = await openPage(375);
      try {
        await connect(page, m.owner);
        await page
          .getByRole("link", { name: "Find and buy equipment for the studio" })
          .click();
        await page
          .getByRole("heading", { name: "A change is waiting for an owner" })
          .waitFor();
        const text = await page.locator("main").innerText();
        expect(text).toContain("Version 2 is proposed and is not in force");
        expect(text).toContain("raises the total budget");
        expect(text).toContain("Version 1 in force");
        expect(text).toContain("$1,500"); // the ceiling in force, not the proposed $9,000
        expect(text).not.toContain("$9,000");
        await audit(page, "pending@375");
      } finally {
        await ctx.close();
      }
    }, 60_000);
  },
);
