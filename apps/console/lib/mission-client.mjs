/**
 * Read-only client for the Mission Workspace. It talks to the member API of a PayFlow host with a member API key that lives
 * only in this object (never written to storage, a URL or a log). Every response is validated before it is shown: a section
 * that is missing or malformed is reported as unavailable, never filled in or guessed.
 */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export class MissionApiError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // "AUTH" | "NOT_FOUND" | "UNAVAILABLE" | "INVALID"
  }
}

export function normalizeOrigin(input) {
  const raw = String(input ?? "").trim();
  if (raw === "") return "";
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    return null;
  if (u.username || u.password) return null;
  return u.origin;
}

const record = (m) =>
  isObj(m) &&
  typeof m.missionId === "string" &&
  typeof m.status === "string" &&
  Number.isSafeInteger(m.latestVersion);
const mission = (m) =>
  record(m) &&
  typeof m.missionId === "string" &&
  typeof m.status === "string" &&
  isObj(m.latestContract) &&
  typeof m.latestContract.objective === "string" &&
  typeof m.latestContract.currency === "string" &&
  Number.isSafeInteger(m.latestContract.totalBudgetMinor) &&
  Number.isSafeInteger(m.latestVersion);

export function createMissionClient({
  origin = "",
  token,
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = 20000,
}) {
  const base = normalizeOrigin(origin);
  if (base === null || typeof token !== "string" || token.length < 8)
    throw new MissionApiError("INVALID");
  const get = async (path, check) => {
    let r;
    try {
      r = await fetchImpl(base + path, {
        method: "GET",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new MissionApiError("UNAVAILABLE");
    }
    if (r.status === 401 || r.status === 403) throw new MissionApiError("AUTH");
    if (r.status === 404) throw new MissionApiError("NOT_FOUND");
    if (!r.ok) throw new MissionApiError("UNAVAILABLE");
    let body;
    try {
      body = await r.json();
    } catch {
      throw new MissionApiError("INVALID");
    }
    if (!check(body)) throw new MissionApiError("INVALID");
    return body;
  };
  const enc = (id) => {
    if (typeof id !== "string" || !ID.test(id))
      throw new MissionApiError("INVALID");
    return encodeURIComponent(id);
  };
  const P = "/v1/admin/org/missions";
  return {
    list: () =>
      get(
        `${P}?limit=25`,
        (b) =>
          isObj(b) && Array.isArray(b.missions) && b.missions.every(record),
      ),
    mission: async (id) => {
      const b = await get(
        `${P}/${enc(id)}`,
        (x) => isObj(x) && mission(x.mission),
      );
      return b.mission;
    },
    history: (id) =>
      get(
        `${P}/${enc(id)}/history`,
        (b) =>
          isObj(b) && Array.isArray(b.versions) && Array.isArray(b.transitions),
      ),
    plan: (id) =>
      get(
        `${P}/${enc(id)}/plans`,
        (b) => isObj(b) && Array.isArray(b.plans) && Array.isArray(b.tasks),
      ),
    ledger: (id) =>
      get(
        `${P}/${enc(id)}/ledger`,
        (b) =>
          isObj(b) &&
          isObj(b.summary) &&
          Number.isSafeInteger(b.summary.ceilingMinor) &&
          Number.isSafeInteger(b.summary.exposureMinor) &&
          Array.isArray(b.items),
      ),
    authorities: (id) =>
      get(
        `${P}/${enc(id)}/authorities`,
        (b) => isObj(b) && Array.isArray(b.authorities),
      ),
  };
}

/** Money in the contract's own currency, using that currency's own number of minor digits. */
export function money(minor, currency) {
  try {
    const f = new Intl.NumberFormat("en-US", { style: "currency", currency });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(minor / 10 ** digits);
  } catch {
    return `${minor} minor units of ${currency}`;
  }
}
