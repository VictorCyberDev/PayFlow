import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { hostHarness } from "./helpers/host-harness.js";

/**
 * R1b — the customer web app in a real browser against the real Gateway on PostgreSQL (same origin, real cookies).
 * One journey: create an account -> add an agent -> describe a mission in the wizard -> submit -> approve -> see the spending
 * authority -> pause (authority ends) -> sign out. Plus: the session cookie is invisible to page script, hostile text is rendered
 * as text, nothing overflows at six widths, and axe finds no WCAG A/AA violations on the screens.
 */
const url = process.env.TEST_DATABASE_URL;
const pw = resolve("apps/console/node_modules/playwright-core/index.mjs");
const have = existsSync(pw);
if (process.env.REQUIRE_BROWSER === "1" && !have)
  throw new Error("Playwright missing");
interface Loc {
  waitFor(o?: { timeout?: number }): Promise<void>;
  click(): Promise<void>;
  fill(v: string): Promise<void>;
  selectOption(v: string): Promise<unknown>;
  check(): Promise<void>;
  innerText(): Promise<string>;
  count(): Promise<number>;
  first(): Loc;
  filter(o: { hasText?: string | RegExp; has?: Loc }): Loc;
  locator(s: string): Loc;
  getByLabel(n: string, o?: { exact?: boolean }): Loc;
  getByRole(r: string, o?: { name?: string | RegExp; level?: number }): Loc;
}
interface Page {
  goto(u: string): Promise<unknown>;
  url(): string;
  getByLabel(n: string, o?: { exact?: boolean }): Loc;
  getByRole(r: string, o?: { name?: string | RegExp; level?: number }): Loc;
  getByText(t: string | RegExp, o?: { exact?: boolean }): Loc;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  locator(s: string): Loc;
  evaluate<R>(fn: () => R): Promise<R>;
  evaluate<R, A>(fn: (a: A) => R, arg: A): Promise<R>;
  addScriptTag(o: { content: string }): Promise<unknown>;
  setViewportSize(s: { width: number; height: number }): Promise<void>;
  on(e: "dialog", h: (d: { accept(): Promise<void> }) => void): void;
}
interface Ctx {
  newPage(): Promise<Page>;
  cookies(): Promise<
    { name: string; httpOnly: boolean; sameSite: string; value: string }[]
  >;
  close(): Promise<void>;
}
interface Browser {
  newContext(o: object): Promise<Ctx>;
  close(): Promise<void>;
}
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
  "R1b customer app (real browser + real Gateway)",
  () => {
    const h = hostHarness({
      // every test in this file comes from one address; the default per-address cap is for the public internet, not a test run
      env: { PAYFLOW_IP_RATE_LIMIT_PER_MINUTE: "100000" },
      draftModel: () => ({
        complete: () =>
          Promise.resolve({
            status: "OK" as const,
            text: JSON.stringify({
              objective: "Buy two quiet keyboards",
              intendedOutcome: "Two keyboards ordered",
              successCriteria: ["Under budget", "Quiet switches"],
              suggestedBudgetMinor: 100_000,
              suggestedMaxPurchaseMinor: 30_000,
              suggestedCategory: "EQUIPMENT",
              questions: ["Which layout?"],
            }),
          }),
      }),
      extraTruncate:
        "mission_booking_events,mission_bookings,mission_workspace_listings,mission_workspace_searches,user_sessions,user_memberships,user_accounts,missions,mission_versions,mission_agent_grants,mission_transitions,mission_authorities,mission_ledger_items,mission_ledger_entries,mission_plans,mission_tasks,mission_task_deps,mission_task_events,mandates",
    });
    const require_ = createRequire(import.meta.url);
    let axeSource = "";
    let browser: Browser;
    beforeAll(async () => {
      axeSource = readFileSync(
        require_.resolve("../apps/console/node_modules/axe-core/axe.min.js"),
        "utf8",
      );
      const { chromium } = (await import(pw)) as {
        chromium: { launch(o: object): Promise<Browser> };
      };
      browser = await chromium.launch({
        headless: true,
        ...(chromePath ? { executablePath: chromePath } : {}),
      });
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
    });

    const open = async (width = 1280) => {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
        // The app ships a strict CSP (no inline script). Only the test's axe injection needs it lifted, and only in the browser context.
        bypassCSP: true,
      });
      const page = await ctx.newPage();
      page.on("dialog", (d) => void d.accept());
      return { ctx, page };
    };
    const axe = async (page: Page) => {
      await page.addScriptTag({ content: axeSource });
      return page.evaluate(async () => {
        const a = (window as unknown as { axe: Axe }).axe;
        const r = await a.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
        });
        return r.violations.map((v) => `${v.id}:${v.nodes.length}`);
      });
    };
    const overflow = (page: Page) =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );

    it("the whole customer journey works in a browser, and the session is invisible to page script", async () => {
      const { ctx, page } = await open();
      await page.goto(`${h.origin}/workspace`);
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      expect(await axe(page)).toEqual([]);
      // sign-in with nothing created is refused with a human message and no detail
      await page.getByLabel("Email").fill("nobody@example.com");
      await page.getByLabel("Password").fill("not the right password");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByText("don't match").waitFor();

      // create an account
      await page.getByText("Create an account").click();
      await page.getByLabel("Your name").fill("Sam Rivera");
      await page.getByLabel("Organization name").fill("Rivera Studio");
      await page.getByLabel("Email").fill("sam@example.com");
      await page.getByLabel("Password").fill("a long enough passphrase");
      await page.getByRole("button", { name: "Create account" }).click();
      await page
        .getByRole("heading", { name: "Welcome, Sam Rivera" })
        .waitFor();

      // the cookie is HttpOnly + Strict and not readable by script
      const cookie = (await ctx.cookies()).find(
        (c) => c.name === "pf_session",
      )!;
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("Strict");
      expect(await page.evaluate(() => document.cookie)).toBe("");

      // add an agent
      await page.getByRole("link", { name: "Agents" }).click();
      await page.getByRole("heading", { name: "Agents", level: 1 }).waitFor();
      await page.getByLabel("Agent name").fill("Buyer");
      await page.getByRole("button", { name: "Add agent" }).click();
      await page.getByText("Buyer").first().waitFor();
      // a credential is shown once
      await page
        .getByRole("button", { name: "Create credential for Buyer" })
        .click();
      await page.getByText("Copy this credential now").waitFor();
      expect(await page.locator(".secret").innerText()).toMatch(
        /^pf_sbx_pfc_[a-f0-9]{24}\./u,
      );

      // the wizard, with validation on the way
      await page.goto(`${h.origin}/workspace#/missions/new`);
      await page.getByRole("heading", { name: "New mission" }).waitFor();
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByText("Fill in the goal").waitFor();
      // the optional AI suggestion pre-fills the form for review; it creates nothing
      await page
        .getByLabel("Or describe it in your own words (optional)")
        .fill("two quiet keyboards for the studio");
      await page.getByRole("button", { name: "Suggest" }).click();
      await page.getByText("Review every field").waitFor();
      expect(
        Number((await h.repo.sql`select count(*)::int n from missions`)[0]!.n),
      ).toBe(0);
      await page
        .getByLabel("What should be done?")
        .fill("Buy two quiet keyboards");
      await page
        .getByLabel("What does done look like?")
        .fill("Two keyboards ordered");
      await page
        .getByLabel("How will you judge it? (one per line)")
        .fill("Under budget\nQuiet switches");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByLabel("Largest single purchase").fill("2000");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByText("cannot exceed the total budget").waitFor();
      await page.getByLabel("Largest single purchase").fill("300");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByText("Give at least one agent a role").waitFor();
      await page.getByLabel("Buy (within limits)").check();
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("heading", { name: "Review" }).waitFor();
      await page.getByRole("button", { name: "Create mission" }).click();
      await page
        .getByRole("heading", { name: "Buy two quiet keyboards" })
        .waitFor();
      await page.getByText("Draft", { exact: true }).first().waitFor();

      // nothing is in force until the owner approves
      expect(
        Number(
          (
            await h.repo.sql`select count(*)::int n from mission_authorities`
          )[0]!.n,
        ),
      ).toBe(0);
      await page.getByRole("button", { name: "Submit for approval" }).click();
      await page
        .getByText("Waiting for you", { exact: true })
        .first()
        .waitFor();
      await page.getByRole("button", { name: "Approve" }).click();
      await page.getByText("In force", { exact: true }).first().waitFor();
      await page.getByRole("cell", { name: "EQUIPMENT" }).waitFor();
      expect(
        Number(
          (
            await h.repo
              .sql`select count(*)::int n from mission_authorities where status = 'ACTIVE'`
          )[0]!.n,
        ),
      ).toBe(1);
      expect(await axe(page)).toEqual([]);

      // pausing ends the spending authority immediately
      await page.getByRole("button", { name: "Pause" }).click();
      await page.getByText("Paused", { exact: true }).first().waitFor();
      expect(
        Number(
          (
            await h.repo
              .sql`select count(*)::int n from mission_authorities where status = 'ACTIVE'`
          )[0]!.n,
        ),
      ).toBe(0);

      // sign out: the page falls back to sign-in and the old cookie is dead
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      await page.goto(`${h.origin}/workspace#/missions`);
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      const dead = await fetch(`${h.origin}/v1/app/me`, {
        headers: { cookie: `pf_session=${cookie.value}` },
      });
      expect(dead.status).toBe(401);
      await ctx.close();
    }, 120_000);

    (process.env.SHOTS_DIR ? it : it.skip)(
      "design review screenshots (only when SHOTS_DIR is set)",
      async () => {
        const dir = process.env.SHOTS_DIR!;
        const { ctx, page } = await open(1280);
        await fetch(`${h.origin}/v1/app/signup`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: h.origin },
          body: JSON.stringify({
            email: "shots@example.com",
            password: "a long enough passphrase",
            displayName: "Sam Rivera",
            organizationName: "Rivera Studio",
          }),
        });
        await page.goto(`${h.origin}/workspace`);
        await page.getByRole("heading", { name: "Sign in" }).waitFor();
        for (const w of [1280, 375]) {
          await page.setViewportSize({ width: w, height: 900 });
          await page.screenshot({
            path: `${dir}/signin-${w}.png`,
            fullPage: true,
          });
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.getByLabel("Email").fill("shots@example.com");
        await page.getByLabel("Password").fill("a long enough passphrase");
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("heading", { name: /Welcome/u }).waitFor();
        await page.goto(`${h.origin}/workspace#/agents`);
        await page.getByLabel("Agent name").fill("Buyer");
        await page.getByRole("button", { name: "Add agent" }).click();
        await page.getByText("Buyer").first().waitFor();
        await page.goto(`${h.origin}/workspace#/missions/new`);
        await page.getByRole("heading", { name: "New mission" }).waitFor();
        for (const w of [1280, 375]) {
          await page.setViewportSize({ width: w, height: 900 });
          await page.screenshot({
            path: `${dir}/wizard-${w}.png`,
            fullPage: true,
          });
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        await page
          .getByLabel("What should be done?")
          .fill("Buy two quiet keyboards");
        await page
          .getByLabel("What does done look like?")
          .fill("Two keyboards ordered");
        await page
          .getByLabel("How will you judge it? (one per line)")
          .fill("Under budget");
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByLabel("Buy (within limits)").check();
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByRole("button", { name: "Create mission" }).click();
        await page.getByRole("button", { name: "Submit for approval" }).click();
        await page.getByRole("button", { name: "Approve" }).click();
        await page.getByText("In force", { exact: true }).first().waitFor();
        await page.getByRole("cell", { name: "EQUIPMENT" }).waitFor();
        for (const w of [1280, 375]) {
          await page.setViewportSize({ width: w, height: 900 });
          await page.screenshot({
            path: `${dir}/mission-${w}.png`,
            fullPage: true,
          });
        }
        await page.goto(`${h.origin}/workspace#/`);
        await page.getByRole("heading", { name: /Welcome/u }).waitFor();
        await page.screenshot({ path: `${dir}/home-375.png`, fullPage: true });
        await ctx.close();
      },
      120_000,
    );

    it("the approvals center shows what is waiting, answers the questions before the buttons, and approving puts the mission in force", async () => {
      const { ctx, page } = await open();
      await fetch(`${h.origin}/v1/app/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({
          email: "approver@example.com",
          password: "a long enough passphrase",
          displayName: "Ada Approver",
          organizationName: "Approvals Ltd",
        }),
      });
      await page.goto(`${h.origin}/workspace`);
      await page.getByLabel("Email").fill("approver@example.com");
      await page.getByLabel("Password").fill("a long enough passphrase");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: /Welcome/u }).waitFor();
      await page.goto(`${h.origin}/workspace#/agents`);
      await page.getByLabel("Agent name").fill("Buyer");
      await page.getByRole("button", { name: "Add agent" }).click();
      await page.getByText("Buyer").first().waitFor();
      // empty state first
      await page.getByRole("link", { name: "Approvals" }).click();
      await page.getByText("Nothing is waiting for you.").waitFor();
      // create and submit a mission through the wizard: it now waits for the owner
      await page.goto(`${h.origin}/workspace#/missions/new`);
      await page.getByLabel("What should be done?").fill("Buy a standing desk");
      await page.getByLabel("What does done look like?").fill("Desk ordered");
      await page
        .getByLabel("How will you judge it? (one per line)")
        .fill("Under budget");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByLabel("Buy (within limits)").check();
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Create mission" }).click();
      await page.getByRole("button", { name: "Submit for approval" }).click();
      await page
        .getByText("Waiting for you", { exact: true })
        .first()
        .waitFor();
      await page.getByRole("link", { name: "Approvals" }).click();
      await page
        .getByRole("heading", { name: "Put this mission to work?" })
        .waitFor();
      const card = await page.locator("main").innerText();
      for (const q of [
        "Who wants to act",
        "Reversible?",
        "Creates a binding obligation?",
        "Most it can ever commit",
        "You are asked first above",
      ])
        expect(card).toContain(q);
      expect(await axe(page)).toEqual([]);
      expect(
        Number(
          (
            await h.repo.sql`select count(*)::int n from mission_authorities`
          )[0]!.n,
        ),
      ).toBe(0);
      await page.getByRole("button", { name: "Approve" }).click();
      await page.getByText("Nothing is waiting for you.").waitFor();
      expect(
        Number(
          (
            await h.repo
              .sql`select count(*)::int n from mission_authorities where status = 'ACTIVE'`
          )[0]!.n,
        ),
      ).toBe(1);
      await ctx.close();
    }, 90_000);

    it("workspace search from the mission page: honest sandbox labelling, unknown terms shown as unknown, nothing booked or spent", async () => {
      const { ctx, page } = await open();
      await fetch(`${h.origin}/v1/app/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({
          email: "space@example.com",
          password: "a long enough passphrase",
          displayName: "Sam Space",
          organizationName: "Space Ltd",
        }),
      });
      await page.goto(`${h.origin}/workspace`);
      await page.getByLabel("Email").fill("space@example.com");
      await page.getByLabel("Password").fill("a long enough passphrase");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: /Welcome/u }).waitFor();
      await page.goto(`${h.origin}/workspace#/agents`);
      await page.getByLabel("Agent name").fill("Scout");
      await page.getByRole("button", { name: "Add agent" }).click();
      await page.getByText("Scout").first().waitFor();
      await page.goto(`${h.origin}/workspace#/missions/new`);
      await page
        .getByLabel("What should be done?")
        .fill("Find a small office in Bristol");
      await page
        .getByLabel("What does done look like?")
        .fill("Three offices compared");
      await page
        .getByLabel("How will you judge it? (one per line)")
        .fill("Under budget");
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByLabel("Currency").selectOption("GBP");
      await page.getByLabel("Total budget").fill("5000");
      await page.getByLabel("Largest single purchase").fill("2000");
      await page.getByLabel("Ask me first above").fill("1500");
      await page
        .getByLabel("Workspaces (desks, offices, meeting rooms)")
        .check();
      await page
        .getByLabel("Professional services (design, writing, bookkeeping)")
        .check();
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByLabel("Research and compare").check();
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Create mission" }).click();
      await page.getByRole("button", { name: "Submit for approval" }).click();
      await page.getByRole("button", { name: "Approve" }).click();
      await page.getByText("In force", { exact: true }).first().waitFor();
      await page.getByRole("link", { name: "Find a workspace" }).click();
      await page
        .getByRole("heading", { name: "Workspaces", level: 1 })
        .waitFor();
      await page.getByLabel("City").fill("Bristol");
      await page.getByLabel("First day").fill("2026-12-08");
      await page.getByLabel("Last day").fill("2026-12-15");
      await page.getByRole("button", { name: "Search" }).click();
      await page
        .getByText("fictional sandbox listings")
        .waitFor()
        .catch(async (e: unknown) => {
          throw new Error(
            `${String(e)} PAGE: ${(await page.locator("main").innerText()).slice(0, 600)}`,
          );
        });
      await page
        .getByRole("heading", { name: "Harbour Studio (fictional)" })
        .waitFor();
      const text = await page.locator("main").innerText();
      expect(text).toContain("Fits your needs");
      expect(text).toContain("Not stated by the source"); // the incomplete listing never shows a made-up figure
      expect(text).toContain("not quotes, bookings or reservations");
      if (process.env.SHOTS_DIR)
        await page.screenshot({
          path: `${process.env.SHOTS_DIR}/workspaces-1280.png`,
          fullPage: true,
        });
      expect(await axe(page)).toEqual([]);
      expect(
        Number(
          (
            await h.repo
              .sql`select count(*)::int n from mission_workspace_searches`
          )[0]!.n,
        ),
      ).toBe(1);
      expect(
        Number(
          (
            await h.repo.sql`select count(*)::int n from mission_ledger_items`
          )[0]!.n,
        ),
      ).toBe(0);
      // propose -> approve -> asked -> confirm with the weakest evidence: the screen never claims more than the evidence
      const card = page.locator("article").filter({
        has: page.getByRole("heading", {
          name: "Harbour Studio (fictional)",
        }),
      });
      await card.getByRole("button", { name: "Propose a booking" }).click();
      const bk = page
        .locator("article")
        .filter({ hasText: "Proposed. Nothing is approved or reserved." });
      await bk.waitFor();
      expect(await bk.innerText()).toContain("Budget held now");
      await bk
        .getByRole("button", { name: "Approve and hold the budget" })
        .click();
      const ap = page
        .locator("article")
        .filter({ hasText: "Approved to attempt. Nothing is reserved yet." });
      await ap.waitFor();
      await ap
        .getByRole("button", { name: "I have asked the provider" })
        .click();
      const ho = page.locator("article").filter({
        hasText: "Waiting for the provider. Nothing is reserved yet.",
      });
      await ho.waitFor();
      await ho.locator("summary").click();
      await ho.getByLabel("What shows it").selectOption("OWNER_ATTESTATION");
      await ho.getByRole("button", { name: "Record the confirmation" }).click();
      const done = page
        .locator("article")
        .filter({ hasText: "PayFlow has no proof" });
      await done.waitFor();
      expect(await done.innerText()).not.toContain("Confirmed by the provider");
      expect(await done.innerText()).toContain("Confirmed by you");
      if (process.env.SHOTS_DIR)
        await page.screenshot({
          path: `${process.env.SHOTS_DIR}/bookings-1280.png`,
          fullPage: true,
        });
      expect(await axe(page)).toEqual([]);
      expect(
        (await h.repo.sql`select state from mission_bookings`).map((r) =>
          String(r.state),
        ),
      ).toEqual(["CONFIRMED"]);
      // every mission record screen opens, says something plain, and passes axe; Finance shows the held budget in words
      const mid = /msn_[a-f0-9]{24}/u.exec(page.url())![0];
      for (const [sec, heading] of [
        ["finance", "Finance"],
        ["quotes", "Sourcing and quotes"],
        ["negotiations", "Negotiations"],
        ["orders", "Purchases and orders"],
        ["disputes", "Disputes"],
        ["contractors", "Contractors"],
        ["obligations", "Obligations"],
        ["proof", "Proof"],
      ] as const) {
        await page.goto(`${h.origin}/workspace#/missions/${mid}/${sec}`);
        await page.getByRole("heading", { name: heading, level: 1 }).waitFor();
        const t = await page.locator("main").innerText();
        expect(t, sec).not.toMatch(/undefined|\[object|NaN|null/u);
        expect(await axe(page), sec).toEqual([]);
      }
      await page.goto(`${h.origin}/workspace#/missions/${mid}/finance`);
      await page.getByRole("heading", { name: "Finance", level: 1 }).waitFor();
      expect(await page.locator("main").innerText()).toContain("£");
      // services: a search lists fictional packages honestly, and an unstated price is shown as unstated
      await page.goto(`${h.origin}/workspace#/missions/${mid}/services`);
      await page.getByRole("heading", { name: "Services", level: 1 }).waitFor();
      await page.getByLabel("Most you will pay (GBP)").fill("1000");
      await page.getByRole("button", { name: "Search" }).click();
      await page.getByText("fictional sandbox packages").waitFor();
      const svc = await page.locator("main").innerText();
      expect(svc).toContain("Logo and one-page style sheet");
      expect(svc).toContain("Fits your needs");
      expect(svc).toContain("Price not stated");
      expect(svc).not.toMatch(/undefined|\[object|NaN/u);
      expect(await axe(page)).toEqual([]);
      for (const [hash, heading] of [
        ["notifications", "Notifications"],
        ["settings", "Settings"],
        ["help", "Help"],
      ] as const) {
        await page.goto(`${h.origin}/workspace#/${hash}`);
        await page.getByRole("heading", { name: heading, level: 1 }).waitFor();
        expect(await axe(page), hash).toEqual([]);
      }
      if (process.env.SHOTS_DIR) {
        await page.goto(`${h.origin}/workspace#/missions/${mid}/finance`);
        await page
          .getByRole("heading", { name: "Finance", level: 1 })
          .waitFor();
        await page.screenshot({
          path: `${process.env.SHOTS_DIR}/finance-1280.png`,
          fullPage: true,
        });
        await page.goto(`${h.origin}/workspace#/missions/${mid}/proof`);
        await page.getByRole("heading", { name: "Proof", level: 1 }).waitFor();
        await page.screenshot({
          path: `${process.env.SHOTS_DIR}/proof-1280.png`,
          fullPage: true,
        });
      }
      await ctx.close();
    }, 90_000);

    it("hostile text from the server is shown as text and never runs", async () => {
      const { ctx, page } = await open();
      await page.goto(`${h.origin}/workspace`);
      await page.getByText("Create an account").click();
      await page
        .getByLabel("Your name")
        .fill("<img src=x onerror=window.__pwned=1>");
      await page.getByLabel("Organization name").fill("Evil <b>Org</b>");
      await page.getByLabel("Email").fill("evil@example.com");
      await page.getByLabel("Password").fill("another long passphrase");
      await page.getByRole("button", { name: "Create account" }).click();
      await page.getByRole("heading", { name: /Welcome, <img/u }).waitFor();
      expect(
        await page.evaluate(
          () => (window as unknown as { __pwned?: number }).__pwned,
        ),
      ).toBeUndefined();
      expect(await page.locator("main img").count()).toBe(0);
      await ctx.close();
    }, 60_000);

    it("nothing overflows sideways and axe finds nothing at six widths", async () => {
      const { ctx, page } = await open(1280);
      await fetch(`${h.origin}/v1/app/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.origin },
        body: JSON.stringify({
          email: "sam@example.com",
          password: "a long enough passphrase",
          displayName: "Sam Rivera",
          organizationName: "Rivera Studio",
        }),
      });
      await page.goto(`${h.origin}/workspace`);
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w, height: 900 });
        expect(await overflow(page), `sign-in @${w}`).toBeLessThanOrEqual(0);
      }
      await page.getByLabel("Email").fill("sam@example.com");
      await page.getByLabel("Password").fill("a long enough passphrase");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("heading", { name: /Welcome/u }).waitFor();
      for (const hash of ["#/", "#/agents", "#/missions", "#/missions/new"]) {
        await page.goto(`${h.origin}/workspace${hash}`);
        await page.locator("main h1").first().waitFor();
        for (const w of WIDTHS) {
          await page.setViewportSize({ width: w, height: 900 });
          expect(await overflow(page), `${hash} @${w}`).toBeLessThanOrEqual(0);
        }
        expect(await axe(page), hash).toEqual([]);
      }
      await ctx.close();
    }, 120_000);
  },
);
