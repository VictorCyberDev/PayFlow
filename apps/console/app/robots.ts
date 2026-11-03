import type { MetadataRoute } from "next";
import { SITE_URL } from "../lib/site";
export const dynamic = "force-static";
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/app/",
        "/new/",
        "/authorities/",
        "/agents/",
        "/activity/",
        "/proof/",
        "/enterprise/",
        "/developer/",
        "/verify/",
        "/api/",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
