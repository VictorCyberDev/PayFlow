import { z } from "zod";

export const MachineAuthoritySchema = z
  .object({
    authorityId: z.string().min(1),
    sponsorPrincipalId: z.string().min(1),
    machineIdentity: z.string().min(1),
    allowedPurposes: z.array(z.string().min(1)).min(1),
    allowedResourceKinds: z
      .array(z.enum(["API", "COMPUTE", "STORAGE", "DATA", "SERVICE"]))
      .min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    maxSingleActionMinor: z.number().int().safe().positive(),
    maxTotalMinor: z.number().int().safe().positive(),
    maxActionsPerHour: z.number().int().safe().positive(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type MachineAuthority = Readonly<z.infer<typeof MachineAuthoritySchema>>;

export interface MachineEconomicAction {
  readonly machineIdentity: string;
  readonly purpose: string;
  readonly resourceKind: "API" | "COMPUTE" | "STORAGE" | "DATA" | "SERVICE";
  readonly amountMinor: number;
  readonly currency: string;
  readonly proposedAt: string;
}

export function evaluateMachineEconomicAction(
  authority: MachineAuthority,
  action: MachineEconomicAction,
  context: {
    cumulativeSpentMinor: number;
    actionsInPreviousHour: number;
    now: string;
  },
): readonly string[] {
  const reasons: string[] = [];
  if (
    !MachineAuthoritySchema.safeParse(authority).success ||
    !Number.isFinite(Date.parse(context.now)) ||
    !Number.isFinite(Date.parse(action.proposedAt)) ||
    !Number.isSafeInteger(context.cumulativeSpentMinor) ||
    context.cumulativeSpentMinor < 0 ||
    !Number.isSafeInteger(context.actionsInPreviousHour) ||
    context.actionsInPreviousHour < 0
  )
    return ["INVALID_MACHINE_CONTEXT"];
  if (!Number.isSafeInteger(context.cumulativeSpentMinor + action.amountMinor))
    reasons.push("AMOUNT_OVERFLOW");
  if (Date.parse(action.proposedAt) > Date.parse(context.now))
    reasons.push("FUTURE_ACTION");
  if (authority.machineIdentity !== action.machineIdentity)
    reasons.push("MACHINE_IDENTITY_MISMATCH");
  if (!authority.allowedPurposes.includes(action.purpose))
    reasons.push("PURPOSE_DENIED");
  if (!authority.allowedResourceKinds.includes(action.resourceKind))
    reasons.push("RESOURCE_KIND_DENIED");
  if (authority.currency !== action.currency) reasons.push("CURRENCY_MISMATCH");
  if (!Number.isSafeInteger(action.amountMinor) || action.amountMinor <= 0)
    reasons.push("INVALID_AMOUNT");
  if (action.amountMinor > authority.maxSingleActionMinor)
    reasons.push("SINGLE_ACTION_LIMIT_EXCEEDED");
  if (
    context.cumulativeSpentMinor + action.amountMinor >
    authority.maxTotalMinor
  )
    reasons.push("TOTAL_LIMIT_EXCEEDED");
  if (context.actionsInPreviousHour >= authority.maxActionsPerHour)
    reasons.push("VELOCITY_LIMIT_EXCEEDED");
  if (Date.parse(context.now) >= Date.parse(authority.expiresAt))
    reasons.push("AUTHORITY_EXPIRED");
  return reasons;
}
