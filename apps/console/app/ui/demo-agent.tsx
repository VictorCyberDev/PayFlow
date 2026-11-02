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

const narrowControl = {
  maxWidth: "100%",
  whiteSpace: "normal" as const,
  overflowWrap: "anywhere" as const,
};

function safeDiagnostic(error: unknown) {
  const code = error instanceof Error ? error.message : "UNAVAILABLE";
  return /^[A-Z0-9_]{3,96}$/.test(code) ? code : "UNAVAILABLE";
}

/** Owner-scoped Sandbox wallet control. It is independent of any Authority. */
export function SandboxWalletPanel() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchPayPalVaultStatus().then((v) => live && setConnected(v));
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
        setDiagnostic(null);
        return state ? completePayPalVaultConnection(state) : false;
      })
      .then((ok) => {
        setConnected(ok);
        if (!ok) setDiagnostic("VAULT_COMPLETE_FAILED");
        u.searchParams.delete("paypal");
        u.searchParams.delete("state");
        window.history.replaceState({}, "", u.pathname + u.search + u.hash);
      })
      .catch((error) => setDiagnostic(safeDiagnostic(error)))
      .finally(() => setBusy(false));
  }, []);

  async function connect() {
    setBusy(true);
    setDiagnostic(null);
    try {
      await startPayPalVaultConnection();
    } catch (error) {
      setBusy(false);
      setDiagnostic(safeDiagnostic(error));
    }
  }

  return (
    <section
      className="block"
      aria-labelledby="sandbox-wallet"
      style={{ minWidth: 0, maxWidth: "100%" }}
    >
      <h2 id="sandbox-wallet" className="label">
        Sandbox payment wallet
      </h2>
      <p>
        Connect one PayPal Sandbox buyer to this demo owner. The wallet stays
        available across Authorities; creating, revoking, or replacing an
        Authority does not require reconnecting it.
      </p>
      {connected === true ? (
        <p className="body-lg">PayPal Sandbox connected.</p>
      ) : (
        <button
          type="button"
          className="btn btn--quiet"
          style={narrowControl}
          disabled={busy}
          onClick={() => void connect()}
        >
          {busy ? "Connecting…" : "Connect Sandbox PayPal"}
        </button>
      )}
      {diagnostic && (
        <p
          className="banner"
          role="status"
          style={{ minWidth: 0, overflowWrap: "anywhere" }}
        >
          Sandbox wallet setup did not complete. No money moved. Diagnostic:{" "}
          {diagnostic}
        </p>
      )}
    </section>
  );
}

/** Demonstration only: simulates an Agent shopping. It never widens or replaces the Authority. */
export function DemoAgentPanel({ mandateId }: { mandateId: string }) {
  const { retry } = useConsole();
  const [offer, setOffer] = useState<{ payment: string } | null>(null);
  const [vaultConnected, setVaultConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DemoOutcome | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);

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
        setDiagnostic(null);
        return state ? completePayPalVaultConnection(state) : false;
      })
      .then(async (ok) => {
        setVaultConnected(ok);
        if (!ok) setDiagnostic("VAULT_COMPLETE_FAILED");
        if (ok) {
          const agent = await fetchDemoAgentStatus();
          if (agent) setOffer(agent);
        }
        u.searchParams.delete("paypal");
        u.searchParams.delete("state");
        window.history.replaceState({}, "", u.pathname + u.search + u.hash);
      })
      .catch((error) => setDiagnostic(safeDiagnostic(error)))
      .finally(() => setBusy(false));
  }, []);

  if (!offer) return null;
  const paymentRailConnected = offer.payment === "SANDBOX_CONNECTED";

  async function connectWallet() {
    setBusy(true);
    setOutcome(null);
    setDiagnostic(null);
    try {
      await startPayPalVaultConnection(mandateId);
    } catch (error) {
      setBusy(false);
      setDiagnostic(safeDiagnostic(error));
    }
  }

  async function run(scenario: DemoScenario) {
    setBusy(true);
    setOutcome(null);
    setDiagnostic(null);
    try {
      setOutcome(await runDemoScenario(mandateId, scenario));
    } catch (error) {
      setDiagnostic(safeDiagnostic(error));
    } finally {
      setBusy(false);
      retry();
    }
  }

  return (
    <section
      className="block demo-agent"
      aria-labelledby="try-agent"
      style={{ minWidth: 0, maxWidth: "100%" }}
    >
      <h2 id="try-agent" className="label">
        Demo · Try your Agent
      </h2>
      <p>
        Simulate your Shopping Agent finding a keyboard. It acts without asking
        you, but only inside this Authority.
      </p>

      {vaultConnected === false && (
        <div className="banner" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <p>
            The owner has not connected a Sandbox PayPal wallet yet. You can
            connect it here or from the Authorities page; the connection is not
            tied to this Authority.
          </p>
          <button
            type="button"
            className="btn btn--quiet"
            style={narrowControl}
            disabled={busy}
            onClick={() => void connectWallet()}
          >
            Connect Sandbox PayPal
          </button>
        </div>
      )}

      {vaultConnected === true && !paymentRailConnected && (
        <p className="note">
          Sandbox wallet approved and stored securely. Payment readiness is
          still being verified; do not retry a purchase until it reports ready.
        </p>
      )}

      <p className="actions">
        <button
          type="button"
          className="btn btn--quiet"
          style={narrowControl}
          disabled={busy || !paymentRailConnected}
          onClick={() => void run("VALID_PURCHASE")}
        >
          Agent finds an $84 keyboard
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          style={narrowControl}
          disabled={busy}
          onClick={() => void run("PRICE_DRIFT")}
        >
          Agent finds a $184 keyboard
        </button>
      </p>
      {!paymentRailConnected && vaultConnected !== true && (
        <p className="note">
          Payments aren&rsquo;t connected in this demo, so only the blocked case
          can run.
        </p>
      )}
      <div role="status" aria-live="polite" aria-busy={busy}>
        {busy && <p className="note">Working…</p>}
        {diagnostic && (
          <p className="banner" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            The agent did not execute. No money moved. Diagnostic: {diagnostic}
          </p>
        )}
        {outcome && (
          <p className="body-lg">
            {result[outcome.status]}{" "}
            {outcome.code && outcome.status !== "COMPLETED" && (
              <span className="note">Diagnostic: {outcome.code}. </span>
            )}
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
