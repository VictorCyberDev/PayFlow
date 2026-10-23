"use client";
import Link from "next/link";
import { activityOutcome, authorityKind } from "../../lib/language";
import { greeting } from "../../lib/present";
import { AccessGate } from "../ui/access";
import { ActivityRow } from "../ui/activity";
import { AuthorityFrame } from "../ui/frame";
import { useConsole } from "../ui/provider";
import { Empty, Loading, Unavailable } from "./common";

function Welcome() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <p className="label">Verifiable financial authority for AI agents</p>
        <h1 id="hero-title" className="h1 h1--hero">
          Permission to spend.
          <br />
          <span className="h1__quiet">Not control of your money.</span>
        </h1>
        <p className="lead">
          You set the boundaries. Your Agent works inside them. PayFlow checks
          every purchase against your rules, and shows you what happened to your
          money.
        </p>
      </section>
      <ol className="how" aria-label="How PayFlow works">
        <li>
          <span className="label">1 · Frame</span>
          <strong>You say what&apos;s allowed</strong>
          <span>How much, what, where, until when.</span>
        </li>
        <li>
          <span className="label">2 · Gate</span>
          <strong>PayFlow checks every purchase</strong>
          <span>Anything outside your rules stops before money moves.</span>
        </li>
        <li>
          <span className="label">3 · Trace</span>
          <strong>You see what happened</strong>
          <span>
            &quot;$0 moved&quot; or &quot;$84 paid once&quot;, with proof behind
            it.
          </span>
        </li>
      </ol>
      <AccessGate lead="Open the demo to create and review Authorities." />
      <p className="note">
        <Link className="text-link" href="/about/">
          About this demo
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
          </p>
        </>
      )}
    </>
  );
}
