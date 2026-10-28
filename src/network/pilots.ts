import { z } from "zod";

export const PilotStatusSchema = z.enum([
  "DRAFT",
  "ONBOARDING",
  "SANDBOX_ACTIVE",
  "READY_FOR_EXTERNAL_REVIEW",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
]);

export const DesignPartnerPilotSchema = z
  .object({
    id: z.string().min(1),
    organizationId: z.string().min(1),
    workspaceId: z.string().min(1),
    environment: z.literal("SANDBOX"),
    status: PilotStatusSchema,
    sponsorPrincipalId: z.string().min(1),
    workflowName: z.string().min(1).max(256),
    metricTargets: z.array(z.string().min(1).max(256)).max(50),
    integrationChecklistCompleted: z.boolean(),
    securityQuestionnaireCompleted: z.boolean(),
    deploymentChecklistCompleted: z.boolean(),
    agreementRequirementsReviewed: z.boolean(),
    externalPartnerConfirmed: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type DesignPartnerPilot = Readonly<
  z.infer<typeof DesignPartnerPilotSchema>
>;

export const PilotMetricObservationSchema = z
  .object({
    pilotId: z.string().min(1),
    metric: z.enum([
      "AUTHORITIES_CREATED",
      "GOVERNED_ACTIONS",
      "DENIALS",
      "ESCALATIONS",
      "REPLAY_ATTEMPTS",
      "UNKNOWN_OUTCOMES",
      "RECONCILIATION_LATENCY_MS",
      "VERIFY_CALLS",
      "PROOF_VIEWS",
      "INTEGRATION_DEFECTS",
    ]),
    value: z.number().safe().nonnegative(),
    observedAt: z.string().datetime(),
    source: z.enum(["SYSTEM", "PARTNER_REPORTED"]),
  })
  .strict();
export type PilotMetricObservation = Readonly<
  z.infer<typeof PilotMetricObservationSchema>
>;

export const PilotFeedbackSchema = z
  .object({
    id: z.string().min(1),
    pilotId: z.string().min(1),
    category: z.enum([
      "INTEGRATION",
      "SECURITY",
      "PRODUCT",
      "OPERATIONS",
      "COMMERCIAL",
    ]),
    message: z.string().min(1).max(5000),
    source: z.enum(["INTERNAL", "EXTERNAL_PARTNER"]),
    capturedAt: z.string().datetime(),
  })
  .strict();
export type PilotFeedback = Readonly<z.infer<typeof PilotFeedbackSchema>>;

export function pilotReadiness(pilot: DesignPartnerPilot): {
  readonly internallyReady: boolean;
  readonly externallyConfirmed: boolean;
  readonly missing: readonly string[];
} {
  const missing: string[] = [];
  if (!pilot.integrationChecklistCompleted)
    missing.push("INTEGRATION_CHECKLIST");
  if (!pilot.securityQuestionnaireCompleted)
    missing.push("SECURITY_QUESTIONNAIRE");
  if (!pilot.deploymentChecklistCompleted) missing.push("DEPLOYMENT_CHECKLIST");
  if (!pilot.agreementRequirementsReviewed)
    missing.push("AGREEMENT_REQUIREMENTS");
  return {
    internallyReady: missing.length === 0,
    externallyConfirmed: pilot.externalPartnerConfirmed,
    missing,
  };
}

export function pilotDashboard(
  pilot: DesignPartnerPilot,
  metrics: readonly PilotMetricObservation[],
  feedback: readonly PilotFeedback[],
) {
  const ownedMetrics = metrics.filter((metric) => metric.pilotId === pilot.id);
  const ownedFeedback = feedback.filter((item) => item.pilotId === pilot.id);
  return {
    pilotId: pilot.id,
    status: pilot.status,
    environment: pilot.environment,
    readiness: pilotReadiness(pilot),
    metrics: ownedMetrics,
    feedbackCount: ownedFeedback.length,
    externalFeedbackCount: ownedFeedback.filter(
      (item) => item.source === "EXTERNAL_PARTNER",
    ).length,
    fabricatedPartnerEvidence: false as const,
  };
}
