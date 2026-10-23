import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "./ui/shell";
import { ConsoleProvider } from "./ui/provider";

export const metadata: Metadata = {
  title: "PayFlow — Permission to spend, not control of your money",
  description:
    "Give AI agents permission to spend — not control of your money.",
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
