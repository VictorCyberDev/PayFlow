import type { Metadata } from "next";
import Link from "next/link";
import {
  ApprovalDecisionCard,
  FinanceAuthorityCard,
  UnknownPaymentNotice,
  type AuthorityExposureView,
} from "../../ui/procurement";

export const metadata: Metadata = {
  title: "Finance & procurement — PayFlow",
  description:
    "Let a procurement agent buy within boundaries you set. See exposure, decide exceptions, and keep proof.",
  alternates: { canonical: "/solutions/finance/" },
};

const office: AuthorityExposureView = {
  name: "Office Procurement",
  agent: "Procurement Agent",
  autonomousPerPurchaseMinor: 100000,
  limitMinor: 1000000,
  reservedMinor: 50000,
  pendingMinor: 0,
  settledMinor: 318000,
  availableMinor: 632000,
  approvedSuppliers: 12,
  expires: "December 31",
  status: "ACTIVE",
};

export default function FinancePage() {
  return (
    <article className="company-document">
      <p className="eyebrow">PAYFLOW / SOLUTIONS</p>
      <h1>Automate purchasing. Keep the control.</h1>
      <p className="intro">
        A procurement agent can buy from approved suppliers inside limits you
        set. Above those limits it asks you. Every purchase leaves proof, and a
        payment that can&apos;t be confirmed is never retried.
      </p>

      <section aria-labelledby="see">
        <h2 id="see">What finance sees</h2>
        <FinanceAuthorityCard a={office} illustrative />
      </section>

      <section aria-labelledby="decide">
        <h2 id="decide">What happens above the limit</h2>
        <ApprovalDecisionCard
          agent="Procurement Agent"
          supplier="Acme Office"
          item="Office chairs"
          amountMinor={124000}
          autonomousLimitMinor={100000}
        />
      </section>

      <section aria-labelledby="blocked">
        <h2 id="blocked">What happens outside the boundary</h2>
        <p>
          The agent asks for $1,840 against a $1,000 per-purchase Authority with
          a supplier that isn&apos;t on the list. The Gate stops it.{" "}
          <strong>$0 moved.</strong> The agent gets a reason it can act on, such
          as choosing an approved supplier, and cannot widen its own limits.
        </p>
      </section>

      <section aria-labelledby="unknown">
        <h2 id="unknown">When the provider doesn&apos;t answer</h2>
        <UnknownPaymentNotice amountMinor={124000} />
      </section>

      <section aria-labelledby="proof">
        <h2 id="proof">Proof for the auditor</h2>
        <p>
          Each purchase has one record: the organization and agent, the supplier
          and item, the quote, the Authority, the approval if one was needed,
          the reservation, the one-time grant, the provider result and the final
          outcome. Anyone can verify it offline.
        </p>
        <Link className="company-link" href="/verify/">
          Verify a sample Proof →
        </Link>
      </section>

      <section aria-labelledby="real">
        <h2 id="real">What is real today, and what is not</h2>
        <ul>
          <li>
            <strong>Real in source and tested:</strong> a procurement policy
            pack (suppliers, items, price tolerance, quantity, budget, tax,
            fees, cost centre, invoice reference, escalation threshold);
            reserved, in-flight and settled exposure that matches the
            kernel&apos;s own accounting; an approval queue the agent cannot
            reach; organization isolation; an append-only audit trail.
          </li>
          <li>
            <strong>Sandbox only:</strong> payment runs on PayPal Sandbox
            against one demo merchant. The cards above show illustrative
            numbers, not a customer.
          </li>
          <li>
            <strong>Not built yet:</strong> ERP and invoice connectors,
            subscription and recurring controls in the product, obligations
            beyond a reservation, and completing a payment after an approval
            without the payer present. No procurement customer is claimed.
          </li>
        </ul>
      </section>

      <nav className="doc-links" aria-label="Further reading">
        <Link href="/contact/">Talk to us about a pilot →</Link>
        <Link href="/security/">Security →</Link>
        <Link href="/pricing/">Pricing hypothesis →</Link>
      </nav>
    </article>
  );
}
