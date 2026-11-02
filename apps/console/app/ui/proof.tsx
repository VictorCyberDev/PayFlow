import Link from "next/link";
import type { ReactNode } from "react";
import type {
  ActivityView,
  ManagedAuthority,
} from "../../lib/management-client.mjs";
import { activityOutcome } from "../../lib/language";
import { exactUtc } from "../../lib/present";
import { FlowTrace } from "./activity";

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="proof__rows">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Layer 3 as a deliberate mode, not a nested disclosure. Technical vocabulary is allowed here. */
export function ProofShell({
  back,
  backLabel,
  title,
  children,
}: {
  back: string;
  backLabel: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="proof" aria-labelledby="proof-title">
      <p>
        <Link className="text-link" href={back}>
          ‹ {backLabel}
        </Link>
      </p>
      <p className="label">Proof</p>
      <h1 id="proof-title" className="h2">
        {title}
      </h1>
      {children}
    </section>
  );
}

export function ActivityProof({ x }: { x: ActivityView }) {
  const o = activityOutcome(x);
  return (
    <ProofShell
      back={`/activity/?id=${encodeURIComponent(x.operationId)}`}
      backLabel="Back to this activity"
      title={o.headline}
    >
      <FlowTrace x={x} />
      <h2 className="h3">Authority & Agent</h2>
      <Rows
        rows={[
          ["Authority", x.mandateId],
          ["Agent", x.agentId],
        ]}
      />
      <h2 className="h3">Gate decision</h2>
      <Rows
        rows={[
          ["decision", x.decision ?? "none recorded"],
          ["status", x.status],
          ["money moved", x.moneyMoved],
          ["verification", x.verification],
          ["explanation", x.explanation],
        ]}
      />
      <h2 className="h3">Exact action</h2>
      <Rows
        rows={[
          [
            "amount (minor units)",
            x.amountMinor === null
              ? "n/a"
              : `${x.amountMinor} ${x.currency ?? ""}`,
          ],
          ["item", x.item],
          ["merchant", x.merchant],
        ]}
      />
      <h2 className="h3">Execution & outcome</h2>
      <Rows
        rows={[
          ["Provider order", x.references.providerOrderId],
          ["Provider capture", x.references.providerCaptureId],
          ["Provider effect", x.moneyMoved],
        ]}
      />
      <h2 className="h3">Reconciliation</h2>
      <p>
        {x.moneyMoved === "UNKNOWN"
          ? "We haven't confirmed whether money moved. Don't retry this action. We're checking the original attempt."
          : x.explanation}
      </p>
      <h2 className="h3">Verification</h2>
      <Rows
        rows={[
          ["Verification", x.verification],
          ["Observed", exactUtc(x.observedAt)],
        ]}
      />
      <details>
        <summary>Raw Proof and technical references</summary>
        <h2 className="h3">Stages</h2>
        <table className="proof__table">
          <thead>
            <tr>
              <th scope="col">stage</th>
              <th scope="col">status</th>
              <th scope="col">reason</th>
            </tr>
          </thead>
          <tbody>
            {x.stages.map((s) => (
              <tr key={s.stage}>
                <td>{s.stage}</td>
                <td>{s.status}</td>
                <td>{s.reasonCode}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2 className="h3">References</h2>
        <Rows
          rows={[
            ["operation", x.operationId],
            ["authority", x.mandateId],
            ["agent", x.agentId],
            ["payment attempt", x.references.paymentAttemptId],
            ["provider order", x.references.providerOrderId],
            ["provider capture", x.references.providerCaptureId],
          ]}
        />
        <h2 className="h3">Times (UTC)</h2>
        <Rows
          rows={[
            ["occurred", exactUtc(x.occurredAt)],
            ["observed", exactUtc(x.observedAt)],
          ]}
        />
      </details>
    </ProofShell>
  );
}

export function AuthorityProof({ a }: { a: ManagedAuthority }) {
  return (
    <ProofShell
      back={`/authorities/?id=${encodeURIComponent(a.mandateId)}`}
      backLabel="Back to this Authority"
      title={a.purpose}
    >
      <h2 className="h3">Authority</h2>
      <Rows
        rows={[
          ["authority id", a.mandateId],
          ["state", a.state],
          ["agent id", a.agent.id],
          ["agent status", a.agent.status],
          ["fresh dispatch blocked", String(a.freshDispatchBlocked)],
        ]}
      />
      <h2 className="h3">Terms (minor units)</h2>
      <Rows
        rows={[
          ["single maximum", `${a.singleMaximumMinor} ${a.currency}`],
          [
            "cumulative limit",
            a.cumulativeLimitMinor === null
              ? "none"
              : `${a.cumulativeLimitMinor} ${a.currency}`,
          ],
          ["committed", `${a.committedMinor} ${a.currency}`],
          ["reserved", `${a.reservedMinor} ${a.currency}`],
          ["remaining", `${a.remainingMinor} ${a.currency}`],
          [
            "autonomous threshold",
            `${a.autonomousThresholdMinor} ${a.currency}`,
          ],
          [
            "human approval threshold",
            `${a.humanApprovalThresholdMinor} ${a.currency}`,
          ],
          [
            "quantity",
            `${a.quantityRemaining ?? "n/a"} of ${a.quantityLimit ?? "n/a"}`,
          ],
          ["conditions", a.allowedConditions.join(", ")],
          ["capabilities", a.allowedCapabilities.join(", ")],
          ["merchant scope", a.merchantScopeSummary],
        ]}
      />
      <h2 className="h3">Times (UTC)</h2>
      <Rows
        rows={[
          ["created", exactUtc(a.createdAt)],
          ["expires", exactUtc(a.expiresAt)],
          ["observed", exactUtc(a.observedAt)],
        ]}
      />
      <p className="note">
        Displayed terms never authorize a payment. Every request is checked on
        the server.
      </p>
    </ProofShell>
  );
}
