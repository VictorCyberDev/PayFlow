import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { ConsoleContext, type ConsoleValue } from "../app/ui/provider";
import HomeView from "../app/views/home";
import { ActivityBody } from "../app/views/activity";
import { AuthoritiesBody } from "../app/views/authorities";
import {
  authority,
  blocked,
  NOW,
  paid,
  revoked,
  unknown,
} from "../qa/fixtures";

const noop = () => {};
const base: ConsoleValue = {
  session: "signed-in",
  management: {
    status: "READY",
    authorities: [authority],
    activity: [],
    error: null,
    selected: null,
  },
  activation: { status: "IDLE", pending: null, authority: null },
  now: NOW,
  login: async () => true,
  logout: async () => {},
  prepare: async () => {},
  confirm: async () => {},
  invalidateFlow: noop,
  resetFlow: noop,
  requestRevoke: noop,
  cancelRevoke: noop,
  revoke: async () => {},
  retry: noop,
};
const render = (v: Partial<ConsoleValue>, node: ReactNode) =>
  renderToStaticMarkup(
    <ConsoleContext.Provider value={{ ...base, ...v }}>
      {node}
    </ConsoleContext.Provider>,
  );
const mgmt = (m: Partial<ConsoleValue["management"]>) => ({
  management: { ...base.management, ...m },
});
const q = (s: string) => new URLSearchParams(s);
const TECH =
  /Mandate|AgentPassport|execution grant|reservation|fingerprint|UNKNOWN_FINANCIAL|provider conformance|reason code|operation id|\bUTC\b|GMT/i;

test("Home: calm state says everything is within your rules, with one Authority and one action", () => {
  const html = render(mgmt({ activity: [paid, blocked] }), <HomeView />);
  assert.match(html, /Everything is within your rules\./);
  assert.match(html, /\$16/);
  assert.match(html, /\$84 paid once/);
  assert.match(html, /\$0 moved/);
  assert.match(html, /href="\/new\/?"/);
  assert.doesNotMatch(html, TECH);
});

