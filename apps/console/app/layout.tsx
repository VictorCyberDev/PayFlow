import { SITE_URL } from "../lib/site";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./commercial.css";
import { Surfaces } from "./ui/surfaces";
import "./company.css";
import "./missions.css";
import "./flow.css";
import { BRAND } from "../lib/brand";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "PayFlow — Make it happen",
    description:
      "Your AI business partner. Tell PayFlow what you need done; it brings you the decisions that are yours.",
    images: ["/brand/social-card.png"],
  },
  twitter: { card: "summary_large_image", images: ["/brand/social-card.png"] },
  title: `${BRAND.name} — Make it happen`,
  description:
    "Your AI business partner. Tell PayFlow what you need done; it plans the work, explains the trade-offs and brings you the decisions that are yours.",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#FAF8F2",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Surfaces>{children}</Surfaces>
      </body>
    </html>
  );
}
