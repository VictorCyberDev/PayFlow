"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BrandMark, Wordmark } from "./brand";
import { useConsole } from "./provider";
import { BRAND } from "../../lib/brand";

const items = [
  {
    href: "/app/",
    label: "Overview",
    mobile: true,
    match: (p: string) => p.startsWith("/app"),
  },
  {
    href: "/new/",
    label: "New Authority",
    short: "New",
    mobile: true,
    match: (p: string) => p.startsWith("/new"),
  },
  {
    href: "/authorities/",
    label: "Authorities",
    mobile: true,
    match: (p: string) => p.startsWith("/authorities"),
  },
  {
    href: "/activity/",
    label: "Activity",
    mobile: true,
    match: (p: string) => p.startsWith("/activity"),
  },
  {
    href: "/agents/",
    label: "Agents",
    mobile: false,
    match: (p: string) => p.startsWith("/agents"),
  },
  {
    href: "/proof/",
    label: "Proof",
    mobile: false,
    match: (p: string) => p.startsWith("/proof"),
  },
];

const roleItems = [
  { href: "/developer/", label: "Developer" },
  { href: "/enterprise/", label: "Enterprise" },
  { href: "/verify/", label: "Verifier / Merchant" },
] as const;

/** The one persistent environment indicator. The explanation lives on /about/. */
export function EnvironmentBadge() {
  return (
    <span className="env-badge" title="Sandbox environment. No real money.">
      Sandbox
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  const { session, logout } = useConsole();
  const nav = (cls: string, short = false, mobileOnly = false) => (
    <nav className={cls} aria-label="Primary">
      {items
        .filter((item) => !mobileOnly || item.mobile)
        .map((i) => {
          const active = i.match(path);
          return (
            <Link
              key={i.href}
              href={i.href}
              className={active ? "nav-link is-active" : "nav-link"}
              aria-current={active ? "page" : undefined}
            >
              {short ? (i.short ?? i.label) : i.label}
            </Link>
          );
        })}
    </nav>
  );
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="rail">
        <Link
          href="/"
          className="rail__brand"
          aria-label={`${BRAND.name} home`}
        >
          <Wordmark />
        </Link>
        {nav("rail__nav")}
        <div className="rail__foot">
          <EnvironmentBadge />
          <nav className="role-links" aria-label="Product surfaces">
            {roleItems.map((item) => (
              <Link className="text-link" href={item.href} key={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
          <Link className="text-link" href="/about/">
            About this demo
          </Link>
          {session === "signed-in" && (
            <button
              type="button"
              className="text-link"
              onClick={() => void logout()}
            >
              End demo session
            </button>
          )}
        </div>
      </header>
      <header className="topbar">
        <Link
          href="/"
          className="topbar__brand"
          aria-label={`${BRAND.name} home`}
        >
          <BrandMark size={24} />
          <span>{BRAND.name}</span>
        </Link>
        <span className="topbar__end">
          <EnvironmentBadge />
          <Link className="text-link topbar__about" href="/about/">
            About
          </Link>
        </span>
      </header>
      <main
        id="main"
        className={`main ${path.startsWith("/enterprise") || path.startsWith("/developer") || path.startsWith("/agents") ? "main--workspace" : path.startsWith("/activity") ? "main--data" : "main--focused"}`}
        tabIndex={-1}
      >
        {children}
      </main>
      {nav("tabbar", true, true)}
    </div>
  );
}
