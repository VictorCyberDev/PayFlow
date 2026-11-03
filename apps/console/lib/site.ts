/**
 * The ONE place the canonical origin lives (metadata, Open Graph, sitemap, robots). The console
 * boundary test forbids reading the environment in the browser graph, so this is a constant: change
 * it in the commit that makes the public host live (see docs/GATE-A-PUBLIC-HOST.md).
 *
 * This is the `payflow-public` project's stable alias: the isolated public Gate A environment (no accepted
 * evidence, simulated rail only). The older `payflow-one-kappa.vercel.app` alias returns 404 to the public.
 */
export const SITE_URL = "https://payflow-public.vercel.app";
