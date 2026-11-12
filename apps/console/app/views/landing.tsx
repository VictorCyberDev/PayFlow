import Link from "next/link";
import {
  EvidenceChip,
  FlowObject,
  FlowShell,
  type EvidenceClass,
} from "../ui/flow";

const GOALS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Find my first ten customers", href: "/partner/?goal=" },
  { label: "Kit out a two-person studio", href: "/explore/?q=" },
  { label: "Get paid for work I've delivered", href: "/partner/?goal=" },
  { label: "Plan a trip around one meeting", href: "/partner/?goal=" },
];

/**
 * What a visitor can actually do today, stated plainly. This section is the opposite of a feature grid: it is the honest
 * inventory the mandate demands (§23.3, §34), written so a founder can tell a working capability from a planned one
 * without reading a changelog.
 */
const TRUTH: ReadonlyArray<{
  what: string;
  detail: string;
  kind: EvidenceClass | "PLANNED";
}> = [
  {
    what: "Turn a goal into a plan",
    detail:
      "Describe the goal in your own words. A language model drafts the workstreams; PayFlow's own code re-does every sum, so a total you read is one it worked out rather than one it was handed.",
    kind: "MODEL_PROPOSED",
  },
  {
    what: "Keep money decisions yours",
    detail:
      "Every step that would spend money is marked as needing your approval — by PayFlow's own code, never by the model that wrote the plan.",
    kind: "MODEL_PROPOSED",
  },
  {
    what: "Search real products and compare sellers",
    detail:
      "A real catalogue, searched when you ask. PayFlow shows what each seller listed, in that seller's currency, and says plainly that delivery and tax are not in the number.",
    kind: "PROVIDER_OBSERVED",
  },
  {
    what: "Walk a whole founder journey",
    detail:
      "The guided demo runs a six-week studio launch end to end: plan, options, a decision, an approval and a receipt. Every screen is labelled as a simulation.",
    kind: "SIMULATED",
  },
  {
    what: "Buy, book, hire and pay for real",
    detail:
      "The payment engine, spending limits and reconciliation are built and tested, but they run on an isolated payment host and are deliberately not wired to this public site.",
    kind: "PLANNED",
  },
];

export default function Landing() {
  return (
    <FlowShell>
      <section className="wrap flow__hero">
        <div className="stack">
          <p className="eyebrow">Your AI business partner</p>
          <h1>
            Make it
            <br />
            happen.
          </h1>
          <p className="lede">
            Tell PayFlow what you need done. It works out the plan, finds the
            options, explains the trade-offs — and brings you the decisions that
            are yours to make.
          </p>
          <form className="stack" action="/partner/" method="get">
            <div className="field">
              <label htmlFor="goal">What do you want to get done?</label>
              <textarea
                id="goal"
                name="goal"
                rows={3}
                maxLength={1200}
                placeholder="I'm launching a creative studio in six weeks. I need clients, two designers and equipment. My budget is $5,000."
              />
            </div>
            <div className="actions">
              <button className="btn" type="submit">
                Make it happen
              </button>
              <Link className="btn btn--ghost" href="/try/">
                Try the guided demo
              </Link>
            </div>
          </form>
          <p className="quiet-note">
            No account, no sign-up, no API key. PayFlow writes a plan — it does
            not buy, book, hire, send or pay anything.
          </p>
        </div>
        <FlowObject state="ready" title="PayFlow is ready" />
      </section>

      <section className="band" aria-labelledby="goals">
        <div className="wrap stack">
          <h2 id="goals">Start with the goal you actually have</h2>
          <p className="lede">
            These are the things founders ask for first. Pick one and PayFlow
            will take it from there.
          </p>
          <div className="grid grid--2" style={{ width: "100%" }}>
            {GOALS.map((goal) => (
              <Link
                className="card"
                key={goal.label}
                href={`${goal.href}${encodeURIComponent(goal.label)}`}
              >
                <h3>{goal.label}</h3>
                <span className="card__go">
                  {goal.href.startsWith("/explore")
                    ? "Search real products →"
                    : "Ask PayFlow →"}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="band" aria-labelledby="how">
        <div className="wrap stack">
          <h2 id="how">How your partner works</h2>
          <ol className="steps" style={{ maxWidth: "44em" }}>
            <li>
              <div>
                <strong>You say what you need</strong>
                <span>
                  In plain words. A sentence is enough to start, and PayFlow
                  asks only the questions whose answers would change the plan.
                </span>
              </div>
            </li>
            <li>
              <div>
                <strong>PayFlow does the work</strong>
                <span>
                  It breaks the goal into workstreams, works out what each one
                  costs, researches the options and explains why it recommends
                  what it recommends.
                </span>
              </div>
            </li>
            <li>
              <div>
                <strong>You make the decisions that matter</strong>
                <span>
                  Anything that spends money, signs something or contacts
                  somebody comes back to you first, with the cost, the
                  counterparty and what approving it allows.
                </span>
              </div>
            </li>
            <li>
              <div>
                <strong>You see what really happened</strong>
                <span>
                  Not a tick that says “done”. The actual result, the receipt,
                  and an honest “we could not confirm this” when that is the
                  truth.
                </span>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section className="band" aria-labelledby="control">
        <div className="wrap flow__hero">
          <div className="stack">
            <p className="eyebrow">Control</p>
            <h2 id="control">
              It stops at the decision.
              <br />
              Every time.
            </h2>
            <p className="lede">
              PayFlow can prepare an entire purchase — the product, the seller,
              the total cost including delivery — and still not spend a penny.
              The last step is always yours, and the permission it asks for is
              for that exact action, that amount, that seller, and nothing else.
            </p>
            <Link className="btn btn--ghost" href="/try/">
              See a decision in the demo
            </Link>
          </div>
          <FlowObject state="deciding" />
        </div>
      </section>

      <section className="band" aria-labelledby="truth">
        <div className="wrap stack">
          <h2 id="truth">What is real here today</h2>
          <p className="lede">
            Most products this ambitious show you a film. This is the actual
            state of the build, labelled the way PayFlow labels everything.
          </p>
          <div className="grid grid--2" style={{ width: "100%" }}>
            {TRUTH.map((row) => (
              <article className="card" key={row.what}>
                {row.kind === "PLANNED" ? (
                  <span className="chip">Not on this site</span>
                ) : (
                  <EvidenceChip kind={row.kind} />
                )}
                <h3>{row.what}</h3>
                <p>{row.detail}</p>
              </article>
            ))}
          </div>
          <p className="quiet-note">
            PayFlow never shows a simulated result as a real one, and never
            calls a prepared action a completed one. If a provider is not
            switched on for this deployment, the page tells you so instead of
            showing you a canned answer.
          </p>
        </div>
      </section>

      <section className="band" aria-labelledby="start">
        <div className="wrap stack">
          <h2 id="start">Tell PayFlow what you need.</h2>
          <div className="actions">
            <Link className="btn" href="/partner/">
              Make it happen
            </Link>
            <Link className="btn btn--ghost" href="/try/">
              Try the guided demo
            </Link>
          </div>
        </div>
      </section>
    </FlowShell>
  );
}
