import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The PayFlow V4 consumer identity.
 *
 * The mark is one line that enters level, rises through a decision, and settles on a filled point: the product's whole story
 * in a glyph that still reads at 16px. It is drawn here rather than loaded, so there is no extra request and no raster to go
 * stale.
 */
export function FlowGlyph({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.5 17.5C6 17.5 6.5 6.5 11.5 6.5C15.5 6.5 16 12 19 12"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="20.5" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function FlowWordmark() {
  return (
    <>
      <FlowGlyph size={22} />
      <span>PayFlow</span>
    </>
  );
}

/** The eleven states of §5.4. Each is legible from its label alone; motion only makes the change readable. */
export type FlowState =
  | "ready"
  | "listening"
  | "planning"
  | "searching"
  | "comparing"
  | "negotiating"
  | "deciding"
  | "executing"
  | "confirmed"
  | "paused"
  | "unverified";

const STATE_LABEL: Readonly<Record<FlowState, string>> = Object.freeze({
  ready: "Ready",
  listening: "Listening",
  planning: "Working out a plan",
  searching: "Searching",
  comparing: "Comparing options",
  negotiating: "Negotiating",
  deciding: "Waiting for your decision",
  executing: "Carrying out what you approved",
  confirmed: "Confirmed",
  paused: "Paused",
  unverified: "Not able to confirm this yet",
});

export function flowStateLabel(state: FlowState): string {
  return STATE_LABEL[state];
}

/**
 * The signature object. `state` must reflect what the application is actually doing — it is never set to a busy state to
 * make a screen look alive, which is why every caller derives it from real state.
 */
export function FlowObject({
  state,
  title,
}: {
  state: FlowState;
  title?: string;
}) {
  return (
    <figure
      style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}
    >
      <svg
        className="flow-object"
        data-state={state}
        viewBox="0 0 520 190"
        role="img"
        aria-label={`PayFlow: ${STATE_LABEL[state]}`}
      >
        <circle className="flow-object__halo" cx="432" cy="96" r="34" />
        <circle className="flow-object__halo" cx="432" cy="96" r="52" />
        <path
          className="flow-object__line"
          d="M16 154C96 154 104 36 212 36C308 36 320 96 432 96"
        />
        <circle className="flow-object__node" cx="432" cy="96" r="11" />
      </svg>
      <figcaption className="eyebrow" aria-hidden="true">
        {title ?? STATE_LABEL[state]}
      </figcaption>
    </figure>
  );
}

/**
 * Evidence classes, transferred from Willie's REAL_VS_SIMULATED ladder.
 * The rule that matters: the interface may never promote a weaker class to a stronger one.
 */
export type EvidenceClass =
  "SIMULATED" | "MODEL_PROPOSED" | "PROVIDER_OBSERVED" | "PROVIDER_CONFIRMED";

const EVIDENCE: Readonly<
  Record<EvidenceClass, { label: string; cls: string }>
> = Object.freeze({
  SIMULATED: { label: "Simulated", cls: "chip chip--simulated" },
  MODEL_PROPOSED: { label: "Proposal", cls: "chip chip--proposed" },
  PROVIDER_OBSERVED: { label: "Observed", cls: "chip chip--observed" },
  PROVIDER_CONFIRMED: { label: "Confirmed", cls: "chip" },
});

export function EvidenceChip({ kind }: { kind: EvidenceClass }) {
  const e = EVIDENCE[kind];
  return <span className={e.cls}>{e.label}</span>;
}

const NAV = [
  { href: "/try/", label: "Try" },
  { href: "/explore/", label: "Explore" },
  { href: "/partner/", label: "Partner" },
  { href: "/account/", label: "Workspace" },
] as const;

/** The consumer chrome. Developer and enterprise destinations live in the footer, not in a founder's way (§6.5). */
export function FlowShell({
  children,
  active,
}: {
  children: ReactNode;
  active?: string;
}) {
  return (
    <div className="flow">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="flow__bar">
        <Link className="flow__brand" href="/" aria-label="PayFlow home">
          <FlowWordmark />
        </Link>
        <nav className="flow__nav" aria-label="Primary">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main id="main" className="flow__main" tabIndex={-1}>
        {children}
      </main>
      <footer className="flow__foot">
        <div className="wrap">
          <p>
            PayFlow asks before taking actions that matter, and shows you the
            verified result afterwards.
          </p>
          <nav aria-label="More">
            <Link href="/calendar/">Your week</Link>
            <Link href="/app/">Console</Link>
            <Link href="/developer/">Developers</Link>
            <Link href="/enterprise/">Enterprise</Link>
            <Link href="/verify/">Verify</Link>
            <Link href="/proof/">Proof</Link>
            <Link href="/about/">About this build</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
