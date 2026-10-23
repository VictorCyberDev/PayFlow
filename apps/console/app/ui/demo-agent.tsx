"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchDemoAgentStatus,
  runDemoScenario,
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
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DemoOutcome | "ERROR" | null>(null);
  useEffect(() => {
    let live = true;
    void fetchDemoAgentStatus().then((s) => live && setOffer(s));
    return () => {
      live = false;
    };
  }, []);
  if (!offer) return null;
  const connected = offer.payment === "SANDBOX_CONNECTED";
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
      <p className="actions">
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy || !connected}
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
      {!connected && (
        <p className="note">
          Payments aren&apos;t connected in this demo, so only the blocked case
          can run.
        </p>
      )}
      <div role="status" aria-live="polite" aria-busy={busy}>
        {busy && <p className="note">Your Agent is shopping…</p>}
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
