"use client";
import { useState } from "react";
import Link from "next/link";
import { usd } from "../../lib/money";

export { usd };

/** The shape the org finance projection returns for one Authority (src/network/org-views.ts). */
export interface AuthorityExposureView {
  name: string;
  agent: string;
  autonomousPerPurchaseMinor: number;
  limitMinor: number;
  reservedMinor: number;
  pendingMinor: number;
  settledMinor: number;
  availableMinor: number;
  approvedSuppliers: number;
  expires: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
}

export function FinanceAuthorityCard({
  a,
  illustrative,
}: {
  a: AuthorityExposureView;
  illustrative?: boolean;
}) {
  const rows: [string, string, string?][] = [
    ["Autonomous per purchase", usd(a.autonomousPerPurchaseMinor)],
    ["Budget", usd(a.limitMinor)],
    ["Reserved", usd(a.reservedMinor), "Decided, not yet paying"],
    ["In flight", usd(a.pendingMinor), "Money may be moving; confirming"],
    ["Settled", usd(a.settledMinor), "Confirmed by the provider"],
    ["Available", usd(a.availableMinor)],
    ["Approved suppliers", String(a.approvedSuppliers)],
    ["Expires", a.expires],
  ];
  return (
    <section className="finance-card" aria-labelledby="fc-title">
      <p className="eyebrow">
        Authority {illustrative ? "· Illustrative data" : ""}
      </p>
      <h2 id="fc-title">{a.name}</h2>
      <p className="fc-agent">
        Agent <strong>{a.agent}</strong> ·{" "}
        <span className={a.status === "ACTIVE" ? "fc-active" : "fc-stopped"}>
          {a.status === "ACTIVE"
            ? "Active"
            : a.status === "REVOKED"
              ? "Stopped"
              : "Expired"}
        </span>
      </p>
      <dl className="fc-grid">
        {rows.map(([k, v, hint]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              {v}
              {hint && <small>{hint}</small>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="fc-note">
        Obligations beyond a reservation, such as invoices and subscriptions,
        are not tracked yet and are not shown as zero.
      </p>
      <Link className="company-link" href="/authorities/">
        Stop or change this Authority →
      </Link>
    </section>
  );
}

type Decision = "waiting" | "approved" | "rejected";

export function ApprovalDecisionCard({
  agent,
  supplier,
  amountMinor,
  autonomousLimitMinor,
  item,
}: {
  agent: string;
  supplier: string;
  amountMinor: number;
  autonomousLimitMinor: number;
  item: string;
}) {
  const [state, setState] = useState<Decision>("waiting");
  return (
    <section className="decision-card" aria-labelledby="dc-title">
      <p className="eyebrow">Decision needed · Illustrative</p>
      <h2 id="dc-title">
        {agent} wants to spend {usd(amountMinor)}
      </h2>
      <p>
        {item} · Supplier: {supplier}
      </p>
      <p>
        <strong>Why you&apos;re asked:</strong> the agent may act on its own up
        to {usd(autonomousLimitMinor)}. This is{" "}
        {usd(amountMinor - autonomousLimitMinor)} above that.
      </p>
      <div className="dc-actions" role="group" aria-label="Your decision">
        <button
          type="button"
          className="company-button primary"
          onClick={() => setState("approved")}
        >
          Approve once
        </button>
        <button
          type="button"
          className="company-button"
          onClick={() => setState("rejected")}
        >
          Reject
        </button>
        <Link className="company-button" href="/authorities/">
          Adjust Authority
        </Link>
      </div>
      <p className="dc-result" aria-live="polite">
        {state === "waiting" && "Nothing has happened yet. $0 moved."}
        {state === "approved" &&
          "Approved once. The Authority is reserved for this purchase. Nothing has been paid yet, and the agent cannot use this approval for anything else."}
        {state === "rejected" &&
          "Rejected. $0 moved. The agent is told it was declined."}
      </p>
      <p className="fc-note">
        The agent never sees or holds this decision. Only you can approve.
      </p>
    </section>
  );
}

export function UnknownPaymentNotice({ amountMinor }: { amountMinor: number }) {
  return (
    <section className="unknown-card" aria-labelledby="uk-title">
      <p className="eyebrow">Payment · {usd(amountMinor)}</p>
      <h2 id="uk-title">Payment status being confirmed</h2>
      <p>
        <strong>Don&apos;t retry.</strong> PayFlow is checking the provider. If
        money did move, retrying would pay twice.
      </p>
      <p className="fc-note">
        This amount stays held against the Authority until the provider confirms
        the outcome.
      </p>
    </section>
  );
}
