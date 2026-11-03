import { chromium } from "../apps/console/node_modules/playwright-core/index.mjs";
import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = resolve("apps/console/out");
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
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin =
  process.env.COMPANY_QA_ORIGIN ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {}),
  headless: true,
  args: ["--no-sandbox", "--single-process", "--no-zygote"],
});
const results = [];
const errors = [];
mkdirSync("docs/evidence/company", { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const page = await context.newPage();
try {
  for (const width of [320, 375, 430, 768, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    page.on("pageerror", (e) => errors.push(e.message));
    const response = await page.goto(origin);
    await page.waitForSelector("h1");
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    await page
      .getByRole("button", { name: "Unconfirmed", exact: true })
      .click();
    if (
      !(await page
        .getByText("We haven't confirmed whether money moved.", { exact: true })
        .isVisible())
    )
      throw new Error("UNKNOWN copy missing");
    await page.getByRole("button", { name: "Over limit", exact: true }).click();
    if (!(await page.getByText("$0 moved", { exact: true }).isVisible()))
      throw new Error("denial missing");
    await page.addScriptTag({
      content: readFileSync(
        require.resolve("../apps/console/node_modules/axe-core/axe.min.js"),
        "utf8",
      ),
    });
    const a11y = await page.evaluate(() =>
      window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      }),
    );
    results.push({
      route: "/",
      width,
      status: response.status(),
      overflow,
      violations: a11y.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target),
      })),
    });
    if ([320, 1440].includes(width))
      await page.screenshot({
        path: `docs/evidence/company/home-${width}.png`,
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const path of [
    "/product/",
    "/solutions/agent-builders/",
    "/docs/",
    "/docs/quickstart/",
    "/security/",
    "/pricing/",
    "/contact/",
    "/evidence/",
    "/status/",
    "/research/",
    "/research/zero-moved/",
    "/privacy/",
    "/app/",
    "/proof/",
  ]) {
    const r = await page.goto(origin + path);
    await page.waitForSelector("h1");
    const data = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      h1: document.querySelectorAll("h1").length,
    }));
    results.push({ route: path, width: 1280, status: r.status(), ...data });
  }

  const report = {
    environment: "local static production export; no provider contacted",
    results,
    errors,
  };
  writeFileSync(
    "docs/evidence/company/browser-qa.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  const failed = results.filter(
    (r) => r.status !== 200 || r.overflow || r.h1 > 1 || r.violations?.length,
  );
  console.log(JSON.stringify({ checks: results.length, failed, errors }));
  if (failed.length || errors.length) process.exitCode = 1;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
