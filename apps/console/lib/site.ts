/**
 * The ONE place the canonical origin lives (metadata, Open Graph, sitemap, robots). The console
 * boundary test forbids reading the environment in the browser graph, so this is a constant: change
 * it in the commit that makes the public host live (see docs/GATE-A-PUBLIC-HOST.md).
 *
 * Today this is the `payflow` project's production alias, which Vercel Authentication still protects.
 */
export const SITE_URL = "https://payflow-one-kappa.vercel.app";
