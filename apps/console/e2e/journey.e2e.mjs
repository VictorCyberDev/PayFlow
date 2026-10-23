// M5E browser acceptance. Drives the real static console against the real HTTP host
// (tests/e2e-host.ts) with recorded model behavior and an isolated PostgreSQL database.
// No live Groq, PayPal or payment rail is involved.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const shots = process.env.E2E_SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const databaseUrl = process.env.E2E_DATABASE_URL;
assert.ok(databaseUrl, "E2E_DATABASE_URL is required");
const code = randomBytes(32).toString("base64url");
let host, browser, origin, control;
const ctl = async (path) =>
  (await fetch(control + path, { method: "POST" })).json().catch(() => ({}));
const counts = async () => (await fetch(control + "/counts")).json();
const reset = () => ctl("/reset");

before(async () => {
  host = spawn("node", ["--import", "tsx", "tests/e2e-host.ts"], {
    cwd: root,
    env: {
      ...process.env,
      E2E_DATABASE_URL: databaseUrl,
      E2E_BOOTSTRAP_KEY: code,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("E2E host timeout")),
      60000,
    );
    host.stdout.on("data", (d) => {
      log += d;
      const m = /E2E_READY (.*)/.exec(log);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[1]));
      }
    });
    host.stderr.on("data", (d) => (log += d));
    host.on("exit", () => reject(new Error("E2E host exited")));
  });
  ({ origin, control } = ready);
  const executablePath = [
    process.env.PLAYWRIGHT_CHROMIUM,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  ].find((p) => p && existsSync(p));
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => {
  await browser?.close();
  host?.kill();
});

async function open(viewport = { width: 1280, height: 900 }, opts = {}) {
  const context = await browser.newContext({ viewport, ...opts });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
      problems.push("console: " + m.text());
  });
  await page.goto(origin);
  return { context, page, problems };
}
const shot = (page, name) =>
  shots
    ? page.screenshot({ path: `${shots}/${name}.png`, fullPage: true })
    : undefined;
async function review(page) {
  await page
    .getByRole("button", { name: /recorded, fully specified example/ })
    .click();
  await page.getByRole("button", { name: "Review request" }).click();
  await page.getByText("What the AI understood").waitFor();
}
async function signIn(page) {
  await page.getByLabel("Demo access code").fill(code);
  await page.getByRole("button", { name: "Open demo session" }).click();
  await page
    .getByRole("button", { name: "Prepare exact authority review" })
    .waitFor();
}
async function activate(page) {
  await page
    .getByRole("button", { name: "Prepare exact authority review" })
    .click();
  await page
    .getByRole("heading", { name: /Give .* this authority\?/ })
    .waitFor();
  await page.getByRole("button", { name: "Confirm authority" }).click();
  await page.getByRole("heading", { name: "Authority active" }).waitFor();
}
const zeroPayments = async () => {
  const c = await counts();
  for (const t of [
    "payment_attempts",
    "authorization_reservations",
    "execution_grants",
    "transaction_proposals",
    "paypal_provider_observations",
  ])
    assert.equal(c[t], 0, t + " must stay zero");
  return c;
};

test("full journey: ask, untrusted review, exact confirmation, active, reload, activity, revoke, revoked, reload", async () => {
  await reset();
  const { context, page, problems } = await open();
  await shot(page, "01-home-desktop");
  assert.match(
    await page.locator("#activity").innerText(),
    /Open a demo session to see/,
  );
  await review(page);
  assert.ok(await page.getByText("Not yet authorized").first().isVisible());
  assert.equal((await counts()).mandates, 0, "a review creates no Mandate");
  await signIn(page);
  await page
    .getByRole("button", { name: "Prepare exact authority review" })
    .click();
  await page
    .getByRole("heading", { name: /Give .* this authority\?/ })
    .waitFor();
  assert.equal(
    (await counts()).mandates,
    0,
    "pending review creates no Mandate",
  );
  await shot(page, "02-confirmation-desktop");
  await page.getByRole("button", { name: "Confirm authority" }).click();
  await page.getByRole("heading", { name: "Authority active" }).waitFor();
  assert.equal((await counts()).mandates, 1);
  await shot(page, "03-active-desktop");
  // Saved Authority (durable list) and reload.
  await page.reload();
  await page.getByRole("heading", { name: "Authority active" }).waitFor();
  const saved = page.locator(".managed-card");
  await saved.first().waitFor();
  assert.match(await saved.first().innerText(), /Active/i);
  assert.match(
    await page.locator("#activity").innerText(),
    /What happened, and why/,
  );
  await shot(page, "04-authority-activity-desktop");
  const before = await counts();
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.getByRole("heading", { name: "Authority active" }).waitFor();
  }
  const afterReload = await counts();
  assert.equal(afterReload.events, before.events, "reloads append no evidence");
  // Revoke deliberately.
  await saved.first().getByRole("button", { name: "Revoke authority" }).click();
  await page.getByRole("heading", { name: "Revoke this authority?" }).waitFor();
  assert.match(await page.locator(".revoke-sheet").innerText(), /not reversed/);
  await shot(page, "05-revoke-sheet-desktop");
  await page
    .locator(".revoke-sheet")
    .getByRole("button", { name: "Revoke authority" })
    .click();
  await page
    .locator(".state-pill", { hasText: /Revoked/i })
    .first()
    .waitFor();
  // No other card on the page may keep claiming the authority is active (no reload).
  await page
    .getByRole("heading", { name: "Authority revoked" })
    .waitFor({ timeout: 5000 });
  assert.equal(
    await page.getByRole("heading", { name: "Authority active" }).count(),
    0,
  );
  assert.match(
    await page.locator(".managed-card").first().innerText(),
    /Completed\s+payments are not reversed/,
  );
  await shot(page, "06-revoked-desktop");
  await page.reload();
  await page
    .locator(".state-pill", { hasText: /Revoked/i })
    .first()
    .waitFor();
  const done = await zeroPayments();
  assert.equal(done.MANDATE_REVOKED, 1);
  assert.deepEqual(problems, []);
  await context.close();
});

