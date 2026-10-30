import type { MetadataRoute } from "next";
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
    sitemap: "https://payflow-one-kappa.vercel.app/sitemap.xml",
  };
}
