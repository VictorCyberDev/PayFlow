import { describe, expect, it } from "vitest";
import {
  DesignPartnerPilotSchema,
  PilotFeedbackSchema,
  PilotMetricObservationSchema,
  pilotDashboard,
} from "../src/network/pilots.js";
import {
  InMemoryBillingProvider,
  buildUsageInvoice,
} from "../src/network/billing.js";
import { PRICING_ARCHITECTURE } from "../src/network/metering.js";

describe("M12 design-partner pilot system", () => {
  it("separates internal readiness from real external partner confirmation", () => {
    const pilot = DesignPartnerPilotSchema.parse({
      id: "pilot-1",
      organizationId: "org-1",
      workspaceId: "workspace-1",
      environment: "SANDBOX",
      status: "READY_FOR_EXTERNAL_REVIEW",
      sponsorPrincipalId: "principal-1",
      workflowName: "AP sandbox workflow",
      metricTargets: ["UNKNOWN rate", "verification latency"],
      integrationChecklistCompleted: true,
      securityQuestionnaireCompleted: true,
      deploymentChecklistCompleted: true,
      agreementRequirementsReviewed: true,
      externalPartnerConfirmed: false,
      createdAt: "2026-10-28T02:00:00.000Z",
      updatedAt: "2026-10-28T03:00:00.000Z",
    });
    const metric = PilotMetricObservationSchema.parse({
      pilotId: pilot.id,
      metric: "VERIFY_CALLS",
      value: 12,
      observedAt: "2026-10-28T03:00:00.000Z",
      source: "SYSTEM",
    });
    const feedback = PilotFeedbackSchema.parse({
      id: "feedback-1",
      pilotId: pilot.id,
      category: "PRODUCT",
      message: "Internal dry-run feedback only.",
      source: "INTERNAL",
      capturedAt: "2026-10-28T03:00:00.000Z",
    });
    const dashboard = pilotDashboard(pilot, [metric], [feedback]);
    expect(dashboard.readiness.internallyReady).toBe(true);
    expect(dashboard.readiness.externallyConfirmed).toBe(false);
    expect(dashboard.externalFeedbackCount).toBe(0);
    expect(dashboard.fabricatedPartnerEvidence).toBe(false);
  });
});

describe("M15 billing abstraction", () => {
  it("builds a sandbox usage invoice without charging a user", async () => {
    const plan = PRICING_ARCHITECTURE.find((entry) => entry.id === "PLATFORM");
    expect(plan).toBeDefined();
    const invoice = buildUsageInvoice(
      {
        invoiceId: "invoice-1",
        organizationId: "org-1",
        environment: "SANDBOX",
        periodStart: "2026-10-01T00:00:00.000Z",
        periodEnd: "2026-11-01T00:00:00.000Z",
      },
      plan!,
      [
        {
          id: "usage-1",
          organizationId: "org-1",
          environment: "SANDBOX",
          meter: "GOVERNED_ACTION",
          quantity: 50,
          occurredAt: "2026-10-28T03:00:00.000Z",
          idempotencyKey: "usage-billing-idempotency-0001",
        },
      ],
    );
    expect(invoice.totalMinor).toBe(50);
    expect(invoice.status).toBe("DRAFT");
    const provider = new InMemoryBillingProvider();
    await expect(provider.createInvoice(invoice)).resolves.toEqual({
      providerInvoiceId: "local:invoice-1",
      state: "DRAFT",
    });
    await expect(
      provider.createInvoice({ ...invoice, environment: "PRODUCTION" }),
    ).rejects.toThrow("IN_MEMORY_BILLING_SANDBOX_ONLY");
  });
});