test("stale tab showing ACTIVE is corrected by a fresh durable read after revocation elsewhere", async () => {
  await reset();
  const { context, page, problems } = await open();
  await review(page);
  await signIn(page);
  await activate(page);
  await page.locator(".managed-card").first().waitFor();
  const id = new URL(page.url()).searchParams.get("authority");
  assert.ok(id);
  await ctl("/revoke?mandateId=" + encodeURIComponent(id)); // "another device"
  // The old tab still renders ACTIVE until it reads again; nothing local restores it either way.
  assert.match(
    await page.locator(".managed-card").first().innerText(),
    /Active/i,
  );
  await page.getByRole("button", { name: "Refresh saved state" }).click();
  await page
    .locator(".state-pill", { hasText: /Revoked/i })
    .first()
    .waitFor();
  await page.getByRole("button", { name: "Refresh authority" }).click();
  await page.getByRole("heading", { name: "Authority revoked" }).waitFor();
  await zeroPayments();
  assert.deepEqual(problems, []);
  await context.close();
});

test("CSRF failure on confirmation creates nothing and is presented safely", async () => {
  await reset();
  const { context, page } = await open();
  await review(page);
  await signIn(page);
  await page
    .getByRole("button", { name: "Prepare exact authority review" })
    .click();
  await page
    .getByRole("heading", { name: /Give .* this authority\?/ })
    .waitFor();
  await page.route("**/api/activation/confirm", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-payflow-csrf": "forged" },
    }),
  );
  await page.getByRole("button", { name: "Confirm authority" }).click();
  await page
    .getByText(/could not be verified/)
    .first()
    .waitFor();
  assert.equal((await counts()).mandates, 0);
  assert.equal(
    await page.getByRole("heading", { name: "Authority active" }).count(),
    0,
  );
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /Error:|at .*\.(ts|js)|CSRF_REJECTED/,
  );
  await zeroPayments();
  await context.close();
});

test("session expiry on the server blocks activation with a human message and no Mandate", async () => {
  await reset();
  const { context, page } = await open();
  await review(page);
  await signIn(page);
  await page
    .getByRole("button", { name: "Prepare exact authority review" })
    .click();
  await page
    .getByRole("heading", { name: /Give .* this authority\?/ })
    .waitFor();
  await ctl("/advance?seconds=960"); // beyond the 15-minute session lifetime
  await page.getByRole("button", { name: "Confirm authority" }).click();
  await page
    .getByText(/could not be verified|session|expired/i)
    .first()
    .waitFor();
  assert.equal((await counts()).mandates, 0);
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /Error:|SESSION_REQUIRED|at .*\.(ts|js)/,
  );
  await zeroPayments();
  await context.close();
});

test("tampered session cookie in the browser context cannot read or revoke saved authority", async () => {
  await reset();
  const { context, page } = await open();
  await review(page);
  await signIn(page);
  await activate(page);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "payflow_session");
  assert.ok(session?.httpOnly, "session cookie is HttpOnly");
  assert.equal(session.sameSite, "Strict");
  assert.equal(
    await page.evaluate(() => document.cookie),
    "",
    "script cannot read the session",
  );
  const bad =
    session.value.slice(0, -1) + (session.value.endsWith("A") ? "B" : "A");
  await context.clearCookies();
  await context.addCookies([{ ...session, value: bad }]);
  await page.reload();
  assert.equal(
    await page.getByRole("heading", { name: "Authority active" }).count(),
    0,
  );
  assert.equal((await counts()).MANDATE_REVOKED, 0);
  await context.close();
});

