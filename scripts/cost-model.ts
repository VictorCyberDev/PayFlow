/**
 * PayFlow M15 unit-cost model. Deterministic, pure, no I/O, no clock, no network.
 *
 * Every input carries a provenance:
 *   VERIFIED   - a publicly documented vendor price, with source URL and fetch date.
 *   ESTIMATE   - an explicit engineering/business assumption (never a measurement).
 *   UNVERIFIED - a price that could not be confirmed. The value is null. Calculations
 *                never silently treat it as zero: the result lists it in `unverified`
 *                and marks `complete: false`, and its cost line is omitted, so the
 *                reported total is a LOWER BOUND until the input is resolved.
 *
 * Nothing here is a price list, a forecast or evidence that customers will pay.
 * Revenue figures belong to callers and are HYPOTHETICAL.
 */

export type Provenance = "VERIFIED" | "ESTIMATE" | "UNVERIFIED";

export interface UnitCostInput {
  readonly id: string;
  readonly description: string;
  readonly unit: string;
  /** null if and only if provenance is UNVERIFIED. */
  readonly value: number | null;
  readonly provenance: Provenance;
  /** Required for VERIFIED. */
  readonly sourceUrl?: string;
  /** ISO date, required for VERIFIED. */
  readonly fetchedOn?: string;
  /** Required for ESTIMATE; explains why the number is used. For UNVERIFIED, what is missing. */
  readonly assumption?: string;
}

export type UnitCostTable = readonly UnitCostInput[];

export const FETCH_DATE = "2026-11-02";
const VERCEL_PRICING = "https://vercel.com/docs/pricing";
const VERCEL_REGIONAL = "https://vercel.com/docs/pricing/regional-pricing";
const VERCEL_PRO = "https://vercel.com/docs/plans/pro-plan";
const NEON_PRICING = "https://neon.com/pricing";
const PAYPAL_FEES = "https://www.paypal.com/us/business/paypal-business-fees";

const verified = (
  id: string,
  description: string,
  unit: string,
  value: number,
  sourceUrl: string,
  assumption?: string,
): UnitCostInput => ({
  id,
  description,
  unit,
  value,
  provenance: "VERIFIED",
  sourceUrl,
  fetchedOn: FETCH_DATE,
  ...(assumption === undefined ? {} : { assumption }),
});

const estimate = (
  id: string,
  description: string,
  unit: string,
  value: number,
  assumption: string,
): UnitCostInput => ({
  id,
  description,
  unit,
  value,
  provenance: "ESTIMATE",
  assumption,
});

const unverified = (
  id: string,
  description: string,
  unit: string,
  assumption: string,
): UnitCostInput => ({
  id,
  description,
  unit,
  value: null,
  provenance: "UNVERIFIED",
  assumption,
});

/**
 * The explicit input table. Vendor rates are the UPPER end of the published regional range
 * (region not yet chosen), which is the conservative direction for a cost model.
 * Usage-shape inputs (profile.*) are ESTIMATES: they have NOT been measured on the live system.
 */
