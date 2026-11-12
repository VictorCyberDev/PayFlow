"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Explore is one destination with several kinds of thing in it (mandate section 6.3: products, talent, workspaces,
 * services and travel). Keeping them behind one nav item is what stops the top bar growing an entry per provider —
 * which is also what keeps it on one line on a 320px phone.
 */
const TABS = [
  { href: "/explore/", label: "Products" },
  { href: "/flights/", label: "Flights" },
  { href: "/talent/", label: "Talent" },
] as const;

export function ExploreTabs() {
  const path = usePathname() ?? "";
  return (
    <nav className="tabs" aria-label="What to explore">
      {TABS.map((t) => {
        const active = path.startsWith(t.href.replace(/\/$/, ""));
        return (
          <Link
            key={t.href}
            href={t.href}
            className={active ? "tabs__tab is-active" : "tabs__tab"}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
