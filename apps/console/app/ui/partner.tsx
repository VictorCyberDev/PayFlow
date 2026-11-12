"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EvidenceChip, FlowObject, type FlowState } from "./flow";

/** Mirrors the governed plan the endpoint returns. Nothing here is trusted to be well-formed; every field is checked. */
type Workstream = {
  name: string;
  outcome: string;
  firstStep: string;
  estimatedCostMinor: number | null;
  movesMoney: boolean;
  requiresApproval: boolean;
};
type Plan = {
  understanding: string;
  clarifyingQuestions: string[];
  workstreams: Workstream[];
  nextAction: string;
  currency: string;
  estimatedTotalMinor: number;
  unestimatedWorkstreams: number;
  budgetMinor: number | null;
  withinBudget: boolean | null;
  authorization: string;
};

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(0)} ${currency}`;
  }
}

/** A reply from the network is data, not truth. Anything that does not match the shape is treated as no plan at all. Exported for tests. */
export function readPlan(value: unknown): Plan | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (
    typeof p.understanding !== "string" ||
    typeof p.nextAction !== "string" ||
    typeof p.currency !== "string" ||
    typeof p.estimatedTotalMinor !== "number" ||
    p.authorization !== "NONE" ||
    !Array.isArray(p.workstreams) ||
    !Array.isArray(p.clarifyingQuestions)
  )
    return null;
  const workstreams = p.workstreams.filter(
    (w): w is Workstream =>
      !!w &&
      typeof w === "object" &&
      typeof (w as Workstream).name === "string" &&
      typeof (w as Workstream).outcome === "string" &&
      typeof (w as Workstream).firstStep === "string" &&
      typeof (w as Workstream).requiresApproval === "boolean",
  );
  if (workstreams.length === 0) return null;
  return {
    understanding: p.understanding,
    clarifyingQuestions: p.clarifyingQuestions.filter(
      (q): q is string => typeof q === "string",
    ),
    workstreams,
    nextAction: p.nextAction,
    currency: p.currency,
    estimatedTotalMinor: p.estimatedTotalMinor,
    unestimatedWorkstreams:
      typeof p.unestimatedWorkstreams === "number"
        ? p.unestimatedWorkstreams
        : 0,
    budgetMinor: typeof p.budgetMinor === "number" ? p.budgetMinor : null,
    withinBudget: typeof p.withinBudget === "boolean" ? p.withinBudget : null,
    authorization: "NONE",
  };
}

type Phase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "planned"; plan: Plan }
  | { kind: "unavailable"; message: string }
  | { kind: "needs-more" };

const FALLBACK =
  "PayFlow could not reach the planning assistant. Nothing was started. You can still walk the whole journey in the guided demo.";

export function Partner() {
  const params = useSearchParams();
  const initial = (params?.get("goal") ?? "").slice(0, 1200);
  const [goal, setGoal] = useState(initial);
  const [budget, setBudget] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  const state: FlowState =
    phase.kind === "working"
      ? "planning"
      : phase.kind === "planned"
        ? phase.plan.workstreams.some((w) => w.requiresApproval)
          ? "deciding"
          : "confirmed"
        : phase.kind === "unavailable"
          ? "unverified"
          : "ready";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (goal.trim().length < 8) {
      setPhase({ kind: "needs-more" });
      document.getElementById("p-goal")?.focus();
      return;
    }
    setPhase({ kind: "working" });
    const minor = Math.round(Number(budget) * 100);
    try {
      const res = await fetch("/api/partner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: goal.trim(),
          currency,
          budgetMinor: Number.isSafeInteger(minor) && minor > 0 ? minor : null,
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!live.current) return;
      const plan =
        body && typeof body === "object"
          ? readPlan((body as Record<string, unknown>).plan)
          : null;
      if (res.ok && plan) {
        setPhase({ kind: "planned", plan });
        return;
      }
      const message =
        body &&
        typeof body === "object" &&
        typeof (body as Record<string, unknown>).message === "string"
          ? ((body as Record<string, unknown>).message as string)
          : FALLBACK;
      setPhase({ kind: "unavailable", message });
    } catch {
      if (live.current) setPhase({ kind: "unavailable", message: FALLBACK });
    }
  }

  return (
    <>
      <section className="wrap flow__hero">
        <div className="stack">
          <p className="eyebrow">Your partner</p>
          <h1>What can I help you get done?</h1>
          <form className="stack" onSubmit={(e) => void submit(e)}>
            <div className="field">
              <label htmlFor="p-goal">Your goal, in your own words</label>
              <textarea
                id="p-goal"
                rows={4}
                maxLength={1200}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="I'm launching a creative studio in six weeks. I need clients, two designers and equipment."
              />
            </div>
            <div className="grid grid--2" style={{ width: "100%" }}>
              <div className="field">
                <label htmlFor="p-budget">Budget (optional)</label>
                <input
                  id="p-budget"
                  type="number"
                  min="0"
                  step="1"
                  inputMode="numeric"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="5000"
                />
              </div>
              <div className="field">
                <label htmlFor="p-currency">Currency</label>
                <select
                  id="p-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {["USD", "EUR", "GBP", "NGN", "CAD", "AUD"].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="actions">
              <button
                className="btn"
                type="submit"
                disabled={phase.kind === "working"}
              >
                {phase.kind === "working" ? "Working…" : "Make it happen"}
              </button>
              <Link className="btn btn--ghost" href="/try/">
                Guided demo
              </Link>
            </div>
          </form>
        </div>
        <FlowObject state={state} />
      </section>

      <div aria-live="polite" className="wrap">
        {phase.kind === "needs-more" && (
          <p className="lede" style={{ paddingTop: 24 }}>
            Tell PayFlow a little more about what you want to get done — a
            sentence is enough.
          </p>
        )}

        {phase.kind === "unavailable" && (
          <section className="band stack" aria-labelledby="unavail">
            <h2 id="unavail">PayFlow did not plan that one</h2>
            <p className="lede">{phase.message}</p>
            <Link className="btn" href="/try/">
              Walk the guided demo instead
            </Link>
          </section>
        )}

        {phase.kind === "planned" && (
          <section className="band stack" aria-labelledby="plan">
            <EvidenceChip kind="MODEL_PROPOSED" />
            <h2 id="plan">Here is what I understood</h2>
            <p className="lede">{phase.plan.understanding}</p>

            {phase.plan.clarifyingQuestions.length > 0 && (
              <>
                <h3>Before I go further</h3>
                <ul className="stack" style={{ paddingLeft: "1.1rem" }}>
                  {phase.plan.clarifyingQuestions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </>
            )}

            <h3>The plan</h3>
            <div className="grid grid--2" style={{ width: "100%" }}>
              {phase.plan.workstreams.map((w) => (
                <article
                  className={
                    w.requiresApproval ? "card card--decision" : "card"
                  }
                  key={w.name}
                >
                  {w.requiresApproval ? (
                    <span className="chip chip--decision">Needs you</span>
                  ) : (
                    <span className="chip">PayFlow can start</span>
                  )}
                  <h3>{w.name}</h3>
                  <p>{w.outcome}</p>
                  <p>
                    <strong>First step:</strong> {w.firstStep}
                  </p>
                  <p className="mono">
                    {w.estimatedCostMinor === null
                      ? "Cost not estimated"
                      : money(w.estimatedCostMinor, phase.plan.currency)}
                  </p>
                </article>
              ))}
            </div>

            <h3>What it adds up to</h3>
            <dl className="ledger" style={{ width: "100%" }}>
              <div className="ledger__row ledger__row--total">
                <dt>Estimated so far</dt>
                <dd>
                  {money(phase.plan.estimatedTotalMinor, phase.plan.currency)}
                </dd>
              </div>
              {phase.plan.unestimatedWorkstreams > 0 && (
                <div className="ledger__row">
                  <dt>Still without an estimate</dt>
                  <dd>
                    {phase.plan.unestimatedWorkstreams} of{" "}
                    {phase.plan.workstreams.length}
                  </dd>
                </div>
              )}
              {phase.plan.budgetMinor !== null && (
                <div className="ledger__row">
                  <dt>Your budget</dt>
                  <dd>
                    {money(phase.plan.budgetMinor, phase.plan.currency)}
                    {phase.plan.withinBudget === false ? " — over" : " — fits"}
                  </dd>
                </div>
              )}
            </dl>
            <p className="quiet-note">
              These are estimates, not quotes. PayFlow added them up itself
              rather than trusting the figure it was given.
            </p>

            <div className="banner">
              <span aria-hidden="true">●</span>
              <p>
                <strong>Nothing has been done.</strong> This is a plan. PayFlow
                has not bought, booked, hired, contacted or paid anyone, and the
                steps marked <em>Needs you</em> would come back to you first,
                with the cost and the counterparty, before anything happened.
              </p>
            </div>

            <h3>Recommended next action</h3>
            <p className="lede">{phase.plan.nextAction}</p>
          </section>
        )}
      </div>
    </>
  );
}