export const DEFAULT_INPUTS: UnitCostTable = [
  // ---- Vendor prices -------------------------------------------------------------------
  verified(
    "vercel.activeCpuUsdPerHour",
    "Vercel Functions Active CPU, on-demand",
    "USD per CPU-hour",
    0.221,
    VERCEL_REGIONAL,
    "Published range is $0.128 - $0.221 per hour by region; upper end used because region is undecided.",
  ),
  verified(
    "vercel.provisionedMemoryUsdPerGbHour",
    "Vercel Functions Provisioned Memory, on-demand",
    "USD per GB-hour",
    0.0183,
    VERCEL_REGIONAL,
    "Published range is $0.0106 - $0.0183 per GB-hour by region; upper end used.",
  ),
  unverified(
    "vercel.invocationUsdPerMillion",
    "Vercel Functions invocations, on-demand",
    "USD per 1M invocations",
    "The pricing page lists on-demand invocations as 'N/A' (no per-invocation rate found in the fetched documentation). Not guessed. Cost of invocations is therefore EXCLUDED from totals and surfaced.",
  ),
  verified(
    "vercel.fastDataTransferUsdPerGb",
    "Vercel Fast Data Transfer, on-demand",
    "USD per GB",
    0.35,
    VERCEL_REGIONAL,
    "Published range is $0.15 - $0.35 per GB; upper end used. Pro Flat Rate CDN includes 1 TB/month and 1M CDN requests, which would make small-tier egress $0; the conservative upper rate is kept.",
  ),
  verified(
    "vercel.observabilityUsdPerMillionEvents",
    "Vercel Observability Plus events",
    "USD per 1M events",
    1.2,
    VERCEL_PRICING,
    "Used as the logging/monitoring unit price. Whether PayFlow enables Observability Plus is not confirmed.",
  ),
  verified(
    "vercel.proPlatformFeeUsdPerMonth",
    "Vercel Pro platform fee (1 deploying seat; includes $20 usage credit)",
    "USD per month",
    20,
    VERCEL_PRO,
    "The $20 monthly usage credit is deliberately NOT subtracted from usage (conservative); it would offset the first $20 of usage.",
  ),
  verified(
    "neon.computeUsdPerCuHour",
    "Neon Launch plan compute",
    "USD per CU-hour",
    0.106,
    NEON_PRICING,
    "Scale plan is $0.222 per CU-hour. Launch assumed; production plan choice is not made.",
  ),
  verified(
    "neon.storageUsdPerGbMonth",
    "Neon storage",
    "USD per GB-month",
    0.35,
    NEON_PRICING,
  ),
  verified(
    "paypal.checkoutPercentFee",
    "PayPal Checkout standard US merchant fee, percentage component",
    "fraction of transaction amount",
    0.0349,
    PAYPAL_FEES,
    "Charged by PayPal to the receiving merchant under their PayPal agreement. NOT a PayFlow cost of goods; excluded from every PayFlow cost calculation. Informational only.",
  ),
  verified(
    "paypal.checkoutFixedFeeUsd",
    "PayPal Checkout standard US merchant fee, fixed component (USD)",
    "USD per transaction",
    0.49,
    PAYPAL_FEES,
    "Same caveat as above. Fees vary by account, volume, currency and corridor.",
  ),
  // ---- Platform-level fixed assumptions -------------------------------------------------
  estimate(
    "fixed.neonBaselineCuHoursPerMonth",
    "Neon baseline always-on compute for the shared production database",
    "CU-hours per month",
    182.5,
    "0.25 CU x 730 hours, i.e. assumes the compute never scales to zero. A real figure depends on Neon autoscaling/suspend settings that are not decided.",
  ),
  estimate(
    "fixed.monthlySupportHoursPerActiveOrg",
    "Support and success time per active organization",
    "hours per org per month",
    2,
    "Assumption for a developer-preview to early-production product: 2 hours per active organization per month of engineer/founder time. Not measured; there are no customers.",
  ),
  estimate(
    "fixed.supportUsdPerHour",
    "Loaded cost of support time",
    "USD per hour",
    75,
    "Placeholder opportunity cost of an engineer's time. No payroll data was used. Treat as an assumption to be replaced.",
  ),
  estimate(
    "fixed.retentionMonths",
    "Months that evidence/proof/audit records are retained in the database",
    "months",
    12,
    "Assumed retention for audit evidence. No retention policy has been agreed with any customer or counsel.",
  ),
  // ---- Authority evaluation profile (ESTIMATES, unmeasured) --------------------------------
  estimate(
    "profile.authority.activeCpuMs",
    "Active CPU per Authority evaluation",
    "ms",
    15,
    "Engineering guess for validation + policy evaluation + one transactional replay claim. Not benchmarked on Vercel.",
  ),
  estimate(
    "profile.authority.wallMs",
    "Wall-clock function duration per Authority evaluation",
    "ms",
    60,
    "Guess: dominated by 2-4 round trips to Postgres.",
  ),
  estimate(
    "profile.authority.memoryGb",
    "Provisioned function memory",
    "GB",
    1,
    "Assumes a 1 GB function size. Actual configured size not read from deployment settings.",
  ),
  estimate(
    "profile.authority.dbCuSeconds",
    "Neon incremental compute per Authority evaluation",
    "CU-seconds",
    0.05,
    "Guess: about 0.2 s of a 0.25 CU endpoint. Ignores the baseline, which is modelled as fixed.",
  ),
  estimate(
    "profile.authority.storedBytes",
    "Bytes persisted per Authority evaluation",
    "bytes",
    2000,
    "Guess: replay claim, decision record and audit event rows including indexes.",
  ),
  estimate(
    "profile.authority.egressBytes",
    "Response bytes per Authority evaluation",
    "bytes",
    3000,
    "Guess for a JSON decision response.",
  ),
  estimate(
    "profile.authority.logEvents",
    "Observability events per Authority evaluation",
    "events",
    2,
    "Guess: one request log plus one structured gateway event.",
  ),
  // ---- Verify profile (ESTIMATES, unmeasured) -----------------------------------------------
  estimate(
    "profile.verify.activeCpuMs",
    "Active CPU per Verify call",
    "ms",
    5,
    "Guess: signature verification of a portable proof; no model calls.",
  ),
  estimate(
    "profile.verify.wallMs",
    "Wall-clock function duration per Verify call",
    "ms",
    25,
    "Guess; assumes verification keys are cached in memory.",
  ),
  estimate(
    "profile.verify.memoryGb",
    "Provisioned function memory",
    "GB",
    1,
    "Same size assumption as Authority path.",
  ),
  estimate(
    "profile.verify.dbCuSeconds",
    "Neon incremental compute per Verify call",
    "CU-seconds",
    0.02,
    "Guess: at most one read.",
  ),
  estimate(
    "profile.verify.storedBytes",
    "Bytes persisted per Verify call",
    "bytes",
    0,
    "Assumes verification is stateless and unlogged beyond observability events. If verification requests become metered rows this must change.",
  ),
  estimate(
    "profile.verify.egressBytes",
    "Response bytes per Verify call",
    "bytes",
    4000,
    "Guess for a verification result document.",
  ),
  estimate(
    "profile.verify.logEvents",
    "Observability events per Verify call",
    "events",
    1,
    "Guess: request log only.",
  ),
  // ---- Execution profile (ESTIMATES, unmeasured) ----------------------------------------------
  estimate(
    "profile.execution.activeCpuMs",
    "Active CPU per execution (excludes waiting on the rail)",
    "ms",
    40,
    "Guess: Authority evaluation work plus grant minting, proof assembly and signing.",
  ),
  estimate(
    "profile.execution.wallMs",
    "Wall-clock function duration per execution",
    "ms",
    1200,
    "Guess: includes awaiting a PayPal Sandbox API round trip (about 1 s). Provisioned memory is billed for this wall time.",
  ),
  estimate(
    "profile.execution.memoryGb",
    "Provisioned function memory",
    "GB",
    1,
    "Same size assumption as Authority path.",
  ),
  estimate(
    "profile.execution.dbCuSeconds",
    "Neon incremental compute per execution",
    "CU-seconds",
    0.3,
    "Guess: several transactional reads and writes (grant, attempt, outcome, proof).",
  ),
  estimate(
    "profile.execution.storedBytes",
    "Bytes persisted per execution",
    "bytes",
    8000,
    "Guess: execution grant, attempt, rail reference, proof and audit rows including indexes.",
  ),
  estimate(
    "profile.execution.egressBytes",
    "Response bytes per execution",
    "bytes",
    5000,
    "Guess: outcome plus proof link metadata.",
  ),
  estimate(
    "profile.execution.logEvents",
    "Observability events per execution",
    "events",
    4,
    "Guess: request log plus lifecycle events.",
  ),
  // ---- Model calls -----------------------------------------------------------------------------
  estimate(
    "profile.modelCallsPerAuthorityEvaluation",
    "LLM/model calls in the Authority evaluation path",
    "calls",
    0,
    "By design the Trust Kernel decision path is deterministic code and calls no model. This input exists so the claim is explicit and auditable. Any model-based feature outside this path is out of scope of this model.",
  ),
];

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/** Throws on malformed, negative, non-finite or silently-missing inputs. */
export function validateInputs(table: UnitCostTable): void {
  const seen = new Set<string>();
  for (const input of table) {
    if (seen.has(input.id)) throw new Error(`DUPLICATE_INPUT:${input.id}`);
    seen.add(input.id);
    if (input.provenance === "UNVERIFIED") {
      if (input.value !== null) {
        throw new Error(`UNVERIFIED_INPUT_MUST_BE_NULL:${input.id}`);
      }
      continue;
    }
    if (input.value === null || !Number.isFinite(input.value)) {
      throw new Error(`INPUT_NOT_FINITE:${input.id}`);
    }
    if (input.value < 0) throw new Error(`NEGATIVE_COST_INPUT:${input.id}`);
    if (
      input.provenance === "VERIFIED" &&
      (!input.sourceUrl || !input.fetchedOn)
    ) {
      throw new Error(`VERIFIED_INPUT_NEEDS_SOURCE:${input.id}`);
    }
    if (input.provenance === "ESTIMATE" && !input.assumption) {
      throw new Error(`ESTIMATE_INPUT_NEEDS_ASSUMPTION:${input.id}`);
    }
  }
}

