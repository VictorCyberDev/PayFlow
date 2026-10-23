/** Display-only controller. No stored state, compilation, activation or authority. */
export function createReviewController(
  publish,
  transport = (source, signal) =>
    fetch("/api/intent-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
      signal,
    }).then((r) => {
      if (!r.ok) throw new Error("unavailable");
      return r.json();
    }),
  clock = () => Date.now(),
) {
  let epoch = 0,
    abort,
    state = { status: "EMPTY", source: "", review: null };
  const emit = (value) => {
    state = value;
    publish(value);
  };
  return {
    getState: () => state,
    edit(source) {
      epoch++;
      abort?.abort();
      emit({
        status:
          source &&
          (state.review ||
            ["INTERPRETING", "STALE", "EXPIRED"].includes(state.status))
            ? "STALE"
            : "EMPTY",
        source,
        review: null,
      });
    },
    expire() {
      if (state.review && clock() >= Date.parse(state.review.expiresAt)) {
        epoch++;
        emit({ status: "EXPIRED", source: state.source, review: null });
      }
    },
    dispose() {
      epoch++;
      abort?.abort();
    },
    async submit(source) {
      const request = ++epoch;
      abort?.abort();
      abort = new AbortController();
      if (!source.trim()) {
        emit({ status: "EMPTY", source, review: null });
        return;
      }
      emit({ status: "INTERPRETING", source, review: null });
      let timer;
      try {
        const activeAbort = abort;
        const review = await Promise.race([
          transport(source, activeAbort.signal),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              activeAbort.abort();
              reject(new Error("timeout"));
            }, 20000);
          }),
        ]);
        if (request !== epoch) return;
        if (!validDisplay(review, source)) throw new Error("invalid");
        if (clock() >= Date.parse(review.expiresAt)) {
          emit({ status: "EXPIRED", source, review: null });
          return;
        }
        emit({ status: review.status, source, review });
      } catch {
        if (request === epoch)
          emit({ status: "SAFE_PROVIDER_FAILURE", source, review: null });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function validDisplay(v, source) {
  const string = (x, max) => typeof x === "string" && x.length <= max;
  const terms = (x) =>
    Array.isArray(x) &&
    x.length <= 8 &&
    x.every(
      (t) =>
        t &&
        Object.keys(t).sort().join() === "label,value" &&
        string(t.label, 80) &&
        string(t.value, 2000),
    );
  const keys = [
    "version",
    "authority",
    "source",
    "interpretationStatus",
    "status",
    "fingerprint",
    "interpreted",
    "terms",
    "message",
    "question",
    "reasonCodes",
    "provenance",
    "reviewedAt",
    "expiresAt",
  ];
  return (
    v &&
    Object.keys(v).sort().join() === keys.sort().join() &&
    v.version === "payflow.intent-review.v1" &&
    v.authority === "NOT_YET_AUTHORIZED" &&
    v.source === source &&
    ["INTERPRETED", "UNAVAILABLE"].includes(v.interpretationStatus) &&
    [
      "VALID_DRAFT",
      "NEEDS_CLARIFICATION",
      "REJECTED",
      "SAFE_PROVIDER_FAILURE",
    ].includes(v.status) &&
    (v.fingerprint === null ||
      (typeof v.fingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(v.fingerprint))) &&
    terms(v.terms) &&
    terms(v.interpreted) &&
    string(v.message, 500) &&
    (v.question === null || string(v.question, 500)) &&
    Array.isArray(v.reasonCodes) &&
    v.reasonCodes.length <= 100 &&
    v.reasonCodes.every((x) => string(x, 120)) &&
    v.provenance &&
    Object.keys(v.provenance).sort().join() ===
      "instructionVersion,mode,sourceReference" &&
    v.provenance.mode === "NON_PRODUCTION_REVIEW" &&
    string(v.provenance.instructionVersion, 80) &&
    string(v.provenance.sourceReference, 200) &&
    Number.isFinite(Date.parse(v.reviewedAt)) &&
    Number.isFinite(Date.parse(v.expiresAt)) &&
    (v.status === "VALID_DRAFT"
      ? v.fingerprint !== null
      : v.fingerprint === null &&
        v.terms.length === 0 &&
        v.interpreted.length === 0)
  );
}
