"use client";
import { SIGN_IN_HREF } from "../../lib/availability";
import Link from "next/link";
import { useState } from "react";
import { Wordmark, BrandMark } from "./brand";
const nav = [
  ["Product", "/product/"],
  ["Solutions", "/solutions/"],
  ["Developers", "/docs/"],
  ["Security", "/security/"],
  ["Research", "/research/"],
  ["Pricing", "/pricing/"],
  ["Company", "/company/"],
];
export function CompanyShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="company">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="company-header">
        <Link href="/" aria-label="PayFlow home">
          <Wordmark />
        </Link>
        <nav aria-label="Company">
          {nav.map(([label, href]) => (
            <Link href={href!} key={label}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="company-actions">
          <Link href={SIGN_IN_HREF}>Sign in</Link>
          <Link className="company-button" href="/docs/quickstart/">
            Start building <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="company-footer">
        <div>
          <Wordmark />
          <p>
            Any agent. Any rail.
            <br />
            One authority truth.
          </p>
          <small>
            Developer preview. Financial authority for autonomous systems.
          </small>
        </div>
        <nav aria-label="Resources">
          {[
            ["Documentation", "/docs/"],
            ["Evidence", "/evidence/"],
            ["Status", "/status/"],
            ["Changelog", "/changelog/"],
            ["Contact", "/contact/"],
            ["Support", "/support/"],
            ["Privacy", "/privacy/"],
            ["Terms", "/terms/"],
            ["Acceptable use", "/acceptable-use/"],
            ["Subprocessors", "/subprocessors/"],
          ].map(([label, href]) => (
            <Link href={href!} key={label}>
              {label}
            </Link>
          ))}
        </nav>
        <p className="footer-note">
          No customer volume, uptime, audit or certification is claimed.{" "}
          <Link href="/evidence/">Inspect the evidence.</Link>
        </p>
      </footer>
    </div>
  );
}
export function GateExample() {
  const [state, setState] = useState<
    "blocked" | "allowed" | "unknown" | "replay"
  >("blocked");
  const outcomes = {
    blocked: "$0 moved",
    allowed: "$84 paid once",
    unknown: "We haven't confirmed whether money moved.",
    replay: "0 additional effects",
  };
  return (
    <figure className="gate-example">
      <figcaption>
        <span className="eyebrow">Authority / 001</span>
        <span className="example-label">
          Interactive illustration · local data
        </span>
      </figcaption>
      <div className="authority-frame">
        <div>
          <span className="eyebrow">BOUND</span>
          <h2>One new keyboard.</h2>
          <p>
            Approved merchant <span aria-hidden="true">·</span> ≤ $100
          </p>
        </div>
        <div className="gate-graphic" aria-hidden="true">
          <div className="attempt">
            {state === "blocked" ? "$184" : "$84"}
            <small>ATTEMPT</small>
          </div>
          <div className="flow-line" />
          <BrandMark size={98} />
        </div>
        <div className="gate-outcome" aria-live="polite">
          <span className="eyebrow">
            {state === "blocked"
              ? "GATE / DENIED"
              : state === "unknown"
                ? "VERIFY / UNKNOWN"
                : state === "replay"
                  ? "VERIFY / REPLAY"
                  : "VERIFY / CONFIRMED"}
          </span>
          <strong>{outcomes[state]}</strong>
          <p>
            {state === "unknown"
              ? "Don't retry this action. We're checking the original attempt."
              : state === "blocked"
                ? "This action exceeds Authority."
                : state === "replay"
                  ? "The original action remains the only effect."
                  : "Within Authority. Outcome confirmed in this illustration."}
          </p>
        </div>
      </div>
      <div className="example-controls" aria-label="Explore financial outcomes">
        {[
          ["blocked", "Over limit"],
          ["allowed", "Within bounds"],
          ["unknown", "Unconfirmed"],
          ["replay", "Replay"],
        ].map(([key, label]) => (
          <button
            type="button"
            aria-pressed={state === key}
            onClick={() => setState(key as typeof state)}
            key={key}
          >
            {label}
          </button>
        ))}
      </div>
    </figure>
  );
}

/*
 * The infrastructure-first marketing homepage (CompanyHome) and the `sequence` and `products` copy that only it used
 * lived here until V4. `/` is now the consumer landing page (app/views/landing.tsx), per the V4 mandate section 5.1 and
 * section 9, so they were removed rather than left as an unreachable second homepage. The Gate demonstration above
 * survives on its own: it is still rendered by /sandbox/ and /research/break-authority/.
 */