function assertCount(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`INVALID_USAGE:${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------------------------

export interface CostLine {
  readonly id: string;
  readonly description: string;
  readonly costUsd: number;
}

export interface CostResult {
  /** Sum of the lines that could be computed. A LOWER BOUND when `complete` is false. */
  readonly totalUsd: number;
  readonly lines: readonly CostLine[];
  /** True only if every needed input was VERIFIED or ESTIMATE. */
  readonly complete: boolean;
  /** Input ids that were needed but UNVERIFIED; never silently zeroed. */
  readonly unverified: readonly string[];
  /** Input ids that contributed while being ESTIMATE. */
  readonly estimated: readonly string[];
}

class Calc {
  private readonly byId: ReadonlyMap<string, UnitCostInput>;
  readonly lines: CostLine[] = [];
  readonly unverified = new Set<string>();
  readonly estimated = new Set<string>();

  constructor(table: UnitCostTable) {
    validateInputs(table);
    this.byId = new Map(table.map((entry) => [entry.id, entry]));
  }

  /** Looks up a value, recording provenance. Returns null for UNVERIFIED. */
  value(id: string): number | null {
    const entry = this.byId.get(id);
    if (!entry) throw new Error(`UNKNOWN_INPUT:${id}`);
    if (entry.provenance === "UNVERIFIED") {
      this.unverified.add(id);
      return null;
    }
    if (entry.provenance === "ESTIMATE") this.estimated.add(id);
    return entry.value;
  }

  /** Adds a line = constant x product(values). Omitted (and surfaced) if any factor is UNVERIFIED. */
  line(
    id: string,
    description: string,
    constant: number,
    factors: readonly string[],
  ): void {
    let product = constant;
    let missing = false;
    for (const factor of factors) {
      const v = this.value(factor);
      if (v === null) missing = true;
      else product *= v;
    }
    if (missing) return;
    this.lines.push({ id, description, costUsd: product });
  }

  result(): CostResult {
    let total = 0;
    for (const entry of this.lines) total += entry.costUsd;
    return {
      totalUsd: total,
      lines: this.lines,
      complete: this.unverified.size === 0,
      unverified: [...this.unverified].sort(),
      estimated: [...this.estimated].sort(),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Per-operation cost
// ---------------------------------------------------------------------------------------------

export type OperationKind = "authority" | "verify" | "execution";

const MS_PER_HOUR = 3_600_000;
const SECONDS_PER_HOUR = 3600;
const BYTES_PER_GB = 1_000_000_000;

function addOperationLines(
  calc: Calc,
  kind: OperationKind,
  count: number,
): void {
  const p = `profile.${kind}`;
  calc.line(`${kind}.cpu`, "Vercel Active CPU", count / MS_PER_HOUR, [
    `${p}.activeCpuMs`,
    "vercel.activeCpuUsdPerHour",
  ]);
  calc.line(
    `${kind}.memory`,
    "Vercel Provisioned Memory (wall time)",
    count / MS_PER_HOUR,
    [`${p}.wallMs`, `${p}.memoryGb`, "vercel.provisionedMemoryUsdPerGbHour"],
  );
  calc.line(`${kind}.invocations`, "Vercel invocations", count / 1_000_000, [
    "vercel.invocationUsdPerMillion",
  ]);
  calc.line(
    `${kind}.dbCompute`,
    "Neon incremental compute",
    count / SECONDS_PER_HOUR,
    [`${p}.dbCuSeconds`, "neon.computeUsdPerCuHour"],
  );
  calc.line(
    `${kind}.dbStorage`,
    "Neon storage over retention period",
    count / BYTES_PER_GB,
    [`${p}.storedBytes`, "fixed.retentionMonths", "neon.storageUsdPerGbMonth"],
  );
  calc.line(
    `${kind}.egress`,
    "Vercel Fast Data Transfer",
    count / BYTES_PER_GB,
    [`${p}.egressBytes`, "vercel.fastDataTransferUsdPerGb"],
  );
  calc.line(
    `${kind}.logging`,
    "Logging / monitoring events",
    count / 1_000_000,
    [`${p}.logEvents`, "vercel.observabilityUsdPerMillionEvents"],
  );
  if (kind === "authority") {
    // Model calls: the Authority path calls none. Included as an explicit zero-cost factor
    // of 0 x (no price needed) so a nonzero estimate would be flagged for pricing.
    const calls = calc.value("profile.modelCallsPerAuthorityEvaluation");
    if (calls !== null && calls > 0) {
      throw new Error("MODEL_CALLS_IN_AUTHORITY_PATH_NOT_PRICED");
    }
  }
}

/** Variable cost of `count` operations of a kind. */
export function operationCost(
  table: UnitCostTable,
  kind: OperationKind,
  count: number,
): CostResult {
  assertCount("count", count);
  const calc = new Calc(table);
  addOperationLines(calc, kind, count);
  return calc.result();
}

export function costPer1000AuthorityEvaluations(
  table: UnitCostTable = DEFAULT_INPUTS,
): CostResult {
  return operationCost(table, "authority", 1000);
}

export function costPer1000VerifyCalls(
  table: UnitCostTable = DEFAULT_INPUTS,
): CostResult {
  return operationCost(table, "verify", 1000);
}

export function costPer1000Executions(
  table: UnitCostTable = DEFAULT_INPUTS,
): CostResult {
  return operationCost(table, "execution", 1000);
}

// ---------------------------------------------------------------------------------------------
// Per organization / per agent
// ---------------------------------------------------------------------------------------------

export interface OrganizationUsage {
  readonly authorityEvaluations: number;
  readonly verifyCalls: number;
  readonly executions: number;
  readonly activeAgents: number;
  /** Number of active organizations sharing the platform fixed cost. Must be >= 1. */
  readonly orgsSharingFixedCosts: number;
  /** Multiplier on support hours (1 = default estimate). 0 = no support. */
  readonly supportMultiplier?: number;
}

/** Monthly platform fixed cost (Vercel Pro fee + Neon baseline compute), total not allocated. */
export function platformFixedMonthly(
  table: UnitCostTable = DEFAULT_INPUTS,
): CostResult {
  const calc = new Calc(table);
  calc.line("fixed.vercelPro", "Vercel Pro platform fee", 1, [
    "vercel.proPlatformFeeUsdPerMonth",
  ]);
  calc.line("fixed.neonBaseline", "Neon baseline compute", 1, [
    "fixed.neonBaselineCuHoursPerMonth",
    "neon.computeUsdPerCuHour",
  ]);
  return calc.result();
}

/** Monthly cost to serve one active organization: variable usage + support + fixed share. */
export function costPerActiveOrganization(
  table: UnitCostTable,
  usage: OrganizationUsage,
): CostResult {
  assertCount("authorityEvaluations", usage.authorityEvaluations);
  assertCount("verifyCalls", usage.verifyCalls);
  assertCount("executions", usage.executions);
  assertCount("activeAgents", usage.activeAgents);
  if (
    !Number.isFinite(usage.orgsSharingFixedCosts) ||
    usage.orgsSharingFixedCosts < 1
  ) {
    throw new Error("INVALID_USAGE:orgsSharingFixedCosts");
  }
  const support = usage.supportMultiplier ?? 1;
  assertCount("supportMultiplier", support);

  const calc = new Calc(table);
  addOperationLines(calc, "authority", usage.authorityEvaluations);
  addOperationLines(calc, "verify", usage.verifyCalls);
  addOperationLines(calc, "execution", usage.executions);
  calc.line("support", "Support time", support, [
    "fixed.monthlySupportHoursPerActiveOrg",
    "fixed.supportUsdPerHour",
  ]);
  calc.line(
    "fixed.vercelPro",
    "Vercel Pro platform fee (share)",
    1 / usage.orgsSharingFixedCosts,
    ["vercel.proPlatformFeeUsdPerMonth"],
  );
  calc.line(
    "fixed.neonBaseline",
    "Neon baseline compute (share)",
    1 / usage.orgsSharingFixedCosts,
    ["fixed.neonBaselineCuHoursPerMonth", "neon.computeUsdPerCuHour"],
  );
  return calc.result();
}

/** Org cost divided by active agents. Throws if there are no active agents. */
export function costPerActiveAgent(
  table: UnitCostTable,
  usage: OrganizationUsage,
): CostResult {
  if (!(usage.activeAgents > 0)) throw new Error("NO_ACTIVE_AGENTS");
  const org = costPerActiveOrganization(table, usage);
  return {
    ...org,
    totalUsd: org.totalUsd / usage.activeAgents,
    lines: org.lines.map((entry) => ({
      ...entry,
      costUsd: entry.costUsd / usage.activeAgents,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Margin
// ---------------------------------------------------------------------------------------------

/** (revenue - cost) / revenue. Revenue must be > 0 and cost >= 0. */
export function grossMargin(revenueUsd: number, costUsd: number): number {
  if (!Number.isFinite(revenueUsd) || revenueUsd <= 0) {
    throw new Error("INVALID_REVENUE");
  }
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error("NEGATIVE_COST");
  }
  return (revenueUsd - costUsd) / revenueUsd;
}

/** Informational: the PayPal merchant fee on a payment. Borne by the merchant, not by PayFlow. */
export function paypalMerchantFeeUsd(
  table: UnitCostTable,
  amountUsd: number,
): number {
  assertCount("amountUsd", amountUsd);
  const calc = new Calc(table);
  const pct = calc.value("paypal.checkoutPercentFee");
  const fixed = calc.value("paypal.checkoutFixedFeeUsd");
  if (pct === null || fixed === null) throw new Error("PAYPAL_FEE_UNVERIFIED");
  return amountUsd * pct + fixed;
}

/** Returns a copy of the table with one input's value multiplied. Provenance is preserved. */
export function scaleInput(
  table: UnitCostTable,
  id: string,
  factor: number,
): UnitCostTable {
  if (!Number.isFinite(factor) || factor < 0) {
    throw new Error("INVALID_SCALE_FACTOR");
  }
  let found = false;
  const next = table.map((entry) => {
    if (entry.id !== id) return entry;
    found = true;
    if (entry.value === null) return entry;
    return { ...entry, value: entry.value * factor };
  });
  if (!found) throw new Error(`UNKNOWN_INPUT:${id}`);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Illustrative gross-margin tiers. ALL REVENUE IS HYPOTHETICAL.
// ---------------------------------------------------------------------------------------------

export interface IllustrativeTier {
  readonly name: string;
  readonly usage: OrganizationUsage;
  readonly storageNote: string;
  /** HYPOTHETICAL monthly revenue in USD. Not a price, not validated. */
  readonly hypotheticalRevenueUsd: number;
  readonly revenueBasis: string;
}

export const ILLUSTRATIVE_TIERS: readonly IllustrativeTier[] = [
  {
    name: "Small developer",
    usage: {
      authorityEvaluations: 10_000,
      verifyCalls: 20_000,
      executions: 2_000,
      activeAgents: 3,
      orgsSharingFixedCosts: 50,
    },
    storageNote: "Derived from per-operation stored bytes x retention",
    hypotheticalRevenueUsd: 100,
    revenueBasis:
      "HYPOTHETICAL: 10,000 governed actions x $0.01 (the placeholder governedActionMinor=1 in src/network/metering.ts); verifies free.",
  },
  {
    name: "Mid-market",
    usage: {
      authorityEvaluations: 500_000,
      verifyCalls: 1_000_000,
      executions: 100_000,
      activeAgents: 40,
      orgsSharingFixedCosts: 10,
    },
    storageNote: "Derived from per-operation stored bytes x retention",
    hypotheticalRevenueUsd: 5_000,
    revenueBasis:
      "HYPOTHETICAL: 500,000 governed actions x $0.01; verifies free.",
  },
  {
    name: "Enterprise",
    usage: {
      authorityEvaluations: 5_000_000,
      verifyCalls: 10_000_000,
      executions: 1_000_000,
      activeAgents: 400,
      orgsSharingFixedCosts: 5,
      supportMultiplier: 10,
    },
    storageNote: "Derived from per-operation stored bytes x retention",
    hypotheticalRevenueUsd: 22_000,
    revenueBasis:
      "HYPOTHETICAL: $2,000 platform fee + 5,000,000 governed actions x $0.004; verifies free. Support is modelled at 10x the default hours.",
  },
];

export interface TierReport {
  readonly tier: IllustrativeTier;
  readonly cost: CostResult;
  readonly margin: number;
  readonly dominantLine: CostLine;
  readonly sensitivity: readonly {
    readonly factor: number;
    readonly costUsd: number;
    readonly margin: number;
  }[];
}

/** The input id whose scaling moves the dominant cost line. */
const DOMINANT_LINE_INPUT: Readonly<Record<string, string>> = {
  support: "fixed.supportUsdPerHour",
  "fixed.neonBaseline": "fixed.neonBaselineCuHoursPerMonth",
  "fixed.vercelPro": "vercel.proPlatformFeeUsdPerMonth",
  "authority.memory": "vercel.provisionedMemoryUsdPerGbHour",
  "verify.memory": "vercel.provisionedMemoryUsdPerGbHour",
  "execution.memory": "vercel.provisionedMemoryUsdPerGbHour",
  "authority.cpu": "vercel.activeCpuUsdPerHour",
  "verify.cpu": "vercel.activeCpuUsdPerHour",
  "execution.cpu": "vercel.activeCpuUsdPerHour",
  "authority.dbCompute": "neon.computeUsdPerCuHour",
  "verify.dbCompute": "neon.computeUsdPerCuHour",
  "execution.dbCompute": "neon.computeUsdPerCuHour",
  "authority.dbStorage": "neon.storageUsdPerGbMonth",
  "verify.dbStorage": "neon.storageUsdPerGbMonth",
  "execution.dbStorage": "neon.storageUsdPerGbMonth",
  "authority.egress": "vercel.fastDataTransferUsdPerGb",
  "verify.egress": "vercel.fastDataTransferUsdPerGb",
  "execution.egress": "vercel.fastDataTransferUsdPerGb",
  "authority.logging": "vercel.observabilityUsdPerMillionEvents",
  "verify.logging": "vercel.observabilityUsdPerMillionEvents",
  "execution.logging": "vercel.observabilityUsdPerMillionEvents",
};

export const SENSITIVITY_FACTORS: readonly number[] = [0.5, 1, 2, 5, 10];

export function reportTier(
  table: UnitCostTable,
  tier: IllustrativeTier,
): TierReport {
  const cost = costPerActiveOrganization(table, tier.usage);
  const dominantLine = cost.lines.reduce((a, b) =>
    b.costUsd > a.costUsd ? b : a,
  );
  const inputId = DOMINANT_LINE_INPUT[dominantLine.id];
  const sensitivity = SENSITIVITY_FACTORS.map((factor) => {
    const scaled =
      inputId === undefined ? table : scaleInput(table, inputId, factor);
    const costUsd = costPerActiveOrganization(scaled, tier.usage).totalUsd;
    return {
      factor,
      costUsd,
      margin: grossMargin(tier.hypotheticalRevenueUsd, costUsd),
    };
  });
  return {
    tier,
    cost,
    margin: grossMargin(tier.hypotheticalRevenueUsd, cost.totalUsd),
    dominantLine,
    sensitivity,
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown rendering (deterministic) for docs/economics
// ---------------------------------------------------------------------------------------------

const usd = (value: number): string =>
  `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 6 : 2,
  })}`;
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function renderUnitCostsMarkdown(
  table: UnitCostTable = DEFAULT_INPUTS,
): string {
  const rows = table.map((entry) => {
    const value =
      entry.value === null ? "UNVERIFIED (no value)" : `${entry.value}`;
    const source =
      entry.provenance === "VERIFIED"
        ? `${entry.sourceUrl ?? ""} (fetched ${entry.fetchedOn ?? ""})`
        : "";
    return `| \`${entry.id}\` | ${entry.provenance} | ${value} | ${entry.unit} | ${source} | ${entry.assumption ?? ""} |`;
  });
  return [
    "| Input | Provenance | Value | Unit | Source | Assumption / note |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function renderPerThousandMarkdown(
  table: UnitCostTable = DEFAULT_INPUTS,
): string {
  const entries: readonly [string, CostResult][] = [
    ["Authority evaluations", costPer1000AuthorityEvaluations(table)],
    ["Verify calls", costPer1000VerifyCalls(table)],
    ["Executions", costPer1000Executions(table)],
  ];
  const lines = [
    "| Per 1,000 | Computed cost (USD, lower bound if incomplete) | Complete? | Unverified inputs excluded |",
    "| --- | --- | --- | --- |",
  ];
  for (const [name, result] of entries) {
    lines.push(
      `| ${name} | ${usd(result.totalUsd)} | ${result.complete ? "yes" : "NO"} | ${result.unverified.join(", ") || "none"} |`,
    );
  }
  return lines.join("\n");
}

