import { SITE_URL } from "../lib/site";
import type { MetadataRoute } from "next";
import { companyDocuments } from "../lib/company-content";
export const dynamic = "force-static";
export default function sitemap(): MetadataRoute.Sitemap {
  return ["", ...Object.keys(companyDocuments)].map((path) => ({
    url: `${SITE_URL}/${path ? `${path}/` : ""}`,
  }));
}
