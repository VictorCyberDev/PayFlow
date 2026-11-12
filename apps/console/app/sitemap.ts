import { SITE_URL } from "../lib/site";
import type { MetadataRoute } from "next";
import { companyDocuments } from "../lib/company-content";

/**
 * The V4 consumer routes are listed explicitly. Beyond SEO this is load-bearing: scripts/a11y-acceptance.mjs reads the
 * sitemap to decide what to audit, so a route missing here is a route nothing checks.
 */
const CONSUMER_ROUTES = ["try", "partner", "explore"];

export const dynamic = "force-static";
export default function sitemap(): MetadataRoute.Sitemap {
  return ["", ...CONSUMER_ROUTES, ...Object.keys(companyDocuments)].map(
    (path) => ({
      url: `${SITE_URL}/${path ? `${path}/` : ""}`,
    }),
  );
}
