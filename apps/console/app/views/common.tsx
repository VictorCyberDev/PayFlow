"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { AccessGate } from "../ui/access";
import { useConsole } from "../ui/provider";

/** Page frame: one h1, a short lead, and the standard signed-out / loading / unavailable states. */
export function PageHead({ title, lead }: { title: string; lead?: string }) {
  return (
    <header className="pagehead">
      <h1 className="h1">{title}</h1>
      {lead && <p className="lead">{lead}</p>}
    </header>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="status" role="status" aria-live="polite">
      {what}
    </p>
  );
}

export function Unavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="empty" role="status" aria-live="polite">
      <h2 className="h3">We can&apos;t reach your saved state right now</h2>
      <p>
        We&apos;ll keep trying. Nothing is shown rather than guessing, and
        nothing has been changed.
      </p>
      <button type="button" className="btn btn--quiet" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

/** Gate for destinations that need the demo session. */
export function NeedsSession({
  children,
  signedOutLead,
}: {
  children: ReactNode;
  signedOutLead: string;
}) {
  const { session, management, retry } = useConsole();
  if (session === "checking")
    return <Loading what="Checking your demo session…" />;
  if (session === "signed-out") return <AccessGate lead={signedOutLead} />;
  if (management.status === "UNAVAILABLE")
    return <Unavailable onRetry={retry} />;
  if (
    management.status !== "READY" &&
    management.status !== "CONFIRM_REVOKE" &&
    management.status !== "REVOKING" &&
    management.status !== "VERIFYING" &&
    !management.authorities.length &&
    !management.activity.length
  )
    return <Loading what="Loading…" />;
  return <>{children}</>;
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <section className="empty">
      <h2 className="h3">{title}</h2>
      {children && <p>{children}</p>}
      {action && (
        <Link className="btn" href={action.href}>
          {action.label}
        </Link>
      )}
    </section>
  );
}

export function errorCopy(error: string | null): string | null {
  return error
    ? "We couldn't confirm that change. Showing the last confirmed state."
    : null;
}
