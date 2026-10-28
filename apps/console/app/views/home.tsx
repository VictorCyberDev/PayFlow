"use client";
import Link from "next/link";
import { activityOutcome, authorityKind } from "../../lib/language";
import { greeting } from "../../lib/present";
import { AccessGate } from "../ui/access";
import { ActivityRow } from "../ui/activity";
import { AuthorityFrame } from "../ui/frame";
import { useConsole } from "../ui/provider";
import { Empty, Loading, Unavailable } from "./common";
import { BRAND } from "../../lib/brand";

function Welcome() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <p className="label">Financial authority for autonomous systems</p>
        <h1 id="hero-title" className="h1 h1--hero">
          Permission to spend.
          <br />
          <span className="h1__quiet">Not unrestricted financial power.</span>
        </h1>
        <p className="lead">
          Give an agent financial capability without giving it unrestricted
          financial power. {BRAND.name} binds exact actions to explicit
          Authority, revalidates at the execution boundary, and preserves
          verifiable financial truth afterward.
        </p>
        <p className="outcome-line">
          Any agent. Any rail. One authority truth.
        </p>
      </section>
      <ol
        className="gate-sequence"
        aria-label={`${BRAND.name} authority sequence`}
      >
        <li>
          <strong>Bound</strong>
          <span>Intent becomes explicit constraints.</span>
        </li>
        <li>
          <strong>Gate</strong>
          <span>The exact action reaches the execution boundary.</span>
        </li>
        <li>
          <strong>Commit</strong>
          <span>Only a valid bounded action may cross.</span>
        </li>
        <li>
          <strong>Verify</strong>
          <span>Completion appears only after durable truth.</span>
        </li>
      </ol>
      <AccessGate lead="Open the sandbox demo to create and review Authorities." />
      <section className="block" aria-labelledby="surfaces">
        <h2 className="label" id="surfaces">
          Built for the whole authority boundary
        </h2>
        <div className="surface-grid">
          <article className="surface-card">
            <h3 className="h3">Developer</h3>
            <p>Gateway, SDKs, MCP, A2A, sandbox, Proof and reconciliation.</p>
            <Link className="text-link" href="/developer/">
              Open developer surface
            </Link>
          </article>
          <article className="surface-card">
            <h3 className="h3">Enterprise</h3>
            <p>
              Organizations, agents, delegation, controls, integrations and
              audit.
            </p>
            <Link className="text-link" href="/enterprise/">
              Open enterprise surface
            </Link>
          </article>
          <article className="surface-card">
            <h3 className="h3">Verifier / Merchant</h3>
            <p>
              Read-only Authority, freshness, revocation and Proof verification.
            </p>
            <Link className="text-link" href="/verify/">
              Open Verify
            </Link>
          </article>
          <article className="surface-card">
            <h3 className="h3">Proof</h3>
            <p>
              What was authorized, what crossed the Gate, and what actually
              happened.
            </p>
            <Link className="text-link" href="/proof/">
              Inspect Proof product
            </Link>
          </article>
        </div>
      </section>
      <p className="note">
        <Link className="text-link" href="/about/">
          About this sandbox
        </Link>
      </p>
    </>
  );
}

export default function HomeView() {
  const { session, management, now, retry } = useConsole();
  if (session === "checking") return <Loading what="Loading…" />;
  if (session === "signed-out") return <Welcome />;
  if (management.status === "UNAVAILABLE")
    return <Unavailable onRetry={retry} />;
  const ready = ["READY", "CONFIRM_REVOKE", "REVOKING", "VERIFYING"].includes(
    management.status,
  );
  if (!ready) return <Loading what="Checking your Authorities…" />;

  const active = management.authorities
    .filter((a) => authorityKind(a) === "active")
    .sort((x, y) => Date.parse(x.expiresAt) - Date.parse(y.expiresAt));
  const attention = management.activity.filter(
    (x) => activityOutcome(x).needsAttention,
  );
  const recent = management.activity
    .filter((x) => !attention.includes(x))
    .slice(0, 3);
  const headline = attention.length
    ? attention.length === 1
      ? "1 payment needs attention."
      : `${attention.length} payments need attention.`
    : !management.authorities.length
      ? "No active Authorities yet."
      : !active.length
        ? "No Authority is active right now."
        : "Everything is within your rules.";

  return (
    <>
      <p className="label">{greeting(now)}</p>
      <h1 className="h1">{headline}</h1>
      {attention.length > 0 && (
        <section aria-labelledby="attn" className="block">
          <h2 id="attn" className="label">
            Needs your attention
          </h2>
          <ul className="journal">
            {attention.map((x) => (
              <ActivityRow
                key={x.operationId}
                x={x}
                now={now}
                href={`/activity/?id=${encodeURIComponent(x.operationId)}`}
              />
            ))}
          </ul>
        </section>
      )}
      {!management.authorities.length ? (
        <Empty
          title="Give your AI clear spending boundaries."
          action={{ href: "/new/", label: "Create Authority" }}
        >
          Describe what your Agent may buy. You&apos;ll review exact limits
          before anything is allowed.
        </Empty>
      ) : (
        <>
          {active[0] && (
            <section aria-labelledby="act-auth" className="block">
              <h2 id="act-auth" className="label">
                {active.length > 1
                  ? `Active Authority · ${active.length} in total`
                  : "Active Authority"}
              </h2>
              <AuthorityFrame
                a={active[0]}
                now={now}
                compact
                headingLevel={3}
                href={`/authorities/?id=${encodeURIComponent(active[0].mandateId)}`}
              />
            </section>
          )}
          <section aria-labelledby="recent" className="block">
            <h2 id="recent" className="label">
              Recent
            </h2>
            {recent.length ? (
              <>
                <ul className="journal">
                  {recent.map((x) => (
                    <ActivityRow
                      key={x.operationId}
                      x={x}
                      now={now}
                      href={`/activity/?id=${encodeURIComponent(x.operationId)}`}
                    />
                  ))}
                </ul>
                <p>
                  <Link className="text-link" href="/activity/">
                    All activity
                  </Link>
                </p>
              </>
            ) : (
              !attention.length && (
                <p className="note">No financial activity yet.</p>
              )
            )}
          </section>
          <p className="actions">
            <Link className="btn" href="/new/">
              New Authority
            </Link>
            <Link className="btn btn--quiet" href="/agents/">
              Agents
            </Link>
            <Link className="btn btn--quiet" href="/proof/">
              Proof
            </Link>
          </p>
        </>
      )}
    </>
  );
}
