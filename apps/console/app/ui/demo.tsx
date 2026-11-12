"use client";
import Link from "next/link";
import { useState } from "react";
import { FlowObject, type FlowState } from "./flow";

/**
 * The one-click judge demo (§8).
 *
 * Everything on this route is a fixture. It makes no network request, reads no customer record, touches no provider and moves
 * no money, and every screen says so. It is deterministic: the same clicks always produce the same journey, so it can be shown
 * twice in a row without surprises.
 *
 * It exists to make one thing legible in two minutes: PayFlow prepares the whole of a consequential action and then stops,
 * because the last step belongs to the founder. So the journey deliberately includes a refusal and an unconfirmed outcome,
 * not only a success.
 */

type Step =
  | "goal"
  | "question"
  | "plan"
  | "options"
  | "approval"
  | "result"
  | "refusal"
  | "unknown";

const ORDER: readonly Step[] = [
  "goal",
  "question",
  "plan",
  "options",
  "approval",
  "result",
  "refusal",
  "unknown",
];

const GOAL =
  "I'm launching a creative studio in six weeks. I need clients, two designers and equipment. My budget is $5,000.";

const PLAN = [
  {
    name: "Find first clients",
    outcome: "Three qualified conversations booked.",
    cost: null,
    needsYou: false,
  },
  {
    name: "Two editing workstations",
    outcome: "Delivered and set up before week four.",
    cost: 248000,
    needsYou: true,
  },
  {
    name: "Hire a motion designer",
    outcome: "One designer contracted for the launch film.",
    cost: 150000,
    needsYou: true,
  },
  {
    name: "Invoice the pilot client",
    outcome: "$500 invoice sent and tracked to payment.",
    cost: null,
    needsYou: true,
  },
] as const;

type Option = {
  id: string;
  name: string;
  seller: string;
  price: number;
  delivery: number;
  tax: number;
  note: string;
  verdict: string;
};
const OPTIONS: readonly Option[] = [
  {
    id: "a",
    name: "27-inch 4K studio display, pair",
    seller: "Northfield Supply",
    price: 219000,
    delivery: 0,
    tax: 29000,
    note: "Delivers in 4 days. 30-day returns.",
    verdict: "Best overall",
  },
  {
    id: "b",
    name: "27-inch 4K display, refurbished pair",
    seller: "Loop Returns Market",
    price: 158000,
    delivery: 4500,
    tax: 21000,
    note: "Delivers in 9 days. 14-day returns, no warranty.",
    verdict: "Best value",
  },
  {
    id: "c",
    name: "32-inch reference display, single",
    seller: "Northfield Supply",
    price: 268000,
    delivery: 0,
    tax: 35000,
    note: "One screen, not two. Delivers in 4 days.",
    verdict: "Best alternative",
  },
];

function usd(minor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(minor / 100);
}
const total = (o: Option) => o.price + o.delivery + o.tax;

const STATE_FOR: Readonly<Record<Step, FlowState>> = Object.freeze({
  goal: "ready",
  question: "listening",
  plan: "planning",
  options: "comparing",
  approval: "deciding",
  result: "confirmed",
  refusal: "paused",
  unknown: "unverified",
});

