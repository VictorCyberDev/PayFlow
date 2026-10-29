"use client";
import { usePathname } from "next/navigation";
import { ConsoleProvider } from "./provider";
import { AppShell } from "./shell";
import { CompanyShell } from "./company";
const appPaths = [
  "/app",
  "/new",
  "/authorities",
  "/activity",
  "/agents",
  "/proof",
  "/developer",
  "/enterprise",
  "/verify",
  "/about",
];
export function Surfaces({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? "/";
  return appPaths.some((p) => path === p || path.startsWith(`${p}/`)) ? (
    <ConsoleProvider>
      <AppShell>{children}</AppShell>
    </ConsoleProvider>
  ) : (
    <CompanyShell>{children}</CompanyShell>
  );
}
