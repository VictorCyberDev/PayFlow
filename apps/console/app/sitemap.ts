import type { MetadataRoute } from "next";
import { companyDocuments } from "../lib/company-content";
export const dynamic = "force-static";
export default function sitemap(): MetadataRoute.Sitemap {
  return ["", ...Object.keys(companyDocuments)].map((path) => ({
    url: `https://payflow-one-kappa.vercel.app/${path ? `${path}/` : ""}`,
  }));
}
