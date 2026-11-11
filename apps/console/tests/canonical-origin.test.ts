import test from "node:test";
import assert from "node:assert/strict";
import { SITE_URL } from "../lib/site";
import { CUSTOMER_APP_URL, SIGN_IN_HREF } from "../lib/availability";

/**
 * The marketing site's canonical origin is the one it is actually served from. These guards exist
 * because the opposite shipped: SITE_URL named `payflow-public.vercel.app`, the customer
 * application's project, which has no deployment and answers 404 DEPLOYMENT_NOT_FOUND. Every
 * canonical tag, the og:image and every sitemap <loc> on the live site therefore pointed at a dead
 * origin, and nothing in the suite noticed.
 */
const APP_PROJECT_ORIGIN = "https://payflow-public.vercel.app";

test("the canonical origin is a well-formed https origin and nothing more", () => {
  const u = new URL(SITE_URL);
  assert.equal(u.protocol, "https:");
  assert.equal(
    u.origin,
    SITE_URL,
    "no trailing slash, path, query or fragment",
  );
});

test("the canonical origin is not the customer application's undeployed project", () => {
  assert.notEqual(
    SITE_URL,
    APP_PROJECT_ORIGIN,
    "marketing metadata must not name the application project; it answers 404",
  );
});

test("the canonical origin is not a Vercel auto-generated domain", () => {
  // `ssoProtection: all_except_custom_domains` gates these, so an anonymous visitor gets a 302 to a
  // Vercel login. Measured 2026-11-11 on payflow-start-up16.vercel.app and
  // payflow-git-main-start-up16.vercel.app.
  assert.doesNotMatch(
    SITE_URL,
    /-start-up16\.vercel\.app$/u,
    "an auto-generated project domain is behind Vercel SSO; customers cannot reach it",
  );
});

test("where 'Sign in' goes stays a separate decision from the canonical origin", () => {
  // The application origin and the marketing origin are different hosts with different protection
  // and different secrets. Conflating them is what produced the defect above.
  if (CUSTOMER_APP_URL !== null)
    assert.notEqual(
      new URL(CUSTOMER_APP_URL).origin,
      SITE_URL,
      "the app is its own origin, not a path on the marketing site",
    );
  else
    assert.equal(
      SIGN_IN_HREF,
      "/preview/",
      "with no application open, 'Sign in' must lead to the honest preview page",
    );
});
