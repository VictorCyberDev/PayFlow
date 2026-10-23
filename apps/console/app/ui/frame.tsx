import Link from "next/link";
import type { ReactNode } from "react";
import type { ManagedAuthority } from "../../lib/management-client.mjs";
import {
  agentCan,
  approvalLine,
  authorityConsequence,
  authorityKind,
  authorityWord,
  conditionLine,
} from "../../lib/language";
import { formatMoney, humanRemaining, humanWhen } from "../../lib/present";
import { GateGlyph } from "./glyph";

export function AgentIdentity({
  name,
  status,
  extra,
}: {
  name: string;
  status?: string;
  extra?: string;
}) {
  return (
    <span className="agent">
      <span className="agent__dot" aria-hidden="true" />
      <span>
        {name}
        {status === "SUSPENDED" ? " · Paused" : ""}
        {extra ? <span className="agent__extra"> · {extra}</span> : null}
      </span>
    </span>
  );
}

export function BoundarySummary({
  a,
  now,
  compact = false,
}: {
  a: ManagedAuthority;
  now: Date;
  compact?: boolean;
}) {
  const kind = authorityKind(a);
  const items = a.quantityRemaining;
  const rows: [string, ReactNode][] = [
    [
      "Agent",
      <AgentIdentity
        key="a"
        name={a.agent.displayName}
        status={a.agent.status}
      />,
    ],
    [
      "May buy",
      items === null
        ? `${conditionLine(a.allowedConditions)}, any quantity within budget`
        : `${items} ${items === 1 ? "item" : "items"} remaining · ${conditionLine(a.allowedConditions)}`,
    ],
    ["Where", a.merchantScopeSummary],
    ["Asking", approvalLine(a)],
    [
      kind === "active" ? "Until" : "Expired",
      kind === "active"
        ? `${humanWhen(a.expiresAt, now)} · ${humanRemaining(a.expiresAt, now)}`
        : humanWhen(a.expiresAt, now),
    ],
  ];
  const shown = compact
    ? rows.filter(([k]) => ["Agent", "Asking", "Until", "Expired"].includes(k))
    : rows;
  return (
    <dl className="boundary">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The Authority object: Frame = what may happen. Never a card, wallet or bank balance. */
export function AuthorityFrame({
  a,
  now,
  compact = false,
  sealed = false,
  headingLevel = 2,
  href,
  actions,
}: {
  a: ManagedAuthority;
  now: Date;
  compact?: boolean;
  sealed?: boolean;
  headingLevel?: 2 | 3;
  href?: string;
  actions?: ReactNode;
}) {
  const kind = authorityKind(a);
  const total = a.cumulativeLimitMinor ?? a.singleMaximumMinor;
  const used = a.committedMinor + a.reservedMinor;
  const share = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const H = headingLevel === 2 ? "h2" : "h3";
  const consequence = authorityConsequence[kind];
  return (
    <article
      className={`frame frame--${kind}${sealed ? " frame--sealed" : ""}`}
      aria-labelledby={"fr-" + a.mandateId}
    >
      <i className="frame__mark frame__mark--tl" aria-hidden="true" />
      <i className="frame__mark frame__mark--tr" aria-hidden="true" />
      <i className="frame__mark frame__mark--bl" aria-hidden="true" />
      <i className="frame__mark frame__mark--br" aria-hidden="true" />
      <i className="frame__gate" aria-hidden="true" />
      <header className="frame__head">
        <H id={"fr-" + a.mandateId} className="label">
          {href ? <Link href={href}>{a.purpose}</Link> : a.purpose}
        </H>
        <span className={`state-tag state-tag--${kind}`}>
          {kind === "revoked" && <GateGlyph kind="revoked" size={14} />}
          {kind === "expired" && <GateGlyph kind="expired" size={14} />}
          {authorityWord[kind]}
        </span>
      </header>
      {kind === "active" ? (
        <p className="money">
          {formatMoney(a.remainingMinor, a.currency)}{" "}
          <span className="money__unit">left</span>
        </p>
      ) : (
        <p className="money money--quiet">{authorityWord[kind]}</p>
      )}
      <p className="sub">
        {kind === "active"
          ? `of ${formatMoney(total, a.currency)} total budget · up to ${formatMoney(a.singleMaximumMinor, a.currency)} per purchase`
          : `${formatMoney(a.remainingMinor, a.currency)} was unused`}
        {used > 0 ? ` · ${formatMoney(a.committedMinor, a.currency)} used` : ""}
        {a.reservedMinor > 0
          ? ` · ${formatMoney(a.reservedMinor, a.currency)} pending`
          : ""}
      </p>
      <div
        className="meter"
        role="img"
        aria-label={`${share}% of the total budget used or pending`}
      >
        <i style={{ width: `${share}%` }} />
      </div>
      {consequence && <p className="note">{consequence}</p>}
      <BoundarySummary a={a} now={now} compact={compact} />
      {actions && <div className="frame__actions">{actions}</div>}
    </article>
  );
}

export { agentCan };
