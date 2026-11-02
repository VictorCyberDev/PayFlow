import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Sql } from "postgres";
import { FakeCommerceRanker } from "../commerce-discovery.js";
import { DEMO_MERCHANT_ID } from "../commerce.js";
import type { DemoShoppingAgent } from "../delegated-demo.js";
import type { Mandate } from "../domain.js";
import type { PostgresTrustRepository } from "../persistence.js";
import {
  AdminAuthError,
  createCredentialAdminHandler,
  staticAdminAuthenticator,
} from "./admin-rest.js";
import { CredentialStore } from "./credentials.js";
import { ExecutingGateway } from "./gateway-execution.js";
import { DurableAuthorizationService } from "../durable-service.js";
import {
  agentInventory,
  authorityExposures,
  developerFunnel,
  financeHome,
  pendingDecisions,
  securityHome,
  unknownOperations,
} from "./org-views.js";
import {
  AuditLog,
  ExecutionControls,
  PostgresRateLimitStore,
} from "./ops-controls.js";
import { enforceRateLimit } from "./reliability.js";
import { PostgresNetworkStore } from "./postgres-adapters.js";
import { PortableProofIssuer } from "./portable-proof.js";
import { ProofReader } from "./proof-read.js";
import { createExecutingRestHandler } from "./rest-execution.js";
import type { RestRequest, RestResponse } from "./rest.js";

export interface HostedGatewayOptions {
  readonly sql: Sql;
  readonly repo: PostgresTrustRepository;
  readonly demo: DemoShoppingAgent;
  /** Simulated-rail agent for the public sandbox. When absent, /v1/sandbox/start is disabled. */
  readonly simulated?: DemoShoppingAgent;
  /** The owner whose Sandbox wallet pays, and the agent that acts for them. */
  readonly principalId: string;
  readonly agentId: string;
  readonly organizationId: string;
  /** When absent, every administrative route is disabled (404). */
  readonly adminToken?: string;
  readonly clock: () => Date;
}

