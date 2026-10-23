/** Product controller only: an activation response is never an active Authority. */
export function createActivationController(
  publish,
  transport = async (path, options = {}) => {
    const r = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
      ...options,
    });
    if (!r.ok) throw new Error("unavailable");
    return r.json();
  },
  remember = () => {},
  clock = () => Date.now(),
) {
  let csrf = null,
    sessionExpires = 0,
    epoch = 0,
    disposed = false,
    state = { status: "SIGNED_OUT", pending: null, authority: null };
  const emit = (value) => {
    if (!disposed) {
      state = value;
      publish(value);
    }
  };
  const post = (path, body) =>
    transport(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(csrf ? { "X-PayFlow-CSRF": csrf } : {}),
      },
      body: JSON.stringify(body),
    });
  const session = async () => {
    const s = await transport("/api/activation/session");
    if (
      s?.authenticated !== true ||
      s.mode !== "NON_PRODUCTION_DEMO" ||
      typeof s.csrfToken !== "string"
    )
      throw new Error("invalid");
    if (
      !Number.isFinite(Date.parse(s.expiresAt)) ||
      Date.parse(s.expiresAt) <= clock()
    )
      throw new Error("expired");
    csrf = s.csrfToken;
    sessionExpires = Date.parse(s.expiresAt);
  };
  const read = async (id, activeOnly = true) => {
    const a = await transport(
      "/api/activation/authority?mandateId=" + encodeURIComponent(id),
    );
    if (
      !a ||
      a.version !== "payflow.authority-view.v1" ||
      a.mandateId !== id ||
      (activeOnly
        ? a.state !== "ACTIVE"
        : !["ACTIVE", "REVOKED", "EXPIRED", "UNAVAILABLE"].includes(a.state)) ||
      !a.agent ||
      (a.state === "ACTIVE" && a.agent.status !== "ACTIVE") ||
      !Number.isSafeInteger(a.singleMaximumMinor) ||
      !Number.isSafeInteger(a.remainingMinor) ||
      !Number.isFinite(Date.parse(a.expiresAt)) ||
      (a.state === "ACTIVE" && Date.parse(a.expiresAt) <= clock())
    )
      throw new Error("invalid");
    return a;
  };
  return {
    getState: () => state,
    dispose() {
      disposed = true;
      epoch++;
      csrf = null;
    },
    invalidate() {
      epoch++;
      if (state.status === "ACTIVE") return;
      emit({
        status: csrf ? "IDLE" : "SIGNED_OUT",
        pending: null,
        authority: null,
      });
    },
    async restore(id = null) {
      const n = ++epoch;
      try {
        await session();
        const a = id ? await read(id, false) : null;
        if (n === epoch)
          emit({
            status: a
              ? a.state === "ACTIVE"
                ? "ACTIVE"
                : "AUTHORITY"
              : "IDLE",
            pending: null,
            authority: a,
          });
      } catch {
        if (n === epoch) {
          csrf = null;
          emit({ status: "SIGNED_OUT", pending: null, authority: null });
        }
      }
    },
    async login(bootstrapCode) {
      const n = ++epoch;
      try {
        await post("/api/activation/session", { bootstrapCode });
        await session();
        if (n === epoch)
          emit({ status: "IDLE", pending: null, authority: null });
      } catch {
        if (n === epoch)
          emit({ status: "SIGNED_OUT", pending: null, authority: null });
      }
    },
    async logout() {
      epoch++;
      let status = "SIGNED_OUT";
      try {
        await post("/api/activation/logout", {});
      } catch {
        status = "ERROR";
      }
      csrf = null;
      emit({ status, pending: null, authority: null });
    },
    async prepare(source) {
      const n = ++epoch;
      emit({ status: "PREPARING", pending: null, authority: null });
      try {
        const p = await post("/api/activation/reviews", { source });
        if (
          !p ||
          p.status !== "PENDING_REVIEW" ||
          p.authority !== "NOT_YET_AUTHORIZED" ||
          p.mode !== "NON_PRODUCTION_DEMO" ||
          p.source !== source ||
          typeof p.reviewId !== "string" ||
          !/^[a-f0-9]{64}$/.test(p.displayHash) ||
          !Array.isArray(p.terms) ||
          !Number.isFinite(Date.parse(p.expiresAt)) ||
          Date.parse(p.expiresAt) <= clock()
        )
          throw new Error("invalid");
        if (n === epoch)
          emit({ status: "PENDING", pending: p, authority: null });
      } catch {
        if (n === epoch)
          emit({ status: "ERROR", pending: null, authority: null });
      }
    },
    async confirm() {
      const p = state.pending;
      if (!p || state.status !== "PENDING") return;
      const n = ++epoch;
      emit({ status: "CONFIRMING", pending: p, authority: null });
      try {
        const result = await post("/api/activation/confirm", {
          action: "CONFIRM_EXACT_TERMS",
          reviewId: p.reviewId,
          displayHash: p.displayHash,
        });
        if (n !== epoch) return;
        if (
          result?.status !== "ACTIVATED" ||
          typeof result.mandateId !== "string"
        )
          throw new Error("invalid");
        emit({ status: "VERIFYING", pending: null, authority: null });
        const a = await read(result.mandateId);
        if (n === epoch) {
          remember(result.mandateId);
          emit({ status: "ACTIVE", pending: null, authority: a });
        }
      } catch {
        if (n === epoch)
          emit({ status: "ERROR", pending: null, authority: null });
      }
    },
    expire() {
      if (csrf && clock() >= sessionExpires) {
        epoch++;
        csrf = null;
        emit({ status: "SIGNED_OUT", pending: null, authority: null });
        return;
      }
      if (state.authority && clock() >= Date.parse(state.authority.expiresAt)) {
        epoch++;
        emit({ status: "ERROR", pending: null, authority: null });
        return;
      }
      if (state.pending && Date.parse(state.pending.expiresAt) <= clock()) {
        epoch++;
        emit({ status: "ERROR", pending: null, authority: null });
      }
    },
  };
}
