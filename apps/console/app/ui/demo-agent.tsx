"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  completePayPalVaultConnection,
  fetchDemoAgentStatus,
  fetchPayPalVaultStatus,
  runDemoScenario,
  startPayPalVaultConnection,
  type DemoOutcome,
  type DemoScenario,
} from "../../lib/demo-agent-client.mjs";
import { useConsole } from "./provider";

const result: Record<DemoOutcome["status"], string> = {
  COMPLETED: "Your Agent completed the purchase without asking you.",
  DENIED: "Blocked by your limits. $0 moved.",
  REFUSED: "Blocked before any payment started. $0 moved.",
  NEEDS_HUMAN:
    "This one is above what your Agent can spend without asking you.",
  UNRESOLVED: "Checking what happened — don't retry yet.",
};

/** Demonstration only: simulates an Agent shopping. It never widens or replaces the Authority. */
export function DemoAgentPanel({ mandateId }: { mandateId: string }) {
  const { retry } = useConsole();
  const [offer, setOffer] = useState<{ payment: string } | null>(null);
  const [vaultConnected, setVaultConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DemoOutcome | "ERROR" | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([fetchDemoAgentStatus(), fetchPayPalVaultStatus()]).then(
      ([agent, vault]) => {
        if (!live) return;
        setOffer(agent);
        setVaultConnected(vault);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const u = new URL(window.location.href);
    if (u.searchParams.get("paypal") !== "approved") return;
    const state = u.searchParams.get("state");
    void Promise.resolve()
      .then(() => {
        setBusy(true);
        return state ? completePayPalVaultConnection(state) : false;
      })
      .then(async (ok) => {
        setVaultConnected(ok);
        setOutcome(ok ? null : "ERROR");
        if (ok) {
          const agent = await fetchDemoAgentStatus();
          if (agent) setOffer(agent);
        }
        u.searchParams.delete("paypal");
        u.searchParams.delete("state");
        window.history.replaceState({}, "", u.pathname + u.search + u.hash);
      })
      .catch(() => setOutcome("ERROR"))
      .finally(() => setBusy(false));
  }, []);

  if (!offer) return null;
  const paymentRailConnected = offer.payment === "SANDBOX_CONNECTED";

  async function connectWallet() {
    setBusy(true);
    setOutcome(null);
    try {
      await startPayPalVaultConnection(mandateId);
    } catch {
      setBusy(false);
      setOutcome("ERROR");
    }
  }

  async function run(scenario: DemoScenario) {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await runDemoScenario(mandateId, scenario));
    } catch {
      setOutcome("ERROR");
    } finally {
      setBusy(false);
      retry();
    }
  }

  return (
    <section className="block demo-agent" aria-labelledby="try-agent">
      <h2 id="try-agent" className="label">
        Demo · Try your Agent
      </h2>
      <p>
        Simulate your Shopping Agent finding a keyboard. It acts without asking
        you, but only inside this Authority.
      </p>

      {vaultConnected === false && (
        <div className="banner">
          <p>
            Connect one Sandbox PayPal buyer once. This only saves the
            buyer&apos;s Sandbox wallet for delegated testing; it does not make
            a purchase.
          </p>
          <button
            type="button"
            className="btn btn--quiet"
            disabled={busy}
            onClick={() => void connectWallet()}
          >
            Connect Sandbox PayPal
          </button>
        </div>
      )}

      {vaultConnected === true && !paymentRailConnected && (
        <p className="note">
          Sandbox wallet approved and stored securely. The payment rail is still
          disabled until final M6 acceptance wiring is enabled.
        </p>
      )}

      <p className="actions">
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy || !paymentRailConnected}
          onClick={() => void run("VALID_PURCHASE")}
        >
          Agent finds an $84 keyboard
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy}
          onClick={() => void run("PRICE_DRIFT")}
        >
          Agent finds a $184 keyboard
        </button>
      </p>
      {!paymentRailConnected && vaultConnected !== true && (
        <p className="note">
          Payments aren&apos;t connected in this demo, so only the blocked case
          can run.
        </p>
      )}
      <div role="status" aria-live="polite" aria-busy={busy}>
        {busy && <p className="note">Working…</p>}
        {outcome === "ERROR" && (
          <p className="banner">That didn&apos;t run. Nothing changed.</p>
        )}
        {outcome && outcome !== "ERROR" && (
          <p className="body-lg">
            {result[outcome.status]}{" "}
            {outcome.operationId && (
              <Link
                className="text-link"
                href={`/activity/?id=${encodeURIComponent(outcome.operationId)}`}
              >
                See what happened
              </Link>
            )}
          </p>
        )}
      </div>
    </section>
  );
}
