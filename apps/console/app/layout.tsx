import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./commercial.css";
import { AppShell } from "./ui/shell";
import { ConsoleProvider } from "./ui/provider";

export const metadata: Metadata = {
  title: "PayFlow — Financial authority for autonomous systems",
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
        <ConsoleProvider>
          <AppShell>{children}</AppShell>
        </ConsoleProvider>
      </body>
    </html>
  );
}
