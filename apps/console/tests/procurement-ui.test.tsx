import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import FinancePage from "../app/solutions/finance/page";
import {
  ApprovalDecisionCard,
  FinanceAuthorityCard,
  UnknownPaymentNotice,
  usd,
} from "../app/ui/procurement";

const decode = (h: string) =>
  h
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
const text = (n: React.ReactElement) =>
  decode(renderToStaticMarkup(n))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

test("money formats exactly", () => {
  assert.equal(usd(8400), "$84");
  assert.equal(usd(124000), "$1,240");
  assert.equal(usd(1999), "$19.99");
});

test("the finance page leads with control, labels its data and states what is not built", () => {
  const t = text(<FinancePage />);
  assert.match(t, /Automate purchasing\. Keep the control\./);
  assert.match(t, /Illustrative data/);
  assert.match(t, /No procurement customer is claimed/);
  assert.match(t, /Not built yet/);
  assert.match(t, /\$0 moved/);
  assert.doesNotMatch(
    t,
    /\b(certified|guarantee|trusted by|customers include)\b/i,
  );
});

test("exposure uses reserved / in flight / settled / available and never shows an invented 'committed' number", () => {
  const t = text(
    <FinanceAuthorityCard
      a={{
        name: "X",
        agent: "A",
        autonomousPerPurchaseMinor: 100000,
        limitMinor: 1000000,
        reservedMinor: 50000,
        pendingMinor: 0,
        settledMinor: 318000,
        availableMinor: 632000,
        approvedSuppliers: 12,
        expires: "Dec 31",
        status: "ACTIVE",
      }}
    />,
  );
  for (const w of ["Reserved", "In flight", "Settled", "Available", "$6,320"])
    assert.ok(t.includes(w), w);
  assert.doesNotMatch(t, /Committed\s+\$/);
  assert.match(t, /not shown as zero/);
});

test("a stopped Authority is stated in words, not only styling", () => {
  const t = text(
    <FinanceAuthorityCard
      a={{
        name: "X",
        agent: "A",
        autonomousPerPurchaseMinor: 1,
        limitMinor: 1,
        reservedMinor: 0,
        pendingMinor: 0,
        settledMinor: 0,
        availableMinor: 1,
        approvedSuppliers: 1,
        expires: "x",
        status: "REVOKED",
      }}
    />,
  );
  assert.match(t, /Stopped/);
});

test("the approval card explains why, offers three choices, says approval does not pay, and keeps the agent out", () => {
  const html = renderToStaticMarkup(
    <ApprovalDecisionCard
      agent="Procurement Agent"
      supplier="Acme Office"
      item="Office chairs"
      amountMinor={124000}
      autonomousLimitMinor={100000}
    />,
  );
  const t = decode(html).replace(/<[^>]+>/g, " ");
  assert.match(t, /wants to spend \$1,240/);
  assert.match(t, /up to \$1,000/);
  assert.match(t, /\$240 above/);
  for (const b of ["Approve once", "Reject", "Adjust Authority"])
    assert.ok(t.includes(b), b);
  assert.match(t, /\$0 moved/);
  assert.match(t, /never sees or holds this decision/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="group"/);
});

test("UNKNOWN uses the locked wording and never says failed or success", () => {
  const t = text(<UnknownPaymentNotice amountMinor={124000} />);
  assert.match(t, /Payment status being confirmed/);
  assert.match(t, /Don.t retry\./);
  assert.match(t, /PayFlow is checking the provider/);
  assert.doesNotMatch(t, /fail|success|paid/i);
});
