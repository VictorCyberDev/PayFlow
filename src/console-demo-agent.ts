import { z } from "zod";
import {
  DemoScenarioSchema,
  type DemoShoppingAgent,
} from "./delegated-demo.js";
import type { ConsoleRequest, ConsoleSessionPort } from "./console-session.js";
import type { PostgresTrustRepository } from "./persistence.js";

/**
 * Owner-bound HTTP surface for the demo Shopping Agent. The browser supplies only a scenario and
 * an Authority selector; the principal comes from the authenticated server session and the
 * Authority must belong to that principal. The response carries no secret, grant or provider id.
 */
export class ConsoleDemoAgent {
  constructor(
    private readonly repo: PostgresTrustRepository,
    private readonly sessions: ConsoleSessionPort,
    private readonly agent: DemoShoppingAgent,
  ) {}
  async status(req: ConsoleRequest) {
    const context = await this.sessions.read(req);
    await this.sessions.requirePrincipal(context);
    return {
      version: "payflow.demo-agent-status.v1",
      mode: "NON_PRODUCTION_DEMO",
      scenarios: ["VALID_PURCHASE", "PRICE_DRIFT"],
      payment: (await this.agent.paymentAvailable())
        ? "SANDBOX_CONNECTED"
        : "NOT_CONNECTED",
    };
  }
  /** Owner-authenticated, body-less nudge for the system to resolve uncertain payments. */
  async reconcile(req: ConsoleRequest, raw: unknown) {
    z.object({}).strict().parse(raw);
    const context = await this.sessions.read(req);
    await this.sessions.requirePrincipal(context);
    return {
      version: "payflow.demo-agent-reconcile.v1",
      checked: await this.agent.reconcileOutstanding(),
    };
  }
  /** `req` has already passed origin, CSRF and mutation rate-limit checks. */
  async run(req: ConsoleRequest, raw: unknown) {
    const body = z
      .object({
        scenario: DemoScenarioSchema,
        mandateId: z.string().min(1).max(128),
      })
      .strict()
      .parse(raw);
    const context = await this.sessions.read(req);
    const principal = await this.sessions.requirePrincipal(context);
    const mandate = await this.repo.getMandate(body.mandateId);
    if (!mandate || mandate.principalId !== principal)
      throw new Error("UNAVAILABLE");
    const outcome = await this.agent.run(mandate.id, body.scenario);
    return {
      version: "payflow.demo-agent-outcome.v1",
      status: outcome.status,
      operationId: outcome.operationId,
      providerEffect: outcome.providerEffect,
      code: "code" in outcome ? outcome.code : null,
    };
  }
}
