"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createReviewController,
  type ClientReviewState,
} from "../../lib/review-client.mjs";
import { exactUtc, humanRemaining, humanWhen } from "../../lib/present";
import { AccessGate } from "../ui/access";
import { AuthorityFrame } from "../ui/frame";
import { useConsole } from "../ui/provider";
import { Loading } from "./common";
import { BRAND } from "../../lib/brand";

type Term = { label: string; value: string };
const initial: ClientReviewState = {
  status: "EMPTY",
  source: "",
  review: null,
};

/** Times arrive as ISO strings in the "Expires" terms; show them as people say them. */
function termValue(t: Term, now: Date) {
  return /expires/i.test(t.label) && Number.isFinite(Date.parse(t.value))
    ? humanWhen(t.value, now)
    : t.value;
}
function Terms({ terms, now }: { terms: Term[]; now: Date }) {
  return (
    <dl className="boundary boundary--constrain">
      {terms.map((t, i) => (
        <div key={t.label} style={{ ["--i" as string]: i }}>
          <dt>{t.label}</dt>
          <dd>{termValue(t, now)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Steps({ n }: { n: 1 | 2 | 3 | 4 }) {
  const names = ["Describe", "Understand", "Confirm", "Created"];
  return (
    <ol className="steps" aria-label="Progress">
      {names.map((s, i) => (
        <li
          key={s}
          aria-current={i + 1 === n ? "step" : undefined}
          className={i + 1 <= n ? "is-done" : ""}
        >
          <span className="steps__n">{i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  );
}

export default function NewAuthorityView() {
  const c = useConsole();
  const {
    session,
    activation,
    management,
    now,
    prepare,
    confirm,
    invalidateFlow,
    resetFlow,
  } = c;
  const [source, setSource] = useState("");
  const [review, setReview] = useState<ClientReviewState>(initial);
  const ctl = useRef<ReturnType<typeof createReviewController> | null>(null);
  const version = useRef(0);
  const [wantConfirm, setWantConfirm] = useState(false);

  useEffect(() => {
    resetFlow();
    const r = createReviewController(setReview);
    ctl.current = r;
    const timer = setInterval(() => r.expire(), 1000);
    return () => {
      clearInterval(timer);
      r.dispose();
    };
  }, [resetFlow]);

  const edit = (value: string) => {
    version.current++;
    setSource(value);
    setWantConfirm(false);
    ctl.current?.edit(value);
    invalidateFlow();
  };
  async function sample() {
    const v = version.current;
    try {
      const r = await fetch("/api/intent-review/sample");
      if (!r.ok) throw new Error();
      const d: unknown = await r.json();
      if (
        d &&
        typeof d === "object" &&
        "sample" in d &&
        typeof d.sample === "string" &&
        d.sample.length <= 2000 &&
        v === version.current
      )
        edit(d.sample);
    } catch {
      /* the review surface reports unavailability when the customer submits */
    }
  }
  const startConfirm = () => {
    setWantConfirm(true);
    if (session === "signed-in") void prepare(source);
  };

  const a = activation;
  const created = a.status === "ACTIVE" && a.authority ? a.authority : null;
  const confirming = [
    "PENDING",
    "PREPARING",
    "CONFIRMING",
    "VERIFYING",
  ].includes(a.status);
  const valid =
    review.status === "VALID_DRAFT" && review.review?.status === "VALID_DRAFT";
  const step: 1 | 2 | 3 | 4 = created ? 4 : confirming ? 3 : valid ? 2 : 1;
  const mine = created
    ? management.authorities.find((x) => x.mandateId === created.mandateId)
    : undefined;

  if (session === "checking") return <Loading what="Loading…" />;

  return (
    <>
      <Steps n={step} />
      <div role="status" aria-live="polite">
        {a.status === "ERROR" && (
          <p className="banner">
            That didn&apos;t go through. Nothing was authorized. Review your
            request again.
          </p>
        )}
      </div>
      {step === 1 && (
        <section aria-labelledby="n1">
          <h1 id="n1" className="h1">
            What may your Agent do?
          </h1>
          <p className="lead">
            Describe it in your own words. Nothing is authorized until you
            confirm exact limits.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ctl.current?.submit(source);
            }}
          >
            <label htmlFor="request">Your request</label>
            <textarea
              id="request"
              value={source}
              onChange={(e) => edit(e.target.value)}
              maxLength={2000}
              rows={5}
              placeholder="Buy me one new mechanical keyboard under $100 this week. Never buy used or refurbished."
            />
            <p className="actions">
              <button
                type="submit"
                className="btn"
                disabled={review.status === "INTERPRETING" || !source.trim()}
              >
                Review my request
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={review.status === "INTERPRETING"}
                onClick={() => void sample()}
              >
                Use the example
              </button>
            </p>
          </form>
          <div
            role="status"
            aria-live="polite"
            aria-busy={review.status === "INTERPRETING"}
          >
            {review.status === "INTERPRETING" && (
              <p className="note">
                Reading your request… Nothing is authorized.
              </p>
            )}
            {review.status === "STALE" && (
              <p className="note">Your request changed. Review it again.</p>
            )}
            {review.status === "EXPIRED" && (
              <p className="note">
                That review expired. Review your request again.
              </p>
            )}
            {review.status === "SAFE_PROVIDER_FAILURE" && (
              <p className="banner">
                We couldn&apos;t read your request right now. Nothing was
                authorized.
              </p>
            )}
            {review.review &&
              review.review.status === "NEEDS_CLARIFICATION" && (
                <p className="banner">
                  {review.review.question} Update your request above, then
                  review it again.
                </p>
              )}
            {review.review && review.review.status === "REJECTED" && (
              <p className="banner">{review.review.message}</p>
            )}
          </div>
        </section>
      )}

      {step === 2 && review.review && (
        <section aria-labelledby="n2">
          <h1 id="n2" className="h1">
            Here&apos;s what {BRAND.name} understood
          </h1>
          <p className="lead">Not yet authorized. These are proposed limits.</p>
          <blockquote>{review.source}</blockquote>
          <h2 className="label">Your Agent would be allowed to</h2>
          <Terms terms={review.review.terms} now={now} />
          {review.review.interpreted.length > 0 && (
            <>
              <h2 className="label">What the AI read from your words</h2>
              <Terms terms={review.review.interpreted} now={now} />
            </>
          )}
          <details className="more">
            <summary>How {BRAND.name} checked this</summary>
            <p>
              The AI&apos;s reading is untrusted. {BRAND.name} compared it with
              its own demo limits.
            </p>
            <p className="mono">
              status {review.review.status}
              {review.review.fingerprint
                ? ` · draft ${review.review.fingerprint}`
                : ""}
              {review.review.reasonCodes.length
                ? ` · ${review.review.reasonCodes.join(", ")}`
                : ""}
              {" · display expires "}
              {exactUtc(review.review.expiresAt)}
            </p>
          </details>
          {wantConfirm && session === "signed-out" ? (
            <AccessGate
              lead="Open the demo to continue. Your review stays here."
              onOpened={() => void prepare(source)}
            />
          ) : (
            <p className="actions">
              <button type="button" className="btn" onClick={startConfirm}>
                Continue to confirm
              </button>
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => edit(source)}
              >
                Edit request
              </button>
            </p>
          )}
        </section>
      )}

      {step === 3 && (
        <section aria-labelledby="n3" aria-busy={a.status !== "PENDING"}>
          <h1 id="n3" className="h1">
            Confirm this Authority
          </h1>
          <p className="lead">Not yet authorized.</p>
          <div role="status" aria-live="polite">
            {a.status === "PREPARING" && (
              <p className="note">Preparing your confirmation…</p>
            )}
            {a.status === "CONFIRMING" && (
              <p className="note">
                Creating your Authority… No purchase is being made.
              </p>
            )}
            {a.status === "VERIFYING" && (
              <p className="note">Checking it was saved…</p>
            )}
          </div>
          {a.pending && a.status === "PENDING" && (
            <>
              <p className="body-lg">
                You&apos;re giving <strong>{a.pending.agentName}</strong>{" "}
                permission to spend within these exact limits.
              </p>
              <Terms terms={a.pending.terms} now={now} />
              <p className="note">
                This doesn&apos;t make a purchase. Confirm{" "}
                {humanRemaining(a.pending.expiresAt, now).replace(
                  " remaining",
                  "",
                )}{" "}
                from now or start again.
              </p>
              <p className="actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void confirm()}
                >
                  Confirm Authority
                </button>
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => invalidateFlow()}
                >
                  Back
                </button>
              </p>
            </>
          )}
        </section>
      )}

      {step === 4 && created && (
        <section aria-labelledby="n4">
          <h1 id="n4" className="h1">
            Authority created
          </h1>
          <p className="lead">
            {created.agent.displayName} can now act within these limits.
            Creating an Authority doesn&apos;t spend anything.
          </p>
          {mine ? (
            <AuthorityFrame a={mine} now={now} sealed />
          ) : (
            <Loading what="Reading your new Authority…" />
          )}
          <p className="actions">
            <Link
              className="btn"
              href={`/authorities/?id=${encodeURIComponent(created.mandateId)}`}
            >
              View Authority
            </Link>
            <Link className="btn btn--quiet" href="/">
              Done
            </Link>
          </p>
        </section>
      )}
    </>
  );
}
