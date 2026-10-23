"use client";
import { useEffect, useRef, useState } from "react";
import {
  createActivationController,
  type ActivationState,
} from "../lib/activation-client.mjs";
export default function ActivationPanel({
  source,
  canPrepare,
}: {
  source: string;
  canPrepare: boolean;
}) {
  const [state, setState] = useState<ActivationState>({
    status: "SIGNED_OUT",
    pending: null,
    authority: null,
  });
  const controller = useRef<ReturnType<
    typeof createActivationController
  > | null>(null);
  useEffect(() => {
    const c = createActivationController(setState, undefined, (id) => {
      const u = new URL(window.location.href);
      u.searchParams.set("authority", id);
      window.history.replaceState(null, "", u);
      window.dispatchEvent(new Event("payflow-authority-changed"));
    });
    controller.current = c;
    void c.restore(new URL(window.location.href).searchParams.get("authority"));
    let ticks = 0;
    const timer = setInterval(() => {
      c.expire();
      if (
        ++ticks % 15 === 0 &&
        ["ACTIVE", "AUTHORITY"].includes(c.getState().status)
      ) {
        void c.restore(c.getState().authority?.mandateId);
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      c.dispose();
    };
  }, []);
  const previousSource = useRef(source);
  useEffect(() => {
    if (previousSource.current !== source) {
      previousSource.current = source;
      controller.current?.invalidate();
    }
  }, [source]);
  return (
    <section
      id="confirmed-authority"
      className="activation-sheet"
      aria-labelledby="activation-title"
    >
      <p className="eyebrow">Non-production fixed-identity demo</p>
      <h2 id="activation-title">Give your agent exact authority</h2>
      <p>
        This demo uses a privately configured operator code. It is not
        production login. Your browser cannot select a different owner.
      </p>
      {state.status === "SIGNED_OUT" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const code = String(new FormData(form).get("bootstrapCode") ?? "");
            form.reset();
            void controller.current?.login(code);
          }}
        >
          <label htmlFor="bootstrap-code">Demo access code</label>
          <input
            id="bootstrap-code"
            name="bootstrapCode"
            type="password"
            autoComplete="off"
            required
            maxLength={256}
          />
          <button type="submit">Open demo session</button>
        </form>
      ) : (
        <>
          <button
            className="text-button"
            type="button"
            onClick={() => void controller.current?.logout()}
          >
            End demo session
          </button>
          {["IDLE", "ERROR"].includes(state.status) && (
            <button
              type="button"
              disabled={!canPrepare}
              onClick={() => void controller.current?.prepare(source)}
            >
              Prepare exact authority review
            </button>
          )}
        </>
      )}
      <ActivationSurface state={state} />
      {state.status === "PENDING" && (
        <button
          type="button"
          onClick={() => void controller.current?.confirm()}
        >
          Confirm authority
        </button>
      )}
      {["ACTIVE", "AUTHORITY"].includes(state.status) && state.authority && (
        <button
          type="button"
          onClick={() =>
            void controller.current?.restore(state.authority!.mandateId)
          }
        >
          Refresh authority
        </button>
      )}
    </section>
  );
}
export function ActivationSurface({ state }: { state: ActivationState }) {
  const p = state.pending,
    a = state.authority;
  const money = (minor: number, currency: string) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
      minor / (currency === "JPY" ? 1 : 100),
    );
  return (
    <div
      aria-live="polite"
      aria-busy={["PREPARING", "CONFIRMING", "VERIFYING"].includes(
        state.status,
      )}
    >
      {state.status === "PREPARING" && (
        <p>Preparing your exact durable review… Not yet authorized.</p>
      )}
      {state.status === "CONFIRMING" && (
        <p>Confirming your authority… No payment is being made.</p>
      )}
      {state.status === "VERIFYING" && (
        <p>Reading the saved authority… Waiting for server verification.</p>
      )}
      {state.status === "ERROR" && (
        <p>
          This action could not be verified. No authority is shown as active.
          Sign in again or prepare a fresh review.
        </p>
      )}
      {p && state.status === "PENDING" && (
        <>
          <h3>Give {p.agentName} this authority?</h3>
          <p>Not yet authorized.</p>
          <blockquote>{p.source}</blockquote>
          <dl>
            {p.terms.map((t) => (
              <div key={t.label}>
                <dt>{t.label}</dt>
                <dd>
                  {t.label === "Authority expires"
                    ? new Date(t.value).toUTCString()
                    : t.value}
                </dd>
              </div>
            ))}
          </dl>
          <p>
            You are about to give this agent financial authority within these
            exact limits.
          </p>
          <p>
            This creates spending authority for your agent. It does not make a
            purchase. You can revoke saved authority in the authority section.
          </p>
          <p>Confirm before {new Date(p.expiresAt).toUTCString()}.</p>
        </>
      )}
      {a && ["ACTIVE", "AUTHORITY"].includes(state.status) && (
        <article className="authority-card">
          <h3>
            {a.state === "ACTIVE"
              ? "Authority active"
              : a.state === "REVOKED"
                ? "Authority revoked"
                : a.state === "EXPIRED"
                  ? "Authority expired"
                  : "Authority temporarily unavailable"}
          </h3>
          <p>{a.agent.displayName}</p>
          <h3>{a.purpose}</h3>
          <p>Up to {money(a.singleMaximumMinor, a.currency)}</p>
          <p>{money(a.remainingMinor, a.currency)} remaining</p>
          <p>
            {a.quantityRemaining} items remaining ·{" "}
            {a.allowedConditions.map((s) => s.toLowerCase()).join(", ")} only
          </p>
          <p>{a.merchantScopeSummary}</p>
          <p>Expires {new Date(a.expiresAt).toUTCString()}</p>
          <p>
            Verified from current saved PayFlow state. Activation does not
            execute a payment.
          </p>
        </article>
      )}
    </div>
  );
}
