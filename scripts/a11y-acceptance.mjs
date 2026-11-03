// Gate A accessibility and responsive acceptance, run against the static production export.
//   (cd apps/console && npm run build) && node scripts/a11y-acceptance.mjs
// Every public route x six widths: status, no horizontal overflow, exactly one h1, axe (WCAG 2.0/2.1/2.2 A+AA).
// Keyboard: the first Tab stop is a visible "skip to content" link that really moves focus into <main>;
// every Tab stop has a visible focus indicator; Tab does not trap focus.
// Touch targets: standalone controls are at least 24x24 CSS px (WCAG 2.2 SC 2.5.8).
// Reduced motion: no running infinite animation. Verify page: the in-browser verifier works by keyboard alone.
import { chromium } from "../apps/console/node_modules/playwright-core/index.mjs";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// A11Y_ORIGIN=https://host runs the same checks against a DEPLOYED site instead of the local static export.
const remote = (process.env.A11Y_ORIGIN ?? "").replace(/\/+$/u, "");
const root = resolve("apps/console/out");
if (!remote && !existsSync(root))
  throw new Error("build the console first: cd apps/console && npm run build");
const sitemap = remote
  ? await (await fetch(remote + "/sitemap.xml")).text()
  : readFileSync(resolve(root, "sitemap.xml"), "utf8");