test("double-click on Confirm and Revoke produces one Mandate and one revocation event", async () => {
  await reset();
  const { context, page } = await open();
  await review(page);
  await signIn(page);
  await page
    .getByRole("button", { name: "Prepare exact authority review" })
    .click();
  await page
    .getByRole("heading", { name: /Give .* this authority\?/ })
    .waitFor();
  await page
    .getByRole("button", { name: "Confirm authority" })
    .dblclick()
    .catch(() => undefined);
  await page.getByRole("heading", { name: "Authority active" }).waitFor();
  assert.equal((await counts()).mandates, 1);
  await page
    .locator(".managed-card")
    .first()
    .getByRole("button", { name: "Revoke authority" })
    .click();
  await page
    .locator(".revoke-sheet")
    .getByRole("button", { name: "Revoke authority" })
    .dblclick()
    .catch(() => undefined);
  await page
    .locator(".state-pill", { hasText: /Revoked/i })
    .first()
    .waitFor();
  assert.equal((await counts()).MANDATE_REVOKED, 1);
  await zeroPayments();
  await context.close();
});

test("no secret, database URL, bootstrap code or challenge reaches the client bundle or network responses", async () => {
  await reset();
  const { context, page } = await open();
  const bodies = [];
  page.on("response", async (r) => {
    if (r.url().startsWith(origin))
      bodies.push(
        (await r.text().catch(() => "")) + JSON.stringify(r.headers()),
      );
  });
  await review(page);
  await signIn(page);
  await activate(page);
  await page.waitForTimeout(300);
  const html = await page.content();
  const all = bodies.join("\n") + html;
  assert.ok(!all.includes(code), "bootstrap code");
  assert.ok(!all.includes(databaseUrl), "database url");
  assert.doesNotMatch(
    all,
    /postgres:\/\/|DATABASE_URL|GROQ|PAYPAL_|client_secret|privateKey|"challenge"|reviewedHash|resumeSecret|executionGrant/i,
  );
  await context.close();
});