const MAX_BODY = 16 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(res: ServerResponse, reply: RestResponse): void {
  res.writeHead(reply.status, {
    ...reply.headers,
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(reply.body));
}

/**
 * Mounts the external-agent Gateway on the hosted (non-production, Sandbox) host. Returns a
 * handler that reports whether it served the request, so the caller can fall through to the
 * console. All decisions remain in the one Authority path; this is only HTTP glue, wiring and a
 * clearly labelled operator provisioning step for a Sandbox sample Authority.
 */
export function createHostedGatewayHandler(options: HostedGatewayOptions) {
  const { sql, repo, demo, clock } = options;
  const iso = () => clock().toISOString();
  const store = new CredentialStore(sql);
  const network = new PostgresNetworkStore(sql);
  const audit = new AuditLog(sql);
  const controls = new ExecutionControls(sql);
  const limiter = new PostgresRateLimitStore(sql);
  const SANDBOX = "SANDBOX" as const;
  const ownerOf = async (credentialId: string) => {
    const r =
      await sql`select organization_id, environment from agent_credentials where credential_id = ${credentialId}`;
    return r[0]
      ? {
          organizationId: String(r[0].organization_id),
          environment: r[0].environment as "SANDBOX" | "PRODUCTION",
        }
      : null;
  };
  const gateway = new ExecutingGateway({
    repo,
    // Routing is by the Authority's organization and is fail-closed in both directions: a public
    // sandbox organization (`sbx_`) can only ever reach the simulated rail, and every other
    // organization can only ever reach the configured real rail.
    delegated: {
      attempt: async (input) => {
        const o =
          await sql`select organization_id from authority_ownership where mandate_id = ${input.mandateId}`;
        const sandboxOrg = String(o[0]?.organization_id ?? "").startsWith(
          "sbx_",
        );
        if (sandboxOrg) {
          if (!options.simulated)
            return Object.freeze({
              status: "REFUSED",
              code: "PAYMENT_RAIL_NOT_CONNECTED",
              proposalId: null,
              operationId: null,
              askedHuman: false,
              providerEffect: "NONE",
            } as const);
          return options.simulated.gatewayPort().attempt(input);
        }
        return demo.gatewayPort().attempt(input);
      },
    },
    railFor: async (mandateId) => {
      const o =
        await sql`select organization_id from authority_ownership where mandate_id = ${mandateId}`;
      return String(o[0]?.organization_id ?? "").startsWith("sbx_")
        ? "SIMULATED"
        : "PAYPAL_SANDBOX";
    },
    ranker: new FakeCommerceRanker(),
    now: iso,
    // Operator pause: refuses NEW economic requests only; reads and Proof stay available.
    pauseCheck: async (clientId) => {
      const o = await ownerOf(clientId);
      return o ? controls.pausedReason(o.organizationId, o.environment) : null;
    },
    // GOVERNED_ACTION = an authenticated, well-formed, non-replayed request PayFlow evaluated.
    onEvent: async (event) => {
      if (event.type !== "gateway.evaluated" || !event.evaluation) return;
      const owner = await sql`
        select organization_id, environment from agent_credentials where credential_id = ${event.clientId}`;
      if (!owner[0]) return;
      await audit.append({
        organizationId: String(owner[0].organization_id),
        environment: owner[0].environment as "SANDBOX" | "PRODUCTION",
        actorKind: "AGENT_CREDENTIAL",
        actorId: event.clientId,
        action: "ACTION_EVALUATED",
        subjectKind: "AUTHORITY",
        subjectId: event.authority,
        detail: {
          agentId: event.evaluation.agentId,
          decision: event.evaluation.decision,
          status: event.evaluation.status,
        },
        occurredAt: event.at,
      });
      await network.recordUsage({
        id: `use_${event.evaluation.key.slice(0, 32)}`,
        organizationId: String(owner[0].organization_id),
        environment: owner[0].environment as "SANDBOX" | "PRODUCTION",
        meter: "GOVERNED_ACTION",
        quantity: 1,
        occurredAt: event.at,
        idempotencyKey: `ga:${event.evaluation.key}`,
        metadata: {
          agentId: event.evaluation.agentId,
          decision: event.evaluation.decision,
          status: event.evaluation.status,
        },
      });
    },
  });
  const proofs = new ProofReader(repo, demo.keys);
  const key = demo.verificationKey();
  const portable = new PortableProofIssuer(proofs, repo, {
    issuer: options.organizationId,
    keyId: key.keyId,
    privateKey: demo.signingForProofs().privateKey,
  });
  const executing = createExecutingRestHandler(gateway, {
    issuePortableProof: (access, id) => portable.issue(access, id, iso()),
    publicKeys: () => ({
      issuer: options.organizationId,
      keys: [{ keyId: key.keyId, jwk: key.jwk }],
    }),
    authenticate: (authorization) => store.authenticate(authorization, iso()),
    readProof: (access, id) => proofs.read(access, id, iso()),
  });
  const authenticateAdmin = options.adminToken
    ? staticAdminAuthenticator({
        token: options.adminToken,
        organizationId: options.organizationId,
        environment: "SANDBOX",
      })
    : undefined;
  const admin = authenticateAdmin
    ? createCredentialAdminHandler(store, {
        authenticateAdmin,
        now: iso,
      })
    : undefined;

  /** The Sandbox "Keyboard Authority": $100, one new keyboard, the demo merchant, 24h. */
  function sampleMandate(
    principalId: string,
    agentId: string,
    now: Date,
  ): Mandate {
    return {
      id: `sandbox-authority-${randomUUID()}`,
      principalId,
      authorizedAgentId: agentId,
      purpose: "Sandbox sample: one new keyboard",
      category: "KEYBOARD",
      currency: "USD",
      maxSingleTransactionMinor: 10000,
      cumulativeLimitMinor: 10000,
      quantityLimit: 1,
      merchantScope: { mode: "ONLY", ids: [DEMO_MERCHANT_ID] },
      allowedConditions: ["NEW"],
      merchantRiskCeiling: "LOW",
      autonomousPurchaseThresholdMinor: 10000,
      humanApprovalThresholdMinor: 10000,
      allowedCapabilities: ["CAPTURE_PAYMENT"],
      version: 1,
      nonce: randomBytes(16).toString("hex"),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
    };
  }

  /**
   * Public, self-serve developer sandbox on the SIMULATED rail. Creates an isolated `sbx_` tenant
   * with its own principal, agent, Authority and a one-hour credential. No payment provider is
   * ever contacted. Enabled only when a simulated-rail agent is configured.
   */
  async function startSandbox(): Promise<RestResponse> {
    const requestId = `req_${randomUUID()}`;
    const headers = {
      "content-type": "application/json",
      "x-payflow-request-id": requestId,
      "cache-control": "no-store",
    };
    const now = clock();
    const rand = randomBytes(6).toString("hex");
    const org = `sbx_${rand}`;
    const principalId = `sbxp_${rand}`;
    const agentId = `sbxa_${rand}`;
    await repo.savePrincipal({
      id: principalId,
      displayName: "Sandbox visitor",
    });
    await repo.saveAgent({
      id: agentId,
      principalId,
      displayName: "Your agent",
      issuedAt: new Date(now.getTime() - 86_400_000).toISOString(),
      expiresAt: new Date(now.getTime() + 2 * 86_400_000).toISOString(),
      status: "ACTIVE",
      capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
    });
    await sql`insert into organizations (id, display_name) values (${org}, 'Public sandbox')`;
    await sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id)
      values (${org}, ${agentId}, 'SANDBOX', ${principalId})`;
    const mandate = sampleMandate(principalId, agentId, now);
    await repo.saveMandate(mandate);
    await sql`insert into authority_ownership (mandate_id, organization_id, environment, owner_principal_id)
      values (${mandate.id}, ${org}, 'SANDBOX', ${principalId})`;
    const { token, credential } = await store.issue(
      {
        organizationId: org,
        environment: "SANDBOX",
        agentId,
        scopes: ["action:request", "proof:read"],
        ttlSeconds: 3600,
        label: "public-sandbox",
      },
      now.toISOString(),
    );
    await audit.append({
      organizationId: org,
      environment: SANDBOX,
      actorKind: "SYSTEM",
      actorId: "public-sandbox",
      action: "SANDBOX_STARTED",
      subjectKind: "CREDENTIAL",
      subjectId: credential.credentialId,
      detail: { rail: "SIMULATED" },
      occurredAt: now.toISOString(),
    });
    return {
      status: 201,
      headers,
      body: {
        requestId,
        sandbox: {
          rail: "SIMULATED",
          notice:
            "Simulated sandbox. No real money moves and no payment provider is contacted. Everything you create here expires.",
          expiresAt: credential.expiresAt,
        },
        // Shown exactly once.
        token,
        authority: {
          id: mandate.id,
          agentId,
          limitMinor: mandate.maxSingleTransactionMinor,
          currency: "USD",
          merchant: DEMO_MERCHANT_ID,
          item: "Quiet keyboard",
          priceMinor: 8400,
          expiresAt: mandate.expiresAt,
        },
        next: {
          execute: "POST /v1/actions/execute",
          tryToBreakIt: "Ask for a different amount and see $0 moved.",
          proof:
            "GET /v1/proofs/{proposalId}/portable, then verify it offline.",
        },
      },
    };
  }

  /** Operator-only. Creates a Sandbox "Keyboard Authority" ($100, one keyboard, demo merchant). */
  async function provisionSampleAuthority(
    request: RestRequest,
  ): Promise<RestResponse> {
    const requestId = `req_${randomUUID()}`;
    const headers = {
      "content-type": "application/json",
      "x-payflow-request-id": requestId,
      "cache-control": "no-store",
    };
    try {
      authenticateAdmin!(request.authorization);
    } catch (error) {
      if (error instanceof AdminAuthError)
        return {
          status: 401,
          headers,
          body: { requestId, reason: "ADMIN_AUTH_REQUIRED" },
        };
      throw error;
    }
    const now = clock();
    const mandate = sampleMandate(options.principalId, options.agentId, now);
    await repo.saveMandate(mandate);
    await sql`insert into organizations (id, display_name) values (${options.organizationId}, 'PayFlow Sandbox') on conflict (id) do nothing`;
    await sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id)
      values (${options.organizationId}, ${options.agentId}, 'SANDBOX', ${options.principalId}) on conflict do nothing`;
    await sql`insert into authority_ownership (mandate_id, organization_id, environment, owner_principal_id)
      values (${mandate.id}, ${options.organizationId}, ${SANDBOX}, ${options.principalId}) on conflict do nothing`;
    await audit.append({
      organizationId: options.organizationId,
      environment: SANDBOX,
      actorKind: "ADMIN",
      actorId: "admin-token",
      action: "AUTHORITY_PROVISIONED",
      subjectKind: "AUTHORITY",
      subjectId: mandate.id,
      detail: { limitMinor: mandate.maxSingleTransactionMinor, sandbox: true },
      occurredAt: now.toISOString(),
    });
    return {
      status: 201,
      headers,
      body: {
        requestId,
        authority: {
          id: mandate.id,
          agentId: mandate.authorizedAgentId,
          limitMinor: mandate.maxSingleTransactionMinor,
          currency: mandate.currency,
          merchant: DEMO_MERCHANT_ID,
          expiresAt: mandate.expiresAt,
          sandbox: true,
        },
      },
    };
  }

  /** Admin-only organization views and approvals. Tenant and environment come from the admin. */
  async function orgRoute(request: RestRequest): Promise<RestResponse | null> {
    const m = request.path.match(
      /^\/v1\/admin\/(org\/(?:agents|finance|security|audit|authorities|decisions|unknown|funnel)|decisions\/([A-Za-z0-9-]{1,64})\/(approve|reject))$/u,
    );
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const headers = {
      "content-type": "application/json",
      "x-payflow-request-id": requestId,
      "cache-control": "no-store",
    };
    try {
      authenticateAdmin!(request.authorization);
    } catch {
      return {
        status: 401,
        headers,
        body: { requestId, reason: "ADMIN_AUTH_REQUIRED" },
      };
    }
    const org = options.organizationId;
    const now = iso();
    const ok = (body: object) => ({
      status: 200,
      headers,
      body: { requestId, ...body },
    });
    const view = m[1]!.replace("org/", "");
    if (request.method === "GET") {
      if (view === "agents")
        return ok({ agents: await agentInventory(sql, org, SANDBOX, now) });
      if (view === "finance")
        return ok({ finance: await financeHome(sql, org, SANDBOX, now) });
      if (view === "security")
        return ok({ agents: await securityHome(sql, org, SANDBOX, now) });
      if (view === "authorities")
        return ok({
          authorities: await authorityExposures(sql, org, SANDBOX, now),
        });
      if (view === "audit")
        return ok({ events: await audit.list(org, SANDBOX) });
      if (view === "funnel")
        return ok({ funnel: await developerFunnel(sql, org, SANDBOX) });
      if (view === "unknown")
        return ok({
          operations: await unknownOperations(sql, org, SANDBOX, now),
          note: "Observation only. Nothing here is re-executed.",
        });
      if (view === "decisions")
        return ok({ decisions: await pendingDecisions(sql, org, SANDBOX) });
    }
    const receiptId = m[2];
    if (request.method === "POST" && receiptId && m[3]) {
      const pending = (await pendingDecisions(sql, org, SANDBOX)).find(
        (d) => d.receiptId === receiptId,
      );
      // Another tenant's receipt, an already-decided one or an unknown id are indistinguishable.
      if (!pending)
        return {
          status: 404,
          headers,
          body: {
            requestId,
            reason: "DECISION_NOT_FOUND",
            recoverable: false,
            humanSummary: "No pending decision with that id.",
            nextAction: "LIST_PENDING_DECISIONS",
          },
        };
      if (m[3] === "reject") {
        await audit.append({
          organizationId: org,
          environment: SANDBOX,
          actorKind: "ADMIN",
          actorId: "admin-token",
          action: "APPROVAL_REJECTED",
          subjectKind: "RECEIPT",
          subjectId: receiptId,
          detail: {
            proposalId: pending.proposalId,
            amountMinor: pending.amountMinor,
          },
          occurredAt: now,
        });
        return ok({ result: "REJECTED", effect: "NONE" });
      }
      const owner =
        await sql`select principal_id from mandates where id = ${pending.authorityId}`;
      try {
        // The approval is recorded under the Authority owner's principal by an authenticated
        // administrator. The agent has no scope or route that can do this.
        const done = await new DurableAuthorizationService(
          repo,
        ).approveEscalation(receiptId, String(owner[0]!.principal_id), now);
        await audit.append({
          organizationId: org,
          environment: SANDBOX,
          actorKind: "ADMIN",
          actorId: "admin-token",
          action: "APPROVAL_RECORDED",
          subjectKind: "RECEIPT",
          subjectId: receiptId,
          detail: {
            proposalId: pending.proposalId,
            amountMinor: pending.amountMinor,
            reservationId: done.reservation.id,
          },
          occurredAt: now,
        });
        return ok({
          result: "APPROVED_ONCE",
          reservationId: done.reservation.id,
          effect: "NONE_YET",
          note: "Authority is reserved. Completing the payment still needs the payer-present resume.",
        });
      } catch (error) {
        return {
          status: 409,
          headers,
          body: {
            requestId,
            reason:
              String((error as Error).message)
                .split(":")[0]!
                .replace(/[^A-Z_]/g, "") || "APPROVAL_REFUSED",
            recoverable: false,
            humanSummary:
              "The approval could not be recorded. Nothing was reserved.",
            nextAction: "REVIEW_DECISION",
          },
        };
      }
    }
    return null;
  }

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://host.invalid");
    const path = url.pathname
      .replace(/^\/api(?=\/v1\/)/u, "")
      .replace(/\/+$/u, "");
    if (!path.startsWith("/v1/")) return false;
    const method = req.method === "GET" ? "GET" : "POST";
    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST" });
      res.end();
      return true;
    }
    let body: unknown;
    try {
      body = method === "POST" ? await readBody(req) : undefined;
    } catch {
      send(res, {
        status: 400,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: {
          reason: "REQUEST_MALFORMED",
          decision: "DENY",
          effectCount: 0,
          recoverable: true,
          humanSummary:
            "The request body is not valid JSON or is too large. $0 moved.",
          nextAction: "FIX_REQUEST_AND_RETRY_WITH_NEW_NONCE",
        },
      });
      return true;
    }
    const authorization = req.headers.authorization;
    const request: RestRequest = {
      method,
      path,
      ...(authorization ? { authorization } : {}),
      ...(body === undefined ? {} : { body }),
    };
    // Rate limit every /v1 request before any processing. It protects PayFlow and never alters a
    // decision; a limited request has zero effect by construction.
    {
      const bearer = authorization?.match(
        /^Bearer pf_(?:sbx|live)_(pfc_[a-f0-9]{24})\./u,
      )?.[1];
      const forwarded = String(req.headers["x-forwarded-for"] ?? "")
        .split(",")[0]
        ?.trim();
      const family = path.startsWith("/v1/admin/")
        ? "admin"
        : path === "/v1/keys"
          ? "keys"
          : "api";
      const limitFor = { admin: 60, keys: 120, api: 120 }[family];
      const subject =
        bearer ??
        (path.startsWith("/v1/admin/")
          ? "admin"
          : `anon:${forwarded ?? "unknown"}`);
      let decision;
      try {
        decision = await enforceRateLimit(limiter, {
          bucket: family,
          subject,
          limit: limitFor,
          windowSeconds: 60,
          now: iso(),
        });
      } catch {
        decision = { allowed: true, remaining: 0, resetAt: iso() }; // a limiter fault must not block safe reads
      }
      if (!decision.allowed) {
        const wait = Math.max(
          1,
          Math.ceil((Date.parse(decision.resetAt) - Date.parse(iso())) / 1000),
        );
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": String(wait),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(
          JSON.stringify({
            decision: "DENY",
            effectCount: 0,
            reason: "RATE_LIMITED",
            recoverable: true,
            humanSummary: "Too many requests. Nothing was processed. $0 moved.",
            nextAction: "WAIT_AND_RETRY_AFTER_RETRY_AFTER_SECONDS",
            retryAfterSeconds: wait,
          }),
        );
        return true;
      }
    }
    if (method === "POST" && path === "/v1/sandbox/start") {
      if (!options.simulated) {
        send(res, {
          status: 404,
          headers: { "content-type": "application/json" },
          body: {
            reason: "SANDBOX_NOT_ENABLED",
            humanSummary: "Self-serve sandbox is not enabled on this host.",
          },
        });
        return true;
      }
      const ip =
        String(req.headers["x-forwarded-for"] ?? "")
          .split(",")[0]
          ?.trim() || "unknown";
      let blocked = false;
      try {
        const perIp = await enforceRateLimit(limiter, {
          bucket: "sandbox-start",
          subject: ip,
          limit: 5,
          windowSeconds: 3600,
          now: iso(),
        });
        const global = await enforceRateLimit(limiter, {
          bucket: "sandbox-start-all",
          subject: "all",
          limit: 200,
          windowSeconds: 3600,
          now: iso(),
        });
        blocked = !perIp.allowed || !global.allowed;
      } catch {
        blocked = true; // fail closed: never mint tenants without a working limiter
      }
      if (blocked) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "3600",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            reason: "SANDBOX_RATE_LIMITED",
            recoverable: true,
            humanSummary:
              "Too many sandboxes were started from here. Try again later.",
            nextAction: "WAIT_AND_RETRY",
            retryAfterSeconds: 3600,
          }),
        );
        return true;
      }
      send(res, await startSandbox());
      return true;
    }
    if (path.startsWith("/v1/admin/")) {
      if (!admin) {
        send(res, {
          status: 404,
          headers: { "content-type": "application/json" },
          body: { reason: "ROUTE_NOT_FOUND" },
        });
        return true;
      }
      const org = await orgRoute(request);
      if (org) {
        send(res, org);
        return true;
      }
      const reply =
        path === "/v1/admin/sandbox/authority" && method === "POST"
          ? await provisionSampleAuthority(request)
          : await admin(request);
      // Audit credential lifecycle after the fact (identifiers only; the token is never recorded).
      const body = reply.body as {
        credential?: {
          credentialId?: string;
          agentId?: string;
          scopes?: string[];
        };
      };
      if (reply.status === 201 && body.credential?.credentialId)
        await audit.append({
          organizationId: options.organizationId,
          environment: SANDBOX,
          actorKind: "ADMIN",
          actorId: "admin-token",
          action: "CREDENTIAL_ISSUED",
          subjectKind: "CREDENTIAL",
          subjectId: body.credential.credentialId,
          detail: {
            agentId: body.credential.agentId ?? null,
            scopes: (body.credential.scopes ?? []).join(","),
          },
          occurredAt: iso(),
        });
      const revoked = path.match(
        /^\/v1\/admin\/credentials\/(pfc_[a-f0-9]{24})\/revoke$/u,
      );
      if (reply.status === 200 && revoked?.[1])
        await audit.append({
          organizationId: options.organizationId,
          environment: SANDBOX,
          actorKind: "ADMIN",
          actorId: "admin-token",
          action: "CREDENTIAL_REVOKED",
          subjectKind: "CREDENTIAL",
          subjectId: revoked[1],
          occurredAt: iso(),
        });
      send(res, reply);
      return true;
    }
    send(res, await executing(request));
    return true;
  };
}
