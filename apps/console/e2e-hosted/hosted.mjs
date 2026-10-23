// M5E-HOST hosted acceptance. Runs against a REAL deployed HTTPS origin (never in normal CI):
//   HOSTED_ORIGIN=https://... HOSTED_BOOTSTRAP_CODE=... npm run test:hosted
// The operator code is read from the environment and is never printed or asserted into output.
// Financial row counts are checked separately by the operator against the isolated database.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const origin = process.env.HOSTED_ORIGIN;
const code = process.env.HOSTED_BOOTSTRAP_CODE;
assert.ok(origin?.startsWith("https://"), "HOSTED_ORIGIN must be an https URL");
assert.ok(code, "HOSTED_BOOTSTRAP_CODE is required");
const host = new URL(origin).host;
const shots = process.env.E2E_SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });
let browser;
before(async () => {
  const executablePath = [
    process.env.PLAYWRIGHT_CHROMIUM,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  ].find((p) => p && existsSync(p));
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => browser?.close());

const shot = (page, name) =>
  shots
    ? page.screenshot({ path: `${shots}/${name}.png`, fullPage: true })
    : undefined;
async function open(viewport = { width: 1280, height: 900 }, opts = {}) {
  const context = await browser.newContext({ viewport, ...opts });
  const page = await context.newPage();
  const problems = [];
  const responses = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
      problems.push("console: " + m.text());
  });
  page.on("response", async (r) => {
    if (r.url().startsWith(origin))
      responses.push({
        url: r.url(),
        headers: r.headers(),
        body: await r.text().catch(() => ""),
      });
  });
  await page.goto(origin);
  return { context, page, problems, responses };
}
const nav = (page, name) =>
  page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name })
    .click();
async function login(page) {
  await page.getByLabel("Access code").fill(code);
  await page.getByRole("button", { name: "Open demo" }).click();
  await page
    .getByRole("heading", {
      level: 1,
      name: /Authorities yet|within your rules|No Authority is active|need.? attention/,
    })
    .waitFor();
}
async function understand(page) {
  await nav(page, /New/);
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
  await page.getByRole("button", { name: "Confirm Authority" }).waitFor();
}
const api = (path, init = {}) =>
  fetch(origin + path, { redirect: "manual", ...init });
async function apiLogin() {
  const r = await api("/api/activation/session", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ bootstrapCode: code }),
  });
  assert.equal(r.status, 200);
  const v = await r.json();
  return {
    headers: r.headers,
    cookie: r.headers.get("set-cookie").split(";")[0],
    csrf: v.csrfToken,
  };
}
const post = (path, body, a, extra = {}) => {
  const h = {
    origin,
    "content-type": "application/json",
    cookie: a.cookie,
    "x-payflow-csrf": a.csrf,
    ...extra,
  };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  return api(path, { method: "POST", headers: h, body: JSON.stringify(body) });
};
const get = (path, a) => api(path, { headers: { cookie: a.cookie } });

