// M17 result-card acceptance. Renders the REAL widget HTML (src/protocols/chatgpt-app.ts) in Chromium and feeds it
// tool outputs the way a host does. Checks wording for each outcome (UNKNOWN is never shown as $0), that tool output
// cannot inject markup, no horizontal overflow from 320px up, and axe (WCAG A/AA) in light and dark.
//   node --import tsx scripts/chatgpt-widget-check.mjs
import { chromium } from "../apps/console/node_modules/playwright-core/index.mjs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DECISION_WIDGET_HTML } from "../src/protocols/chatgpt-app.ts";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(
  require.resolve("../apps/console/node_modules/axe-core/axe.min.js"),
  "utf8",
);
const cases = [
  {
    name: "paid once",
    out: { decision: "ALLOW", status: "COMPLETED", effectCount: 1 },
    badge: "Paid once",
    moved: "Exactly once",
  },
  {
    name: "denied",
    out: {
      decision: "DENY",
      status: "DENIED",
      effectCount: 0,
      humanSummary: "Over the limit. $0 moved.",
      reason: "SINGLE_TRANSACTION_LIMIT_EXCEEDED",
    },
    badge: "Not allowed",
    moved: "$0",
  },
  {
    name: "unknown",
    out: {
      decision: "ALLOW",
      status: "UNRESOLVED",
      effectCount: null,
      doNotRetry: true,
    },
    badge: "Outcome UNKNOWN",
    moved: "UNKNOWN",
  },
  {
    name: "needs approval",
    out: { decision: "ESCALATE", status: "NEEDS_APPROVAL", effectCount: 0 },
    badge: "Needs approval",
  },
  {
    name: "proof valid",
    out: {
      valid: true,
      reason: "PROOF_VALID",
      outcome: "SUCCEEDED",
      effectCount: 1,
    },
    badge: "Proof valid",
  },
  {
    name: "proof invalid",
    out: { valid: false, reason: "SIGNATURE_INVALID" },
    badge: "Proof not valid",
  },
];
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {}),
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 320, height: 640 },
    });
    const page = await context.newPage();
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const c of cases) {
        await page.setContent(DECISION_WIDGET_HTML);
        await page.evaluate(
          (o) =>
            window.postMessage(
              {
                jsonrpc: "2.0",
                method: "ui/notifications/tool-result",
                params: { structuredContent: o },
              },
              "*",
            ),
          c.out,
        );
        await page
          .waitForFunction(
            (b) => document.getElementById("badge").textContent === b,
            c.badge,
            { timeout: 3000 },
          )
          .catch(() =>
            failures.push(
              `${scheme}/${width}/${c.name}: badge not "${c.badge}"`,
            ),
          );
        if (c.moved) {
          const text = await page.locator("#facts").innerText();
          check(
            text.includes(c.moved),
            `${scheme}/${width}/${c.name}: money-moved row missing "${c.moved}"`,
          );
        }
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        check(!overflow, `${scheme}/${width}/${c.name}: horizontal overflow`);
      }
    }
    // Hostile output must render as text, never as markup.
    await page.setContent(DECISION_WIDGET_HTML);
    await page.evaluate(() =>
      window.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            structuredContent: {
              decision: "DENY",
              status: "DENIED",
              humanSummary:
                "<img src=x onerror=window.__pwned=1><script>window.__pwned=1</script>",
              reason: "<b>x</b>",
            },
          },
        },
        "*",
      ),
    );
    await page.waitForFunction(
      () => document.getElementById("badge").textContent === "Not allowed",
    );
    check(
      await page.evaluate(
        () =>
          !window.__pwned &&
          document.querySelectorAll("main img, main b, main script").length ===
            0,
      ),
      `${scheme}: tool output injected markup`,
    );
    // Host that provides the result through window.openai.
    await page.setContent(
      DECISION_WIDGET_HTML.replace(
        "<script>",
        "<script>window.openai={toolOutput:{structuredContent:{effectCount:null}}};",
      ),
    );
    check(
      (await page.locator("#badge").innerText()) === "Outcome UNKNOWN",
      `${scheme}: window.openai.toolOutput not rendered`,
    );
    // axe on a populated card.
    await page.setContent(DECISION_WIDGET_HTML);
    await page.evaluate(() =>
      window.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            structuredContent: {
              decision: "DENY",
              status: "DENIED",
              effectCount: 0,
              humanSummary: "Over the limit. $0 moved.",
              reason: "X",
              nextAction: "STOP",
            },
          },
        },
        "*",
      ),
    );
    await page.waitForFunction(
      () => document.getElementById("badge").textContent === "Not allowed",
    );
    await page.addScriptTag({ content: axeSource });
    const axe = await page.evaluate(() =>
      axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      }),
    );
    for (const v of axe.violations)
      failures.push(`${scheme}: axe ${v.id} (${v.nodes.length})`);
    await context.close();
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`WIDGET CHECK FAILED (${failures.length})`);
  process.exit(1);
}
console.log(
  `WIDGET CHECK PASSED: ${cases.length} outcomes x 4 widths x 2 schemes, injection-safe, axe clean`,
);
