"use client";
import { useEffect, useRef, useState } from "react";
import {
  createManagementController,
  type ManagementState,
  type ManagedAuthority,
} from "../lib/management-client.mjs";
const labels: Record<string, string> = {
  ACTIVE: "Active",
  REVOKED: "Revoked",
  EXPIRED: "Expired",
  UNAVAILABLE: "Temporarily unavailable",
};
const capabilities: Record<string, string> = {
  SEARCH_PRODUCTS: "Find products",
  EVALUATE_PRODUCTS: "Compare products",
  CREATE_ORDER: "Create purchase orders",
  CAPTURE_PAYMENT: "Pay for purchases",
  REQUEST_REFUND: "Request refunds",
  CREATE_SUBSCRIPTION: "Create subscriptions",
  OPEN_DISPUTE: "Open disputes",
};
const money = (n: number | null, c: string) =>
  n === null
    ? "Not established"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(
        n / (c === "JPY" ? 1 : 100),
      );
const date = (s: string) => new Date(s).toUTCString();
export default function ManagementPanel() {
  const [state, setState] = useState<ManagementState>({
    status: "SIGNED_OUT",
    authorities: [],
    activity: [],
    error: null,
    selected: null,
  });
  const c = useRef<ReturnType<typeof createManagementController> | null>(null);
  useEffect(() => {
    const controller = createManagementController(setState);
    c.current = controller;
    void controller.refresh();
    let ticks = 0;
    const timer = setInterval(() => {
      controller.expire();
      if (++ticks % 15 === 0) void controller.refresh();
    }, 1000);
    const refresh = () => void controller.refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("payflow-authority-changed", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("payflow-authority-changed", refresh);
      window.removeEventListener("focus", refresh);
      controller.dispose();
    };
  }, []);
  return (
    <ManagementSurface
      state={state}
      onRefresh={() => void c.current?.refresh()}
      onRequest={(id) => c.current?.requestRevoke(id)}
      onCancel={() => c.current?.cancelRevoke()}
      onRevoke={() =>
        void c.current?.revoke().then(() => {
          // Any other card on this page must re-read durable state, never keep showing ACTIVE.
          window.dispatchEvent(new Event("payflow-authority-revoked"));
        })
      }
    />
  );
}
export function AuthorityDetails({ a }: { a: ManagedAuthority }) {
  return (
    <details>
      <summary>View authority details</summary>
      <dl>
        <div>
          <dt>Maximum per purchase</dt>
          <dd>{money(a.singleMaximumMinor, a.currency)}</dd>
        </div>
        <div>
          <dt>Total limit</dt>
          <dd>{money(a.cumulativeLimitMinor, a.currency)}</dd>
        </div>
        <div>
          <dt>Committed</dt>
          <dd>{money(a.committedMinor, a.currency)}</dd>
        </div>
        <div>
          <dt>Currently reserved</dt>
          <dd>{money(a.reservedMinor, a.currency)}</dd>
        </div>
        <div>
          <dt>Quantity</dt>
          <dd>
            {a.quantityRemaining ?? "Not established"} remaining of{" "}
            {a.quantityLimit ?? "no quantity limit"}
          </dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>{a.merchantScopeSummary}</dd>
        </div>
        <div>
          <dt>Condition</dt>
          <dd>{a.allowedConditions.map((x) => x.toLowerCase()).join(", ")}</dd>
        </div>
        <div>
          <dt>Agent can</dt>
          <dd>
            {a.allowedCapabilities
              .map((x) => capabilities[x] ?? "Unavailable")
              .join(", ")}
          </dd>
        </div>
        <div>
          <dt>Without asking again</dt>
          <dd>Up to {money(a.autonomousThresholdMinor, a.currency)}</dd>
        </div>
        <div>
          <dt>Human approval threshold</dt>
          <dd>{money(a.humanApprovalThresholdMinor, a.currency)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{date(a.createdAt)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{date(a.expiresAt)}</dd>
        </div>
        <div>
          <dt>New dispatch</dt>
          <dd>
            {a.freshDispatchBlocked === true
              ? "Blocked"
              : "Requires normal server authorization for every request"}
          </dd>
        </div>
      </dl>
      <details>
        <summary>View verification details</summary>
        <p>
          Read from saved PayFlow state at {date(a.observedAt)}. Displayed
          limits never authorize a payment.
        </p>
        <details>
          <summary>Technical references</summary>
          <p>Authority: {a.mandateId}</p>
          <p>Agent: {a.agent.id}</p>
        </details>
      </details>
    </details>
  );
}
export function ManagementSurface({
  state,
  onRefresh = () => {},
  onRequest = () => {},
  onCancel = () => {},
  onRevoke = () => {},
}: {
  state: ManagementState;
  onRefresh?: () => void;
  onRequest?: (id: string) => void;
  onCancel?: () => void;
  onRevoke?: () => void;
}) {
  const focusTarget = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state.status === "CONFIRM_REVOKE") focusTarget.current?.focus();
  }, [state.status]);
  const busy = ["REVOKING", "VERIFYING", "LOADING"].includes(state.status);
  return (
    <div className="management-surface">
      <section
        id="managed-authorities"
        className="section-block"
        aria-labelledby="managed-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">Your saved authorities</p>
            <h2 id="managed-title">Clear limits. You stay in control.</h2>
          </div>
          <button
            type="button"
            className="text-button"
            disabled={busy || state.status === "CONFIRM_REVOKE"}
            onClick={onRefresh}
          >
            Refresh saved state
          </button>
        </div>
        <p>
          Non-production demo · Same fixed-owner session as exact confirmation.
          Reads never make a payment.
        </p>
        <div role="status" aria-live="polite">
          {state.error && <p>{state.error}</p>}
          {state.status === "LOADING" && (
            <p>Refreshing saved authority and activity…</p>
          )}
          {state.status === "REVOKING" && (
            <p>Recording your revocation… Waiting for the server.</p>
          )}
          {state.status === "VERIFYING" && (
            <p>
              Checking the saved authority… Revocation is not yet confirmed
              here.
            </p>
          )}
        </div>
        {state.status === "READY" && !state.authorities.length && (
          <p>No saved authorities found for this owner.</p>
        )}
        {state.authorities.map((a) => (
          <article
            className="authority-card managed-card"
            id={"saved-" + a.mandateId}
            key={a.mandateId}
          >
            <div className="authority-card-topline">
              <div>
                <span className="state-pill">
                  {a.agent.status === "SUSPENDED" && a.state === "UNAVAILABLE"
                    ? "Paused"
                    : labels[a.state]}
                </span>
                <h3>{a.purpose}</h3>
                <p>{a.agent.displayName}</p>
              </div>
              <div className="amount-block">
                <span>Up to</span>
                <strong>{money(a.singleMaximumMinor, a.currency)}</strong>
              </div>
            </div>
            <p className="wallet-remaining">
              {money(a.remainingMinor, a.currency)} remaining
            </p>
            <p>
              {a.quantityRemaining ?? "Unspecified"}{" "}
              {a.quantityRemaining === 1 ? "item" : "items"} remaining ·{" "}
              {a.merchantScopeSummary}
            </p>
            <p>Expires {date(a.expiresAt)}</p>
            {a.state === "REVOKED" && (
              <p>
                Authority revoked. New financial dispatch is blocked. Completed
                payments are not reversed.
              </p>
            )}
            {a.state === "UNAVAILABLE" && (
              <p>
                {a.agent.status === "SUSPENDED"
                  ? "The saved agent passport is paused. New financial dispatch is blocked."
                  : "This authority is unavailable for new dispatch. No additional cause is asserted."}
              </p>
            )}
            <AuthorityDetails a={a} />
            {a.state !== "REVOKED" && (
              <button
                className="revoke-button"
                type="button"
                disabled={busy || state.status === "CONFIRM_REVOKE"}
                onClick={() => onRequest(a.mandateId)}
              >
                Revoke authority
              </button>
            )}
          </article>
        ))}
        {state.status === "CONFIRM_REVOKE" && (
          <section
            className="activation-sheet revoke-sheet"
            aria-labelledby="revoke-title"
          >
            <h3 id="revoke-title" tabIndex={-1} ref={focusTarget}>
              Revoke this authority?
            </h3>
            <p>
              {
                state.authorities.find((a) => a.mandateId === state.selected)
                  ?.purpose
              }
            </p>
            <p>
              {
                state.authorities.find((a) => a.mandateId === state.selected)
                  ?.agent.displayName
              }{" "}
              will no longer be allowed to start new purchases under this
              authority.
            </p>
            <p>Existing completed payments are not reversed.</p>
            <button type="button" onClick={onRevoke}>
              Revoke authority
            </button>
            <button type="button" className="text-button" onClick={onCancel}>
              Keep authority
            </button>
          </section>
        )}
      </section>
      <section
        id="activity"
        className="section-block"
        aria-labelledby="activity-title"
      >
        <p className="eyebrow">Saved activity · latest 20 requests</p>
        <h2 id="activity-title">What happened, and why</h2>
        {["SIGNED_OUT", "UNAVAILABLE"].includes(state.status) &&
          !state.activity.length && (
            <p>
              Saved activity is not available yet. Open a demo session to see
              what your agent has done.
            </p>
          )}
        {state.status === "READY" && !state.activity.length && (
          <p>
            No saved operations for this owner. Activating authority does not
            create a purchase.
          </p>
        )}
        <div className="activity-list">
          {state.activity.map((x) => (
            <article
              className="activity-row durable-activity"
              key={x.operationId}
            >
              <span className="activity-icon" aria-hidden="true">
                {x.moneyMoved === "YES" ? "✓" : "—"}
              </span>
              <div className="activity-copy">
                <strong>{x.label}</strong>
                <span>
                  {money(x.amountMinor, x.currency ?? "USD")}
                  {x.item ? " · " + x.item : ""}
                </span>
                {x.merchant && <span>{x.merchant}</span>}
                <time dateTime={x.occurredAt}>{date(x.occurredAt)}</time>
                <p>
                  {x.moneyMoved === "YES"
                    ? "Money moved: yes"
                    : x.moneyMoved === "NO"
                      ? "Your money didn’t move"
                      : "Money movement has not been confirmed"}
                </p>
                <details>
                  <summary>Why?</summary>
                  <p>{x.explanation}</p>
                  <p>{x.agentName}</p>
                  <a
                    href={
                      "?authority=" +
                      encodeURIComponent(x.mandateId) +
                      "#confirmed-authority"
                    }
                  >
                    View related authority
                  </a>
                  <details>
                    <summary>View verification details</summary>
                    <p>
                      {
                        (
                          {
                            VERIFIED: "Verified",
                            INCOMPLETE: "Incomplete",
                            INVALID: "Invalid — needs attention",
                            UNKNOWN_FINANCIAL_OUTCOME:
                              "Final financial outcome unknown",
                            LEGACY:
                              "Historical record — incomplete verification",
                          } as Record<string, string>
                        )[x.verification]
                      }
                    </p>
                    <ul>
                      {x.stages.map((s) => (
                        <li key={s.stage}>
                          {s.stage.replaceAll("_", " ").toLowerCase()}:{" "}
                          {s.status.replaceAll("_", " ").toLowerCase()} ·{" "}
                          {s.reasonCode.replaceAll("_", " ").toLowerCase()}
                        </li>
                      ))}
                    </ul>
                    <details>
                      <summary>Technical references</summary>
                      <p>Operation: {x.operationId}</p>
                      <p>Authority: {x.mandateId}</p>
                      <p>Agent: {x.agentId}</p>
                      {Object.entries(x.references).map(
                        ([k, v]) =>
                          v && (
                            <p key={k}>
                              {k}: {v}
                            </p>
                          ),
                      )}
                    </details>
                  </details>
                </details>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