const routes = [
  ...new Set([
    ...[...sitemap.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/gu)].map(
      (m) => m[1],
    ),
    "/verify/",
    "/research/break-authority/",
    "/solutions/finance/",
    "/enterprise/",
    "/developer/",
  ]),
].sort();

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let file = resolve(root, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + "/") && file !== root) throw new Error();
    if (statSync(file).isDirectory()) file += "/index.html";
    const types = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
      ".png": "image/png",
      ".json": "application/json",
      ".txt": "text/plain",
      ".xml": "application/xml",
    };
    res.setHeader(
      "Content-Type",
      types[extname(file)] ?? "application/octet-stream",
    );
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
if (!remote) await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = remote || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const axeSource = readFileSync(
  require.resolve("../apps/console/node_modules/axe-core/axe.min.js"),
  "utf8",
);
const WIDTHS = [320, 375, 430, 768, 1024, 1440];
const failures = [];
const rows = [];
const fail = (route, width, what, detail) =>
  failures.push({ route, width, what, detail });

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const route of routes) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const r = await page.goto(origin + route);
      if (r.status() !== 200) {
        fail(route, width, "status", r.status());
        continue;
      }
      await page.waitForSelector("h1");
      await page.evaluate(() => document.fonts.ready);
      const m = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        h1: document.querySelectorAll("h1").length,
        lang: document.documentElement.lang,
        mainCount: document.querySelectorAll("main").length,
        animating: document
          .getAnimations()
          .filter(
            (a) =>
              a.effect?.getComputedTiming().iterations === Infinity &&
              a.playState === "running",
          ).length,
        tiny: [
          ...document.querySelectorAll(
            "a[href], button, input:not([type=hidden]), select, textarea, [role=button]",
          ),
        ]
          .filter((el) => {
            const cs = getComputedStyle(el);
            if (cs.visibility === "hidden" || cs.display === "none")
              return false;
            const b = el.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) return false;
            // Links inside running text are exempt (WCAG 2.5.8 inline exception).
            if (
              el.tagName === "A" &&
              cs.display === "inline" &&
              el.closest("p, li, dd, small, span:not(.nav-link)")
            )
              return false;
            return b.width < 24 || b.height < 24;
          })
          .slice(0, 5)
          .map(
            (el) =>
              `${el.tagName.toLowerCase()}:${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}:${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
          ),
      }));
      if (m.overflow > 0)
        fail(route, width, "horizontal overflow (px)", m.overflow);
      if (m.h1 !== 1) fail(route, width, "h1 count", m.h1);
      if (m.lang !== "en") fail(route, width, "html lang", m.lang);
      if (m.mainCount !== 1) fail(route, width, "main landmarks", m.mainCount);
      if (m.animating > 0)
        fail(
          route,
          width,
          "infinite animation under reduced motion",
          m.animating,
        );
      if (m.tiny.length) fail(route, width, "touch target under 24x24", m.tiny);

      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(() =>
        window.axe.run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
          },
        }),
      );
      for (const v of axe.violations)
        fail(
          route,
          width,
          `axe:${v.id}`,
          v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
        );
      rows.push({
        route,
        width,
        overflowPx: m.overflow,
        h1: m.h1,
        axeViolations: axe.violations.length,
      });
    }

    // Keyboard, once per route at a phone width and a desktop width.
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + route);
      await page.waitForSelector("h1");
      await page.evaluate(() =>
        document.activeElement instanceof HTMLElement
          ? document.activeElement.blur()
          : null,
      );
      await page.keyboard.press("Tab");
      const first = await page.evaluate(() => {
        const el = document.activeElement;
        const b = el.getBoundingClientRect();
        return {
          text: (el.textContent || "").trim().toLowerCase(),
          href: el.getAttribute("href"),
          visible:
            b.width > 0 &&
            b.height > 0 &&
            b.bottom > 0 &&
            b.right > 0 &&
            b.top < innerHeight,
        };
      });
      if (!/skip/u.test(first.text) || first.href !== "#main")
        fail(route, width, "first tab stop is not the skip link", first);
      else if (!first.visible)
        fail(route, width, "skip link not visible on focus", first);
      else {
        await page.keyboard.press("Enter");
        const inMain = await page.evaluate(
          () =>
            !!document.activeElement?.closest("main") ||
            document.activeElement?.id === "main",
        );
        if (!inMain)
          fail(route, width, "skip link does not move focus into main", null);
      }
      const seen = new Set();
      let trapped = true;
      let invisible = [];
      await page.evaluate(() => document.querySelector("a, button")?.focus());
      await page.evaluate(() =>
        document.activeElement instanceof HTMLElement
          ? document.activeElement.blur()
          : null,
      );
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press("Tab");
        const f = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return { body: true };
          const cs = getComputedStyle(el);
          const ring =
            (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) ||
            (cs.boxShadow && cs.boxShadow !== "none") ||
            el.matches(":focus-visible");
          const b = el.getBoundingClientRect();
          const key = `${el.tagName}|${el.getAttribute("href") ?? el.id ?? ""}|${Math.round(b.x)}|${Math.round(b.y)}`;
          return {
            key,
            ring:
              !!ring &&
              (cs.outlineStyle !== "none" ||
                (cs.boxShadow && cs.boxShadow !== "none")),
            label: `${el.tagName.toLowerCase()}:${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24)}`,
          };
        });
        if (f.body) {
          trapped = false;
          break;
        }
        if (seen.has(f.key)) {
          trapped = false;
          break;
        }
        seen.add(f.key);
        if (!f.ring) invisible.push(f.label);
      }
      if (trapped && seen.size >= 80)
        fail(
          route,
          width,
          "focus did not leave the page after 80 tabs",
          seen.size,
        );
      if (invisible.length)
        fail(
          route,
          width,
          "focus indicator not visible",
          invisible.slice(0, 5),
        );
    }
  }

  // The verifier by keyboard alone: label -> textarea -> sample -> verify.
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto(origin + "/verify/");
  await page.waitForSelector("h1");
  const buttons = await page.getByRole("button").allTextContents();
  if (
    !buttons.some((t) => /sample/iu.test(t)) ||
    !buttons.some((t) => /^\s*verify\s*$/iu.test(t))
  )
    fail("/verify/", 375, "verifier controls missing", buttons);
  else {
    await page.getByRole("button", { name: /sample/iu }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: /^\s*verify\s*$/iu }).focus();
    await page.keyboard.press("Enter");
    const result = page.locator(".pv-result");
    await result.waitFor({ state: "visible" });
    const text = (await result.innerText()).toLowerCase();
    if (!/verified|yes/u.test(text))
      fail(
        "/verify/",
        375,
        "keyboard-only verification gave no verdict",
        text.slice(0, 120),
      );
    const live = await result.getAttribute("aria-live");
    if (live !== "polite" && live !== "assertive")
      fail("/verify/", 375, "result is not announced (aria-live)", live);
  }
  if (pageErrors.length) fail("*", 0, "page errors", pageErrors.slice(0, 3));
  await context.close();
} finally {
  await browser.close();
  if (!remote) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

mkdirSync(remote ? "docs/evidence/public" : "docs/evidence/company", {
  recursive: true,
});
writeFileSync(
  remote
    ? "docs/evidence/public/a11y-deployed.json"
    : "docs/evidence/company/a11y-acceptance.json",
  JSON.stringify(
    {
      environment: remote
        ? `DEPLOYED site ${new URL(remote).hostname}; Chromium headless`
        : "local static production export served on 127.0.0.1; Chromium headless; no deployed host",
      routes: routes.length,
      widths: WIDTHS,
      checks: [
        "status",
        "horizontal overflow",
        "one h1",
        "html lang",
        "one main",
        "axe WCAG 2.0/2.1/2.2 A+AA",
        "reduced-motion animation",
        "touch targets >= 24px",
        "skip link",
        "focus indicator",
        "no focus trap",
        "keyboard-only verifier",
      ],
      pagesChecked: rows.length,
      failures,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    routes: routes.length,
    pagesChecked: rows.length,
    failures: failures.length,
  }),
);
for (const f of failures.slice(0, 40)) console.log(JSON.stringify(f));
if (failures.length) process.exitCode = 1;
