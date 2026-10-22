"use client";

import { useState } from "react";
import AskPayFlow from "./ask-payflow";
import { demoAuthority } from "../fixtures/authority";

const nav = ["Home", "Ask PayFlow", "Authority", "Activity", "Agents"];

const recent = [
  {
    title: "Paid $84.00",
    detail: "$84.00 · Demo Merchant",
    outcome: "Payment verified",
  },
  {
    title: "Purchase blocked",
    detail: "$184.00 · Above your $100 limit",
    outcome: "Your money didn't move",
  },
];

export default function HomePage() {
  const [active, setActive] = useState("Home");
  return (
    <main className="app-shell" id="home">
      <a className="skip-link" href="#welcome-title">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Primary navigation">
        <a className="brand" href="#home" aria-label="PayFlow home">
          <span className="brand-mark">P</span>
          <span>PayFlow</span>
        </a>

        <nav>
          {nav.map((item, index) => (
            <a
              className={active === item ? "nav-item active" : "nav-item"}
              onClick={() => setActive(item)}
              aria-current={active === item ? "location" : undefined}
              href={
                ["#home", "#ask", "#authority", "#activity", "#agents"][index]
              }
              key={item}
            >
              {item}
            </a>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>Interactive preview</strong>
            <span>Example data. No real authority.</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="mobile-brand">PayFlow</div>
          <span className="preview-label">
            Fixture preview · No live account
          </span>
        </header>

        <div className="content">
          <p className="preview-banner" role="note">
            Preview only. All amounts, agents and outcomes below are examples.
            Nothing on this page authorizes or pays.
          </p>
          <section className="hero" aria-labelledby="welcome-title">
            <p className="eyebrow">Your AI. Your authority.</p>
            <h1 id="welcome-title">What can your agent handle for you?</h1>
            <p className="waiting-note">
              Nothing waiting for you · Example workspace
            </p>
            <p className="hero-copy">
              Describe what you want done. PayFlow turns your instructions into
              clear limits you can review before anything becomes authorized.
            </p>

            <AskPayFlow />
          </section>

          <section
            id="authority"
            className="section-block"
            aria-labelledby="authority-title"
          >
            <div className="section-heading">
              <div>
                <p className="eyebrow">Example authority</p>
                <h2 id="authority-title">
                  The limits your agent would work within
                </h2>
              </div>
              <a className="text-button" href="#authority-detail">
                View example
              </a>
            </div>

            <article className="authority-card">
              <div className="authority-card-topline">
                <div>
                  <span className="state-pill">Example · Active</span>
                  <h3>{demoAuthority.purpose}</h3>
                  <p>{demoAuthority.agentName}</p>
                </div>
                <div className="amount-block">
                  <span>Up to</span>
                  <strong>{demoAuthority.maximum}</strong>
                </div>
              </div>

              <div className="authority-progress" aria-label="$84 of $100 used">
                <div className="authority-progress-bar">
                  <span />
                </div>
                <div className="authority-progress-copy">
                  <span>{demoAuthority.remaining} remaining · example</span>
                  <span>{demoAuthority.used} used</span>
                </div>
              </div>

              <div className="constraint-grid">
                <div>
                  <span>Item</span>
                  <strong>1 new item</strong>
                </div>
                <div>
                  <span>Where</span>
                  <strong>Approved merchants only</strong>
                </div>
                <div>
                  <span>Approval</span>
                  <strong>Can complete without asking again</strong>
                </div>
                <div>
                  <span>Expires</span>
                  <strong>{demoAuthority.expiry}</strong>
                </div>
              </div>

              <div className="authority-actions">
                <p>
                  Illustration only. No confirmed mandate exists for this
                  example.
                </p>
                <a href="#authority-detail">View authority</a>
              </div>
            </article>
            <details id="authority-detail">
              <summary>View example authority details</summary>
              <p>
                Shopping Agent can buy one new keyboard from approved merchants,
                up to $100 per purchase. In this example, $84 is used and $16
                remains.
              </p>
              <p>
                No funds are reserved. Approval settings shown here are
                illustrative.
              </p>
              <details>
                <summary>View verification details</summary>
                <p>Not verified — fixture data, no durable record.</p>
                <details>
                  <summary>Technical references</summary>
                  <p>
                    Source: NON_AUTHORITATIVE_FIXTURE. No mandate, grant or
                    payment identifier.
                  </p>
                </details>
              </details>
            </details>
          </section>

          <section
            id="activity"
            className="section-block"
            aria-labelledby="activity-title"
          >
            <div className="section-heading">
              <div>
                <p className="eyebrow">Recent activity</p>
                <h2 id="activity-title">
                  What your agent tried and what happened
                </h2>
              </div>
              <span className="text-button">Example outcomes</span>
            </div>

            <div className="activity-list">
              {recent.map((item, index) => (
                <article className="activity-row" key={item.title}>
                  <div
                    className={
                      index === 0
                        ? "activity-icon verified"
                        : "activity-icon blocked"
                    }
                    aria-hidden="true"
                  >
                    {index === 0 ? "✓" : "—"}
                  </div>
                  <div className="activity-copy">
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <div className="activity-outcome">
                    <strong>{item.outcome}</strong>
                    <details>
                      <summary>Why?</summary>
                      <p>
                        {index === 0
                          ? "Example: trusted price fits the $100 limit."
                          : "Example: trusted price of $184 exceeded your $100 limit. Your money didn’t move."}
                      </p>
                      <details>
                        <summary>View verification details</summary>
                        <p>
                          {index === 0
                            ? "Illustrative payment only, not a verified live transaction."
                            : "Illustrative blocked request. PayPal calls: 0 in this example."}
                        </p>
                        <details>
                          <summary>Technical references</summary>
                          <p>Fixture only · no operation trace.</p>
                        </details>
                      </details>
                    </details>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section id="agents" className="section-block">
            <h2>Agents</h2>
            <p>Shopping Agent · Example profile</p>
            <p>No live agent is connected to this preview.</p>
          </section>
          <p className="fixture-note">
            M5A preview uses deterministic fixtures only. No authority or
            payment action is performed from this screen.
          </p>
        </div>
      </section>
    </main>
  );
}
