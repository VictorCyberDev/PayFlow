"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlowObject, type FlowState } from "./flow";

/**
 * The account surface: a founder creates a workspace with a name, an email and a password, or signs back into one.
 *
 * No access code, no API key, no tenant id, no invitation — the three things the old console asked for before it would
 * show anybody anything. The session lives in an HttpOnly cookie that this code cannot read, so there is no token
 * handling here and nothing to leak; the CSRF token comes back from the server on every read and is sent only on
 * sign-out, the one state change this surface makes.
 */
export type Identity = {
  status: "SIGNED_IN";
  user: { displayName: string; email: string; emailVerified: boolean };
  workspace: { organizationId: string; role: string; environment: string };
  csrfToken: string;
  expiresAt: string;
};
export type AccountState =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "unconfigured"; message: string }
  | { kind: "signed-in"; identity: Identity };

/** The reply is data, not truth: anything off-shape is treated as signed out rather than rendered. */
export function readIdentity(value: unknown): Identity | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.status !== "SIGNED_IN") return null;
  const user = v.user as Identity["user"] | undefined;
  const workspace = v.workspace as Identity["workspace"] | undefined;
  if (
    !user ||
    typeof user.displayName !== "string" ||
    typeof user.email !== "string" ||
    !workspace ||
    typeof workspace.organizationId !== "string" ||
    typeof workspace.role !== "string" ||
    typeof v.csrfToken !== "string"
  )
    return null;
  return {
    status: "SIGNED_IN",
    user: {
      displayName: user.displayName,
      email: user.email,
      emailVerified: user.emailVerified === true,
    },
    workspace: {
      organizationId: workspace.organizationId,
      role: workspace.role,
      environment:
        typeof workspace.environment === "string" ? workspace.environment : "",
    },
    csrfToken: v.csrfToken,
    expiresAt: typeof v.expiresAt === "string" ? v.expiresAt : "",
  };
}

async function readAccount(): Promise<AccountState> {
  try {
    const res = await fetch("/api/account", {
      headers: { accept: "application/json" },
    });
    const body: unknown = await res.json().catch(() => null);
    const identity = readIdentity(body);
    if (identity) return { kind: "signed-in", identity };
    const record = (body ?? {}) as Record<string, unknown>;
    if (record.status === "UNCONFIGURED")
      return {
        kind: "unconfigured",
        message:
          typeof record.message === "string"
            ? record.message
            : "Accounts are not switched on for this site yet.",
      };
    return { kind: "signed-out" };
  } catch {
    return { kind: "signed-out" };
  }
}

export function useAccount(): {
  state: AccountState;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<AccountState>({ kind: "checking" });
  const live = useRef(true);
  const refresh = useCallback(async () => {
    const next = await readAccount();
    if (live.current) setState(next);
  }, []);
  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);
  return { state, refresh };
}

type Mode = "signup" | "login";

