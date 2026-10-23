/** Read-only refresh plus explicit revoke; server projections remain the only state source. */
export function createManagementController(
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
  clock = () => Date.now(),
) {
  let epoch = 0,
    disposed = false,
    csrf = null,
    expires = 0;
  let state = {
    status: "SIGNED_OUT",
    authorities: [],
    activity: [],
    error: null,
    selected: null,
  };
  const emit = (s) => {
    if (!disposed) {
      state = s;
      publish(s);
    }
  };
  const session = async () => {
    const s = await transport("/api/activation/session");
    if (
      s?.authenticated !== true ||
      s.mode !== "NON_PRODUCTION_DEMO" ||
      typeof s.csrfToken !== "string" ||
      Date.parse(s.expiresAt) <= clock() ||
      !Number.isFinite(Date.parse(s.expiresAt))
    )
      throw new Error("session");
    csrf = s.csrfToken;
    expires = Date.parse(s.expiresAt);
  };
  const reads = async () => {
    const [a, b] = await Promise.all([
      transport("/api/activation/authorities"),
      transport("/api/activation/activity"),
    ]);
    if (
      a?.version !== "payflow.authorities.v1" ||
      b?.version !== "payflow.activity.v1" ||
      !Array.isArray(a.items) ||
      !Array.isArray(b.items) ||
      a.items.length > 20 ||
      b.items.length > 20
    )
      throw new Error("invalid");
    for (const x of a.items)
      if (
        !x ||
        x.version !== "payflow.authority-view.v1" ||
        typeof x.mandateId !== "string" ||
        !["ACTIVE", "REVOKED", "EXPIRED", "UNAVAILABLE"].includes(x.state) ||
        !x.agent ||
        (x.state !== "ACTIVE" && x.freshDispatchBlocked !== true) ||
        (x.state === "ACTIVE" &&
          (Date.parse(x.expiresAt) <= clock() || x.agent.status !== "ACTIVE"))
      )
        throw new Error("invalid");
    for (const x of b.items)
      if (
        !x ||
        typeof x.operationId !== "string" ||
        ![
          "VERIFIED",
          "INCOMPLETE",
          "INVALID",
          "UNKNOWN_FINANCIAL_OUTCOME",
          "LEGACY",
        ].includes(x.verification) ||
        !["YES", "NO", "UNKNOWN"].includes(x.moneyMoved)
      )
        throw new Error("invalid");
    if (clock() >= expires) throw new Error("session");
    return { authorities: a.items, activity: b.items };
  };
  return {
    getState: () => state,
    dispose() {
      disposed = true;
      epoch++;
      csrf = null;
    },
    async refresh() {
      if (
        ["REVOKING", "VERIFYING", "CONFIRM_REVOKE", "LOADING"].includes(
          state.status,
        )
      )
        return;
      const n = ++epoch;
      emit({ ...state, status: "LOADING", error: null });
      try {
        await session();
        const data = await reads();
        if (n === epoch)
          emit({ ...data, status: "READY", error: null, selected: null });
      } catch {
        if (n === epoch) {
          csrf = null;
          emit({
            status: "UNAVAILABLE",
            authorities: [],
            activity: [],
            error:
              "Saved state is unavailable. Open a demo session, then refresh.",
            selected: null,
          });
        }
      }
    },
    requestRevoke(id) {
      if (
        state.status !== "READY" ||
        !state.authorities.some(
          (a) => a.mandateId === id && a.state !== "REVOKED",
        )
      )
        return;
      emit({ ...state, status: "CONFIRM_REVOKE", selected: id, error: null });
    },
    cancelRevoke() {
      if (state.status === "CONFIRM_REVOKE")
        emit({ ...state, status: "READY", selected: null });
    },
    async revoke() {
      if (state.status !== "CONFIRM_REVOKE" || !state.selected) return;
      const id = state.selected,
        n = ++epoch,
        prior = state;
      emit({ ...state, status: "REVOKING", error: null });
      try {
        await session();
        const result = await transport("/api/activation/revoke", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-PayFlow-CSRF": csrf,
          },
          body: JSON.stringify({ action: "REVOKE_AUTHORITY", mandateId: id }),
        });
        if (n !== epoch) return;
        if (result?.status !== "REVOKE_RECORDED" || result.mandateId !== id)
          throw new Error("invalid");
        emit({ ...prior, status: "VERIFYING", error: null });
        const data = await reads();
        if (
          !data.authorities.some(
            (a) => a.mandateId === id && a.state === "REVOKED",
          )
        )
          throw new Error("unverified");
        if (n === epoch)
          emit({ ...data, status: "READY", selected: null, error: null });
      } catch {
        if (n === epoch)
          emit({
            ...prior,
            status: "READY",
            selected: null,
            error:
              "Revocation could not be confirmed. The prior view is retained; refresh to check current saved state.",
          });
      }
    },
    expire() {
      if (
        state.status === "READY" &&
        state.authorities.some(
          (a) => a.state === "ACTIVE" && Date.parse(a.expiresAt) <= clock(),
        )
      ) {
        epoch++;
        emit({
          ...state,
          status: "UNAVAILABLE",
          authorities: [],
          error:
            "The displayed authority has reached its expiry. Refresh for current saved state.",
        });
      }
      if (clock() >= expires && csrf) {
        epoch++;
        csrf = null;
        emit({
          status: "SIGNED_OUT",
          authorities: [],
          activity: [],
          error: null,
          selected: null,
        });
      }
    },
  };
}
