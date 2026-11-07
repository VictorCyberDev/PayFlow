"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MissionApiError,
  createMissionClient,
  money,
  normalizeOrigin,
} from "../../lib/mission-client.mjs";
import { PageHead } from "./common";

/* The Mission Workspace is read-only. It shows exactly what the member API returns; a section that cannot be loaded says so and
   shows nothing in its place. Changes (revise, approve, pause) are made through the API or SDK, where the owner gate applies. */

type Client = ReturnType<typeof createMissionClient>;
type J = any;

const STATUS_COPY: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Waiting for an owner",
  ACTIVE: "Active",
  PAUSED: "Paused",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REVOKED: "Revoked",
  EXPIRED: "Expired",
};
const statusCopy = (s: string) => STATUS_COPY[s] ?? s;

/* Every reason the contract's widening analysis can give (src/missions/contract.ts), in plain words. */
const REASON_COPY: Record<string, string> = {
  CURRENCY_CHANGED: "changes the currency",
  BUDGET_INCREASED: "raises the total budget",
  MAX_COMMITMENT_INCREASED: "raises the largest single commitment",
  ITEM_QUANTITY_LIMIT_RAISED_OR_REMOVED: "raises or removes the item limit",
  EXPIRY_EXTENDED: "extends the end date",
  CATEGORY_RESTRICTION_REMOVED: "removes the spending category limits",
  MERCHANTS_ENABLED: "allows merchants that were not allowed before",
  MERCHANTS_UNRESTRICTED: "allows any merchant",
  NEGOTIATION_APPROVAL_RELAXED: "no longer requires approval to negotiate",
  CONTRACT_APPROVAL_RELAXED: "no longer requires approval to sign",
  HUMAN_APPROVAL_THRESHOLD_RAISED: "raises the amount that needs a person",
  RISK_TIER_RAISED: "raises the risk tier",
};
const REASON_PREFIX: Record<string, string> = {
  CATEGORY_ADDED: "adds the category",
  PROVIDER_TYPE_ADDED: "adds the provider type",
  MERCHANT_ADDED: "adds the merchant",
  AGENT_ADDED: "adds the agent",
  CAPABILITY_ADDED: "gives an agent the capability",
};
const reasonCopy = (r: string) => {
  const [code, ...rest] = r.split(":");
  return (
    REASON_COPY[r] ??
    (REASON_PREFIX[code!]
      ? `${REASON_PREFIX[code!]} ${rest.join(" ")}`
      : r.toLowerCase().replace(/_/gu, " "))
  );
};

const errorCopy = (e: unknown) =>
  e instanceof MissionApiError
    ? e.kind === "AUTH"
      ? "That key was not accepted for missions."
      : e.kind === "NOT_FOUND"
        ? "We couldn't find that mission."
        : e.kind === "INVALID"
          ? "The server answered in a way we can't safely show."
          : "We can't reach the server right now. Nothing has been changed."
    : "Something went wrong. Nothing has been changed.";

function ConnectForm({
  onConnect,
  error,
}: {
  onConnect: (c: Client) => void;
  error: string | null;
}) {
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  return (
    <form
      className="block mission-connect"
      aria-labelledby="connect-title"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          if (normalizeOrigin(origin) === null)
            return setLocal("Use an https address (or http for localhost).");
          onConnect(createMissionClient({ origin, token: token.trim() }));
          setLocal(null);
        } catch {
          setLocal("Enter your member API key.");
        }
      }}
    >
      <h2 id="connect-title" className="h3">
        Open your missions
      </h2>
      <p>
        Enter a member API key from your PayFlow host. It is kept in this tab
        only and is gone when you close or reload it.
      </p>
      <label className="field">
        <span>Host address (leave empty for this site)</span>
        <input
          className="input"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Member API key</span>
        <input
          className="input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {(local ?? error) && (
        <p role="alert" className="banner">
          {local ?? error}
        </p>
      )}
      <p className="actions">
        <button type="submit" className="btn">
          Open missions
        </button>
      </p>
    </form>
  );
}

