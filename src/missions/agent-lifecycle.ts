/**
 * V3 M66 — agent lifecycle. Pure and deterministic. An agent holds authority only while ACTIVE with a credential that has not expired.
 * SUSPENDED agents hold none and can be resumed by a person; RETIRED is final. A credential nearing its end is flagged for rotation
 * before it lapses, so a working agent is not silently cut off, and an overdue credential never keeps working.
 */
export const AGENT_STATES = [
  "ENROLLED",
  "ACTIVE",
  "SUSPENDED",
  "RETIRED",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];
const NEXT: Record<AgentState, readonly AgentState[]> = {
  ENROLLED: ["ACTIVE", "RETIRED"],
  ACTIVE: ["SUSPENDED", "RETIRED"],
  SUSPENDED: ["ACTIVE", "RETIRED"],
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
  if (state === "ENROLLED") return { canAct: false, why: "NOT_ACTIVATED" };
  if (state === "SUSPENDED") return { canAct: false, why: "SUSPENDED" };
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
