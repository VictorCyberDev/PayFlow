/**
 * V3 M68 — agent lifecycle governance. Pure and deterministic. An agent holds authority only while ACTIVE with a credential that has not expired.
 * SUSPENDED agents hold none and can be resumed by a person; REVOKED and RETIRED are final. A credential nearing its end is flagged for rotation
 * before it lapses, so a working agent is not silently cut off, and an overdue credential never keeps working.
 */
/** The same five values the database stores in `organization_agents.lifecycle`. This module adds no state of its own. */
export const AGENT_STATES = [
  "REGISTERED",
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
  "RETIRED",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];
const NEXT: Record<AgentState, readonly AgentState[]> = {
  REGISTERED: ["ACTIVE", "REVOKED", "RETIRED"],
  ACTIVE: ["SUSPENDED", "REVOKED", "RETIRED"],
  SUSPENDED: ["ACTIVE", "REVOKED", "RETIRED"],
  REVOKED: [], // final: a revoked agent is never brought back
  RETIRED: [],
};
export const canMoveAgent = (from: AgentState, to: AgentState) =>
  NEXT[from].includes(to);

export type Readiness =
  | { canAct: true; rotation: "OK" | "ROTATE_SOON" }
  | {
      canAct: false;
      why:
        | "NOT_ACTIVATED"
        | "SUSPENDED"
        | "REVOKED"
        | "RETIRED"
        | "CREDENTIAL_EXPIRED"
        | "CREDENTIAL_NOT_YET_VALID";
    };

export function readiness(
  state: AgentState,
  credential: { issuedAt: string; expiresAt: string },
  now: string,
  rotateWithinDays = 7,
): Readiness {
  if (state === "REGISTERED") return { canAct: false, why: "NOT_ACTIVATED" };
  if (state === "SUSPENDED") return { canAct: false, why: "SUSPENDED" };
  if (state === "REVOKED") return { canAct: false, why: "REVOKED" };
  if (state === "RETIRED") return { canAct: false, why: "RETIRED" };
  const t = Date.parse(now);
  if (t < Date.parse(credential.issuedAt))
    return { canAct: false, why: "CREDENTIAL_NOT_YET_VALID" };
  const left = Date.parse(credential.expiresAt) - t;
  if (!(left > 0)) return { canAct: false, why: "CREDENTIAL_EXPIRED" };
  return {
    canAct: true,
    rotation: left <= rotateWithinDays * 86_400_000 ? "ROTATE_SOON" : "OK",
  };
}
