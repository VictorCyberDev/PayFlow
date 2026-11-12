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

/**
 * The founder partner is the first request-time code the public customer app has. It calls a language model, so the function
 * must outlive the model's own 20s ceiling; at the platform default of 10s every plan would time out before it arrived.
 */
describe("the founder partner function", () => {
  const vj = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    functions: Record<string, { maxDuration: number }>;
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  it("is given room for a model call", () => {
    expect(vj.functions["api/partner.ts"]?.maxDuration).toBeGreaterThanOrEqual(
      25,
    );
  });
  it("gives product search room too", () => {
    expect(vj.functions["api/explore.ts"]?.maxDuration).toBeGreaterThanOrEqual(
      15,
    );
  });
  it("is reachable under the site's own content security policy", () => {
    const csp = vj.headers
      .flatMap((h) => h.headers)
      .find((h) => h.key === "Content-Security-Policy")?.value;
    // The browser only ever calls same-origin /api/partner, so 'self' must be in connect-src and no provider host is needed.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("api.groq.com");
    expect(csp).not.toContain("trychannel3.com");
    // Product photographs are hosted on merchant and catalogue CDNs, so img-src has to admit https. Images are passive
    // content and Referrer-Policy is no-referrer site-wide, so a merchant CDN learns that an image was fetched and
    // nothing about the page. Script, connect and form targets stay closed.
    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'self'");
  });
});
