"use client";
import ActivationPanel from "./activation-panel";
import { useEffect, useRef, useState } from "react";
import { createReviewController } from "../lib/review-client.mjs";

type Term = { label: string; value: string };
type Review = {
  status: string;
  message: string;
  question: string | null;
  terms: Term[];
  interpreted: Term[];
  fingerprint: string | null;
  reasonCodes: string[];
  expiresAt: string;
};
type State = { status: string; source: string; review: Review | null };
export default function AskPayFlow() {
  const [source, setSource] = useState("");
  const [state, setState] = useState<State>({
    status: "EMPTY",
    source: "",
    review: null,
  });
  const controller = useRef<ReturnType<typeof createReviewController> | null>(
    null,
  );
  useEffect(() => {
    const c = createReviewController(setState);
    controller.current = c;
    const timer = setInterval(() => c.expire(), 1000);
    return () => {
      clearInterval(timer);
      c.dispose();
    };
  }, []);
  const sourceVersion = useRef(0);
  function edit(value: string) {
    sourceVersion.current++;
    setSource(value);
    controller.current?.edit(value);
  }
  async function sample() {
    const version = sourceVersion.current;
    try {
      const response = await fetch("/api/intent-review/sample");
      if (!response.ok) throw new Error();
      const data: unknown = await response.json();
      if (
        data &&
        typeof data === "object" &&
        "sample" in data &&
        typeof data.sample === "string" &&
        data.sample.length <= 2000 &&
        version === sourceVersion.current
      )
        edit(data.sample);
    } catch {
      if (version !== sourceVersion.current) return;
      setState({ status: "SAFE_PROVIDER_FAILURE", source, review: null });
    }
  }
  return (
    <section id="ask" aria-labelledby="ask-title">
      <h2 id="ask-title">Ask PayFlow</h2>
      <p className="demo-note">
        Non-production review demo. The local host uses recorded model fixtures,
        not a live AI service. Other text asks for clarification; it never
        invents permission.
      </p>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.current?.submit(source);
        }}
      >
        <label htmlFor="request">
          What would you like your agent to handle?
        </label>
        <textarea
          id="request"
          value={source}
          onChange={(event) => edit(event.target.value)}
          maxLength={2000}
          rows={4}
          placeholder="Buy me one new mechanical keyboard under $100 this week. Never buy used or refurbished."
        />
        <div className="composer-footer">
          <span>Nothing is authorized by entering a request.</span>
          <button
            type="submit"
            disabled={state.status === "INTERPRETING" || !source.trim()}
          >
            Review request
          </button>
        </div>
      </form>
      <button
        className="sample-button"
        disabled={state.status === "INTERPRETING"}
        type="button"
        onClick={() => void sample()}
      >
        Try the recorded, fully specified example
      </button>
      <ReviewSurface state={state} />
      <ActivationPanel
        source={source}
        canPrepare={state.status === "VALID_DRAFT"}
      />
    </section>
  );
}

export function ReviewSurface({ state }: { state: State }) {
  const review = state.review;
  return (
    <div
      className="interpretation"
      aria-live="polite"
      aria-busy={state.status === "INTERPRETING"}
    >
      <p className="eyebrow">AI interpretation · Untrusted</p>
      <h2>Not yet authorized</h2>
      {state.status === "EMPTY" && (
        <p>Describe your request to begin a review. No authority exists yet.</p>
      )}
      {state.status === "INTERPRETING" && (
        <p>
          Interpreting your request and checking its terms… Nothing is
          authorized.
        </p>
      )}
      {state.status === "STALE" && (
        <p>
          Your request changed. Review it again; previous terms no longer apply.
        </p>
      )}
      {state.status === "EXPIRED" && (
        <p>This review has expired. Review your request again.</p>
      )}
      {state.status === "SAFE_PROVIDER_FAILURE" && (
        <p>
          Interpretation is unavailable. Nothing was authorized. Start the local
          review demo host and try again.
        </p>
      )}
      {review && (
        <>
          <h3>Your request</h3>
          <blockquote>{state.source}</blockquote>
          <p>{review.message}</p>
          {review.status === "NEEDS_CLARIFICATION" && (
            <p className="clarification">
              {review.question} Update your request above, then review again.
            </p>
          )}
          {review.status === "VALID_DRAFT" && (
            <>
              <h3>What the AI understood</h3>
              <dl>
                {review.interpreted.map((t) => (
                  <div key={t.label}>
                    <dt>{t.label}</dt>
                    <dd>{t.value}</dd>
                  </div>
                ))}
              </dl>
              <h3>Terms within the demo host’s limits</h3>
              <p>
                These are proposed limits, not a decision to allow a purchase.
                The server checks these terms against independent demo limits.
              </p>
              <dl>
                {review.terms.map((t) => (
                  <div key={t.label}>
                    <dt>{t.label}</dt>
                    <dd>
                      {t.label === "Expires"
                        ? new Date(t.value).toUTCString()
                        : t.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                Authenticated activation is not connected. No confirmation or
                payment action is available.
              </p>
            </>
          )}
          <details>
            <summary>View review details</summary>
            <p>State: {review.status}</p>
            {review.fingerprint && (
              <p className="technical-reference">
                Draft fingerprint: {review.fingerprint}
              </p>
            )}
            <p>
              Review display expires: {new Date(review.expiresAt).toUTCString()}
            </p>
            {review.reasonCodes.map((code) => (
              <p key={code}>{code}</p>
            ))}
            <p>
              Non-production projection. No activation challenge, confirmation
              token or financial capability.
            </p>
          </details>
        </>
      )}
    </div>
  );
}