test("Home: an unresolved payment is elevated with safe guidance", () => {
  const html = render(mgmt({ activity: [unknown, paid] }), <HomeView />);
  assert.match(html, /1 payment needs attention\./);
  assert.match(html, /Checking what happened — don&#x27;t retry yet/);
  assert.match(
    html,
    /We haven&#x27;t confirmed whether money moved\. Don&#x27;t retry yet\./,
  );
  assert.doesNotMatch(html, /Everything is within your rules/);
});

test("Home: signed out is a welcome with one access panel and the promise", () => {
  const html = render({ session: "signed-out" }, <HomeView />);
  assert.match(html, /Permission to spend\./);
  assert.match(html, /Not control of your money\./);
  assert.match(html, /Demo access/);
  assert.doesNotMatch(html, /\$16|>Active</);
});

test("Home: empty and unavailable states are real states", () => {
  assert.match(
    render(mgmt({ authorities: [] }), <HomeView />),
    /No active Authorities yet\./,
  );
  assert.match(
    render(mgmt({ authorities: [] }), <HomeView />),
    /Give your AI clear spending boundaries\./,
  );
  const un = render(
    mgmt({ status: "UNAVAILABLE", authorities: [] }),
    <HomeView />,
  );
  assert.match(un, /We can&#x27;t reach your saved state right now/);
  assert.doesNotMatch(un, /Everything is within your rules/);
});

test("Home never repeats demo disclaimers; the environment is one badge", () => {
  const html = render(mgmt({ activity: [paid] }), <HomeView />);
  assert.doesNotMatch(
    html,
    /fixture|non-production|Non-production|not production/i,
  );
});

test("Authorities list: Frame first, plain wording, no accounting vocabulary", () => {
  const html = render(
    mgmt({ authorities: [authority, revoked] }),
    <AuthoritiesBody params={q("")} />,
  );
  for (const t of [
    "Keyboard purchase",
    "$16",
    "left",
    "of $100 total budget",
    "$84 used",
    "Shopping Agent",
    "Revoked",
    "Headphones",
  ])
    assert.ok(html.includes(t), t);
  assert.match(
    html,
    /Can&#x27;t start new purchases\. Completed payments are not reversed\./,
  );
  assert.doesNotMatch(html, TECH);
  assert.doesNotMatch(
    html,
    /Committed|Currently reserved|Human approval threshold/,
  );
});

test("Authority detail: boundaries answer the ten customer questions and offer one control", () => {
  const html = render(
    {},
    <AuthoritiesBody params={q("id=" + authority.mandateId)} />,
  );
  for (const t of [
    "Keyboard purchase",
    "Shopping Agent",
    "$16",
    "1 item remaining",
    "new only",
    "Approved merchants only",
    "Can spend without asking up to $100",
    "7 days remaining",
    "Revoke Authority",
    "View proof",
  ])
    assert.ok(html.includes(t), t);
  assert.doesNotMatch(html, TECH);
});

test("revoke sheet states the exact consequence and offers a safe cancel", () => {
  const html = render(
    mgmt({ status: "CONFIRM_REVOKE", selected: authority.mandateId }),
    <AuthoritiesBody params={q("id=" + authority.mandateId)} />,
  );
  assert.match(html, /Revoke this Authority\?/);
  assert.match(html, /won&#x27;t be able to start new purchases under it/);
  assert.match(html, /Completed payments are not reversed\./);
  assert.match(html, /Keep Authority/);
});

for (const status of ["REVOKING", "VERIFYING"] as const)
  test(`${status} never claims Revoked before a fresh read confirms it`, () => {
    const html = render(
      mgmt({ status, selected: authority.mandateId }),
      <AuthoritiesBody params={q("id=" + authority.mandateId)} />,
    );
    assert.match(html, />Active</);
    assert.doesNotMatch(html, />Revoked</);
  });

test("a failed revoke shows calm copy, not the controller's maintenance wording", () => {
  const html = render(
    mgmt({
      error:
        "Revocation could not be confirmed. The prior view is retained; refresh to check current saved state.",
    }),
    <AuthoritiesBody params={q("")} />,
  );
  assert.match(
    html,
    /We couldn&#x27;t confirm that change\. Showing the last confirmed state\./,
  );
  assert.doesNotMatch(html, /refresh/i);
});

test("paused agent is readable without inventing a pause control", () => {
  const html = render(
    mgmt({
      authorities: [
        {
          ...authority,
          state: "UNAVAILABLE",
          agent: { ...authority.agent, status: "SUSPENDED" },
          freshDispatchBlocked: true,
        },
      ],
    }),
    <AuthoritiesBody params={q("")} />,
  );
  assert.match(html, /Paused/);
  assert.match(html, /The Agent is paused\. Can&#x27;t start new purchases\./);
  assert.doesNotMatch(html, /Suspend/);
});

test("Activity journal leads each row with the money line", () => {
  const html = render(
    mgmt({ activity: [paid, blocked, unknown] }),
    <ActivityBody params={q("")} />,
  );
  const order = ["$84 paid once", "$0 moved", "Checking what happened"].map(
    (t) => html.indexOf(t),
  );
  assert.ok(order.every((i) => i >= 0));
  assert.doesNotMatch(html, TECH);
  assert.doesNotMatch(html, /VERIFIED|INCOMPLETE|UNKNOWN_/);
});

test("Activity empty state is honest", () => {
  assert.match(
    render(mgmt({ activity: [] }), <ActivityBody params={q("")} />),
    /No financial activity yet\./,
  );
});

test("Activity detail: Outcome, Explanation, and a single path to Proof", () => {
  const html = render(
    mgmt({ activity: [blocked] }),
    <ActivityBody params={q("id=" + blocked.operationId)} />,
  );
  assert.match(html, /\$0 moved/);
  assert.match(html, /Stopped here/);
  assert.match(html, /Not started/);
  assert.match(html, /The request exceeded the maximum amount/);
  assert.match(html, /View proof/);
  assert.doesNotMatch(html, TECH);
  assert.equal(
    (html.match(/<details/g) ?? []).length,
    0,
    "no nested disclosure",
  );
});

test("Proof is a deliberate mode with identifiers, stages, and exact UTC", () => {
  const html = render(
    mgmt({ activity: [blocked] }),
    <ActivityBody params={q("id=" + blocked.operationId + "&proof=1")} />,
  );
  for (const t of [
    "Proof",
    "op_101",
    "auth_7f3a9c21",
    "agent_shop_01",
    "AMOUNT_EXCEEDS_LIMIT",
    "NO_PROVIDER_CALL",
    "2026-10-23T19:36:00.000Z",
    "Back to this activity",
  ])
    assert.ok(html.includes(t), t);
  assert.equal((html.match(/<details/g) ?? []).length, 0);
});

test("Authority proof exposes terms in minor units and states they never authorize payment", () => {
  const html = render(
    {},
    <AuthoritiesBody params={q("id=" + authority.mandateId + "&proof=1")} />,
  );
  assert.match(html, /single maximum/);
  assert.match(html, /10000 USD/);
  assert.match(html, /never authorize a payment/);
});

test("untrusted text is escaped everywhere it is displayed", () => {
  const evil = {
    ...blocked,
    label: "<script>x</script>",
    explanation: "<img src=x onerror=alert(1)>",
    item: "<b>k</b>",
    agentName: "<i>a</i>",
  };
  const html = render(
    mgmt({ activity: [evil] }),
    <ActivityBody params={q("id=" + evil.operationId)} />,
  );
  assert.doesNotMatch(html, /<script>|<img |<b>k|<i>a/);
  assert.match(html, /&lt;img/);
});

test("unknown identifiers fail closed with a way back", () => {
  assert.match(
    render({}, <ActivityBody params={q("id=nope")} />),
    /We couldn&#x27;t find that activity/,
  );
  assert.match(
    render({}, <AuthoritiesBody params={q("id=nope")} />),
    /We couldn&#x27;t find that Authority/,
  );
});