export function Account() {
  const { state, refresh } = useAccount();
  const [mode, setMode] = useState<Mode>("signup");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const flow: FlowState =
    state.kind === "signed-in"
      ? "confirmed"
      : state.kind === "unconfigured"
        ? "unverified"
        : busy
          ? "listening"
          : "ready";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setProblem("");
    try {
      const res = await fetch("/api/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "signup"
            ? {
                action: "signup",
                displayName: String(form.get("displayName") ?? ""),
                organizationName: String(form.get("organizationName") ?? ""),
                email: String(form.get("email") ?? ""),
                password: String(form.get("password") ?? ""),
              }
            : {
                action: "login",
                email: String(form.get("email") ?? ""),
                password: String(form.get("password") ?? ""),
              },
        ),
      });
      const body: unknown = await res.json().catch(() => null);
      if (res.ok && readIdentity(body)) {
        await refresh();
        return;
      }
      const record = (body ?? {}) as Record<string, unknown>;
      setProblem(
        typeof record.message === "string"
          ? record.message
          : "PayFlow could not finish that just now. Nothing was changed.",
      );
    } catch {
      setProblem(
        "PayFlow could not reach your account just now. Nothing was changed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (state.kind !== "signed-in") return;
    setBusy(true);
    try {
      await fetch("/api/account", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-payflow-csrf": state.identity.csrfToken,
        },
        body: JSON.stringify({ action: "logout" }),
      });
    } catch {
      /* the cookie is cleared by the response; a failed call simply leaves the page to re-read */
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  return (
    <section className="wrap flow__hero">
      <div className="stack">
        <p className="eyebrow">Your workspace</p>

        {state.kind === "checking" && <h1>One moment…</h1>}

        {state.kind === "unconfigured" && (
          <>
            <h1>Accounts are not on yet.</h1>
            <p className="lede">{state.message}</p>
            <div className="actions">
              <Link className="btn" href="/partner/">
                Plan something anyway
              </Link>
              <Link className="btn btn--ghost" href="/try/">
                Try the guided demo
              </Link>
            </div>
            <p className="quiet-note">
              Nothing you do on this site needs an account today. When accounts
              are switched on, this is where you will make one.
            </p>
          </>
        )}

        {state.kind === "signed-in" && (
          <>
            <h1>Welcome back, {state.identity.user.displayName}.</h1>
            <dl className="ledger" style={{ maxWidth: "34rem" }}>
              <div className="ledger__row">
                <dt>Signed in as</dt>
                <dd>{state.identity.user.email}</dd>
              </div>
              <div className="ledger__row">
                <dt>Your role</dt>
                <dd>{state.identity.workspace.role.toLowerCase()}</dd>
              </div>
            </dl>
            <p className="quiet-note">
              Your workspace holds nothing that can spend money. PayFlow still
              asks you before any action that would.
            </p>
            <div className="actions">
              <Link className="btn" href="/partner/">
                Get something done
              </Link>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => void signOut()}
                disabled={busy}
              >
                Sign out
              </button>
            </div>
          </>
        )}

        {(state.kind === "signed-out" ||
          (state.kind === "checking" && false)) && (
          <>
            <h1>{mode === "signup" ? "Make a workspace." : "Welcome back."}</h1>
            <p className="lede">
              {mode === "signup"
                ? "A name, an email and a password. No access code, no API key, nothing to configure."
                : "Sign in to pick up where you left off."}
            </p>
            <form className="stack" onSubmit={(e) => void submit(e)}>
              {mode === "signup" && (
                <>
                  <div className="field">
                    <label htmlFor="a-name">Your name</label>
                    <input
                      id="a-name"
                      name="displayName"
                      type="text"
                      autoComplete="name"
                      maxLength={80}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="a-org">
                      What should we call your workspace?
                    </label>
                    <input
                      id="a-org"
                      name="organizationName"
                      type="text"
                      autoComplete="organization"
                      maxLength={120}
                      required
                    />
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="a-email">Email</label>
                <input
                  id="a-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="a-password">Password</label>
                <input
                  id="a-password"
                  name="password"
                  type="password"
                  autoComplete={
                    mode === "signup" ? "new-password" : "current-password"
                  }
                  minLength={mode === "signup" ? 12 : 1}
                  maxLength={200}
                  required
                  aria-describedby={mode === "signup" ? "a-pw-hint" : undefined}
                />
                {mode === "signup" && (
                  <p className="quiet-note" id="a-pw-hint">
                    At least 12 characters. Not your email address, and not the
                    same character over and over.
                  </p>
                )}
              </div>
              <p role="status" className="field-note">
                {problem}
              </p>
              <div className="actions">
                <button className="btn" type="submit" disabled={busy}>
                  {busy
                    ? "Working…"
                    : mode === "signup"
                      ? "Make my workspace"
                      : "Sign in"}
                </button>
                <button
                  className="btn btn--ghost"
                  type="button"
                  onClick={() => {
                    setMode(mode === "signup" ? "login" : "signup");
                    setProblem("");
                  }}
                >
                  {mode === "signup"
                    ? "I already have one"
                    : "Make a new workspace"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
      <FlowObject state={flow} />
    </section>
  );
}
