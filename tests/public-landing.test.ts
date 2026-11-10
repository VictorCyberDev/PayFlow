import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The root deployment publishes `public/`. Without an index it answered 404 on `/` while Vercel reported READY (found 2026-11-10 by requesting the URL). */
describe("root deployment landing page", () => {
  const html = readFileSync("public/index.html", "utf8");
  it("exists, says plainly that the application is not available and no money can move", () => {
    expect(html).toContain("not publicly available yet");
    expect(html).toContain("no real money can move");
    expect(html).toContain("SANDBOX");
  });
  it("makes no claim of live capability and runs no script (the CSP allows none from elsewhere)", () => {
    expect(html).not.toMatch(/<script/iu);
    expect(html).not.toMatch(/sign up|log in|get started|live payments?/iu);
  });
});
