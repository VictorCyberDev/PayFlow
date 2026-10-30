import { chromium } from "../apps/console/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {}),
  headless: true,
  args: ["--no-sandbox", "--single-process", "--no-zygote"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
  });
  const fonts = [
    ["Bricolage Grotesque", "bricolage-grotesque"],
    ["Instrument Sans", "instrument-sans"],
    ["IBM Plex Mono", "ibm-plex-mono"],
  ]
    .map(
      ([name, file]) =>
        `@font-face{font-family:'${name}';src:url(data:font/woff2;base64,${readFileSync(`apps/console/app/fonts/${file}-latin-${file === "ibm-plex-mono" ? "400" : "wght"}-normal.woff2`).toString("base64")})}`,
    )
    .join("");
  for (const slug of [
    "announcement",
    "technical",
    "benchmark",
    "research",
    "developer",
    "merchant",
    "enterprise",
  ]) {
    await page.setContent(
      `<style>body{margin:0}${fonts}</style>${readFileSync(`docs/brand/v2/social-${slug}.svg`, "utf8")}`,
    );
    await page.evaluate(() => document.fonts.ready);
    const data = await page.screenshot({ type: "png" });
    writeFileSync(`docs/brand/v2/social-${slug}.png`, data);
    if (slug === "announcement")
      writeFileSync("apps/console/public/brand/social-card.png", data);
  }
} finally {
  await browser.close();
}