test("mobile 375px: no horizontal overflow, adequate touch targets, usable sheets", async () => {
  await reset();
  const { context, page, problems } = await open(
    { width: 375, height: 812 },
    { hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  );
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
  assert.ok((await overflow()) <= 0, "home overflow");
  await shot(page, "m01-home-mobile");
  await review(page);
  await signIn(page);
  await page
    .getByRole("button", { name: "Prepare exact authority review" })
    .click();
  await page
    .getByRole("heading", { name: /Give .* this authority\?/ })
    .waitFor();
  assert.ok((await overflow()) <= 0, "confirmation overflow");
  await shot(page, "m02-confirmation-mobile");
  await page.getByRole("button", { name: "Confirm authority" }).click();
  await page.getByRole("heading", { name: "Authority active" }).waitFor();
  await page.locator(".managed-card").first().waitFor();
  assert.ok((await overflow()) <= 0, "authority overflow");
  await shot(page, "m03-authority-mobile");
  await page
    .locator(".managed-card")
    .first()
    .getByRole("button", { name: "Revoke authority" })
    .click();
  await page.getByRole("heading", { name: "Revoke this authority?" }).waitFor();
  assert.ok((await overflow()) <= 0, "revoke sheet overflow");
  await shot(page, "m04-revoke-mobile");
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("button, a[href], summary, input, textarea")]
      .filter((e) => e.getClientRects().length)
      .map((e) => ({
        t: (e.textContent || e.id || e.tagName).trim().slice(0, 40),
        r: e.getBoundingClientRect(),
      }))
      .filter((x) => x.r.height < 44 || x.r.width < 44)
      .map((x) => `${x.t} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
  );
  assert.deepEqual(small, [], "touch targets under 44px");
  assert.deepEqual(problems, []);
  await context.close();
});

test("accessibility: keyboard-only flow, visible focus, labels, live regions, reduced motion, contrast", async () => {
  await reset();
  const { context, page } = await open(
    { width: 1280, height: 900 },
    { reducedMotion: "reduce" },
  );
  // Every form control has an accessible name.
  const unnamed = await page.evaluate(() =>
    [...document.querySelectorAll("input, textarea, select")]
      .filter(
        (e) => !(e.labels && e.labels.length) && !e.getAttribute("aria-label"),
      )
      .map((e) => e.outerHTML.slice(0, 80)),
  );
  assert.deepEqual(unnamed, []);
  assert.ok(await page.locator("[aria-live]").count());
  // Keyboard-only: tab to the sample button, activate, submit.
  await page.keyboard.press("Tab");
  const skip = await page.evaluate(() => document.activeElement?.textContent);
  assert.match(skip ?? "", /Skip to content/);
  await page
    .getByRole("button", { name: /recorded, fully specified example/ })
    .focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.getElementById("request")?.value.length > 0,
  );
  await page.getByRole("button", { name: "Review request" }).focus();
  await page.keyboard.press("Enter");
  await page.getByText("What the AI understood").waitFor();
  await page.getByLabel("Demo access code").focus();
  await page.keyboard.type(code);
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "Prepare exact authority review" })
    .waitFor();
  await page
    .getByRole("button", { name: "Prepare exact authority review" })
    .focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Confirm authority" }).waitFor();
  await page.getByRole("button", { name: "Confirm authority" }).focus();
  const focus = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return {
      outline: s.outlineStyle,
      width: parseFloat(s.outlineWidth),
      shadow: s.boxShadow,
    };
  });
  assert.ok(
    (focus.outline !== "none" && focus.width > 0) || focus.shadow !== "none",
    "focus indicator visible",
  );
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Authority active" }).waitFor();
  await page.locator(".managed-card").first().waitFor();
  // Revoke by keyboard; the sheet takes focus.
  await page
    .locator(".managed-card")
    .first()
    .getByRole("button", { name: "Revoke authority" })
    .focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Revoke this authority?" }).waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "revoke-title",
    "focus moves to the sheet",
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page
    .locator(".state-pill", { hasText: /Revoked/i })
    .first()
    .waitFor();
  assert.equal((await counts()).MANDATE_REVOKED, 1);
  // Status is conveyed in words, not colour alone.
  assert.match(
    await page.locator(".state-pill").first().innerText(),
    /[A-Za-z]{4,}/,
  );
  // details/summary are keyboard operable.
  const summary = page.locator("summary").first();
  await summary.focus();
  await page.keyboard.press("Enter");
  assert.equal(await summary.evaluate((e) => e.parentElement.open), true);
  // Reduced motion: no animation or transition longer than a blink.
  const motion = await page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .filter((e) => {
        const s = getComputedStyle(e);
        const d = (v) =>
          Math.max(
            0,
            ...v
              .split(",")
              .map((x) => parseFloat(x) * (x.includes("ms") ? 0.001 : 1)),
          );
        return d(s.animationDuration) > 0.05 || d(s.transitionDuration) > 0.05;
      })
      .map((e) => e.tagName + "." + e.className),
  );
  assert.deepEqual(motion, []);
  // Contrast: WCAG AA (4.5:1 normal, 3:1 large) for every visible text node.
  const failing = await page.evaluate(() => {
    const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) =>
        (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (e) => {
      for (let n = e; n; n = n.parentElement) {
        const [r, g, b, a = 1] = parse(getComputedStyle(n).backgroundColor);
        if (a > 0.5) return [r, g, b];
      }
      return [255, 255, 255];
    };
    const out = [];
    for (const e of document.querySelectorAll("body *")) {
      if (
        ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      )
        continue;
      if (!e.getClientRects().length) continue;
      const s = getComputedStyle(e);
      const fg = parse(s.color),
        bg = bgOf(e);
      const [a, b] = [lum(fg), lum(bg)];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large =
        parseFloat(s.fontSize) >= 24 ||
        (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5))
        out.push(
          `${e.tagName}.${e.className} ${ratio.toFixed(2)} "${e.textContent.trim().slice(0, 30)}"`,
        );
    }
    return out.slice(0, 15);
  });
  assert.deepEqual(failing, [], "contrast below WCAG AA");
  await context.close();
});

test("server unavailable: a failing read keeps prior state with a safe message and never claims success", async () => {
  await reset();
  const { context, page } = await open();
  await review(page);
  await signIn(page);
  await activate(page);
  await page.locator(".managed-card").first().waitFor();
  await page.route("**/api/activation/authorities", (r) => r.abort());
  await page.route("**/api/activation/authority?*", (r) => r.abort());
  await page.getByRole("button", { name: "Refresh saved state" }).click();
  await page
    .getByText(
      /couldn.t verify|could not be verified|unavailable|No change was made/i,
    )
    .first()
    .waitFor();
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /Error:|at .*\.(ts|js)|ECONN|fetch failed/,
  );
  await zeroPayments();
  await context.close();
});
