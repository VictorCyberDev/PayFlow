import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The company site's "Sign in" must not lead to a surface that cannot sign anyone in. Until the customer app is public (CUSTOMER_APP_URL set by the
 * owner), it goes to an honest private-preview page, and that page does not promise a sign-up.
 */
describe("marketing sign-in honesty", () => {
  const avail = readFileSync("apps/console/lib/availability.ts", "utf8");
  const header = readFileSync("apps/console/app/ui/company.tsx", "utf8");
  const content = readFileSync("apps/console/lib/company-content.ts", "utf8");
  it("sign in follows the single availability constant and defaults to the preview page", () => {
    expect(avail).toContain("CUSTOMER_APP_URL: string | null = null");
    expect(avail).toContain('"/preview/"');
    expect(header).toContain("href={SIGN_IN_HREF}");
    expect(header).not.toContain('href="/app/"');
  });
  it("the preview page exists, says nothing can be signed up for, and links only to pages that exist", () => {
    const i = content.indexOf("preview: make(");
    expect(i).toBeGreaterThan(0);
    const doc = content.slice(i, content.indexOf("status: make(", i));
    expect(doc).toContain("no public sign-up or sign-in");
    expect(doc).toMatch(/no real money moves/iu);
    for (const href of ["/sandbox/", "/docs/", "/status/", "/contact/"]) {
      expect(doc).toContain(href);
      expect(content).toContain(
        href === "/docs/"
          ? "\n  docs: make("
          : `\n  ${href.slice(1, -1)}: make(`,
      );
    }
  });
});
