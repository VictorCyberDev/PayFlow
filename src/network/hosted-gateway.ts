import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
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
import { AlertEngine } from "./alerts.js";
import {
  can,
  MemberAuthError,
  MemberStore,
  ROLES,
  type Member,
  type Permission,
} from "./rbac.js";
import { SigningKeyRegistry } from "./signing-keys.js";
import {
  reconciliationMetrics,
  UnknownReconciler,
} from "./unknown-reconciler.js";
import { CredentialStore } from "./credentials.js";
import { ExecutingGateway } from "./gateway-execution.js";
import { GATEWAY_AUDIENCE } from "./gateway.js";
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
import { createMcpHttpHandler } from "../protocols/mcp-http.js";
import { protectedResourceMetadata } from "../protocols/chatgpt-app.js";
import { createA2AHttpHandler } from "../protocols/a2a-http.js";
import { PostgresDelegationRegistry } from "./delegation.js";
import { createGatewayMcpServices } from "../protocols/mcp-gateway.js";
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
  /**
   * A scheduler credential (for example Vercel Cron's `CRON_SECRET`). It can call ONE route, the
   * observation-only `GET /v1/admin/ops/reconcile/tick`, and nothing else. It is not an operator token.
   */
  readonly cronSecret?: string;
  /**
   * Public https URL of `POST /v1/mcp`. When absent the MCP endpoint is disabled (404). MCP is a protocol adapter
   * over the same Gateway: it uses the caller's own Gateway credential and the same single decision path.
   */
  readonly mcpResource?: string;
  /** Issuers of OAuth authorization servers for MCP clients. Empty until one is commissioned; never invented. */
  /** "verify-only" removes every tool that can start a payment from the MCP surface. Default "full". */
  readonly mcpProfile?: "full" | "verify-only";
  readonly mcpAuthorizationServers?: readonly string[];
  /** One alert webhook. When absent, alerts are persisted and visible but not delivered anywhere. */
  readonly alertWebhookUrl?: string;
  /** Test seam for alert delivery. */
  readonly sendAlert?: (
    url: string,
    init: RequestInit,
  ) => Promise<{ ok: boolean }>;
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
  const registry = new SigningKeyRegistry(sql);
  const members = new MemberStore(sql);
  const alerts = new AlertEngine(sql);
  // The active key is registered once; older keys stay published so historical Proof still
  // verifies. A key that was revoked cannot be re-activated: the process then refuses to sign.
  let keysReady: Promise<unknown> | undefined;
  const ensureKeys = () =>
    (keysReady ??= registry
      .activate(options.organizationId, key.keyId, key.jwk, iso())
      .catch((error) => {
        keysReady = undefined;
        throw error;
      }));
  const executing = createExecutingRestHandler(gateway, {
    issuePortableProof: async (access, id) => {
      await ensureKeys();
      return portable.issue(access, id, iso());
    },
    publicKeys: async () => {
      await ensureKeys();
      return {
        issuer: options.organizationId,
        keys: await registry.published(options.organizationId),
      };
    },
    authenticate: (authorization) => store.authenticate(authorization, iso()),
    readProof: (access, id) => proofs.read(access, id, iso()),
  });
  const publishedKeys = async () => {
    await ensureKeys();
    return {
      issuer: options.organizationId,
      keys: await registry.published(options.organizationId),
    };
  };
  const mcp = options.mcpResource
    ? createMcpHttpHandler({
        resource: options.mcpResource,
        audience: GATEWAY_AUDIENCE,
        resourceMetadataPath: "/v1/oauth-protected-resource",
        allowedOrigins: [],
        authenticate: async (request) => {
          try {
            const access = await store.authenticate(
              request.headers.get("authorization") ?? undefined,
              iso(),
            );
            return { subject: access.clientId, scopes: access.scopes, access };
          } catch {
            return null;
          }
        },
        servicesFor: (identity) =>
          createGatewayMcpServices({
            gateway,
            access: identity.access,
            now: iso,
            issuePortableProof: async (access, id) => {
              await ensureKeys();
              return portable.issue(access, id, iso());
            },
            publicKeys: publishedKeys,
            ...(options.mcpProfile === "verify-only"
              ? { verifyOnly: true }
              : {}),
          }),
        // The hosted per-credential rate limit above already ran for this request.
        rateLimit: () => Promise.resolve(true),
      })
    : undefined;
  const a2aBase = "/v1/a2a";
  const a2a = options.mcpResource
    ? createA2AHttpHandler({
        baseUrl: new URL(options.mcpResource).origin,
        basePath: a2aBase,
        audience: GATEWAY_AUDIENCE,
        authenticate: async (request) => {
          try {
            const access = await store.authenticate(
              request.headers.get("authorization") ?? undefined,
              iso(),
            );
            return { subject: access.clientId, scopes: access.scopes, access };
          } catch {
            return null;
          }
        },
        servicesFor: (identity) =>
          createGatewayMcpServices({
            gateway,
            access: identity.access,
            now: iso,
            issuePortableProof: async (access, id) => {
              await ensureKeys();
              return portable.issue(access, id, iso());
            },
            publicKeys: publishedKeys,
            ...(options.mcpProfile === "verify-only"
              ? { verifyOnly: true }
              : {}),
          }),
        rateLimit: () => Promise.resolve(true),
        replayStore: {
          claimNonce: (scope, nonce) => repo.claimReplay(scope, nonce),
        },
        // Inline (peer-presented) delegations are never trusted on the hosted host; stored chains are.
        parentFor: () => Promise.resolve(null),
        delegations: new PostgresDelegationRegistry(sql),
        now: iso,
      })
    : undefined;
  const authenticateAdmin = options.adminToken
    ? staticAdminAuthenticator({
        token: options.adminToken,
        organizationId: options.organizationId,
        environment: "SANDBOX",
      })
    : undefined;
  const reconciler = new UnknownReconciler(sql, (organizationId) => {
    const lookup = organizationId.startsWith("sbx_")
      ? options.simulated?.lookupProvider()
      : demo.lookupProvider();
    if (!lookup) throw new Error("NO_LOOKUP_PROVIDER");
    return lookup;
  });

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
    _request: RestRequest,
    actor: { kind: "OPERATOR" } | { kind: "MEMBER"; member: Member },
  ): Promise<RestResponse> {
    const requestId = `req_${randomUUID()}`;
    const headers = {
      "content-type": "application/json",
      "x-payflow-request-id": requestId,
      "cache-control": "no-store",
    };
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
      ...actorOf(actor),
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

  type Actor = { kind: "OPERATOR" } | { kind: "MEMBER"; member: Member };
  const actorOf = (actor: Actor) =>
    actor.kind === "OPERATOR"
      ? ({ actorKind: "OPERATOR", actorId: "platform-operator" } as const)
      : ({ actorKind: "MEMBER", actorId: actor.member.memberId } as const);

  const adminHeaders = (requestId: string) => ({
    "content-type": "application/json",
    "x-payflow-request-id": requestId,
    "cache-control": "no-store",
  });
  const reply = (
    requestId: string,
    status: number,
    body: object,
  ): RestResponse => ({
    status,
    headers: adminHeaders(requestId),
    body: { requestId, ...body },
  });

  /**
   * Resolves WHO is calling an administrative route. An operator token and a member token are
   * different principals. The operator holds no organization role.
   */
  async function resolveActor(
    request: RestRequest,
  ): Promise<Actor | "UNAUTHENTICATED"> {
    try {
      authenticateAdmin!(request.authorization);
      return { kind: "OPERATOR" };
    } catch (error) {
      if (!(error instanceof AdminAuthError)) throw error;
    }
    try {
      return {
        kind: "MEMBER",
        member: await members.authenticate(request.authorization, iso()),
      };
    } catch (error) {
      if (error instanceof MemberAuthError) return "UNAUTHENTICATED";
      throw error;
    }
  }

  /**
   * Server-side authorization for a member action. Returns the member, or the exact refusal.
   * Denied attempts are written to the audit trail under the member's own organization.
   */
  async function requireMember(
    requestId: string,
    actor: Actor | "UNAUTHENTICATED",
    permission: Permission,
    target: string,
  ): Promise<{ member: Member } | RestResponse> {
    if (actor === "UNAUTHENTICATED")
      return reply(requestId, 401, {
        reason: "MEMBER_AUTH_REQUIRED",
        nextAction: "USE_A_MEMBER_CREDENTIAL",
      });
    if (actor.kind === "OPERATOR")
      return reply(requestId, 403, {
        reason: "OPERATOR_TOKEN_HAS_NO_ORGANIZATION_ROLE",
        nextAction: "USE_A_MEMBER_CREDENTIAL",
      });
    if (!can(actor.member.role, permission)) {
      await audit.append({
        organizationId: actor.member.organizationId,
        environment: actor.member.environment,
        actorKind: "MEMBER",
        actorId: actor.member.memberId,
        action: "PERMISSION_DENIED",
        subjectKind: "ROUTE",
        subjectId: target.slice(0, 120),
        detail: { permission, role: actor.member.role },
        occurredAt: iso(),
      });
      return reply(requestId, 403, {
        reason: "PERMISSION_DENIED",
        requiredPermission: permission,
        recoverable: false,
        humanSummary: "Your role does not allow this action. Nothing changed.",
        nextAction: "ASK_AN_ORGANIZATION_OWNER",
      });
    }
    return { member: actor.member };
  }

  const VIEW_PERMISSION: Readonly<Record<string, Permission>> = {
    agents: "view:agents",
    finance: "view:finance",
    security: "view:security",
    authorities: "view:authorities",
    decisions: "view:decisions",
    unknown: "view:unknown",
    funnel: "view:funnel",
    audit: "view:audit",
  };

  /** Organization views, approvals, members, pauses. Tenant and environment come from the MEMBER. */
  async function orgRoute(request: RestRequest): Promise<RestResponse | null> {
    const m = request.path.match(
      /^\/v1\/admin\/(org\/(?:agents|finance|security|audit|authorities|decisions|unknown|funnel)|decisions\/([A-Za-z0-9-]{1,64})\/(approve|reject))$/u,
    );
    if (!m) return null;
    const requestId = `req_${randomUUID()}`;
    const view = m[1]!.replace("org/", "");
    const receiptId = m[2];
    const decide = receiptId && m[3] ? (m[3] as "approve" | "reject") : null;
    const gate = await requireMember(
      requestId,
      await resolveActor(request),
      decide ? (`decision:${decide}` as Permission) : VIEW_PERMISSION[view]!,
      request.path,
    );
    if (!("member" in gate)) return gate;
    const org = gate.member.organizationId;
    const env = gate.member.environment;
    const now = iso();
    const ok = (body: object) => reply(requestId, 200, body);
    if (request.method === "GET" && !decide) {
      if (view === "agents")
        return ok({ agents: await agentInventory(sql, org, env, now) });
      if (view === "finance")
        return ok({ finance: await financeHome(sql, org, env, now) });
      if (view === "security")
        return ok({ agents: await securityHome(sql, org, env, now) });
      if (view === "authorities")
        return ok({
          authorities: await authorityExposures(sql, org, env, now),
        });
      if (view === "audit") return ok({ events: await audit.list(org, env) });
      if (view === "funnel")
        return ok({ funnel: await developerFunnel(sql, org, env) });
      if (view === "unknown")
        return ok({
          operations: await unknownOperations(sql, org, env, now),
          note: "Observation only. Nothing here is re-executed.",
        });
      if (view === "decisions")
        return ok({ decisions: await pendingDecisions(sql, org, env) });
    }
    if (request.method === "POST" && receiptId && decide) {
      const pending = (await pendingDecisions(sql, org, env)).find(
        (d) => d.receiptId === receiptId,
      );
      // Another tenant's receipt, an already-decided one or an unknown id are indistinguishable.
      if (!pending)
        return reply(requestId, 404, {
          reason: "DECISION_NOT_FOUND",
          recoverable: false,
          humanSummary: "No pending decision with that id.",
          nextAction: "LIST_PENDING_DECISIONS",
        });
      if (decide === "reject") {
        await audit.append({
          organizationId: org,
          environment: env,
          actorKind: "MEMBER",
          actorId: gate.member.memberId,
          action: "APPROVAL_REJECTED",
          subjectKind: "RECEIPT",
          subjectId: receiptId,
          detail: {
            proposalId: pending.proposalId,
            amountMinor: pending.amountMinor,
            role: gate.member.role,
          },
          occurredAt: now,
        });
        return ok({ result: "REJECTED", effect: "NONE" });
      }
      const owner =
        await sql`select principal_id from mandates where id = ${pending.authorityId}`;
      try {
        // The approval is recorded under the Authority owner's principal by an authenticated
        // member whose role allows it. The agent has no scope or route that can do this.
        const done = await new DurableAuthorizationService(
          repo,
        ).approveEscalation(receiptId, String(owner[0]!.principal_id), now);
        await audit.append({
          organizationId: org,
          environment: env,
          actorKind: "MEMBER",
          actorId: gate.member.memberId,
          action: "APPROVAL_RECORDED",
          subjectKind: "RECEIPT",
          subjectId: receiptId,
          detail: {
            proposalId: pending.proposalId,
            amountMinor: pending.amountMinor,
            reservationId: done.reservation.id,
            role: gate.member.role,
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
        return reply(requestId, 409, {
          reason:
            String((error as Error).message)
              .split(":")[0]!
              .replace(/[^A-Z_]/g, "") || "APPROVAL_REFUSED",
          recoverable: false,
          humanSummary:
            "The approval could not be recorded. Nothing was reserved.",
          nextAction: "REVIEW_DECISION",
        });
      }
    }
    return null;
  }

  const cronAuthorized = (authorization: string | undefined): boolean => {
    if (!options.cronSecret) return false;
    const presented = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!presented) return false;
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(options.cronSecret).digest();
    return timingSafeEqual(a, b);
  };
  const deliverAlerts = async (now: string) =>
    options.alertWebhookUrl
      ? alerts.deliver(
          options.alertWebhookUrl,
          options.sendAlert ?? ((url, init) => fetch(url, init)),
          now,
        )
      : { attempted: 0, delivered: 0, failed: 0 };

  /** Members, credentials, org pause, and platform operations. */
  async function controlRoute(
    request: RestRequest,
  ): Promise<RestResponse | null> {
    const path = request.path;
    const requestId = `req_${randomUUID()}`;
    const memberPath = path.match(
      /^\/v1\/admin\/members(?:\/(pfm_[a-f0-9]{24})\/revoke)?$/u,
    );
    const credPath =
      /^\/v1\/admin\/credentials(\/pfc_[a-f0-9]{24}\/revoke)?$/u.exec(path);
    const pausePath = /^\/v1\/admin\/org\/(pause|resume)$/u.exec(path);
    const opsPath = /^\/v1\/admin\/ops\/(.+)$/u.exec(path);
    if (!memberPath && !credPath && !pausePath && !opsPath) return null;
    const actor = await resolveActor(request);

    // ---- platform operator routes: the operator token only, never a member role.
    if (opsPath) {
      // The scheduler credential may call the observation-only tick and nothing else.
      const cronCall =
        opsPath[1] === "reconcile/tick" &&
        request.method === "GET" &&
        cronAuthorized(request.authorization);
      if (!cronCall) {
        if (actor === "UNAUTHENTICATED")
          return reply(requestId, 401, { reason: "ADMIN_AUTH_REQUIRED" });
        if (actor.kind !== "OPERATOR")
          return reply(requestId, 403, {
            reason: "PLATFORM_OPERATOR_ONLY",
            nextAction: "ASK_THE_PLATFORM_OPERATOR",
          });
      }
      const now = iso();
      const op = opsPath[1]!;
      if (request.method === "GET" && op === "reconciliation")
        return reply(requestId, 200, {
          metrics: await reconciliationMetrics(sql, now),
          note: "Observation only. Reconciliation never creates or repeats a provider effect.",
        });
      if (request.method === "GET" && op === "alerts")
        return reply(requestId, 200, { alerts: await alerts.list() });
      // GET is accepted so a plain scheduler (cron, a hosted cron service) can call it. A tick is
      // safe to repeat: it only observes and records.
      if (op === "reconcile/tick") {
        const tick = await reconciler.tick(now);
        const evaluated = await alerts.evaluate(now);
        const delivery = await deliverAlerts(now);
        return reply(requestId, 200, {
          tick,
          alerts: evaluated,
          delivery,
          via: cronCall ? "SCHEDULER" : "OPERATOR",
        });
      }
      // A clearly labelled synthetic alert to prove the channel end to end. It is raised, delivered
      // and resolved at once, so it never lingers as incident history.
      if (request.method === "POST" && op === "alerts/test") {
        const { alertId } = await alerts.raise(
          {
            severity: "P2",
            code: "SYNTHETIC_TEST",
            subjectKind: "TEST",
            subjectId: "synthetic",
            detail: { synthetic: true },
          },
          now,
        );
        const delivery = await deliverAlerts(now);
        await alerts.resolve(alertId, now);
        return reply(requestId, 200, {
          synthetic: true,
          delivery,
          channelConfigured: Boolean(options.alertWebhookUrl),
        });
      }
      const alertAction = /^alerts\/(alr_[a-f0-9]{24})\/(ack|resolve)$/u.exec(
        op,
      );
      if (request.method === "POST" && alertAction) {
        const done =
          alertAction[2] === "ack"
            ? await alerts.acknowledge(
                alertAction[1]!,
                "platform-operator",
                now,
              )
            : await alerts.resolve(alertAction[1]!, now);
        return reply(requestId, done ? 200 : 404, {
          result: done ? "OK" : "NOT_FOUND",
        });
      }
      return reply(requestId, 404, { reason: "ROUTE_NOT_FOUND" });
    }

    // ---- bootstrap: the operator may create the FIRST owner of an existing organization.
    if (memberPath && !memberPath[1] && request.method === "POST") {
      if (actor !== "UNAUTHENTICATED" && actor.kind === "OPERATOR") {
        const b = (request.body ?? {}) as Record<string, unknown>;
        const orgId =
          typeof b.organizationId === "string" ? b.organizationId : "";
        const environment =
          b.environment === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";
        const exists =
          await sql`select 1 from organizations where id = ${orgId}`;
        if (!exists[0] || b.role !== "OWNER")
          return reply(requestId, 400, {
            reason:
              "BOOTSTRAP_ONLY_CREATES_AN_OWNER_OF_AN_EXISTING_ORGANIZATION",
            nextAction: "FIX_REQUEST",
          });
        const issued = await members.issue(
          orgId,
          environment,
          "platform-operator",
          { displayName: b.displayName, role: "OWNER" },
          iso(),
        );
        await audit.append({
          organizationId: orgId,
          environment,
          actorKind: "OPERATOR",
          actorId: "platform-operator",
          action: "OWNER_BOOTSTRAPPED",
          subjectKind: "MEMBER",
          subjectId: issued.member.memberId,
          occurredAt: iso(),
        });
        return reply(requestId, 201, {
          member: issued.member,
          token: issued.token,
          notice: "Store this token now. It cannot be retrieved again.",
        });
      }
    }

    // ---- everything below needs a member whose role carries the permission.
    const needed: Permission =
      memberPath && memberPath[1]
        ? "member:manage"
        : memberPath
          ? request.method === "GET"
            ? "view:members"
            : "member:manage"
          : credPath && credPath[1]
            ? "credential:revoke"
            : credPath
              ? request.method === "GET"
                ? "view:credentials"
                : "credential:issue"
              : pausePath![1] === "pause"
                ? "org:pause"
                : "org:resume";
    const gate = await requireMember(requestId, actor, needed, path);
    if (!("member" in gate)) return gate;
    const { member } = gate;
    const now = iso();
    const ctx = {
      organizationId: member.organizationId,
      environment: member.environment,
    };
    const log = (
      action: string,
      subjectKind: string,
      subjectId: string,
      detail: Record<string, string | number | boolean | null> = {},
    ) =>
      audit.append({
        organizationId: member.organizationId,
        environment: member.environment,
        actorKind: "MEMBER",
        actorId: member.memberId,
        action,
        subjectKind,
        subjectId,
        detail: { role: member.role, ...detail },
        occurredAt: now,
      });

    if (memberPath) {
      if (memberPath[1]) {
        const result = await members.revoke(
          ctx.organizationId,
          ctx.environment,
          memberPath[1],
          now,
        );
        if (result === "REVOKED")
          await log("MEMBER_REVOKED", "MEMBER", memberPath[1]);
        return reply(
          requestId,
          result === "REVOKED" ? 200 : result === "LAST_OWNER" ? 409 : 404,
          { result },
        );
      }
      if (request.method === "GET")
        return reply(requestId, 200, {
          members: await members.list(ctx.organizationId, ctx.environment),
        });
      const requestedRole = (request.body as { role?: unknown } | undefined)
        ?.role;
      if (!ROLES.includes(requestedRole as never))
        return reply(requestId, 400, {
          reason: "REQUEST_MALFORMED",
          nextAction: "FIX_REQUEST",
        });
      try {
        const issued = await members.issue(
          ctx.organizationId,
          ctx.environment,
          member.memberId,
          request.body,
          now,
        );
        await log("MEMBER_ADDED", "MEMBER", issued.member.memberId, {
          newRole: issued.member.role,
        });
        return reply(requestId, 201, {
          member: issued.member,
          token: issued.token,
          notice: "Store this token now. It cannot be retrieved again.",
        });
      } catch {
        return reply(requestId, 400, {
          reason: "REQUEST_MALFORMED",
          nextAction: "FIX_REQUEST",
        });
      }
    }

    if (credPath) {
      const handler = createCredentialAdminHandler(store, {
        authenticateAdmin: () => ctx,
        now: iso,
      });
      const out = await handler(request);
      const body = out.body as {
        credential?: {
          credentialId?: string;
          agentId?: string;
          scopes?: string[];
        };
      };
      if (out.status === 201 && body.credential?.credentialId)
        await log(
          "CREDENTIAL_ISSUED",
          "CREDENTIAL",
          body.credential.credentialId,
          {
            agentId: body.credential.agentId ?? null,
            scopes: (body.credential.scopes ?? []).join(","),
          },
        );
      if (out.status === 200 && credPath[1])
        await log(
          "CREDENTIAL_REVOKED",
          "CREDENTIAL",
          credPath[1].split("/")[1]!,
        );
      return out;
    }

    // org pause / resume: writes only the ORG scope of the member's own organization.
    const scope = `ORG:${ctx.organizationId}`;
    if (pausePath![1] === "pause") {
      const reasonRaw = (request.body as { reason?: unknown } | undefined)
        ?.reason;
      const reason =
        typeof reasonRaw === "string" && reasonRaw.trim()
          ? reasonRaw.trim().slice(0, 200)
          : "paused by organization";
      await sql`insert into execution_controls (scope, disabled, reason, updated_at)
        values (${scope}, true, ${reason}, ${now})
        on conflict (scope) do update set disabled = true, reason = excluded.reason, updated_at = excluded.updated_at`;
      await log("ORG_EXECUTION_PAUSED", "SCOPE", scope);
      return reply(requestId, 200, {
        result: "PAUSED",
        scope,
        effect: "NEW_EXECUTIONS_REFUSED",
      });
    }
    await sql`update execution_controls set disabled = false, updated_at = ${now} where scope = ${scope}`;
    await log("ORG_EXECUTION_RESUMED", "SCOPE", scope);
    return reply(requestId, 200, { result: "RESUMED", scope });
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
        /^Bearer pf_(?:sbx|live|act)_(pf[cm]_[a-f0-9]{24})\./u,
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
      // One bucket per credential or member; callers with no recognizable identity are keyed by
      // address. A shared bucket would let one noisy or hostile caller lock every organization out
      // of its own administrative API.
      const subject = bearer ?? `anon:${forwarded ?? "unknown"}`;
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
    if (method === "GET" && path === "/v1/oauth-protected-resource" && mcp) {
      send(res, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "public, max-age=300",
        },
        body: protectedResourceMetadata({
          resource: options.mcpResource as string,
          authorizationServers: options.mcpAuthorizationServers ?? [],
          documentation: new URL("/docs/", options.mcpResource).href,
        }),
      });
      return true;
    }
    if (a2a && (path === a2aBase || path.startsWith(`${a2aBase}/`))) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string") headers.set(name, value);
      const reply = await a2a(
        new Request(new URL(path, options.mcpResource), {
          method,
          headers,
          ...(method === "POST" ? { body: JSON.stringify(body ?? null) } : {}),
        }),
      );
      res.writeHead(reply.status, Object.fromEntries(reply.headers.entries()));
      res.end(Buffer.from(await reply.arrayBuffer()));
      return true;
    }
    if (path === "/v1/mcp" && mcp) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (typeof value === "string") headers.set(name, value);
      const reply = await mcp(
        new Request(`${options.mcpResource}`, {
          method,
          headers,
          ...(method === "POST" ? { body: JSON.stringify(body ?? null) } : {}),
        }),
      );
      res.writeHead(reply.status, Object.fromEntries(reply.headers.entries()));
      res.end(Buffer.from(await reply.arrayBuffer()));
      return true;
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
      if (!authenticateAdmin) {
        send(res, {
          status: 404,
          headers: { "content-type": "application/json" },
          body: { reason: "ROUTE_NOT_FOUND" },
        });
        return true;
      }
      const planeReply =
        (await orgRoute(request)) ?? (await controlRoute(request));
      if (planeReply) {
        send(res, planeReply);
        return true;
      }
      if (path === "/v1/admin/sandbox/authority" && method === "POST") {
        const requestId = `req_${randomUUID()}`;
        const actor = await resolveActor(request);
        // The operator may seed the sandbox Authority; a member needs authority:provision.
        const allowed =
          actor !== "UNAUTHENTICATED" && actor.kind === "OPERATOR"
            ? ({ actor } as const)
            : await requireMember(
                requestId,
                actor,
                "authority:provision",
                path,
              );
        if ("actor" in allowed || "member" in allowed) {
          send(
            res,
            await provisionSampleAuthority(
              request,
              "actor" in allowed
                ? allowed.actor
                : { kind: "MEMBER", member: allowed.member },
            ),
          );
        } else send(res, allowed);
        return true;
      }
      send(res, {
        status: 404,
        headers: { "content-type": "application/json" },
        body: { reason: "ROUTE_NOT_FOUND" },
      });
      return true;
    }
    const reply = await executing(request);
    // Funnel: a Proof read is the step after a first action. Identifiers only; never the token.
    if (
      reply.status === 200 &&
      request.method === "GET" &&
      /^\/v1\/proofs\//u.test(path)
    ) {
      const credentialId = request.authorization?.match(
        /^Bearer pf_(?:sbx|live)_(pfc_[a-f0-9]{24})\./u,
      )?.[1];
      const owner = credentialId ? await ownerOf(credentialId) : null;
      if (owner)
        await audit
          .append({
            organizationId: owner.organizationId,
            environment: owner.environment,
            actorKind: "AGENT_CREDENTIAL",
            actorId: credentialId!,
            action: "PROOF_READ",
            subjectKind: "PROOF",
            subjectId: path.split("/")[3]!.slice(0, 64),
            detail: { portable: path.endsWith("/portable") },
            occurredAt: iso(),
          })
          .catch(() => undefined); // measurement must never change the response
    }
    send(res, reply);
    return true;
  };
}
