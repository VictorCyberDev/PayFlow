"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  activityOutcome,
  delegatedLine,
  merchantName,
} from "../../lib/language";
import { humanWhen } from "../../lib/present";
import {
  ActivityRow,
  FlowTrace,
  OutcomeHero,
  VerificationLine,
} from "../ui/activity";
import { AgentIdentity } from "../ui/frame";
import { ActivityProof } from "../ui/proof";
import { useConsole } from "../ui/provider";
import { Empty, NeedsSession, PageHead } from "./common";

export function ActivityDetail({ id, proof }: { id: string; proof: boolean }) {
  const { management, now } = useConsole();
  const x = management.activity.find((a) => a.operationId === id);
  if (!x)
    return (
      <Empty
        title="We couldn't find that activity"
        action={{ href: "/activity/", label: "Back to Activity" }}
      >
        It may be older than the latest 20 requests.
      </Empty>
    );
  if (proof) return <ActivityProof x={x} />;
  const o = activityOutcome(x);
  const related = management.authorities.find(
    (a) => a.mandateId === x.mandateId,
  );
  return (
    <article>
      <p>
        <Link className="text-link" href="/activity/">
          ‹ Activity
        </Link>
      </p>
      <OutcomeHero x={x} />
      <FlowTrace x={x} />
      <section className="block" aria-labelledby="why">
        <h2 id="why" className="label">
          What happened
        </h2>
        <p className="body-lg">{o.detail}</p>
        {x.delegated && <p className="body-lg">{delegatedLine}</p>}
        <VerificationLine x={x} />
        <dl className="boundary">
          <div>
            <dt>Agent</dt>
            <dd>
              <AgentIdentity name={x.agentName} />
            </dd>
          </div>
          <div>
            <dt>When</dt>
            <dd>{humanWhen(x.occurredAt, now)}</dd>
          </div>
          {x.merchant && (
            <div>
              <dt>Where</dt>
              <dd>{merchantName(x.merchant)}</dd>
            </div>
          )}
          <div>
            <dt>Authority</dt>
            <dd>
              <Link
                className="text-link"
                href={`/authorities/?id=${encodeURIComponent(x.mandateId)}`}
              >
                {related ? related.purpose : "View Authority"}
              </Link>
            </dd>
          </div>
        </dl>
      </section>
      <p className="actions">
        <Link
          className="btn btn--quiet"
          href={`/activity/?id=${encodeURIComponent(x.operationId)}&proof=1`}
        >
          View proof
        </Link>
      </p>
    </article>
  );
}

export function ActivityBody({ params }: { params: URLSearchParams }) {
  const id = params.get("id");
  const { management, now } = useConsole();
  if (id) return <ActivityDetail id={id} proof={params.get("proof") === "1"} />;
  return (
    <>
      <PageHead title="Activity" lead="What happened to your money." />
      {management.activity.length ? (
        <ul className="journal">
          {management.activity.map((x) => (
            <ActivityRow
              key={x.operationId}
              x={x}
              now={now}
              href={`/activity/?id=${encodeURIComponent(x.operationId)}`}
            />
          ))}
        </ul>
      ) : (
        <Empty title="No financial activity yet.">
          Creating an Authority doesn&apos;t spend anything.
        </Empty>
      )}
    </>
  );
}

export default function ActivityView() {
  const params = useSearchParams() ?? new URLSearchParams();
  return (
    <NeedsSession signedOutLead="Open the demo to see what your Agent has done.">
      <ActivityBody params={params} />
    </NeedsSession>
  );
}
