import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 2026-11-10: the root deployment answered 404 on `/` while Vercel reported READY, because its build command (`npm run build`) never staged a
 * homepage into `public/`. The consolidated company export is produced by `build:company`; this pins that the deployment uses it, and that the
 * PayPal payer-return routes keep working beside it.
 */
describe("root deployment configuration", () => {
  const vj = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    buildCommand: string;
    installCommand: string;
    outputDirectory: string;
    rewrites: { source: string; destination: string }[];
  };
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  it("builds the company export into the published directory, installing the console's own dependencies", () => {
    expect(vj.buildCommand).toBe("npm run build:company");
    expect(pkg.scripts["build:company"]).toContain("scripts/stage-company.mjs");
    expect(vj.installCommand).toContain("--prefix apps/console");
    expect(vj.outputDirectory).toBe("public");
  });
  it("keeps the PayPal payer-return routes and assets", () => {
    for (const s of ["/paypal/return", "/paypal/cancel", "/paypal/status"])
      expect(
        vj.rewrites.some(
          (r) => r.source === s && r.destination === "/api/paypal",
        ),
      ).toBe(true);
    expect(
      readFileSync("public/payer-return.js", "utf8").length,
    ).toBeGreaterThan(0);
  });
});
