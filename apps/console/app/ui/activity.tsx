import Link from "next/link";
import type { ActivityView } from "../../lib/management-client.mjs";
import {
  activityOutcome,
  traceSteps,
  verificationSummary,
  type OutcomeKind,
} from "../../lib/language";
import { formatMoney, humanWhen } from "../../lib/present";
import { GateGlyph, type GlyphKind } from "./glyph";

const glyphFor = (k: OutcomeKind, status: string): GlyphKind =>
  k === "paid"
    ? "paid"
    : k === "blocked"
      ? status === "FAILED"
        ? "failed"
        : "blocked"
      : "unresolved";

export function ActivityRow({
  x,
  now,
  href,
}: {
  x: ActivityView;
  now: Date;
  href: string;
}) {
  const o = activityOutcome(x);
  const sub = [x.item, x.agentName, humanWhen(x.occurredAt, now)]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className={`journal__row journal__row--${o.kind}`}>
      <Link href={href} className="journal__link">
        <GateGlyph kind={glyphFor(o.kind, x.status)} />
        <span className="journal__body">
          <span className="journal__money">{o.headline}</span>
          <span className="journal__sub">{sub}</span>
          {o.kind !== "paid" && (
            <span className="journal__why">{o.detail}</span>
          )}
        </span>
        <span className="journal__word">{o.word}</span>
      </Link>
    </li>
  );
}

/** Layer 1 for a single operation: the money line, large, with its state word. */
export function OutcomeHero({ x }: { x: ActivityView }) {
  const o = activityOutcome(x);
  return (
    <header className={`outcome outcome--${o.kind}`}>
      <GateGlyph kind={glyphFor(o.kind, x.status)} size={44} />
      <div>
        <p className="outcome__state">{o.word}</p>
        <h1 className="money money--hero">{o.headline}</h1>
        {x.amountMinor !== null && o.kind !== "paid" && (
          <p className="sub">
            Requested {formatMoney(x.amountMinor, x.currency ?? "USD")}
            {x.item ? ` · ${x.item}` : ""}
          </p>
        )}
      </div>
    </header>
  );
}

/** Frame → Gate → Trace. The Trace never shows success before durable evidence says so. */
export function FlowTrace({ x }: { x: ActivityView }) {
  const steps = traceSteps(x);
  const o = activityOutcome(x);
  return (
    <ol className={`trace trace--${o.kind}`} aria-label="How this was decided">
      {steps.map((s) => (
        <li key={s.id} className={`trace__step trace__step--${s.state}`}>
          <i className="trace__node" aria-hidden="true" />
          <span className="trace__label">{s.label}</span>
          <span className="trace__word">{s.word}</span>
        </li>
      ))}
    </ol>
  );
}

export function VerificationLine({ x }: { x: ActivityView }) {
  return <p className="note">{verificationSummary(x.verification)}</p>;
}
