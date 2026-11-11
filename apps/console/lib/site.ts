/**
 * The ONE place the canonical MARKETING origin lives (metadata, Open Graph, sitemap, robots). The
 * console boundary test forbids reading the environment in the browser graph, so this is a constant.
 *
 * This is the marketing site's own origin, and it is deliberately NOT the customer application's.
 * Where "Sign in" goes is a separate decision, held by `CUSTOMER_APP_URL` in ./availability.ts.
 *
 * Measured on 2026-11-11 against the live hosts (anonymous requests, no cookies):
 *   - https://payflow-one-kappa.vercel.app/  -> 200 (and /product/, /verify/, /status/, /preview/,
 *     /pricing/ all 200). It is the `payflow` project's added production domain, so the project's
 *     `ssoProtection: all_except_custom_domains` does not gate it.
 *   - https://payflow-start-up16.vercel.app/ -> 302 to Vercel SSO (an auto-generated project domain,
 *     which that setting DOES gate). Never link a customer to one of these.
 *   - https://payflow-public.vercel.app/     -> 404 DEPLOYMENT_NOT_FOUND. `payflow-public` is the
 *     customer-application project and has no deployment, so it cannot be a canonical origin.
 *
 * Until this commit SITE_URL was the payflow-public address, which put a 404 origin in every
 * canonical tag, the og:image and every sitemap <loc> of the site that is actually serving.
 */
export const SITE_URL = "https://payflow-one-kappa.vercel.app";
