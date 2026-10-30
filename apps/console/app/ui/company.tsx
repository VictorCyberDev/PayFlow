"use client";
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
          <Link href="/app/">Sign in</Link>
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
export const sequence = [
  ["01", "Bound", "Resolve intent into exact constraints."],
  ["02", "Gate", "Evaluate this action before execution."],
  ["03", "Commit", "Cross only with a bounded, one-time grant."],
  ["04", "Verify", "Resolve the outcome from durable evidence."],
];
export const products = [
  [
    "Authority",
    "What may the agent do?",
    "Define who, what, where, how much and until when.",
  ],
  [
    "Gateway",
    "May this exact action proceed?",
    "Evaluate every attempt against existing Authority.",
  ],
  [
    "Verify",
    "Was the agent authorized?",
    "Verify signed presentations without payment credentials.",
  ],
  [
    "Proof",
    "What actually happened?",
    "Inspect the action, decision and confirmed provider effect.",
  ],
  [
    "Control",
    "Who governs the organization?",
    "Manage agent lifecycles, roles and approval boundaries.",
  ],
  [
    "Network",
    "Can Authority travel?",
    "A local interoperability demonstrator. External adoption remains pending.",
  ],
];
export function CompanyHome() {
  return (
    <>
      <section className="company-hero">
        <div className="hero-copy">
          <p className="eyebrow">PAYFLOW / FINANCIAL AUTHORITY</p>
          <h1>
            Financial authority for autonomous systems
            <span className="amber-stop">.</span>
          </h1>
          <p className="hero-deck">
            Let agents execute financial work within exact boundaries—and prove
            what actually happened afterward.
          </p>
          <div className="hero-ctas">
            <Link className="company-button primary" href="/sandbox/">
              Start in Sandbox <span aria-hidden="true">↗</span>
            </Link>
            <Link className="company-link" href="/docs/">
              Read the docs <span aria-hidden="true">→</span>
            </Link>
          </div>
          <Link className="enterprise-link" href="/contact/">
            Evaluating for your organization? Talk to us →
          </Link>
        </div>
        <GateExample />
      </section>
      <section className="company-section sequence-section">
        <p className="eyebrow">One boundary. Four steps.</p>
        <ol className="company-sequence">
          {sequence.map(([n, title, description]) => (
            <li key={n}>
              <span>{n}</span>
              <h2>{title}</h2>
              <p>{description}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="company-section product-section">
        <div className="section-heading">
          <p className="eyebrow">THE AUTHORITY STACK</p>
          <h2>
            Financial capability.
            <br />
            Explicit limits.
          </h2>
          <p>
            Authority comes from the principal. The agent proposes. PayFlow
            evaluates. Provider evidence establishes the outcome.
          </p>
        </div>
        <div className="product-lines">
          {products.map(([name, question, description]) => (
            <article key={name}>
              <span className="product-index">
                <BrandMark size={24} /> PayFlow {name}
              </span>
              <h3>{question}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="company-section dark-section">
        <p className="eyebrow">BUILT FOR REAL FINANCIAL FAILURE MODES</p>
        <h2>
          The difficult cases
          <br />
          are the product.
        </h2>
        <div className="failure-grid">
          {[
            ["Replay", "One request must not become two financial effects."],
            ["Drift", "The merchant, price or item changes after intent."],
            ["Revocation", "Previously granted Authority no longer applies."],
            ["Concurrency", "Several agents compete for the same limit."],
            ["Ambiguity", "An API error does not establish that $0 moved."],
            ["Tampering", "A mark on a page is not cryptographic Proof."],
          ].map(([name, text]) => (
            <article key={name}>
              <h3>{name}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
        <Link className="company-link" href="/evidence/">
          Review accepted, local and pending evidence →
        </Link>
      </section>
      <section className="company-section solutions-section">
        <p className="eyebrow">THREE SIDES. ONE AUTHORITY TRUTH.</p>
        <h2>Build. Govern. Verify.</h2>
        <div className="solutions-grid">
          {[
            [
              "Agent builders",
              "Give agents financial capability—not unrestricted financial power.",
              "agent-builders",
            ],
            [
              "Finance & procurement",
              "Let agents execute financial work without surrendering financial control.",
              "finance",
            ],
            [
              "Platforms & merchants",
              "Know whether the agent was authorized before money moves.",
              "merchants",
            ],
          ].map(([title, copy, slug]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{copy}</p>
              <Link className="company-link" href={`/solutions/${slug}/`}>
                Explore →
              </Link>
            </article>
          ))}
        </div>
      </section>
      <section className="company-section closing-section">
        <BrandMark size={64} />
        <h2>Bound. Gate. Commit. Verify.</h2>
        <p>Start with an exact boundary. Keep the evidence.</p>
        <Link className="company-button primary" href="/docs/quickstart/">
          Start building ↗
        </Link>
      </section>
    </>
  );
}
