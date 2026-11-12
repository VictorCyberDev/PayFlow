import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import Landing from "../app/views/landing";
import { Demo } from "../app/ui/demo";
import { FlowObject, flowStateLabel, type FlowState } from "../app/ui/flow";
import { readPlan } from "../app/ui/partner";

const home = () => renderToStaticMarkup(<Landing />);
const demo = () => renderToStaticMarkup(<Demo />);
const text = (html: string) => html.replace(/<[^>]*>/g, " ");

test("the homepage sells the product, not the protocol", () => {
  const html = home();
  assert.match(html, /Make it<br\/>happen\.|Make it\s*<br\s*\/?>\s*happen\./);
  assert.match(text(html), /Your AI business partner/);
  assert.match(html, /href="\/try\/?"/);
  assert.match(html, /href="\/partner\/?(\?|")/);
});

test("no founder meets infrastructure vocabulary on the way in", () => {
  // The words that made the old homepage unreadable to a non-engineer. They may still exist deeper in the product.
  for (const jargon of [
    "Authority",
    "Gateway",
    "MCP",
    "A2A",
    "SDK",
    "bootstrap",
    "access code",
    "tenant",
    "Trust Kernel",
    "execution boundary",
  ])
    assert.doesNotMatch(
      text(home()),
      new RegExp(jargon, "i"),
      `homepage still says "${jargon}"`,
    );
});

test("the homepage states what is real and what is not, and never overstates it", () => {
  const html = home();
  assert.match(html, /chip chip--simulated/);
  assert.match(html, /chip chip--proposed/);
  assert.match(text(html), /never shows a simulated result as a real one/i);
  // A capability that is not on this site must not be presented as one that is.
  assert.match(text(html), /Not on this site/);
});

test("the demo says it is a simulation before it says anything else", () => {
  const html = demo();
  assert.match(html, /chip chip--simulated/);
  assert.match(text(html), /Everything on this page is made up/);
  assert.match(text(html), /No provider was called, no money moved/);
  assert.match(text(html), /Nothing here leaves your browser/);
});

test("the demo needs no account, code or key to start", () => {
  const html = demo();
  assert.doesNotMatch(text(html), /sign in|sign up|access code|api key/i);
  assert.match(text(html), /Hand it to PayFlow/);
});

test("every Flow state is legible from its label alone", () => {
  const states: FlowState[] = [
    "ready",
    "listening",
    "planning",
    "searching",
    "comparing",
    "negotiating",
    "deciding",
    "executing",
    "confirmed",
    "paused",
    "unverified",
  ];
  const seen = new Set<string>();
  for (const s of states) {
    const label = flowStateLabel(s);
    assert.ok(label.length > 2, s);
    assert.ok(!seen.has(label), `two states share the label "${label}"`);
    seen.add(label);
    // The state reaches assistive technology as words, not as an animation.
    assert.match(
      renderToStaticMarkup(<FlowObject state={s} />),
      new RegExp(`aria-label="PayFlow: ${label}"`),
    );
  }
  // The two states a founder must never misread are distinct from every other.
  assert.equal(flowStateLabel("deciding"), "Waiting for your decision");
  assert.equal(flowStateLabel("unverified"), "Not able to confirm this yet");
});

test("the browser refuses a plan that does not carry authorization NONE", () => {
  const valid = {
    understanding: "ok",
    clarifyingQuestions: [],
    workstreams: [
      {
        name: "n",
        outcome: "o",
        firstStep: "f",
        estimatedCostMinor: 1,
        movesMoney: true,
        requiresApproval: true,
      },
    ],
    nextAction: "a",
    currency: "USD",
    estimatedTotalMinor: 1,
    unestimatedWorkstreams: 0,
    budgetMinor: null,
    withinBudget: null,
    authorization: "NONE",
  };
  assert.ok(readPlan(valid));
  // A reply claiming its own approval is not rendered at all.
  assert.equal(readPlan({ ...valid, authorization: "GRANTED" }), null);
  assert.equal(readPlan({ ...valid, workstreams: [] }), null);
  assert.equal(readPlan(null), null);
  assert.equal(readPlan("a string"), null);
});
