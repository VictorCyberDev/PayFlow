"use client";
import { usePathname } from "next/navigation";
import { ConsoleProvider } from "./provider";
import { AppShell } from "./shell";
import { CompanyShell } from "./company";
/** V4 consumer surfaces bring their own chrome (FlowShell), so neither legacy shell may wrap them. */
const flowPaths = ["/", "/try", "/partner", "/explore", "/account"];
const appPaths = [
  "/app",
  "/new",
  "/authorities",
  "/missions",
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
  if (
    flowPaths.some(
      (p) => path === p || path === `${p}/` || path.startsWith(`${p}/`),
    )
  )
    return <>{children}</>;
  return appPaths.some((p) => path === p || path.startsWith(`${p}/`)) ? (
    <ConsoleProvider>
      <AppShell>{children}</AppShell>
    </ConsoleProvider>
  ) : (
    <CompanyShell>{children}</CompanyShell>
  );
}