function Table({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: (string | number)[][];
}) {
  return (
    <div
      className="org-table-wrap"
      role="region"
      aria-label={`${caption}, scrolls sideways on narrow screens`}
      tabIndex={0}
    >
      <table className="org-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {c}
                  </th>
                ) : (
                  <td key={j}>{c}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({
  id,
  title,
  failed,
  children,
}: {
  id: string;
  title: string;
  failed: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="block" aria-labelledby={id}>
      <h2 id={id} className="label">
        {title}
      </h2>
      {failed ? (
        <p role="status" className="note">
          This section is unavailable right now. Nothing is shown rather than
          guessing.
        </p>
      ) : (
        children
      )}
    </section>
  );
}

function Detail({ client, id }: { client: Client; id: string }) {
  const [state, setState] = useState<{
    mission?: J;
    history?: J;
    plan?: J;
    ledger?: J;
    authorities?: J;
    failed: Set<string>;
    fatal?: string;
    loading: boolean;
  }>({ failed: new Set(), loading: true });
  useEffect(() => {
    let live = true;
    (async () => {
      let mission: J;
      try {
        mission = await client.mission(id);
      } catch (e) {
        if (live)
          setState({ failed: new Set(), loading: false, fatal: errorCopy(e) });
        return;
      }
      const parts = await Promise.allSettled([
        client.history(id),
        client.plan(id),
        client.ledger(id),
        client.authorities(id),
      ]);
      if (!live) return;
      const names = ["history", "plan", "ledger", "authorities"];
      const failed = new Set<string>();
      const got: Record<string, J> = {};
      parts.forEach((p, i) =>
        p.status === "fulfilled"
          ? (got[names[i]!] = p.value)
          : failed.add(names[i]!),
      );
      setState({ mission, ...got, failed, loading: false });
    })();
    return () => {
      live = false;
    };
  }, [client, id]);
  const { mission, history, plan, ledger, authorities, failed } = state;
  if (state.loading)
    return (
      <p className="status" role="status" aria-live="polite">
        Loading mission…
      </p>
    );
  if (state.fatal || !mission)
    return (
      <section className="empty" role="alert">
        <h2 className="h3">{state.fatal}</h2>
        <Link className="btn" href="/missions/">
          Back to missions
        </Link>
      </section>
    );
  const inForce = mission.activeContract ?? null;
  const c = inForce ?? mission.latestContract;
  const cur: string = c.currency;
  return (
    <>
      <p>
        <Link className="text-link" href="/missions/">
          ‹ Missions
        </Link>
      </p>
      <header className="pagehead">
        <h1 className="h1" tabIndex={-1} id="mission-title">
          {c.objective}
        </h1>
        <p className="lead">
          <span className="mission-status" data-status={mission.status}>
            {statusCopy(mission.status)}
          </span>{" "}
          ·{" "}
          {inForce
            ? `Version ${mission.activeVersion} in force`
            : "No version approved yet"}
        </p>
      </header>
      {mission.pendingContract && (
        <section
          className="banner"
          role="status"
          aria-labelledby="pending-title"
        >
          <h2 id="pending-title" className="h3">
            A change is waiting for an owner
          </h2>
          <p>
            Version {mission.pendingVersion} is proposed and is not in force.{" "}
            {mission.pendingReasons.length > 0 &&
              `It ${mission.pendingReasons.map(reasonCopy).join(" and ")}.`}
          </p>
        </section>
      )}
      <Section id="money" title="Budget" failed={failed.has("ledger")}>
        {ledger && (
          <>
            <dl className="mission-facts">
              <div>
                <dt>Ceiling</dt>
                <dd>{money(ledger.summary.ceilingMinor, cur)}</dd>
              </div>
              <div>
                <dt>Committed or spent</dt>
                <dd>{money(ledger.summary.exposureMinor, cur)}</dd>
              </div>
              <div>
                <dt>Still available</dt>
                <dd>{money(ledger.summary.availableMinor, cur)}</dd>
              </div>
              <div>
                <dt>Of that, outcome unknown</dt>
                <dd>{money(ledger.summary.unknownExposureMinor, cur)}</dd>
              </div>
              <div>
                <dt>Of that, not independently verified</dt>
                <dd>{money(ledger.summary.unverifiedExposureMinor, cur)}</dd>
              </div>
              <div>
                <dt>Refunded</dt>
                <dd>{money(ledger.summary.refundedMinor, cur)}</dd>
              </div>
            </dl>
            {ledger.summary.overCommittedMinor > 0 && (
              <p role="status" className="banner">
                Commitments exceed the current ceiling by{" "}
                {money(ledger.summary.overCommittedMinor, cur)}. No new
                commitments can be added until this is resolved.
              </p>
            )}
            {ledger.items.length > 0 ? (
              <Table
                caption="Commitments"
                head={["Item", "Stage", "Amount", "Refunded", "Evidence"]}
                rows={ledger.items.map((i: J) => [
                  String(i.label),
                  String(i.stage),
                  money(i.amountMinor, cur),
                  money(i.refundedMinor, cur),
                  String(i.verification).toLowerCase().replace(/_/gu, " "),
                ])}
              />
            ) : (
              <p className="note">Nothing has been committed yet.</p>
            )}
          </>
        )}
      </Section>
      <Section id="plan" title="Plan" failed={failed.has("plan")}>
        {plan &&
          (plan.tasks.length > 0 ? (
            <>
              <Table
                caption={`Tasks in plan version ${plan.activePlanVersion}`}
                head={["Task", "State", "Can run", "Estimate"]}
                rows={plan.tasks.map((t: J) => [
                  String(t.title),
                  String(t.state).toLowerCase().replace(/_/gu, " "),
                  String(t.readiness).toLowerCase().replace(/_/gu, " "),
                  t.estimatedCostMinor === null
                    ? "none"
                    : `${money(t.estimatedCostMinor, cur)} (${String(t.estimateSource).toLowerCase().replace(/_/gu, " ")}, not a quote)`,
                ])}
              />
              <p className="note">{plan.estimateNote}</p>
            </>
          ) : (
            <p className="note">
              {plan.plans.length > 0
                ? "A plan has been proposed and is not active yet."
                : "No plan yet."}
            </p>
          ))}
      </Section>
      <Section
        id="auth"
        title="Spending authority"
        failed={failed.has("authorities")}
      >
        {authorities &&
          (authorities.authorities.length > 0 ? (
            <Table
              caption="Authorities compiled from this mission"
              head={[
                "Agent",
                "Category",
                "Allocation",
                "Largest single",
                "State",
              ]}
              rows={authorities.authorities.map((a: J) => [
                String(a.agentId),
                String(a.category),
                money(a.allocationMinor, cur),
                money(a.maxSingleTransactionMinor, cur),
                a.status === "ACTIVE" ? "active" : "revoked",
              ])}
            />
          ) : (
            <p className="note">
              No agent can spend under this mission right now.
            </p>
          ))}
        {authorities?.notCompiled?.length > 0 && (
          <ul className="note">
            {authorities.notCompiled.map((n: J, i: number) => (
              <li key={i}>
                {n.agentId ?? "No agent"}:{" "}
                {String(n.reason).toLowerCase().replace(/_/gu, " ")}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <section className="block" aria-labelledby="contract">
        <h2 id="contract" className="label">
          What was asked for
        </h2>
        <p>{c.intendedOutcome}</p>
        <ul>
          {c.successCriteria.map((s: string) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p className="note">
          Total budget {money(c.totalBudgetMinor, cur)} · largest single
          commitment {money(c.maxCommitmentMinor, cur)}
          {c.expiresAt ? ` · ends ${new Date(c.expiresAt).toUTCString()}` : ""}
        </p>
      </section>
      <Section id="hist" title="History" failed={failed.has("history")}>
        {history && (
          <Table
            caption="What happened to this mission"
            head={["When (UTC)", "Event", "By", "Status"]}
            rows={history.transitions.map((t: J) => [
              new Date(t.at).toISOString().replace("T", " ").slice(0, 19),
              String(t.event).toLowerCase().replace(/_/gu, " "),
              `${String(t.actorKind).toLowerCase()} ${t.actorId}`,
              statusCopy(String(t.to)),
            ])}
          />
        )}
      </Section>
    </>
  );
}

function List({ client }: { client: Client }) {
  const [data, setData] = useState<{
    missions?: { record: J; detail: J | null }[];
    error?: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    client
      .list()
      .then(async (r: J) => {
        // The list holds records only; each mission's text and budget come from its own read, and one that cannot be read says so.
        const rows = await Promise.all(
          r.missions.map(async (record: J) => ({
            record,
            detail: await client.mission(record.missionId).catch(() => null),
          })),
        );
        if (live) setData({ missions: rows });
      })
      .catch((e: unknown) => live && setData({ error: errorCopy(e) }));
    return () => {
      live = false;
    };
  }, [client, attempt]);
  const load = () => {
    setData(null);
    setAttempt((n) => n + 1);
  };
  if (!data)
    return (
      <p className="status" role="status" aria-live="polite">
        Loading missions…
      </p>
    );
  if (data.error)
    return (
      <section className="empty" role="alert">
        <h2 className="h3">{data.error}</h2>
        <button type="button" className="btn btn--quiet" onClick={load}>
          Try again
        </button>
      </section>
    );
  if (!data.missions!.length)
    return (
      <section className="empty">
        <h2 className="h3">No missions yet</h2>
        <p>
          Missions are created through the PayFlow API or SDK, with a contract
          the owner approves.
        </p>
      </section>
    );
  return (
    <ul className="stack mission-list">
      {data.missions!.map(({ record: m, detail }) => {
        const c = detail
          ? (detail.activeContract ?? detail.latestContract)
          : null;
        return (
          <li key={m.missionId} className="surface-card">
            <h2 className="h3">
              <Link href={`/missions/?id=${encodeURIComponent(m.missionId)}`}>
                {c ? c.objective : `Mission ${m.missionId}`}
              </Link>
            </h2>
            <p>
              <span className="mission-status" data-status={m.status}>
                {statusCopy(m.status)}
              </span>
              {c
                ? ` · Budget ${money(c.totalBudgetMinor, c.currency)}`
                : " · details unavailable right now"}
              {m.pendingVersion ? " · a change is waiting for an owner" : ""}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export default function MissionsView() {
  const params = useSearchParams();
  const id = params.get("id");
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useMemo(() => {
    if (!client)
      return (
        <ConnectForm
          onConnect={(c) => (setError(null), setClient(c))}
          error={error}
        />
      );
    return id ? <Detail client={client} id={id} /> : <List client={client} />;
  }, [client, id, error]);
  useEffect(() => {
    if (client) heading.current?.focus();
  }, [id, client]);
  return (
    <>
      {!(client && id) && (
        <PageHead
          title="Missions"
          lead="What your agents have been asked to get done, and what it has cost so far."
        />
      )}
      {body}
      {client && (
        <p className="actions">
          <button
            type="button"
            className="text-link"
            onClick={() => setClient(null)}
          >
            Forget the key and close
          </button>
        </p>
      )}
    </>
  );
}
