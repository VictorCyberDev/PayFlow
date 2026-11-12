"use client";
import Link from "next/link";
import { useState } from "react";
import { EvidenceChip, FlowObject, type FlowState } from "./flow";
import { ExploreTabs } from "./explore-tabs";

type Candidate = {
  handle: string;
  name: string | null;
  summary: string | null;
  location: string | null;
  company: string | null;
  portfolioUrl: string | null;
  profileUrl: string;
  avatarUrl: string | null;
  publicProjects: number | null;
  followers: number | null;
  declaredAvailable: boolean;
};
type Search = {
  candidates: Candidate[];
  profilesRead: number;
  source: string;
  covers: string;
  unknowns: string[];
  evidence: string;
};

/** A reply from the network is data, not truth. Anyone not marked self-declared is not rendered. */
function readSearch(value: unknown): Search | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (s.evidence !== "PROVIDER_OBSERVED" || !Array.isArray(s.candidates))
    return null;
  const candidates = s.candidates.filter(
    (c): c is Candidate =>
      !!c &&
      typeof c === "object" &&
      typeof (c as Candidate).handle === "string" &&
      typeof (c as Candidate).profileUrl === "string" &&
      (c as Candidate).declaredAvailable === true,
  );
  return {
    candidates,
    profilesRead: typeof s.profilesRead === "number" ? s.profilesRead : 0,
    source: typeof s.source === "string" ? s.source : "",
    covers: typeof s.covers === "string" ? s.covers : "",
    unknowns: Array.isArray(s.unknowns)
      ? s.unknowns.filter((u): u is string => typeof u === "string")
      : [],
    evidence: "PROVIDER_OBSERVED",
  };
}

type Phase =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "found"; search: Search }
  | { kind: "unavailable"; message: string };

const FALLBACK =
  "PayFlow could not reach the directory just now. Nobody was contacted. You can still walk the guided demo.";

export function Talent() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const flow: FlowState =
    phase.kind === "searching"
      ? "searching"
      : phase.kind === "found"
        ? "comparing"
        : phase.kind === "unavailable"
          ? "unverified"
          : "ready";

  async function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setPhase({ kind: "searching" });
    try {
      const res = await fetch("/api/talent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          skills: String(f.get("skills") ?? ""),
          location: String(f.get("location") ?? "") || null,
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      const record = (body ?? {}) as Record<string, unknown>;
      const found = res.ok ? readSearch(record.search) : null;
      if (found) {
        setPhase({ kind: "found", search: found });
        return;
      }
      setPhase({
        kind: "unavailable",
        message: typeof record.message === "string" ? record.message : FALLBACK,
      });
    } catch {
      setPhase({ kind: "unavailable", message: FALLBACK });
    }
  }

  return (
    <>
      <section className="wrap flow__hero flow__hero--demo">
        <div className="stack">
          <p className="eyebrow">Explore</p>
          <h1>Who do you need?</h1>
          <ExploreTabs />
          <form className="stack" onSubmit={(e) => void search(e)}>
            <div className="grid grid--2" style={{ width: "100%" }}>
              <div className="field">
                <label htmlFor="t-skills">Skills you need</label>
                <input
                  id="t-skills"
                  name="skills"
                  maxLength={120}
                  required
                  placeholder="rust systems"
                />
              </div>
              <div className="field">
                <label htmlFor="t-where">
                  Anywhere in particular? (optional)
                </label>
                <input
                  id="t-where"
                  name="location"
                  maxLength={60}
                  placeholder="Lisbon"
                />
              </div>
            </div>
            <div className="actions">
              <button
                className="btn"
                type="submit"
                disabled={phase.kind === "searching"}
              >
                {phase.kind === "searching" ? "Looking…" : "Find people"}
              </button>
              <Link className="btn btn--ghost" href="/partner/">
                Plan the hire first
              </Link>
            </div>
            <p className="quiet-note">
              PayFlow only shows people who have set their own profile to say
              they are open to work. It will not message anyone.
            </p>
          </form>
        </div>
        <FlowObject state={flow} />
      </section>

      <div aria-live="polite" className="wrap band">
        {phase.kind === "unavailable" && (
          <section className="stack">
            <h2>No one to show</h2>
            <p className="lede">{phase.message}</p>
            <Link className="btn" href="/try/">
              Walk the guided demo instead
            </Link>
          </section>
        )}

        {phase.kind === "found" && (
          <section className="stack">
            <EvidenceChip kind="PROVIDER_OBSERVED" />
            <h2>
              {phase.search.candidates.length} of {phase.search.profilesRead}{" "}
              profiles say they are open to work
            </h2>
            <div className="banner">
              <span aria-hidden="true">●</span>
              <p>
                <strong>These are real people.</strong> Each one set their own
                profile to say they are open to work; PayFlow checked that
                rather than guessing it. It does not know{" "}
                {phase.search.unknowns.join(", ")}. Nobody has been contacted.
              </p>
            </div>

            {phase.search.candidates.length === 0 ? (
              <p className="lede">
                PayFlow read {phase.search.profilesRead} profiles and none of
                them said they were open to work, so it is showing you nobody
                rather than people who never said that. Try different skills.
              </p>
            ) : (
              <div className="grid grid--2" style={{ width: "100%" }}>
                {phase.search.candidates.map((c) => (
                  <article className="card" key={c.handle}>
                    <span className="chip">Open to work</span>
                    <div
                      style={{ display: "flex", gap: 14, alignItems: "center" }}
                    >
                      {c.avatarUrl && (
                        // eslint-disable-next-line @next/next/no-img-element -- a static export cannot run next/image's optimizer
                        <img
                          className="avatar"
                          src={c.avatarUrl}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                      )}
                      <div>
                        <h3>{c.name ?? c.handle}</h3>
                        <p className="mono">{c.handle}</p>
                      </div>
                    </div>
                    {c.summary && <p>{c.summary}</p>}
                    <dl className="ledger" style={{ width: "100%" }}>
                      {c.location && (
                        <div className="ledger__row">
                          <dt>Based in</dt>
                          <dd>{c.location}</dd>
                        </div>
                      )}
                      {c.company && (
                        <div className="ledger__row">
                          <dt>At</dt>
                          <dd>{c.company}</dd>
                        </div>
                      )}
                      <div className="ledger__row">
                        <dt>Public projects</dt>
                        <dd>{c.publicProjects ?? "not stated"}</dd>
                      </div>
                    </dl>
                    <div className="actions">
                      <a
                        className="btn btn--small btn--ghost"
                        href={c.profileUrl}
                        rel="nofollow noopener noreferrer"
                        target="_blank"
                      >
                        See their work
                      </a>
                      {c.portfolioUrl && (
                        <a
                          className="btn btn--small btn--ghost"
                          href={c.portfolioUrl}
                          rel="nofollow noopener noreferrer"
                          target="_blank"
                        >
                          Portfolio
                        </a>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
            <p className="quiet-note">
              Source: {phase.search.source}. This finds {phase.search.covers}.
              It will not find a motion designer who does not publish code —
              PayFlow would rather tell you that than show you the wrong people.
            </p>
          </section>
        )}
      </div>
    </>
  );
}