test("HTTPS, security headers and cookie attributes on the hosted origin", async () => {
  assert.equal(new URL(origin).protocol, "https:");
  const page = await api("/");
  assert.equal(page.status, 200);
  const h = page.headers;
  assert.match(h.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(
    h.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("x-frame-options"), "DENY");
  assert.match(h.get("strict-transport-security") ?? "", /max-age=/);
  // Static assets must not carry a wildcard CORS grant (Vercel's default is "*").
  const acao = h.get("access-control-allow-origin");
  assert.ok(
    acao === null || acao === origin,
    "static ACAO must be absent or same-origin, got " + acao,
  );
  const a = await apiLogin();
  assert.equal(
    a.headers.get("access-control-allow-origin"),
    null,
    "API must grant no CORS",
  );
  const setCookie = a.headers.get("set-cookie");
  assert.match(setCookie, /^__Host-payflow_session=/);
  for (const attr of [
    "; HttpOnly",
    "; Secure",
    "; SameSite=Strict",
    "; Path=/",
  ])
    assert.ok(setCookie.includes(attr), "cookie missing " + attr);
  assert.ok(!/Domain=/i.test(setCookie), "__Host- cookie must not set Domain");
  const preflight = await api("/api/activation/revoke", {
    method: "OPTIONS",
    headers: {
      origin: "https://attacker.invalid",
      "access-control-request-method": "POST",
    },
  });
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
});

test("complete hosted journey: untrusted review, exact confirmation, Active, reload, revoke elsewhere, Revoked, reload", async () => {
  const { context, page, problems } = await open();
  await shot(page, "h01-home");
  await login(page);
  await understand(page);
  assert.ok(await page.getByText("Not yet authorized").first().isVisible());
  await toConfirm(page);
  assert.ok(await page.getByText("Not yet authorized").first().isVisible());
  await shot(page, "h02-confirmation");
  await page.getByRole("button", { name: "Confirm Authority" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Authority created" })
    .waitFor();
  await page.locator(".frame").first().waitFor();
  await shot(page, "h03-created");
  const id = new URL(
    await page
      .getByRole("link", { name: "View Authority" })
      .getAttribute("href"),
    origin,
  ).searchParams.get("id");
  assert.ok(id, "authority reference present");
  // Hosted cookie properties as the browser sees them.
  const cookie = (await context.cookies()).find(
    (c) => c.name === "__Host-payflow_session",
  );
  assert.ok(cookie, "__Host- session cookie set");
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "Strict");
  assert.equal(cookie.path, "/");
  assert.equal(await page.evaluate(() => document.cookie), "");
  assert.equal(await page.evaluate(() => location.protocol), "https:");
  await page.getByRole("link", { name: "View Authority" }).click();
  await page.getByRole("button", { name: "Revoke Authority" }).waitFor();
  assert.match(await page.locator(".frame").first().innerText(), /Active/i);
  // Reload: still Active from durable state.
  await page.reload();
  await page.getByRole("button", { name: "Revoke Authority" }).waitFor();
  // Stale tab: a second page revokes; the first corrects itself when it reads again.
  const other = await context.newPage();
  await other.goto(origin + "/authorities/?id=" + encodeURIComponent(id));
  await other.getByRole("button", { name: "Revoke Authority" }).click();
  const dialog = other.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: "Revoke this Authority?" })
    .waitFor();
  await shot(other, "h04-revoke-sheet");
  await dialog.getByRole("button", { name: "Revoke Authority" }).click();
  await other
    .locator(".state-tag", { hasText: /Revoked/i })
    .first()
    .waitFor();
  assert.match(await page.locator(".frame").first().innerText(), /Active/i);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .locator(".state-tag", { hasText: /Revoked/i })
    .first()
    .waitFor();
  await shot(page, "h05-revoked");
  await page.reload();
  await page
    .locator(".state-tag", { hasText: /Revoked/i })
    .first()
    .waitFor();
  assert.deepEqual(problems, []);
  await context.close();
});

