"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { agentCan, authorityKind } from "../../lib/language";
import { ActivityRow } from "../ui/activity";
import { AuthorityFrame } from "../ui/frame";
import { AuthorityProof } from "../ui/proof";
import { DemoAgentPanel } from "../ui/demo-agent";
import { useConsole } from "../ui/provider";
import { Empty, NeedsSession, PageHead, errorCopy } from "./common";

function RevokeSheet() {
  const { management, cancelRevoke, revoke } = useConsole();
  const ref = useRef<HTMLDialogElement>(null);
  const open = ["CONFIRM_REVOKE", "REVOKING", "VERIFYING"].includes(
    management.status,
  );
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const a = management.authorities.find(
    (x) => x.mandateId === management.selected,
  );
  const busy =
    management.status === "REVOKING" || management.status === "VERIFYING";
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="revoke-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) cancelRevoke();
      }}
    >
      <h2 id="revoke-title" className="h2" tabIndex={-1}>
        Revoke this Authority?
      </h2>
      {a && (
        <p>
          <strong>{a.purpose}</strong> · {a.agent.displayName}
        </p>
      )}
      <p>
        {a?.agent.displayName ?? "The Agent"} won&apos;t be able to start new
        purchases under it.
      </p>
      <p>Completed payments are not reversed.</p>
      <p role="status" aria-live="polite" className="note">
        {management.status === "REVOKING" && "Recording your change…"}
        {management.status === "VERIFYING" && "Checking it was saved…"}
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void revoke()}
        >
          Revoke Authority
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy}
          onClick={cancelRevoke}
        >
          Keep Authority
        </button>
      </div>
    </dialog>
  );
}

export function AuthorityDetail({ id, proof }: { id: string; proof: boolean }) {
  const { management, now, requestRevoke } = useConsole();
  const a = management.authorities.find((x) => x.mandateId === id);
  if (!a)
    return (
      <Empty
        title="We couldn't find that Authority"
        action={{ href: "/authorities/", label: "Back to Authorities" }}
      />
    );
  if (proof) return <AuthorityProof a={a} />;
  const related = management.activity
    .filter((x) => x.mandateId === id)
    .slice(0, 5);
  const kind = authorityKind(a);
  const busy = ["REVOKING", "VERIFYING", "CONFIRM_REVOKE", "LOADING"].includes(
    management.status,
  );
  return (
    <>
      <p>
        <Link className="text-link" href="/authorities/">
          ‹ Authorities
        </Link>
      </p>
      <AuthorityFrame a={a} now={now} />
      <section className="block" aria-labelledby="can">
        <h2 id="can" className="label">
          What your Agent can do
        </h2>
        <p className="body-lg">
          {a.agent.displayName} can {agentCan(a)}.
        </p>
      </section>
      {kind === "active" && <DemoAgentPanel mandateId={a.mandateId} />}
      {related.length > 0 && (
        <section className="block" aria-labelledby="rel">
          <h2 id="rel" className="label">
            Recent activity
          </h2>
          <ul className="journal">
            {related.map((x) => (
              <ActivityRow
                key={x.operationId}
                x={x}
                now={now}
                href={`/activity/?id=${encodeURIComponent(x.operationId)}`}
              />
            ))}
          </ul>
        </section>
      )}
      <p className="actions">
        <Link
          className="btn btn--quiet"
          href={`/authorities/?id=${encodeURIComponent(a.mandateId)}&proof=1`}
        >
          View proof
        </Link>
        {kind !== "revoked" && (
          <button
            type="button"
            className="btn btn--stop"
            disabled={busy}
            onClick={() => requestRevoke(a.mandateId)}
          >
            Revoke Authority
          </button>
        )}
      </p>
    </>
  );
}

export function AuthoritiesBody({ params }: { params: URLSearchParams }) {
  const id = params.get("id");
  const { management, now, cancelRevoke } = useConsole();
  useEffect(() => () => cancelRevoke(), [cancelRevoke]);
  const err = errorCopy(management.error);
  return (
    <>
      {err && (
        <p className="banner" role="status">
          {err}
        </p>
      )}
      {id ? (
        <AuthorityDetail id={id} proof={params.get("proof") === "1"} />
      ) : (
        <>
          <PageHead
            title="Authorities"
            lead="What your Agents can do with your money."
          />
          {management.authorities.length ? (
            <div className="stack">
              {management.authorities.map((a) => (
                <AuthorityFrame
                  key={a.mandateId}
                  a={a}
                  now={now}
                  headingLevel={3}
                  compact
                  href={`/authorities/?id=${encodeURIComponent(a.mandateId)}`}
                />
              ))}
            </div>
          ) : (
            <Empty
              title="Give your AI clear spending boundaries."
              action={{ href: "/new/", label: "Create Authority" }}
            >
              Describe what your Agent may buy. You&apos;ll review exact limits
              before anything is allowed.
            </Empty>
          )}
        </>
      )}
      <RevokeSheet />
    </>
  );
}

export default function AuthoritiesView() {
  const params = useSearchParams() ?? new URLSearchParams();
  return (
    <NeedsSession signedOutLead="Open the demo to see the Authorities your Agents hold.">
      <AuthoritiesBody params={params} />
    </NeedsSession>
  );
}
