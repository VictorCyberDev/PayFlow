// Screenshots every gallery page at desktop / tablet / mobile. Usage: node qa/shoot.mjs <galleryDir> <outDir>
import { readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
const [dir, out] = [resolve(process.argv[2]), resolve(process.argv[3])];
mkdirSync(out, { recursive: true });
const exe = [
  process.env.PLAYWRIGHT_CHROMIUM,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
].find((p) => p && existsSync(p));
const b = await chromium.launch({
  executablePath: exe,
  args: ["--allow-file-access-from-files"],
});
const sizes = { desktop: [1440, 900], tablet: [768, 1024], mobile: [375, 812] };
for (const [label, [width, height]] of Object.entries(sizes)) {
  const ctx = await b.newContext({
    viewport: { width, height },
    deviceScaleFactor: label === "mobile" ? 2 : 1,
  });
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
    const p = await ctx.newPage();
    await p.goto("file://" + join(dir, f));
    await p.waitForTimeout(250);
    const over = await p.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (over > 0) console.log(`OVERFLOW ${label} ${f} +${over}px`);
    await p.screenshot({
      path: join(out, `${f.replace(".html", "")}.${label}.png`),
      fullPage: true,
    });
    await p.close();
  }
  await ctx.close();
}
await b.close();