export function Demo() {
  const [step, setStep] = useState<Step>("goal");
  const [chosen, setChosen] = useState<Option>(OPTIONS[0]!);
  const [answer, setAnswer] = useState("");
  const index = ORDER.indexOf(step);

  const go = (next: Step) => {
    setStep(next);
    if (typeof document !== "undefined")
      document.getElementById("demo-stage")?.focus();
  };
  const reset = () => {
    setStep("goal");
    setChosen(OPTIONS[0]!);
    setAnswer("");
  };

  return (
    <>
      <section className="wrap flow__hero flow__hero--demo">
        <div className="stack">
          <span className="chip chip--simulated">Simulated</span>
          <h1>See PayFlow work.</h1>
          <p className="lede">
            A two-minute walk through one founder's six weeks: the plan, the
            options, the decision that stops at you, and what happens when the
            answer is no — or when nobody can honestly say yet.
          </p>
          <p className="quiet-note">
            Step {index + 1} of {ORDER.length}. Nothing here leaves your
            browser.
          </p>
        </div>
        <FlowObject state={STATE_FOR[step]} />
      </section>

      <div className="wrap band">
        <div
          className="banner banner--sim"
          role="note"
          style={{ marginBottom: 24 }}
        >
          <span aria-hidden="true">●</span>
          <p>
            <strong>Everything on this page is made up.</strong> The products,
            sellers, prices, candidate and receipt are fixtures written for this
            demonstration. No provider was called, no money moved, and no real
            order, booking or payment exists.
          </p>
        </div>

        <section
          id="demo-stage"
          tabIndex={-1}
          aria-live="polite"
          className="stack"
          style={{ width: "100%" }}
        >
          {step === "goal" && (
            <>
              <p className="eyebrow">The founder says</p>
              <h2>&ldquo;{GOAL}&rdquo;</h2>
              <p className="lede">
                No form, no categories, no setup. PayFlow starts from the
                sentence.
              </p>
              <div className="actions">
                <button className="btn" onClick={() => go("question")}>
                  Hand it to PayFlow
                </button>
              </div>
            </>
          )}

          {step === "question" && (
            <>
              <p className="eyebrow">PayFlow asks</p>
              <h2>Where should equipment be delivered?</h2>
              <p className="lede">
                One question, and only because the answer changes the plan:
                delivery time and tax both depend on it. PayFlow does not ask
                anything it can work out for itself.
              </p>
              <div className="field" style={{ maxWidth: "26rem" }}>
                <label htmlFor="demo-city">Delivery city</label>
                <input
                  id="demo-city"
                  type="text"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Lagos"
                />
              </div>
              <div className="actions">
                <button className="btn" onClick={() => go("plan")}>
                  Answer and continue
                </button>
                <button className="btn btn--ghost" onClick={() => go("plan")}>
                  Skip — I don't know yet
                </button>
              </div>
            </>
          )}

          {step === "plan" && (
            <>
              <p className="eyebrow">The plan</p>
              <h2>Four workstreams, $5,000 budget</h2>
              <div className="grid grid--2" style={{ width: "100%" }}>
                {PLAN.map((w) => (
                  <article
                    className={w.needsYou ? "card card--decision" : "card"}
                    key={w.name}
                  >
                    <span
                      className={w.needsYou ? "chip chip--decision" : "chip"}
                    >
                      {w.needsYou ? "Needs you" : "PayFlow can start"}
                    </span>
                    <h3>{w.name}</h3>
                    <p>{w.outcome}</p>
                    <p className="mono">
                      {w.cost === null ? "No cost estimated" : usd(w.cost)}
                    </p>
                  </article>
                ))}
              </div>
              <p className="quiet-note">
                Three of the four would spend money or contact someone, so three
                of the four come back to the founder. PayFlow starts the client
                research on its own.
              </p>
              <div className="actions">
                <button className="btn" onClick={() => go("options")}>
                  Show me the equipment options
                </button>
              </div>
            </>
          )}

          {step === "options" && (
            <>
              <p className="eyebrow">Comparing</p>
              <h2>Three ways to get two screens</h2>
              <p className="lede">
                Every price below is the <strong>total</strong> cost — hardware,
                delivery and tax — because a cheaper sticker with shipping added
                at checkout is not cheaper.
              </p>
              <div className="grid grid--3" style={{ width: "100%" }}>
                {OPTIONS.map((o) => (
                  <article
                    className={chosen.id === o.id ? "card card--done" : "card"}
                    key={o.id}
                  >
                    <span className="chip chip--simulated">{o.verdict}</span>
                    <h3>{o.name}</h3>
                    <p>{o.seller}</p>
                    <dl className="ledger" style={{ width: "100%" }}>
                      <div className="ledger__row">
                        <dt>Hardware</dt>
                        <dd>{usd(o.price)}</dd>
                      </div>
                      <div className="ledger__row">
                        <dt>Delivery</dt>
                        <dd>{o.delivery === 0 ? "Free" : usd(o.delivery)}</dd>
                      </div>
                      <div className="ledger__row">
                        <dt>Tax (estimated)</dt>
                        <dd>{usd(o.tax)}</dd>
                      </div>
                      <div className="ledger__row ledger__row--total">
                        <dt>Total</dt>
                        <dd>{usd(total(o))}</dd>
                      </div>
                    </dl>
                    <p>{o.note}</p>
                    <button
                      className="btn btn--small btn--ghost"
                      onClick={() => setChosen(o)}
                      aria-pressed={chosen.id === o.id}
                    >
                      {chosen.id === o.id ? "Selected" : "Choose this"}
                    </button>
                  </article>
                ))}
              </div>
              <p className="quiet-note">
                Tax is marked estimated because it is. PayFlow does not present
                a guess as a confirmed charge.
              </p>
              <div className="actions">
                <button className="btn" onClick={() => go("approval")}>
                  Prepare the purchase
                </button>
              </div>
            </>
          )}

          {step === "approval" && (
            <>
              <p className="eyebrow">Your decision</p>
              <h2>Approve this purchase?</h2>
              <div
                className="card card--decision"
                style={{ maxWidth: "44rem" }}
              >
                <span className="chip chip--decision">Needs you</span>
                <h3>{chosen.name}</h3>
                <dl className="ledger" style={{ width: "100%" }}>
                  <div className="ledger__row">
                    <dt>Seller</dt>
                    <dd>{chosen.seller}</dd>
                  </div>
                  <div className="ledger__row">
                    <dt>Why this one</dt>
                    <dd>{chosen.verdict}</dd>
                  </div>
                  <div className="ledger__row">
                    <dt>Delivery and returns</dt>
                    <dd style={{ fontWeight: 400 }}>{chosen.note}</dd>
                  </div>
                  <div className="ledger__row ledger__row--total">
                    <dt>Total charge</dt>
                    <dd>{usd(total(chosen))}</dd>
                  </div>
                </dl>
                <p>
                  <strong>Approving this allows exactly one thing:</strong> one
                  payment of {usd(total(chosen))} to {chosen.seller} for this
                  order. Not a second attempt, not a different seller, not a
                  larger amount, and not another purchase later.
                </p>
                <p>
                  <strong>What happens next:</strong> PayFlow submits the order,
                  waits for the seller to confirm, and shows you the receipt. If
                  it cannot confirm, it will say so rather than guess.
                </p>
                <div className="actions">
                  <button className="btn" onClick={() => go("result")}>
                    Approve {usd(total(chosen))}
                  </button>
                  <button
                    className="btn btn--ghost"
                    onClick={() => go("options")}
                  >
                    Show me other options
                  </button>
                </div>
              </div>
            </>
          )}

          {step === "result" && (
            <>
              <p className="eyebrow">The outcome</p>
              <h2>Confirmed, and here is the proof</h2>
              <dl className="ledger" style={{ maxWidth: "44rem" }}>
                <div className="ledger__row">
                  <dt>Prepared</dt>
                  <dd>Order built and checked</dd>
                </div>
                <div className="ledger__row">
                  <dt>Approved by you</dt>
                  <dd>{usd(total(chosen))}</dd>
                </div>
                <div className="ledger__row">
                  <dt>Submitted</dt>
                  <dd>Sent to {chosen.seller}</dd>
                </div>
                <div className="ledger__row">
                  <dt>Seller confirmed</dt>
                  <dd>Order accepted</dd>
                </div>
                <div className="ledger__row ledger__row--total">
                  <dt>Completed</dt>
                  <dd>{usd(total(chosen))} charged once</dd>
                </div>
              </dl>
              <p className="quiet-note">
                Five states, not one tick. &ldquo;Approved&rdquo; and
                &ldquo;paid&rdquo; are different facts, and PayFlow never
                collapses them — which is what makes the last line worth
                believing.
              </p>
              <div className="actions">
                <button className="btn" onClick={() => go("refusal")}>
                  Now show me what PayFlow refuses
                </button>
              </div>
            </>
          )}

          {step === "refusal" && (
            <>
              <p className="eyebrow">A week later</p>
              <h2>PayFlow stopped itself</h2>
              <div
                className="card card--decision"
                style={{ maxWidth: "44rem" }}
              >
                <span className="chip chip--decision">Not done</span>
                <h3>Second pair of screens — $2,480</h3>
                <p>
                  The founder asked PayFlow to repeat the order for a new hire.
                  It did not.
                </p>
                <p>
                  <strong>Why:</strong> the approval covered one payment of{" "}
                  {usd(total(chosen))} to {chosen.seller} for that order.
                  Nothing in it covers a second one, and PayFlow cannot widen
                  its own permission — only the founder can give it.
                </p>
                <p>
                  <strong>What this cost:</strong> nothing. No charge, no order,
                  no half-finished state to unpick.
                </p>
              </div>
              <p className="quiet-note">
                This is the part that cannot be faked by a convincing demo.
                Every refusal is recorded with the same care as every success.
              </p>
              <div className="actions">
                <button className="btn" onClick={() => go("unknown")}>
                  And when nobody knows the answer?
                </button>
              </div>
            </>
          )}

          {step === "unknown" && (
            <>
              <p className="eyebrow">The honest case</p>
              <h2>&ldquo;We could not confirm this.&rdquo;</h2>
              <div className="card" style={{ maxWidth: "44rem" }}>
                <span className="chip">Unconfirmed</span>
                <h3>Designer's first milestone — $1,500</h3>
                <p>
                  PayFlow submitted the payment and the connection dropped
                  before an answer came back. It does not know whether the money
                  moved.
                </p>
                <p>
                  <strong>So it says that.</strong> It does not retry, because a
                  retry could pay twice. It does not show a tick, because a tick
                  would be a lie. It keeps asking the provider until there is a
                  real answer, and tells the founder the moment there is one.
                </p>
              </div>
              <p className="quiet-note">
                Most software rounds this state to &ldquo;success&rdquo; or
                &ldquo;failed&rdquo;. Rounding it is how people get charged
                twice.
              </p>
              <div className="actions">
                <button className="btn" onClick={reset}>
                  Start the demo again
                </button>
                <Link className="btn btn--ghost" href="/partner/">
                  Try it with your own goal
                </Link>
              </div>
            </>
          )}
        </section>

        <p className="quiet-note" style={{ marginTop: 32 }}>
          <button
            className="btn btn--small btn--ghost"
            onClick={reset}
            type="button"
          >
            Reset demo
          </button>
        </p>
      </div>
    </>
  );
}
