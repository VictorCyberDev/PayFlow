import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./commercial.css";
import { Surfaces } from "./ui/surfaces";
import "./company.css";
import { BRAND } from "../lib/brand";

export const metadata: Metadata = {
  metadataBase: new URL("https://payflow-one-kappa.vercel.app"),
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "PayFlow — Financial authority for autonomous systems",
    description: "Any agent. Any rail. One authority truth.",
    images: ["/brand/social-card.png"],
  },
  twitter: { card: "summary_large_image", images: ["/brand/social-card.png"] },
  title: `${BRAND.name} — ${BRAND.category}`,
  description:
    "Let agents execute financial work without surrendering financial control.",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F2EFE6",
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
