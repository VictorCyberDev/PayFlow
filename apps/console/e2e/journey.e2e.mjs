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
const nav = (page, name) =>
  page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name })
    .click();
async function signIn(page) {
  await page.getByLabel("Access code").fill(code);
  await page.getByRole("button", { name: "Open demo" }).click();
  await page
    .getByRole("heading", { level: 1, name: /No active Authorities yet/ })
    .waitFor();
}
/** Describe -> Understand (while signed in or out). */
async function understand(page) {
  await nav(page, /New/);
  await page
    .getByRole("heading", { level: 1, name: "What may your Agent do?" })
    .waitFor();
  await page.getByRole("button", { name: "Use the example" }).click();
  await page.waitForFunction(
    () => document.getElementById("request")?.value.length > 0,
  );
  await page.getByRole("button", { name: "Review my request" }).click();
  await page
    .getByRole("heading", { level: 1, name: /what PayFlow understood/ })
    .waitFor();
}
async function toConfirm(page) {
  await page.getByRole("button", { name: "Continue to confirm" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Confirm this Authority" })
    .waitFor();
  // Confirmation is ready only once the exact review has been prepared.
  await page.getByRole("button", { name: "Confirm Authority" }).waitFor();
}
async function createAuthority(page) {
  await understand(page);
  await toConfirm(page);
  await page.getByRole("button", { name: "Confirm Authority" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Authority created" })
    .waitFor();
}
const authorityId = async (page) =>
  new URL(
    await page
      .getByRole("link", { name: "View Authority" })
      .getAttribute("href"),
    origin,
  ).searchParams.get("id");
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
const sandboxBadges = (page) => page.locator(".env-badge:visible").count();

test("signed out: welcome, one environment badge, protected destinations ask for the demo session", async () => {
  await reset();
  const { context, page, problems } = await open();
  await page
    .getByRole("heading", { level: 1, name: /Permission to spend/ })
    .waitFor();
  await shot(page, "01-home-signed-out");
  assert.equal(await sandboxBadges(page), 1, "exactly one environment badge");
  assert.doesNotMatch(
    await page.locator("main").innerText(),
    /fixture|non-production|recorded/i,
  );
  await nav(page, "Authorities");
  await page.waitForURL("**/authorities/");
  await page.locator(".how").waitFor({ state: "detached" }); // the welcome copy is gone
  await page.getByRole("heading", { name: "Demo access" }).waitFor();
  assert.equal(
    await page.getByText(/\$\d/).count(),
    0,
    "no money shown while signed out",
  );
  await nav(page, "Activity");
  await page.waitForURL("**/activity/");
  await page.getByRole("heading", { name: "Demo access" }).waitFor();
  await page.getByRole("link", { name: "About this demo" }).first().click();
  await page
    .getByRole("heading", { level: 1, name: "About this demo" })
    .waitFor();
  assert.match(
    await page.locator("main").innerText(),
    /sandbox[\s\S]*recorded examples/i,
  );
  assert.equal((await page.locator("a[href='/about/']").count()) > 0, true);
  assert.deepEqual(problems, []);
  await context.close();
});

test("wrong access code is refused with a calm message", async () => {
  await reset();
  const { context, page } = await open();
  await page.getByLabel("Access code").fill("definitely-not-the-code");
  await page.getByRole("button", { name: "Open demo" }).click();
  await page.getByText(/That code didn.t work/).waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: /No active Authorities yet/ })
      .count(),
    0,
  );
  await context.close();
});

test("full journey: describe, understand, confirm, created, view, reload, revoke, revoked, reload", async () => {
  await reset();
  const { context, page, problems } = await open();
  await signIn(page);
  await shot(page, "02-home-empty");
  await understand(page);
  assert.ok(await page.getByText("Not yet authorized").first().isVisible());
  assert.equal((await counts()).mandates, 0, "a review creates no Mandate");
  await shot(page, "03-understand");
  await toConfirm(page);
  assert.equal(
    (await counts()).mandates,
    0,
    "pending confirmation creates no Mandate",
  );
  await shot(page, "04-confirm");
  await page.getByRole("button", { name: "Confirm Authority" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Authority created" })
    .waitFor();
  assert.equal((await counts()).mandates, 1);
  await shot(page, "05-created");
  const id = await authorityId(page);
  assert.ok(id);
  await page.getByRole("link", { name: "View Authority" }).click();
  await page.getByRole("button", { name: "Revoke Authority" }).waitFor();
  const frame = page.locator(".frame").first();
  await frame.waitFor();
  const text = await frame.innerText();
  assert.match(text, /Active/i);
  assert.match(text, /\$100\s*left/);
  assert.match(text, /Can spend without asking up to \$100/);
  assert.doesNotMatch(
    await page.locator("main").innerText(),
    /GMT|UTC|Mandate|fingerprint|committed/i,
  );
  await shot(page, "06-authority-detail");
  const before = await counts();
  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.locator(".frame").first().waitFor();
  }
  assert.equal(
    (await counts()).events,
    before.events,
    "reloads append no evidence",
  );
  // Home reflects the Authority.
  await nav(page, "Home");
  await page
    .getByRole("heading", {
      level: 1,
      name: "Everything is within your rules.",
    })
    .waitFor();
  await shot(page, "07-home-active");
  // Proof is a deliberate mode.
  await nav(page, "Authorities");
  await page.locator(".frame a").first().click();
  await page.getByRole("link", { name: "View proof" }).click();
  await page.getByRole("heading", { level: 1 }).waitFor();
  assert.match(await page.locator("main").innerText(), new RegExp(id));
  assert.match(await page.locator("main").innerText(), /single maximum/);
  await shot(page, "08-proof");
  await page.getByRole("link", { name: /Back to this Authority/ }).click();
  // Revoke deliberately.
  await page.getByRole("button", { name: "Revoke Authority" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: "Revoke this Authority?" })
    .waitFor();
  assert.match(await dialog.innerText(), /not reversed/);
  await shot(page, "09-revoke-sheet");
  await dialog.getByRole("button", { name: "Revoke Authority" }).click();
  await page
    .locator(".state-tag", { hasText: /Revoked/i })
    .first()
    .waitFor();
  assert.match(
    await page.locator(".frame").first().innerText(),
    /Completed payments are not reversed/,
  );
  await shot(page, "10-revoked");
  await page.reload();
  await page
    .locator(".state-tag", { hasText: /Revoked/i })
    .first()
    .waitFor();
  await nav(page, "Home");
  await page
    .getByRole("heading", {
      level: 1,
      name: /No Authority is active right now/,
    })
    .waitFor();
  const done = await zeroPayments();
  assert.equal(done.MANDATE_REVOKED, 1);
  assert.deepEqual(problems, []);
  await context.close();
});

test("review while signed out keeps the review and asks for the demo session only at confirm", async () => {
  await reset();
  const { context, page } = await open();
  await understand(page);
  await page.getByRole("button", { name: "Continue to confirm" }).click();
  await page.getByRole("heading", { name: "Demo access" }).waitFor();
  assert.ok(
    await page.getByText("Here's what PayFlow understood").isVisible(),
    "review stays on screen",
  );
  await page.getByLabel("Access code").fill(code);
  await page.getByRole("button", { name: "Open demo" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Confirm this Authority" })
    .waitFor();
  assert.equal((await counts()).mandates, 0);
  await page.getByRole("button", { name: "Confirm Authority" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Authority created" })
    .waitFor();
  assert.equal((await counts()).mandates, 1);
  await context.close();
});

test("editing the request invalidates the review; nothing stale can be confirmed", async () => {
  await reset();
  const { context, page } = await open();
  await signIn(page);
  await understand(page);
  await page.getByRole("button", { name: "Edit request" }).click();
  await page
    .getByRole("heading", { level: 1, name: "What may your Agent do?" })
    .waitFor();
  await page.locator("#request").fill("Buy me something nice");
  await page.getByRole("button", { name: "Review my request" }).click();
  await page
    .getByText(/Update your request above|couldn.t read|can.t turn that/i)
    .first()
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Continue to confirm" }).count(),
    0,
  );
  assert.equal((await counts()).mandates, 0);
  await context.close();
});

test("stale tab showing Active is corrected by the system after revocation elsewhere", async () => {
  await reset();
  const { context, page, problems } = await open();
  await signIn(page);
  await createAuthority(page);
  const id = await authorityId(page);
  await nav(page, "Authorities");
  await page.locator(".frame").first().waitFor();
  assert.match(await page.locator(".frame").first().innerText(), /Active/i);
  await ctl("/revoke?mandateId=" + encodeURIComponent(id)); // another device
  // No refresh control exists; the app re-reads on focus.
  assert.equal(await page.getByRole("button", { name: /refresh/i }).count(), 0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .locator(".state-tag", { hasText: /Revoked/i })
    .first()
    .waitFor();
  await zeroPayments();
  assert.deepEqual(problems, []);
  await context.close();
});

test("CSRF failure on confirmation creates nothing and is presented safely", async () => {
  await reset();
  const { context, page } = await open();
  await signIn(page);
  await understand(page);
  await toConfirm(page);
  await page.route("**/api/activation/confirm", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-payflow-csrf": "forged" },
    }),
  );
  await page.getByRole("button", { name: "Confirm Authority" }).click();
  await page
    .getByText(/That didn.t go through\. Nothing was authorized/)
    .first()
    .waitFor();
  assert.equal((await counts()).mandates, 0);
  assert.equal(
    await page.getByRole("heading", { name: "Authority created" }).count(),
    0,
  );
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /Error:|at .*\.(ts|js)|CSRF_REJECTED/,
  );
  await zeroPayments();
  await context.close();
});

test("session expiry on the server blocks confirmation with a human message and no Mandate", async () => {
  await reset();
  const { context, page } = await open();
  await signIn(page);
  await understand(page);
  await toConfirm(page);
  await ctl("/advance?seconds=960"); // beyond the 15-minute session lifetime
  await page.getByRole("button", { name: "Confirm Authority" }).click();
  await page
    .getByText(/That didn.t go through\. Nothing was authorized/)
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

test("tampered session cookie cannot read or revoke saved Authority", async () => {
  await reset();
  const { context, page } = await open();
  await signIn(page);
  await createAuthority(page);
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
  await page.goto(origin + "/authorities/");
  await page.getByRole("heading", { name: "Demo access" }).waitFor();
  assert.equal(await page.locator(".frame").count(), 0);
  assert.equal((await counts()).MANDATE_REVOKED, 0);
  await context.close();
});

test("double-click on Confirm and Revoke produces one Mandate and one revocation event", async () => {
  await reset();
  const { context, page } = await open();
  await signIn(page);
  await understand(page);
  await toConfirm(page);
  await page
    .getByRole("button", { name: "Confirm Authority" })
    .dblclick()
    .catch(() => undefined);
  await page
    .getByRole("heading", { level: 1, name: "Authority created" })
    .waitFor();
  assert.equal((await counts()).mandates, 1);
  await page.getByRole("link", { name: "View Authority" }).click();
  await page.getByRole("button", { name: "Revoke Authority" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke Authority" })
    .dblclick()
    .catch(() => undefined);
  await page
    .locator(".state-tag", { hasText: /Revoked/i })
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
  await signIn(page);
  await createAuthority(page);
  for (const n of ["Authorities", "Activity", "Home"]) await nav(page, n);
  await page.goto(origin + "/about/");
  await page.waitForTimeout(300);
  const all = bodies.join("\n") + (await page.content());
  assert.ok(!all.includes(code), "bootstrap code");
  assert.ok(!all.includes(databaseUrl), "database url");
  assert.doesNotMatch(
    all,
    /postgres:\/\/|DATABASE_URL|GROQ|PAYPAL_|client_secret|privateKey|"challenge"|reviewedHash|resumeSecret|executionGrant/i,
  );
  await context.close();
});

for (const [label, viewport, opts] of [
  [
    "mobile 375px",
    { width: 375, height: 812 },
    { hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  ],
  ["tablet 768px", { width: 768, height: 1024 }, { hasTouch: true }],
])
  test(`${label}: no horizontal overflow, adequate touch targets, bottom navigation, usable sheets`, async () => {
    await reset();
    const { context, page, problems } = await open(viewport, opts);
    const tag = label.startsWith("mobile") ? "m" : "t";
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
    const targets = () =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll(
            "button, a[href], summary, input, textarea",
          ),
        ]
          .filter((e) => e.getClientRects().length)
          .map((e) => ({
            t: (e.textContent || e.id || e.tagName).trim().slice(0, 40),
            r: e.getBoundingClientRect(),
          }))
          .filter((x) => x.r.height < 44 || x.r.width < 44)
          .map(
            (x) => `${x.t} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`,
          ),
      );
    assert.ok((await overflow()) <= 0, "home overflow");
    assert.deepEqual(await targets(), [], "signed-out touch targets");
    await shot(page, `${tag}01-home-signed-out`);
    await signIn(page);
    await nav(page, /New/);
    await page.getByRole("button", { name: "Use the example" }).click();
    await page.waitForFunction(
      () => document.getElementById("request")?.value.length > 0,
    );
    assert.ok((await overflow()) <= 0, "describe overflow");
    await page.getByRole("button", { name: "Review my request" }).click();
    await page
      .getByRole("heading", { level: 1, name: /what PayFlow understood/ })
      .waitFor();
    assert.ok((await overflow()) <= 0, "understand overflow");
    await shot(page, `${tag}02-understand`);
    await toConfirm(page);
    assert.ok((await overflow()) <= 0, "confirm overflow");
    await shot(page, `${tag}03-confirm`);
    await page.getByRole("button", { name: "Confirm Authority" }).click();
    await page
      .getByRole("heading", { level: 1, name: "Authority created" })
      .waitFor();
    await page.locator(".frame").first().waitFor();
    assert.ok((await overflow()) <= 0, "created overflow");
    await shot(page, `${tag}04-created`);
    await page.getByRole("link", { name: "View Authority" }).click();
    await page.getByRole("button", { name: "Revoke Authority" }).waitFor();
    assert.ok((await overflow()) <= 0, "authority overflow");
    assert.deepEqual(await targets(), [], "authority touch targets");
    await page.getByRole("button", { name: "Revoke Authority" }).click();
    await page
      .getByRole("dialog")
      .getByRole("heading", { name: "Revoke this Authority?" })
      .waitFor();
    assert.ok((await overflow()) <= 0, "revoke sheet overflow");
    await shot(page, `${tag}05-revoke`);
    assert.deepEqual(await targets(), [], "sheet touch targets");
    await page.getByRole("button", { name: "Keep Authority" }).click();
    for (const n of ["Activity", "Home"]) {
      await nav(page, n);
      assert.ok((await overflow()) <= 0, n + " overflow");
    }
    // Primary destinations are reachable from the bottom bar on small screens.
    if (tag === "m")
      assert.equal(await page.locator(".tabbar").isVisible(), true);
    assert.deepEqual(problems, []);
    await context.close();
  });

test("accessibility: keyboard-only flow, visible focus, labels, live regions, reduced motion, contrast", async () => {
  await reset();
  const { context, page } = await open(
    { width: 1280, height: 900 },
    { reducedMotion: "reduce" },
  );
  const unnamed = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("input, textarea, select")]
        .filter(
          (e) =>
            !(e.labels && e.labels.length) && !e.getAttribute("aria-label"),
        )
        .map((e) => e.outerHTML.slice(0, 80)),
    );
  assert.deepEqual(await unnamed(), []);
  // One h1 per page and landmarks.
  assert.equal(await page.locator("h1").count(), 1);
  for (const sel of ["main", "nav[aria-label='Primary']"])
    assert.ok(await page.locator(sel).count());
  // Keyboard-only: skip link first.
  await page.keyboard.press("Tab");
  assert.match(
    (await page.evaluate(() => document.activeElement?.textContent)) ?? "",
    /Skip to content/,
  );
  // Sign in by keyboard.
  await page.getByLabel("Access code").focus();
  await page.keyboard.type(code);
  await page.keyboard.press("Enter");
  await page
    .getByRole("heading", { level: 1, name: /No active Authorities yet/ })
    .waitFor();
  await nav(page, /New/);
  await page.getByRole("button", { name: "Use the example" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.getElementById("request")?.value.length > 0,
  );
  await page.getByRole("button", { name: "Review my request" }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("heading", { level: 1, name: /what PayFlow understood/ })
    .waitFor();
  assert.equal(await page.locator("h1").count(), 1);
  await page.getByRole("button", { name: "Continue to confirm" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Confirm Authority" }).waitFor();
  await page.getByRole("button", { name: "Confirm Authority" }).focus();
  const focus = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return {
      outline: s.outlineStyle,
      width: parseFloat(s.outlineWidth),
      shadow: s.boxShadow,
    };
  });
  assert.ok(
    (focus.outline !== "none" && focus.width >= 3) || focus.shadow !== "none",
    "focus indicator visible",
  );
  await page.keyboard.press("Enter");
  await page
    .getByRole("heading", { level: 1, name: "Authority created" })
    .waitFor();
  await page.getByRole("link", { name: "View Authority" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Revoke Authority" }).focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("heading", { name: "Revoke this Authority?" }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.closest("dialog") !== null,
    ),
    true,
    "focus moves into the sheet",
  );
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "hidden" });
  assert.equal(
    (await counts()).MANDATE_REVOKED,
    0,
    "Escape cancels without revoking",
  );
  await page.getByRole("button", { name: "Revoke Authority" }).focus();
  await page.keyboard.press("Enter");
  await dlg.getByRole("button", { name: "Revoke Authority" }).focus();
  await page.keyboard.press("Enter");
  await page
    .locator(".state-tag", { hasText: /Revoked/i })
    .first()
    .waitFor();
  assert.equal((await counts()).MANDATE_REVOKED, 1);
  assert.match(
    await page.locator(".state-tag").first().innerText(),
    /[A-Za-z]{4,}/,
    "state in words",
  );
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
  // Contrast: WCAG AA for every visible text node on the pages a customer uses.
  for (const path of ["/", "/new/", "/authorities/", "/activity/", "/about/"]) {
    await page.goto(origin + path);
    await page.waitForTimeout(300);
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
          ![...e.childNodes].some(
            (n) => n.nodeType === 3 && n.textContent.trim(),
          )
        )
          continue;
        if (!e.getClientRects().length) continue;
        const s = getComputedStyle(e);
        const [a, b] = [lum(parse(s.color)), lum(bgOf(e))];
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
    assert.deepEqual(failing, [], "contrast below WCAG AA on " + path);
  }
  await context.close();
});

test("server unavailable: a failing read shows a calm state, never a stack trace or success, and recovers", async () => {
  await reset();
  const { context, page } = await open();
  await signIn(page);
  await createAuthority(page);
  await nav(page, "Authorities");
  await page.locator(".frame").first().waitFor();
  await page.route("**/api/activation/authorities", (r) => r.abort());
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("heading", { name: /can.t reach your saved state/ })
    .waitFor();
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /Error:|at .*\.(ts|js)|ECONN|fetch failed/,
  );
  assert.equal(
    await page.locator(".frame").count(),
    0,
    "nothing is shown rather than guessing",
  );
  await page.unroute("**/api/activation/authorities");
  await page.getByRole("button", { name: "Try again" }).click();
  await page.locator(".frame").first().waitFor();
  await zeroPayments();
  await context.close();
});
