// Visual QA gallery: renders the REAL views with fixture state to static HTML so desktop, tablet
// and mobile output can be inspected. Usage (after `npm run build`):
//   node --import tsx qa/gallery.tsx <outDir>
// then screenshot with qa/shoot.mjs. Fixtures are presentation data only.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { ConsoleContext, type ConsoleValue } from "../app/ui/provider";
import { AppShell } from "../app/ui/shell";
import HomeView from "../app/views/home";
import { ActivityBody } from "../app/views/activity";
import { AuthoritiesBody } from "../app/views/authorities";
import AboutPage from "../app/about/page";
import { authority, blocked, NOW, paid, revoked, unknown } from "./fixtures";

const noop = () => {};
const base: ConsoleValue = {
  session: "signed-in",
  management: {
    status: "READY",
    authorities: [authority, revoked],
    activity: [unknown, paid, blocked],
    error: null,
    selected: null,
  },
  activation: { status: "IDLE", pending: null, authority: null },
  now: NOW,
  login: async () => true,
  logout: async () => {},
  prepare: async () => {},
  confirm: async () => {},
  invalidateFlow: noop,
  resetFlow: noop,
  requestRevoke: noop,
  cancelRevoke: noop,
  revoke: async () => {},
  retry: noop,
};
const page = (value: ConsoleValue, node: ReactNode) =>
  renderToStaticMarkup(
    <ConsoleContext.Provider value={value}>
      <AppShell>{node}</AppShell>
    </ConsoleContext.Provider>,
  );
const q = (s: string) => new URLSearchParams(s);
const scenes: Record<string, string> = {
  "home-attention": page(base, <HomeView />),
  "home-calm": page(
    { ...base, management: { ...base.management, activity: [paid, blocked] } },
    <HomeView />,
  ),
  "home-signed-out": page({ ...base, session: "signed-out" }, <HomeView />),
  "home-empty": page(
    {
      ...base,
      management: { ...base.management, authorities: [], activity: [] },
    },
    <HomeView />,
  ),
  "home-unavailable": page(
    {
      ...base,
      management: {
        ...base.management,
        status: "UNAVAILABLE",
        authorities: [],
        activity: [],
      },
    },
    <HomeView />,
  ),
  authorities: page(base, <AuthoritiesBody params={q("")} />),
  "authority-detail": page(
    base,
    <AuthoritiesBody params={q("id=" + authority.mandateId)} />,
  ),
  "authority-proof": page(
    base,
    <AuthoritiesBody params={q("id=" + authority.mandateId + "&proof=1")} />,
  ),
  "authority-revoke": page(
    {
      ...base,
      management: {
        ...base.management,
        status: "CONFIRM_REVOKE",
        selected: authority.mandateId,
      },
    },
    <AuthoritiesBody params={q("id=" + authority.mandateId)} />,
  ),
  activity: page(base, <ActivityBody params={q("")} />),
  "activity-paid": page(
    base,
    <ActivityBody params={q("id=" + paid.operationId)} />,
  ),
  "activity-blocked": page(
    base,
    <ActivityBody params={q("id=" + blocked.operationId)} />,
  ),
  "activity-unknown": page(
    base,
    <ActivityBody params={q("id=" + unknown.operationId)} />,
  ),
  "activity-proof": page(
    base,
    <ActivityBody params={q("id=" + blocked.operationId + "&proof=1")} />,
  ),
  about: page(base, <AboutPage />),
};

const out = resolve(process.argv[2] ?? "qa-out");
mkdirSync(out, { recursive: true });
const site = resolve("out");
const cssDir = join(site, "_next/static");
const find = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? find(join(dir, e.name)) : [join(dir, e.name)],
  );
const css = find(cssDir)
  .filter((f) => f.endsWith(".css"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n")
  .replaceAll("../media/", `file://${site}/_next/static/media/`);
for (const [name, html] of Object.entries(scenes))
  writeFileSync(
    join(out, name + ".html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body>${html}</body></html>`,
  );
console.log(Object.keys(scenes).join("\n"));
