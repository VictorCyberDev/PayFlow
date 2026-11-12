import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
test("browser graph contains no execution, persistence, credentials or unrestricted dispatch", () => {
  for (const f of [
    ...files(fileURLToPath(new URL("app/", root))),
    fileURLToPath(new URL("qa/fixtures.ts", root)),
    ...files(fileURLToPath(new URL("lib/", root))),
  ]) {
    const source = readFileSync(f, "utf8");
    assert.doesNotMatch(
      source,
      /DATABASE_URL|PAYFLOW_STATUS_DATABASE_URL|PaymentResumeService|PayPalExecutionRail|process\.env|server action|use server|from ["'][^"']*\/src\//,
    );
  }
});
const read = (p) => readFileSync(new URL(p, root), "utf8");
const allApp = () =>
  files(fileURLToPath(new URL("app/", root)))
    .filter((f) => /\.(tsx|ts)$/.test(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

test("every customer destination is a real route, not an anchor on one page", () => {
  for (const route of [
    "page.tsx",
    "new/page.tsx",
    "authorities/page.tsx",
    "activity/page.tsx",
    "about/page.tsx",
  ])
    assert.ok(read("app/" + route).length > 0, route);
  const shell = read("app/ui/shell.tsx");
  for (const href of ['"/"', '"/new/"', '"/authorities/"', '"/activity/"'])
    assert.ok(shell.includes(href), href);
  assert.doesNotMatch(
    allApp(),
    /href="#(home|ask|authority|activity|agents|managed-authorities)"/,
  );
  assert.match(shell, /Skip to content/);
  assert.match(read("next.config.ts"), /trailingSlash: true/);
});

test("customer-facing views carry no maintenance controls", () => {
  assert.doesNotMatch(
    allApp(),
    /Refresh saved state|Refresh authority|Re-read|Retry provider/,
  );
});

test("browser transport is limited to the accepted review, activation, partner and explore endpoints", () => {
  const client = read("lib/review-client.mjs");
  assert.match(client, /fetch\("\/api\/intent-review"/);
  assert.match(allApp(), /fetch\("\/api\/intent-review\/sample"/);
  // The V4 consumer partner is the one addition. Every fetch in the browser graph must be one of the accepted paths:
  // a new endpoint has to be listed here before it can ship.
  const accepted = [
    "/api/intent-review",
    "/api/intent-review/sample",
    "/api/activation/authority",
    "/api/partner",
    "/api/explore",
    "/api/account",
  ];
  for (const [, path] of (allApp() + client).matchAll(
    /fetch\(\s*[`"']([^`"'$)]*)/g,
  ))
    assert.ok(
      accepted.some((a) => path.startsWith(a)),
      `unaccepted browser transport: ${path}`,
    );
  assert.doesNotMatch(
    allApp() + client,
    /localStorage|sessionStorage|document\.cookie|confirmReviewedIntent|activateReviewedIntent|paypal\.com|api\.groq/,
  );
});

test("client never contains a host assertion, bootstrap key or payment route", () => {
  const client = read("lib/activation-client.mjs");
  assert.doesNotMatch(
    client + allApp(),
    /PAYFLOW_M5C_BOOTSTRAP_KEY|DATABASE_URL|localStorage|sessionStorage|document\.cookie|confirmReviewedIntent|activateReviewedIntent|api\.groq|paypal\.com|PaymentResumeService/,
  );
  assert.match(client, /\/api\/activation\/authority\?mandateId=/);
});

test("the old generic design is gone: one stylesheet, one token set, no rounded-card or gradient identity", () => {
  const css = read("app/globals.css");
  assert.match(css, /--ink:\s*#111418/i);
  assert.match(css, /--signal:\s*#e8aa00/i);
  assert.doesNotMatch(
    css,
    /backdrop-filter|(?<!repeating-)linear-gradient|radial-gradient|#18382f|#2d7a5d/i,
  );
  assert.doesNotMatch(css, /border-radius:\s*(?!0|50%)\d/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("the V4 consumer identity is its own token set, and it degrades without motion", () => {
  // BRAND-001's ink-and-paper system is deliberately superseded for the consumer surfaces (mandate section 5.1). The
  // legacy assertions above still guard globals.css, which the console and marketing surfaces still use.
  const css = read("app/flow.css");
  for (const token of [
    "--blue: #2457ff",
    "--coral: #ff7049",
    "--alert: #c43c17",
    "--lime: #d5f779",
    "--ivory: #faf8f2",
    "--ink: #111a32",
  ])
    assert.ok(css.toLowerCase().includes(token), token);
  // Nothing may be fetched from off-origin, so the CSP stays 'self'.
  assert.doesNotMatch(css, /https?:\/\/|fonts\.googleapis|@import/);
  // Every one of the eleven Flow states must be expressible, and motion must be removable.
  for (const state of [
    "ready",
    "listening",
    "planning",
    "searching",
    "comparing",
    "negotiating",
    "deciding",
    "executing",
    "confirmed",
    "paused",
    "unverified",
  ])
    assert.ok(css.includes(`data-state="${state}"`), state);
  assert.match(css, /prefers-reduced-motion: reduce/);
  // The state that carries a warning must never be drawn in the ordinary accent colour, and must use the text-safe
  // red rather than plain coral, which is 2.58:1 on ivory and fails WCAG 1.4.11 for a meaningful graphic.
  assert.match(
    css,
    /data-state="deciding"\] \.flow-object__line \{\s*stroke: var\(--alert\)/,
  );
});

test("fonts are self-hosted so the CSP stays 'self'", () => {
  const css = read("app/globals.css");
  assert.doesNotMatch(css, /https?:\/\/|fonts\.googleapis/);
  for (const f of ["bricolage-grotesque", "instrument-sans", "ibm-plex-mono"])
    assert.ok(
      readdirSync(fileURLToPath(new URL("app/fonts/", root))).some((n) =>
        n.startsWith(f),
      ),
      f,
    );
});
