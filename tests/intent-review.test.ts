import { describe, it, expect, vi } from "vitest";
import {
  createDemoReview,
  demoReviewBounds,
  demoIntentSource,
  recordedInterpretation,
} from "../src/intent-review-demo.js";
import {
  IntentReviewService,
  IntentReviewSchema,
} from "../src/intent-review.js";
import {
  FakeIntentModelProvider,
  type IntentModelProvider,
} from "../src/intent-model.js";
import { MandateSchema } from "../src/domain.js";
import { readFile } from "node:fs/promises";
const now = new Date("2026-10-22T10:00:00.000Z"),
  expiry = "2026-10-22T11:00:00.000Z",
  source = demoIntentSource(expiry);
function candidate() {
  return recordedInterpretation({ reference: "test", text: source }, expiry);
}
function run(raw: unknown, request: unknown = { source }) {
  const provider: IntentModelProvider = {
    interpretIntent(s) {
      const c =
        typeof raw === "object" && raw !== null
          ? { ...raw, sourceReference: s.reference }
          : raw;
      return new FakeIntentModelProvider(c).interpretIntent();
    },
  };
  return new IntentReviewService(provider, demoReviewBounds, () => now).review(
    request,
  );
}
describe("M5B bounded review", () => {
  it("runs recorded interpretation through existing compiler and semantics, never a mandate", async () => {
    const r = await createDemoReview(() => now).service.review({ source });
    expect(r?.status).toBe("VALID_DRAFT");
    expect(r?.authority).toBe("NOT_YET_AUTHORIZED");
    expect(r?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(r?.terms.find((t) => t.label === "Maximum total")?.value).toBe(
      "$100.00",
    );
    expect(MandateSchema.safeParse(r).success).toBe(false);
  });
  it.each([
    ["maximum", { decimal: "101.00", bound: "INCLUSIVE" }],
    ["currency", "EUR"],
    ["quantity", 2],
    ["conditions", ["USED"]],
    ["merchants", { mode: "ANY" }],
  ])("blocks invented/widened %s", async (field, value) => {
    const c = candidate();
    Object.assign(c.constraints[field as keyof typeof c.constraints], {
      value,
    });
    const r = await run(c);
    expect(r?.status).not.toBe("VALID_DRAFT");
    expect(r?.terms).toEqual([]);
    expect(r?.fingerprint).toBeNull();
  });
  it("semantic disagreement does not silently repair model amount", async () => {
    const c = candidate();
    Object.assign(c.constraints.maximum, {
      value: { decimal: "50.00", bound: "INCLUSIVE" },
    });
    const r = await run(c);
    expect(r?.status).toBe("NEEDS_CLARIFICATION");
    expect(r?.reasonCodes).toContain("maximum:SEMANTIC_SUPPORT_REQUIRED");
    expect(r?.terms).toEqual([]);
  });
  it("missing terms ask one fixed question without a draft", async () => {
    const r = await createDemoReview(() => now).service.review({
      source: "Buy a keyboard under $100 this week.",
    });
    expect(r?.status).toBe("NEEDS_CLARIFICATION");
    expect(r?.question).toBe("What item do you want?");
    expect(r?.terms).toEqual([]);
  });
  it.each([
    null,
    { secret: "private-response" },
    { ...candidate(), activation: true, confirmationToken: "private-response" },
  ])("malformed or activation-bearing model data stays safe", async (c) => {
    const r = await run(c);
    expect(r?.status).toBe("SAFE_PROVIDER_FAILURE");
    expect(JSON.stringify(r)).not.toContain("private-response");
    expect(r?.fingerprint).toBeNull();
  });
  it.each([
    "maximumMinor",
    "currency",
    "quantity",
    "merchantIds",
    "riskCeiling",
    "maximumLifetime",
    "capabilities",
    "principalId",
    "agentId",
    "activationPolicy",
    "reviewBounds",
  ])(
    "rejects client compile/identity field %s before calling provider",
    async (field) => {
      let calls = 0;
      const p: IntentModelProvider = {
        interpretIntent() {
          calls++;
          return Promise.resolve({ status: "MODEL_UNAVAILABLE" });
        },
      };
      const r = await new IntentReviewService(
        p,
        demoReviewBounds,
        () => now,
      ).review({ source, [field]: 999999 });
      expect(r).toBeNull();
      expect(calls).toBe(0);
    },
  );
  it("provider gets source only, never host bounds", async () => {
    let seen: unknown;
    const p: IntentModelProvider = {
      interpretIntent(s) {
        seen = s;
        return Promise.resolve({ status: "MODEL_UNAVAILABLE" });
      },
    };
    await new IntentReviewService(p, demoReviewBounds, () => now).review({
      source,
    });
    expect(Object.keys(seen as object).sort()).toEqual(["reference", "text"]);
  });
  it("provider errors do not expose raw exceptions", async () => {
    const p: IntentModelProvider = {
      interpretIntent() {
        return Promise.reject(new Error("provider-secret"));
      },
    };
    const r = await new IntentReviewService(
      p,
      demoReviewBounds,
      () => now,
    ).review({ source });
    expect(r?.status).toBe("SAFE_PROVIDER_FAILURE");
    expect(JSON.stringify(r)).not.toContain("provider-secret");
  });
  it("bounds an unresponsive provider without retries", async () => {
    vi.useFakeTimers();
    try {
      const p: IntentModelProvider = {
        interpretIntent: () => new Promise(() => {}),
      };
      const task = new IntentReviewService(
        p,
        demoReviewBounds,
        () => now,
      ).review({ source });
      await vi.advanceTimersByTimeAsync(15000);
      expect((await task)?.status).toBe("SAFE_PROVIDER_FAILURE");
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not expose raw provider metadata or chain of thought", async () => {
    const c = {
      ...candidate(),
      reasoning: "provider-secret",
      GROQ_API_KEY: "provider-secret",
    };
    const r = await run(c);
    expect(JSON.stringify(r)).not.toContain("provider-secret");
    expect(
      IntentReviewSchema.safeParse({ ...r, challenge: "injected" }).success,
    ).toBe(false);
  });
  it.each(["", "x".repeat(2001), "🟢".repeat(1001)])(
    "rejects invalid/oversized source",
    async (source) => {
      expect(await run(candidate(), { source })).toBeNull();
    },
  );
  it("review dependency graph has no financial or activation imports", async () => {
    for (const file of [
      "intent-review.ts",
      "intent-review-demo.ts",
      "intent-review-demo-host.ts",
    ]) {
      const code = await readFile(
        new URL("../src/" + file, import.meta.url),
        "utf8",
      );
      expect(code).not.toMatch(
        /from ["'][^"']*(?:activation|persistence|paypal|execution|payment|kernel|service)\.js/,
      );
    }
  });
});