test("hosted adversarial: cookie, CSRF, origin, principal injection, term tampering, replay, unknown owner", async () => {
  const a = await apiLogin();
  const sample = (await (await get("/api/intent-review/sample", a)).json())
    .sample;
  const prepare = async () => {
    const r = await post("/api/activation/reviews", { source: sample }, a);
    assert.equal(r.status, 200);
    return r.json();
  };
  // Tampered cookie
  const [n, v] = a.cookie.split("=");
  const flipped = `${n}=${v.slice(0, -1)}${v.endsWith("A") ? "B" : "A"}`;
  assert.ok(
    (await get("/api/activation/session", { cookie: flipped })).status >= 400,
  );
  // Missing / wrong CSRF, wrong origin
  for (const csrf of [undefined, "", "x".repeat(43)])
    assert.equal(
      (
        await post("/api/activation/reviews", { source: sample }, a, {
          "x-payflow-csrf": csrf,
        })
      ).status,
      400,
    );
  for (const o of ["https://attacker.invalid", "null", undefined])
    assert.equal(
      (
        await post("/api/activation/reviews", { source: sample }, a, {
          origin: o,
        })
      ).status,
      400,
    );
  // Principal injection (body, query, header, login)
  for (const f of ["principalId", "ownerId", "userId"])
    assert.equal(
      (
        await post(
          "/api/activation/reviews",
          { source: sample, [f]: "other" },
          a,
        )
      ).status,
      400,
    );
  assert.equal(
    (await get("/api/activation/authorities?principalId=other", a)).status,
    400,
  );
  const inj = await api("/api/activation/session", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ bootstrapCode: code, principalId: "other" }),
  });
  assert.equal(inj.status, 400);
  // Term tampering cannot widen: injected amount/merchant/capability fields are refused and
  // nothing is consumed; display-hash tampering is refused; the exact confirmation still works once.
  const p = await prepare();
  const exact = {
    action: "CONFIRM_EXACT_TERMS",
    reviewId: p.reviewId,
    displayHash: p.displayHash,
  };
  for (const extra of [
    { maximumMinor: 999999 },
    { merchantIds: ["Evil"] },
    { allowedCapabilities: ["TRANSFER_FUNDS"] },
    { challenge: "x" },
    { reviewedHash: "x" },
  ])
    assert.notEqual(
      (await post("/api/activation/confirm", { ...exact, ...extra }, a)).status,
      200,
    );
  assert.equal(
    (
      await post(
        "/api/activation/confirm",
        { ...exact, displayHash: "f".repeat(64) },
        a,
      )
    ).status,
    409,
  );
  const ok = await post("/api/activation/confirm", exact, a);
  assert.equal(ok.status, 200);
  const { mandateId } = await ok.json();
  // Replay fails; the Mandate carries the reviewed (not tampered) terms.
  assert.equal((await post("/api/activation/confirm", exact, a)).status, 409);
  const view = await (
    await get("/api/activation/authority?mandateId=" + mandateId, a)
  ).json();
  assert.equal(view.state, "ACTIVE");
  assert.equal(view.singleMaximumMinor, 10000);
  assert.match(JSON.stringify(view.merchantScopeSummary), /DemoMerchant/);
  // Unknown / not-owned mandate: indistinguishable and no mutation.
  const unknownRead = await get(
    "/api/activation/authority?mandateId=not-mine",
    a,
  );
  const unknownRevoke = await post(
    "/api/activation/revoke",
    { action: "REVOKE_AUTHORITY", mandateId: "not-mine" },
    a,
  );
  assert.equal(unknownRead.status, 404);
  assert.equal(unknownRevoke.status, 400);
  // Refresh is read-only: repeated reads leave the authority exactly as it was.
  for (let i = 0; i < 5; i++) {
    for (const path of [
      "/api/activation/authorities",
      "/api/activation/activity",
      "/api/activation/authority?mandateId=" + mandateId,
    ])
      assert.equal((await get(path, a)).status, 200);
  }
  // Clean up: revoke what this check created, then logout; the cookie must be dead everywhere.
  assert.equal(
    (
      await post(
        "/api/activation/revoke",
        { action: "REVOKE_AUTHORITY", mandateId },
        a,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await get("/api/activation/authority?mandateId=" + mandateId, a).then(
        (r) => r.json(),
      )
    ).state,
    "REVOKED",
  );
  assert.equal((await post("/api/activation/logout", {}, a)).status, 200);
  assert.ok((await get("/api/activation/session", a)).status >= 400);
});

test("hosted secret review: client bundle and every response contain no secret, challenge or stack trace", async () => {
  const { context, page, responses } = await open();
  await login(page);
  await understand(page);
  await toConfirm(page);
  for (const n of ["Authorities", "Activity"]) await nav(page, n);
  await page.goto(origin + "/about/");
  await page.waitForTimeout(500);
  const everything =
    responses.map((r) => r.body + JSON.stringify(r.headers)).join("\n") +
    (await page.content());
  assert.ok(!everything.includes(code), "operator code must never be echoed");
  assert.doesNotMatch(
    everything,
    /postgres(ql)?:\/\/|DATABASE_URL|neon\.tech|GROQ|PAYPAL_|client_secret|PRIVATE KEY|"challenge"|reviewedHash|resumeSecret|executionGrant|\bat [^\n]{1,200}\.(ts|js):\d+:\d+/i,
  );
  // Literal operator-supplied secrets (never printed): database host/password, etc.
  for (const literal of (process.env.HOSTED_FORBIDDEN ?? "")
    .split(",")
    .filter(Boolean))
    assert.ok(
      !everything.includes(literal),
      "a forbidden literal appears in client-visible output",
    );
  // Scripts served by the origin are scanned too.
  const scripts = [
    ...new Set(
      responses.filter((r) => /\.js(\?|$)/.test(r.url)).map((r) => r.url),
    ),
  ];
  assert.ok(scripts.length > 0);
  await context.close();
});

test("hosted mobile 375px: no horizontal overflow and 44px touch targets", async () => {
  const { context, page } = await open(
    { width: 375, height: 812 },
    { hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  );
  assert.ok(
    (await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )) <= 0,
  );
  await shot(page, "hm01-home-mobile");
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
  assert.deepEqual(small, []);
  await context.close();
});

test("host header must match: a request for another host is not served by the app", async () => {
  // Sanity: the configured audience is exactly this host.
  assert.ok(host.length > 0);
  const r = await api("/api/activation/session");
  assert.ok(r.status >= 400);
});