export function renderGrossMarginMarkdown(
  table: UnitCostTable = DEFAULT_INPUTS,
): string {
  const out: string[] = [];
  out.push(
    "| Tier | Authority evals | Verifies | Executions | Active agents | Variable cost | Support | Fixed share | Total cost | HYPOTHETICAL revenue | Gross margin |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  const reports = ILLUSTRATIVE_TIERS.map((tier) => reportTier(table, tier));
  for (const r of reports) {
    const sum = (prefix: string) =>
      r.cost.lines
        .filter((entry) => entry.id.startsWith(prefix))
        .reduce((acc, entry) => acc + entry.costUsd, 0);
    const support = sum("support");
    const fixed = sum("fixed.");
    const variable = r.cost.totalUsd - support - fixed;
    out.push(
      `| ${r.tier.name} | ${r.tier.usage.authorityEvaluations.toLocaleString("en-US")} | ${r.tier.usage.verifyCalls.toLocaleString("en-US")} | ${r.tier.usage.executions.toLocaleString("en-US")} | ${r.tier.usage.activeAgents} | ${usd(variable)} | ${usd(support)} | ${usd(fixed)} | ${usd(r.cost.totalUsd)} | ${usd(r.tier.hypotheticalRevenueUsd)} | ${pct(r.margin)} |`,
    );
  }
  out.push("");
  for (const r of reports) {
    out.push(`### ${r.tier.name}`, "");
    out.push(`- Revenue basis: ${r.tier.revenueBasis}`);
    out.push(
      `- Orgs assumed to share platform fixed cost: ${r.tier.usage.orgsSharingFixedCosts}`,
    );
    out.push(
      `- Complete: ${r.cost.complete ? "yes" : "NO - lower bound; excludes UNVERIFIED inputs: " + r.cost.unverified.join(", ")}`,
    );
    out.push(
      `- Dominant cost line: \`${r.dominantLine.id}\` (${r.dominantLine.description}) = ${usd(r.dominantLine.costUsd)} of ${usd(r.cost.totalUsd)}`,
    );
    out.push("", "| Dominant-cost multiplier | Total cost | Gross margin |");
    out.push("| ---: | ---: | ---: |");
    for (const s of r.sensitivity) {
      out.push(`| ${s.factor}x | ${usd(s.costUsd)} | ${pct(s.margin)} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

// CLI: node --import tsx scripts/cost-model.ts [--inputs|--per-thousand|--margin]
const entry = process.argv[1] ?? "";
if (entry.endsWith("cost-model.ts") && !process.env["VITEST"]) {
  const mode = process.argv[2] ?? "--margin";
  if (mode === "--inputs") console.log(renderUnitCostsMarkdown());
  else if (mode === "--per-thousand") console.log(renderPerThousandMarkdown());
  else console.log(renderGrossMarginMarkdown());
}
