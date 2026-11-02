"use client";
import { useId, useState } from "react";
import {
  present,
  verifyProof,
  type Presentation,
} from "../../lib/verify-proof";
import sample from "../../lib/sample-proof.json";

type State =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; view: Presentation; technical: Record<string, string> };

export function ProofVerifier() {
  const proofId = useId();
  const keyId = useId();
  const [proofText, setProofText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const [sampleLoaded, setSampleLoaded] = useState(false);

  async function run() {
    setState({ status: "checking" });
    let proof: unknown, keys: unknown;
    try {
      proof = JSON.parse(proofText);
    } catch {
      return setState({
        status: "done",
        view: {
          headline: "Not verified",
          facts: [],
          reason: "The Proof is not valid JSON.",
        },
        technical: { reason: "PROOF_NOT_JSON" },
      });
    }
    try {
      keys = JSON.parse(keyText);
    } catch {
      return setState({
        status: "done",
        view: {
          headline: "Not verified",
          facts: [],
          reason: "The public key is not valid JSON.",
        },
        technical: { reason: "KEY_NOT_JSON" },
      });
    }
    const result = await verifyProof(proof, keys);
    const p = result.proof ?? (proof as Record<string, unknown>);
    setState({
      status: "done",
      view: present(result),
      technical: {
        reason: result.reason,
        keyId: String(p?.keyId ?? ""),
        outcome: String(p?.outcome ?? ""),
        effectCount: String(p?.effectCount ?? ""),
        evidenceDigest: String(p?.evidenceDigest ?? ""),
        signature: String(p?.signature ?? ""),
      },
    });
  }

  return (
    <section className="proof-verifier" aria-labelledby="pv-title">
      <h2 id="pv-title" className="h2">
        Check a Proof
      </h2>
      <p className="lead">
        Paste a Proof and the issuer&apos;s public key. This runs in your
        browser. Nothing is sent anywhere, and no money can move.
      </p>
      <div className="pv-grid">
        <div>
          <label htmlFor={proofId}>Proof (JSON)</label>
          <textarea
            id={proofId}
            value={proofText}
            onChange={(e) => setProofText(e.target.value)}
            spellCheck={false}
            rows={9}
          />
        </div>
        <div>
          <label htmlFor={keyId}>
            Public key (JSON key, or the /v1/keys document)
          </label>
          <textarea
            id={keyId}
            value={keyText}
            onChange={(e) => setKeyText(e.target.value)}
            spellCheck={false}
            rows={9}
          />
        </div>
      </div>
      <div className="pv-actions">
        <button
          type="button"
          className="company-button primary"
          onClick={() => void run()}
          disabled={!proofText.trim() || !keyText.trim()}
        >
          Verify
        </button>
        <button
          type="button"
          className="company-button"
          onClick={() => {
            setProofText(JSON.stringify(sample.proof, null, 2));
            setKeyText(JSON.stringify(sample.keys, null, 2));
            setSampleLoaded(true);
            setState({ status: "idle" });
          }}
        >
          Try a sample
        </button>
      </div>
      {sampleLoaded && <p className="pv-note">{sample._notice}</p>}
      <div className="pv-result" aria-live="polite">
        {state.status === "checking" && <p>Checking…</p>}
        {state.status === "done" && (
          <article
            className={state.view.headline === "Verified" ? "pv-ok" : "pv-bad"}
          >
            <h3>
              <span aria-hidden="true">
                {state.view.headline === "Verified" ? "✓ " : "✕ "}
              </span>
              {state.view.headline}
            </h3>
            {state.view.outcome && (
              <p className="pv-outcome">{state.view.outcome}</p>
            )}
            <p>{state.view.reason}</p>
            {state.view.facts.length > 0 && (
              <dl className="pv-facts">
                {state.view.facts.map((f) => (
                  <div key={f.label}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <details>
              <summary>Technical detail</summary>
              <dl className="pv-tech">
                {Object.entries(state.technical).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>
                      <code>{v || "—"}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </article>
        )}
      </div>
    </section>
  );
}
