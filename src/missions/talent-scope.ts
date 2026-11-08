import { z } from "zod";

/**
 * V3 M46 — what contractor work a mission may look for. Pure and deterministic.
 *
 * The scope is the rulebook for M47-M50: nothing is shortlisted, offered or paid outside it. It is checked against the mission
 * (currency, caps, deadline, provider type) when proposed and again when the owner approves. It may not screen on protected attributes.
 */
const Text = (n: number) => z.string().trim().min(1).max(n);
const Skill = z.string().trim().min(1).max(60);
export const CHECKS = [
  "IDENTITY_VERIFIED",
  "PORTFOLIO_REVIEWED",
  "REFERENCES_CHECKED",
  "WORK_AUTHORIZATION_CONFIRMED",
  "CLASSIFICATION_REVIEWED",
] as const;
export const RoleSchema = z
  .object({
    roleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u),
    title: Text(100),
    requiredSkills: z.array(Skill).min(1).max(20),
    preferredSkills: z.array(Skill).max(20).default([]),
    engagement: z.enum(["FIXED_PRICE", "HOURLY", "RETAINER"]),
    /** Hourly engagements: the highest hourly rate that may be offered. */
    maxHourlyRateMinor: z
      .number()
      .int()
      .safe()
      .min(1)
      .max(1_000_000_00)
      .optional(),
    maxHoursPerWeek: z.number().int().min(1).max(80).optional(),
    durationWeeks: z.number().int().min(1).max(104).optional(),
    budgetCapMinor: z.number().int().safe().min(1).max(1_000_000_000_000),
    deliverables: z.array(Text(200)).min(1).max(20),
  })
  .strict()
  .refine(
    (r) => r.engagement !== "HOURLY" || r.maxHourlyRateMinor !== undefined,
    {
      message: "hourly roles need a maximum rate",
    },
  );
export const TalentScopeSchema = z
  .object({
    category: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    roles: z.array(RoleSchema).min(1).max(10),
    /** Checks a person must record before any offer for this scope. */
    requiredChecks: z.array(z.enum(CHECKS)).min(1).max(CHECKS.length),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (d) => new Set(d.roles.map((r) => r.roleId)).size === d.roles.length,
    {
      message: "role ids must be unique",
    },
  )
  .refine((d) => new Set(d.requiredChecks).size === d.requiredChecks.length, {
    message: "duplicate checks",
  });
export type TalentScope = z.infer<typeof TalentScopeSchema>;

/**
 * Attributes a hiring criterion may never rest on. Matched as whole words, case-insensitively, anywhere in the scope's text. This is a
 * best-effort screen, not legal compliance: words with ordinary technical meanings (native, race condition, single-page, old code,
 * screen orientation, accessibility for disabled users) are deliberately NOT listed so that real engineering scopes are not blocked.
 */
const PROTECTED = [
  "age",
  "aged",
  "young",
  "gender",
  "male",
  "female",
  "woman",
  "racial",
  "ethnic",
  "ethnicity",
  "religion",
  "religious",
  "nationality",
  "marital",
  "married",
  "pregnant",
  "pregnancy",
  "sexuality",
];
const PROTECTED_RE = new RegExp(`\\b(${PROTECTED.join("|")})\\b`, "iu");
export function protectedAttributeHits(scope: TalentScope): string[] {
  const hits: string[] = [];
  for (const r of scope.roles) {
    const text = [
      r.title,
      ...r.requiredSkills,
      ...r.preferredSkills,
      ...r.deliverables,
    ];
    for (const t of text) {
      const m = PROTECTED_RE.exec(t);
      if (m) hits.push(`${r.roleId}:${m[1]!.toLowerCase()}`);
    }
  }
  return hits.sort();
}

export interface MissionFacts {
  readonly currency: string;
  readonly maxCommitmentMinor: number;
  readonly totalBudgetMinor: number;
  readonly spendingCategories: readonly string[];
  readonly providerTypes: readonly string[];
  readonly expiresAt: string;
}
/** Everything wrong with a scope against its mission. Empty means it may be proposed or approved. */
export function scopeProblems(
  scope: TalentScope,
  m: MissionFacts,
  nowIso: string,
): string[] {
  const p: string[] = [];
  if (scope.currency !== m.currency) p.push("CURRENCY_MISMATCH");
  if (!m.spendingCategories.includes(scope.category))
    p.push("CATEGORY_NOT_IN_MISSION");
  if (!m.providerTypes.includes("TALENT_MARKETPLACE"))
    p.push("TALENT_NOT_APPROVED_BY_MISSION");
  if (scope.expiresAt <= nowIso) p.push("SCOPE_ALREADY_EXPIRED");
  if (scope.expiresAt > m.expiresAt) p.push("OUTLIVES_MISSION");
  for (const r of scope.roles)
    if (r.budgetCapMinor > m.maxCommitmentMinor)
      p.push(`${r.roleId}:ABOVE_MAX_COMMITMENT`);
  const total = scope.roles.reduce((a, r) => a + r.budgetCapMinor, 0);
  if (total > m.totalBudgetMinor) p.push("ROLES_EXCEED_BUDGET");
  for (const h of protectedAttributeHits(scope))
    p.push(`PROTECTED_ATTRIBUTE:${h}`);
  return p;
}
