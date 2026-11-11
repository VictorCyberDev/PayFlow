import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createBookingRoutes } from "./booking-routes.js";
import { BookingService } from "../missions/booking-service.js";
import { createWorkspaceRoutes } from "./workspace-routes.js";
import {
  AutomationService,
  type Handler,
} from "../automation/automation-service.js";
import {
  readiness as agentReadiness,
  type AgentState,
} from "../missions/agent-lifecycle.js";
import { PACKS, applyPack } from "../missions/policy-packs.js";
import {
  RECURRING_KIND,
  RecurringService,
} from "../missions/recurring-service.js";
import { createRecurringRoutes } from "./recurring-routes.js";
import { EmailOutbox, type EmailSender } from "./email-outbox.js";
import { InvitationService } from "./invitations.js";
import { AccountDataService } from "./account-data.js";
import { MfaService } from "./mfa.js";
import { QuorumService } from "../missions/quorum-service.js";
import { createQuorumRoutes } from "./quorum-routes.js";
import { createAutomationRoutes } from "./automation-routes.js";
import { createServiceMarketRoutes } from "./service-market-routes.js";
import { ServiceMarketService } from "../missions/service-market-service.js";
import {
  LAUNCH_RUN_KIND,
  LaunchRunService,
} from "../missions/launch-run-service.js";
import { createLaunchRunRoutes } from "./launch-run-routes.js";
import { PLAN_RUN_KIND, PlanRunService } from "../missions/plan-run-service.js";
import { createPlanRunRoutes } from "./plan-run-routes.js";
import { sandboxServiceSource } from "../missions/service-market-sources.js";
import { WorkspaceService } from "../missions/workspace-service.js";
import {
  builtinWorkspaceSources,
  type WorkspaceSourceRegistry,
} from "../missions/workspace-sources.js";
import { APP_ASSETS, APP_FONTS } from "./app-assets.generated.js";
import { draftMission, type DraftModel } from "../missions/draft-assistant.js";
import { z } from "zod";
import {
  UserAuthService,
  SESSION_ABSOLUTE_MS,
  clearedSessionCookie,
  csrfFor,
  principalIdOf,
  readSessionCookie,
  sessionCookie,
} from "./user-auth.js";
import { ExecutionBindingService } from "../missions/execution-binding.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Sql } from "postgres";
import { FakeCommerceRanker } from "../commerce-discovery.js";
import { DEMO_MERCHANT_ID } from "../commerce.js";
import { StaticPublicKeyRing } from "../execution-grant.js";
import type { DemoShoppingAgent, DemoSigningKey } from "../delegated-demo.js";
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
  type Role,
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
import { enforceRateLimit, type RateLimitStore } from "./reliability.js";
import { PostgresNetworkStore } from "./postgres-adapters.js";
import { PortableProofIssuer } from "./portable-proof.js";
import { ProofReader } from "./proof-read.js";
import { verifyProofRequest } from "./hosted-verify.js";
import { PortableCredentialIssuer } from "./credential-issuance.js";
import { MissionService, type MissionCaller } from "../missions/service.js";
import { MissionAuthorityCompiler } from "../missions/authority-compiler.js";
import { createMissionRoutes } from "./mission-routes.js";
import { PlanService } from "../missions/plan-service.js";
import { createPlanRoutes } from "./plan-routes.js";
import { LedgerService } from "../missions/ledger-service.js";
import { createLedgerRoutes } from "./ledger-routes.js";
import { createConnectorRoutes } from "./connector-routes.js";
import { createDiscoveryRoutes } from "./discovery-routes.js";
import { createQualificationRoutes } from "./qualification-routes.js";
import { createQuoteRoutes } from "./quote-routes.js";
import { createSourcingRoutes } from "./sourcing-routes.js";
import { createNegotiationRoutes } from "./negotiation-routes.js";
import { createCommunicationRoutes } from "./communication-routes.js";
import { createAcceptanceRoutes } from "./acceptance-routes.js";
import { AcceptanceService } from "../missions/acceptance-service.js";
import { OperationTraceService } from "../operation-trace.js";
import { createProcurementRoutes } from "./procurement-routes.js";
import { createOrderRoutes } from "./order-routes.js";
import { createFulfillmentRoutes } from "./fulfillment-routes.js";
import { createDisputeRoutes } from "./dispute-routes.js";
import { createObligationRoutes } from "./obligation-routes.js";
import { createPortfolioRoutes } from "./portfolio-routes.js";
import { createTalentScopeRoutes } from "./talent-scope-routes.js";
import { createTalentCandidateRoutes } from "./talent-candidate-routes.js";
import { createShortlistRoutes } from "./shortlist-routes.js";
import { createTalentOfferRoutes } from "./talent-offer-routes.js";
import { createContractorRoutes } from "./contractor-routes.js";
import { ContractorService } from "../missions/contractor-service.js";
import { TalentOfferService } from "../missions/talent-offer-service.js";
import { ShortlistService } from "../missions/shortlist-service.js";
import { TalentCandidateService } from "../missions/talent-candidate-service.js";
import {
  sandboxTalentSource,
  TalentSourceRegistry,
} from "../missions/talent-candidates.js";
import { TalentScopeService } from "../missions/talent-scope-service.js";
import { PortfolioService } from "../missions/portfolio-service.js";
import { ObligationService } from "../missions/obligation-service.js";
import { DisputeService } from "../missions/dispute-service.js";
import { FulfillmentService } from "../missions/fulfillment-service.js";
import { OrderService } from "../missions/order-service.js";
import {
  ProcurementService,
  type TraceReader,
} from "../missions/procurement-service.js";
import { traceFactsOf } from "../missions/purchase.js";
import { CommunicationService } from "../missions/communication-service.js";
import { builtinChannels, type ChannelRegistry } from "../missions/channels.js";
import { NegotiationService } from "../missions/negotiation-service.js";
import { CounterofferService } from "../missions/counteroffer-service.js";
import { SourcingService } from "../missions/sourcing-service.js";
import { QuoteService } from "../missions/quote-service.js";
import { QualificationService } from "../missions/qualification-service.js";
import { DiscoveryService } from "../missions/discovery-service.js";
import { ConnectorService } from "../missions/connector-service.js";
import {
  builtinRegistry,
  type ConnectorRegistry,
} from "../missions/connectors.js";
import { DelegationService, type Caller } from "./delegation-service.js";
import type { JWTVerifyGetKey } from "jose";
import type { ProtocolAuthenticator } from "../protocols/http-auth.js";
import {
  createTenantOAuthAuthenticator,
  OAuthIdentityMappings,
} from "../protocols/oauth-resource.js";
import { IssuerDirectoryPublisher } from "./issuer-directory.js";
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
  /**
   * The host's Proof/credential signing key. It is a property of the HOST, not of any demo agent:
   * Proof must stay verifiable on every instance, so the key outlives whichever agents are mounted.
   */
  readonly signing: DemoSigningKey;
  /**
   * The M6 demonstration Shopping Agent, i.e. FINANCIAL MODE. Absent on an ordinary customer host:
   * the whole customer application, Proof and the operator routes still mount, and every economic
   * request is refused PAYMENT_RAIL_NOT_CONNECTED before a provider is ever reached.
   */
  readonly demo?: DemoShoppingAgent;
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
   * observation-only `GET /v1/admin/ops/reconcile/tick` and `GET /v1/admin/ops/automation/run` (which can only run the registered handlers), and nothing else. It is not an operator token.
   */
  readonly cronSecret?: string;
  /** Sends the account emails queued in the outbox. Absent until the owner configures a provider and a verified sender. */
  readonly emailSender?: EmailSender;
  /** Test seam: the rate-limit store. Production always uses PostgreSQL. */
  readonly rateLimitStore?: RateLimitStore;
  /**
   * Whether an account must have confirmed its email before it can take any outward or financial action. Defaults to ON exactly when a sender is
   * configured: without one nobody could ever confirm, so requiring it would only lock everyone out. /v1/app/me says which applies.
   */
  readonly requireVerifiedEmail?: boolean;
  /** 32-byte key that seals authenticator secrets at rest (derived from the host key). Without it two-step sign-in cannot be set up. */
  readonly mfaSecretKey?: Buffer;
  /**
   * How many reverse proxies sit in front of this host and append to `x-forwarded-for`. The client address is the entry that
   * many positions from the RIGHT (the one the nearest trusted proxy appended); anything to its left is client-controlled and
   * ignored. Default 1. 0 trusts no header and uses the socket address.
   */
  readonly trustedProxyHops?: number;
  /**
   * Browser origins (scheme://host[:port]) allowed to make state-changing requests with a session cookie. Cookie-authenticated
   * unsafe requests from any other Origin are refused (CSRF). Empty = cookie sessions cannot change anything.
   */
  readonly appOrigins?: readonly string[];
  /** Model that SUGGESTS mission wording in the wizard. Absent = the suggestion route answers MODEL_NOT_CONFIGURED. */
  readonly draftModel?: DraftModel;
  /** Set `Secure` on the session cookie (default true). Only local plain-http development turns this off. */
  readonly secureCookies?: boolean;
  /** Requests per minute allowed from one client address across ALL credentials (default 600). */
  readonly ipRateLimitPerMinute?: number;
  /**
   * Public https URL of `POST /v1/mcp`. When absent the MCP endpoint is disabled (404). MCP is a protocol adapter
   * over the same Gateway: it uses the caller's own Gateway credential and the same single decision path.
   */
  readonly mcpResource?: string;
  /** Issuers of OAuth authorization servers for MCP clients. Empty until one is commissioned; never invented. */
  /** "verify-only" removes every tool that can start a payment from the MCP surface. Default "full". */
  readonly mcpProfile?: "full" | "verify-only";
  /**
   * The issuer id (an https or loopback ORIGIN) that portable Authority credentials are issued under and that verifiers
   * fetch a directory for. When absent, credential issuance is disabled (503), not guessed.
   */
  readonly credentialIssuer?: string;
  readonly mcpAuthorizationServers?: readonly string[];
  /**
   * An external OAuth authorization server whose access tokens PayFlow accepts as a RESOURCE SERVER. PayFlow never issues
   * OAuth tokens. `keys` resolves the issuer's signing keys (production: its JWKS URL; never taken from a token). Requires
   * `mcpResource`, which is the `aud` every accepted token must carry. Tenant/agent/scope come from stored mappings only.
   */
  readonly oauth?: {
    readonly issuer: string;
    readonly keys: JWTVerifyGetKey;
  };
  /**
   * With the "verify-only" profile, lets a caller with NO credential use the one stateless, public verification tool
   * (the same check as the public /v1/verify/proofs). It can never reach a payment, tenant data or any other tool.
   */
  readonly mcpAnonymousVerify?: boolean;
  /** One alert webhook. When absent, alerts are persisted and visible but not delivered anywhere. */
  readonly alertWebhookUrl?: string;
  /** Test seam for alert delivery. */
  readonly sendAlert?: (
    url: string,
    init: RequestInit,
  ) => Promise<{ ok: boolean }>;
  readonly clock: () => Date;
  /**
   * Connectors this host offers. Defaults to the built-in registry (the sandbox demo catalogue only). Tests inject a registry to
   * exercise failure modes; production never adds a connector without a code change and review.
   */
  readonly connectors?: ConnectorRegistry;
  /** Channels messages can leave through. Defaults to the sandbox channel, which sends nothing anywhere. */
  readonly channels?: ChannelRegistry;
  /** Test seam: the talent sources candidates can be imported from instead of the built-in fictional sandbox source. */
  readonly talentSources?: TalentSourceRegistry;
  /** Workspace listing sources. Default: the fictional SANDBOX fixture only. */
  readonly workspaceSources?: WorkspaceSourceRegistry;
  /** Test seam: how long a send may take before its outcome is recorded as unknown. */
  readonly sendTimeoutMs?: number;
}

/** The client address: the entry `hops` positions from the right of x-forwarded-for (appended by our trusted proxy). */
function clientAddressOf(req: IncomingMessage, hops: number): string {
  const chain = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return hops > 0 && chain.length >= hops
    ? chain[chain.length - hops]!
    : (req.socket.remoteAddress ?? "unknown");
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

const APP_FILES: Record<string, string> = {
  "/workspace": "index.html",
  "/workspace/": "index.html",
  "/workspace/index.html": "index.html",
  "/workspace/app.js": "app.js",
  "/workspace/app.css": "app.css",
};
const APP_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};
/** The customer web app: three static files embedded in this module (see scripts/embed-app-ui.mjs). Anything else is a 404. */
function appAsset(path: string): { type: string; body: Buffer } | null {
  const font = /^\/workspace\/fonts\/([a-z0-9-]+\.woff2)$/u.exec(path)?.[1];
  const fontData = font ? APP_FONTS[font] : undefined;
  if (fontData)
    return { type: "font/woff2", body: Buffer.from(fontData, "base64") };
  const file = APP_FILES[path];
  const text = file ? APP_ASSETS[file] : undefined;
  if (!file || text === undefined) return null;
  return {
    type: APP_TYPES[file.split(".").pop()!]!,
    body: Buffer.from(text, "utf8"),
  };
}

/**
 * Mounts the external-agent Gateway on the hosted (non-production, Sandbox) host. Returns a
 * handler that reports whether it served the request, so the caller can fall through to the
 * console. All decisions remain in the one Authority path; this is only HTTP glue, wiring and a
 * clearly labelled operator provisioning step for a Sandbox sample Authority.
 */
export function createHostedGatewayHandler(options: HostedGatewayOptions) {
  const { sql, repo, demo, signing, clock } = options;
  /**
   * Verification material for Proof comes from the host key, so Proof reads and traces work with no
   * agent mounted (and historical Proof signed by the same key keeps verifying).
   */
  const proofKeys = new StaticPublicKeyRing(
    new Map([[signing.kid, signing.publicKey]]),
  );
  const iso = () => clock().toISOString();
  const store = new CredentialStore(sql);
  const network = new PostgresNetworkStore(sql);
  const audit = new AuditLog(sql);
  const controls = new ExecutionControls(sql);
  const limiter: RateLimitStore =
    options.rateLimitStore ?? new PostgresRateLimitStore(sql);
  const verifiedEmailRequired =
    options.requireVerifiedEmail ?? Boolean(options.emailSender);
  /**
   * Before the email is confirmed a person may look around, draft and compare. They may not approve, spend, contact suppliers, make bookings or
   * orders, enrol agents or credentials, change members or connect providers. Deny by default: only the listed read-like POSTs pass.
   */
  const SAFE_BEFORE_VERIFY = [
    /^\/v1\/admin\/org\/launch-runs\/lrn_[a-f0-9]{24}\/cancel$/u,
    /^\/v1\/admin\/org\/missions$/u,
    /^\/v1\/admin\/org\/missions\/[^/]+\/(?:workspaces|services\/search|candidates\/compare|quotes\/compare|recurring|plans|launch-runs)$/u,
  ];
  const blockedUntilVerified = (
    verified: boolean,
    method: string,
    path: string,
  ): boolean =>
    verifiedEmailRequired &&
    !verified &&
    method !== "GET" &&
    path.startsWith("/v1/admin/") &&
    !SAFE_BEFORE_VERIFY.some((r) => r.test(path));
  // Used only when the shared limiter cannot answer: a small per-process bound so a limiter fault never becomes unmetered account actions.
  const degraded = new Map<string, { n: number; resetAt: number }>();
  const degradedAllows = (key: string, limit: number): boolean => {
    const nowMs = Date.parse(iso());
    if (degraded.size > 5000)
      for (const [k, v] of degraded) if (v.resetAt <= nowMs) degraded.delete(k);
    if (degraded.size > 5000) return false;
    const cur = degraded.get(key);
    if (!cur || cur.resetAt <= nowMs) {
      degraded.set(key, { n: 1, resetAt: nowMs + 60_000 });
      return true;
    }
    cur.n++;
    return cur.n <= limit;
  };
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
    binding: new ExecutionBindingService({ sql, now: iso }),
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
        // No financial agent on this host: refuse before any provider is reached. Fail closed, so a
        // customer-only deployment can never execute a payment by accident.
        if (!demo)
          return Object.freeze({
            status: "REFUSED",
            code: "PAYMENT_RAIL_NOT_CONNECTED",
            proposalId: null,
            operationId: null,
            askedHuman: false,
            providerEffect: "NONE",
          } as const);
        return demo.gatewayPort().attempt(input);
      },
    },
    // Label only a rail this host really has. Naming PAYPAL_SANDBOX on a host with no financial
    // agent would describe a provider that is not mounted, next to a refusal saying exactly that.
    railFor: async (mandateId) => {
      const o =
        await sql`select organization_id from authority_ownership where mandate_id = ${mandateId}`;
      return String(o[0]?.organization_id ?? "").startsWith("sbx_")
        ? options.simulated
          ? "SIMULATED"
          : null
        : demo
          ? "PAYPAL_SANDBOX"
          : null;
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
  const proofs = new ProofReader(repo, proofKeys);
  const key = {
    keyId: signing.kid,
    jwk: signing.publicKey.export({ format: "jwk" }),
  };
  const portable = new PortableProofIssuer(proofs, repo, {
    issuer: options.organizationId,
    keyId: key.keyId,
    privateKey: signing.privateKey,
  });
  const credentialIssuer = options.credentialIssuer
    ? new PortableCredentialIssuer({
        sql,
        repo,
        audit,
        now: iso,
        issuer: {
          id: options.credentialIssuer,
          kid: key.keyId,
          privateKey: signing.privateKey,
          publicJwk: key.jwk,
        },
      })
    : undefined;
  const registry = new SigningKeyRegistry(sql);
  const directoryPublisher = options.credentialIssuer
    ? new IssuerDirectoryPublisher({
        sql,
        registry,
        registryIssuer: options.organizationId,
        issuer: options.credentialIssuer,
        signer: {
          kid: key.keyId,
          privateKey: signing.privateKey,
        },
        statusListUrl: `${options.credentialIssuer}/v1/issuer/status`,
        now: iso,
      })
    : undefined;
  const members = new MemberStore(sql);
  const emailOutbox = new EmailOutbox({ sql, now: iso });
  const mfa = options.mfaSecretKey
    ? new MfaService({ sql, now: iso, key: options.mfaSecretKey })
    : undefined;
  const userAuth = new UserAuthService({
    ...(mfa ? { mfa } : {}),
    sql,
    now: iso,
    outbox: emailOutbox,
    // At most 5 recovery/verification emails an hour per address, whoever asks and from wherever. A limiter fault means no mail.
    allowMailFor: async (email: string) =>
      (
        await enforceRateLimit(limiter, {
          bucket: "mail-for",
          subject: email,
          limit: 5,
          windowSeconds: 3600,
          now: iso(),
        })
      ).allowed,
    ...(options.appOrigins?.[0] ? { appBaseUrl: options.appOrigins[0] } : {}),
  });
  const invitations = new InvitationService({
    sql,
    now: iso,
    outbox: emailOutbox,
    ...(options.appOrigins?.[0] ? { appBaseUrl: options.appOrigins[0] } : {}),
  });
  const accountData = new AccountDataService({ sql, now: iso });
  const secureCookies = options.secureCookies ?? true;
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

  /** Bearer credential, or an OAuth access token from the configured external issuer, or (verify-only) anonymous. */
  const oauthAuthenticate =
    options.oauth && options.mcpResource
      ? createTenantOAuthAuthenticator({
          issuer: options.oauth.issuer,
          resource: options.mcpResource,
          keys: options.oauth.keys,
          accessAudience: GATEWAY_AUDIENCE,
          sql,
          now: () => Date.parse(iso()),
        })
      : undefined;
  const authenticateProtocol: ProtocolAuthenticator = async (request) => {
    const header = request.headers.get("authorization") ?? undefined;
    // A JWT has two dots; a PayFlow credential is `pf_...`. Each is tried only for its own shape.
    if (header && /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u.test(header))
      return oauthAuthenticate ? oauthAuthenticate(request) : null;
    if (header) {
      try {
        const access = await store.authenticate(header, iso());
        return { subject: access.clientId, scopes: access.scopes, access };
      } catch {
        return null;
      }
    }
    if (options.mcpAnonymousVerify && options.mcpProfile === "verify-only") {
      const now = iso();
      return {
        subject: "anonymous-verifier",
        scopes: ["proof:read"],
        access: {
          clientId: "anonymous-verifier",
          agentId: "anonymous-verifier",
          principalId: "anonymous-verifier",
          audience: GATEWAY_AUDIENCE,
          scopes: ["proof:read"],
          issuedAt: now,
          expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
          status: "ACTIVE",
        },
      };
    }
    return null;
  };
  const mcp = options.mcpResource
    ? createMcpHttpHandler({
        resource: options.mcpResource,
        audience: GATEWAY_AUDIENCE,
        resourceMetadataPath: "/v1/oauth-protected-resource",
        allowedOrigins: [],
        authenticate: authenticateProtocol,
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
        authenticate: authenticateProtocol,
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
  // With no operator token configured, OPERATOR access is impossible (every attempt is an AdminAuthError) but the member-authenticated
  // routes under /v1/admin/ stay available: the customer app must not depend on a shared operator secret existing.
  const authenticateAdmin = options.adminToken
    ? staticAdminAuthenticator({
        token: options.adminToken,
        organizationId: options.organizationId,
        environment: "SANDBOX",
      })
    : (): never => {
        throw new AdminAuthError();
      };
  const reconciler = new UnknownReconciler(sql, (organizationId) => {
    const lookup = organizationId.startsWith("sbx_")
      ? options.simulated?.lookupProvider()
      : (demo?.lookupProvider() ?? null);
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
      authenticateAdmin(request.authorization);
      return { kind: "OPERATOR" };
    } catch (error) {
      if (!(error instanceof AdminAuthError)) throw error;
    }
    if (request.authorization?.startsWith("Session ")) {
      const view = await userAuth.authenticate(request.authorization.slice(8));
      return view ? { kind: "MEMBER", member: view.member } : "UNAUTHENTICATED";
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

  /** An unexpected failure becomes a safe 500, never a request left hanging. */
  async function safely(
    run: () => Promise<RestResponse | null>,
  ): Promise<RestResponse | null> {
    try {
      return await run();
    } catch (error) {
      // Diagnosable without leaking: only the error class, SQLSTATE and constraint name, never the message or any parameter.
      const e = error as {
        name?: string;
        code?: string;
        constraint_name?: string;
      };
      console.error(
        `[gateway] INTERNAL_ERROR ${e.name ?? "Error"} code=${e.code ?? "-"} constraint=${e.constraint_name ?? "-"}`,
      );
      return reply(`req_${randomUUID()}`, 500, {
        reason: "INTERNAL_ERROR",
        recoverable: false,
        humanSummary: "The request could not be completed. Nothing was issued.",
        nextAction: "RETRY_LATER_OR_CONTACT_THE_OPERATOR",
      });
    }
  }

  /** Portable Authority credentials: issue from a stored Authority, list, revoke. Tenant and role come from the MEMBER. */
  async function credentialRoute(
    request: RestRequest,
  ): Promise<RestResponse | null> {
    const issue =
      /^\/v1\/admin\/org\/authorities\/([A-Za-z0-9._:-]{1,128})\/credentials$/u.exec(
        request.path,
      );
    const list = request.path === "/v1/admin/org/credentials";
    const revoke =
      /^\/v1\/admin\/org\/credentials\/(pac_[a-f0-9]{24})\/revoke$/u.exec(
        request.path,
      );
    if (!issue && !list && !revoke) return null;
    const requestId = `req_${randomUUID()}`;
    if (!credentialIssuer)
      return reply(requestId, 503, {
        reason: "ISSUER_NOT_CONFIGURED",
        recoverable: false,
        humanSummary:
          "This host does not issue portable Authority credentials.",
        nextAction: "ASK_THE_PLATFORM_OPERATOR",
      });
    const wants: Permission =
      issue && request.method === "POST"
        ? "authority:attest"
        : revoke
          ? "authority:attest_revoke"
          : "view:authorities";
    const gate = await requireMember(
      requestId,
      await resolveActor(request),
      wants,
      request.path,
    );
    if (!("member" in gate)) return gate;
    const actor = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      memberId: gate.member.memberId,
    };
    if (issue && request.method === "POST") {
      const result = await credentialIssuer.issue(
        actor,
        issue[1]!,
        request.body,
      );
      if (!result.ok)
        return reply(
          requestId,
          result.refusal === "IDEMPOTENCY_KEY_REUSED"
            ? 409
            : result.refusal === "AUTHORITY_NOT_FOUND"
              ? 404
              : result.refusal === "MALFORMED_REQUEST"
                ? 400
                : 403,
          {
            reason: result.refusal,
            recoverable: result.refusal === "MALFORMED_REQUEST",
            humanSummary:
              "No credential was issued. A credential can only say what the stored Authority already allows.",
            nextAction: "CHECK_THE_AUTHORITY_AND_REQUEST",
          },
        );
      return reply(requestId, result.value.replayed ? 200 : 201, {
        credentialId: result.value.credentialId,
        authorityId: result.value.authorityId,
        expiresAt: result.value.expiresAt,
        replayed: result.value.replayed,
        credential: result.value.credential,
      });
    }
    if (issue && request.method === "GET")
      return reply(requestId, 200, {
        credentials: await credentialIssuer.list(
          actor.organizationId,
          actor.environment,
          issue[1],
        ),
      });
    if (list && request.method === "GET")
      return reply(requestId, 200, {
        credentials: await credentialIssuer.list(
          actor.organizationId,
          actor.environment,
        ),
      });
    if (revoke && request.method === "POST") {
      const reason =
        typeof (request.body as { reason?: unknown } | undefined)?.reason ===
        "string"
          ? String((request.body as { reason: string }).reason)
          : "REVOKED_BY_MEMBER";
      const done = await credentialIssuer.revoke(actor, revoke[1]!, reason);
      return done.found
        ? reply(requestId, 200, {
            result: "REVOKED",
            alreadyRevoked: done.alreadyRevoked,
            note: "Verifiers learn of this when they next fetch the signed status list.",
          })
        : reply(requestId, 404, {
            reason: "CREDENTIAL_NOT_FOUND",
            recoverable: false,
            humanSummary: "No credential with that id.",
            nextAction: "LIST_CREDENTIALS",
          });
    }
    return null;
  }

  const delegations = new DelegationService({ sql, repo, audit, now: iso });
  const authorityCompiler = new MissionAuthorityCompiler({
    sql,
    repo,
    audit,
    now: iso,
  });
  const missionService = new MissionService({
    sql,
    audit,
    now: iso,
    afterChange: (tenant, missionId) =>
      authorityCompiler.reconcile(tenant, missionId),
  });
  const quorumService = new QuorumService({ sql, now: iso });
  const missionRoutes = createMissionRoutes({
    service: missionService,
    quorum: quorumService,
    authorities: (caller, missionId) =>
      authorityCompiler.list(caller, missionId),
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const connectorRegistry: ConnectorRegistry =
    options.connectors ?? builtinRegistry(iso);
  const connectorService = new ConnectorService({
    sql,
    audit,
    missions: missionService,
    registry: connectorRegistry,
    now: iso,
  });
  const connectorRoutes = createConnectorRoutes({
    service: connectorService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const planService = new PlanService({
    sql,
    audit,
    missions: missionService,
    now: iso,
    connectorsFor: (tenant) => connectorService.catalogFor(tenant),
  });
  const planRoutes = createPlanRoutes({
    service: planService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const ledgerService = new LedgerService({
    sql,
    audit,
    missions: missionService,
    now: iso,
  });
  const ledgerRoutes = createLedgerRoutes({
    service: ledgerService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const discoveryService = new DiscoveryService({
    sql,
    audit,
    missions: missionService,
    connectors: connectorService,
    ledger: ledgerService,
    now: iso,
  });
  const discoveryRoutes = createDiscoveryRoutes({
    service: discoveryService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const qualificationService = new QualificationService({
    sql,
    audit,
    missions: missionService,
    now: iso,
  });
  const qualificationRoutes = createQualificationRoutes({
    service: qualificationService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const quoteService = new QuoteService({
    sql,
    audit,
    missions: missionService,
    ledger: ledgerService,
    now: iso,
  });
  const quoteRoutes = createQuoteRoutes({
    service: quoteService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const sourcingService = new SourcingService({
    sql,
    audit,
    missions: missionService,
    quotes: quoteService,
    qualification: qualificationService,
    ledger: ledgerService,
    now: iso,
  });
  const sourcingRoutes = createSourcingRoutes({
    service: sourcingService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const negotiationService = new NegotiationService({
    sql,
    audit,
    missions: missionService,
    qualification: qualificationService,
    ledger: ledgerService,
    now: iso,
  });
  const counterofferService = new CounterofferService({
    sql,
    missions: missionService,
    negotiations: negotiationService,
    quotes: quoteService,
  });
  const negotiationRoutes = createNegotiationRoutes({
    service: negotiationService,
    counteroffers: counterofferService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const communicationService = new CommunicationService({
    sql,
    audit,
    missions: missionService,
    negotiations: negotiationService,
    ledger: ledgerService,
    channels: options.channels ?? builtinChannels(),
    now: iso,
    ...(options.sendTimeoutMs ? { sendTimeoutMs: options.sendTimeoutMs } : {}),
  });
  const communicationRoutes = createCommunicationRoutes({
    service: communicationService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const acceptanceService = new AcceptanceService({
    sql,
    audit,
    missions: missionService,
    quotes: quoteService,
    qualification: qualificationService,
    negotiations: negotiationService,
    ledger: ledgerService,
    now: iso,
  });
  const acceptanceRoutes = createAcceptanceRoutes({
    service: acceptanceService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const traceService = new OperationTraceService(repo, proofKeys);
  const traceReader: TraceReader = {
    read: async (proposalId) => {
      try {
        const facts = traceFactsOf(
          await traceService.project({ proposalId }, iso()),
        );
        // PayFlow knows no such payment: there is nothing to reconcile against.
        return facts.references.proposalId === null ? null : facts;
      } catch {
        return null;
      }
    },
  };
  const procurementService = new ProcurementService({
    sql,
    audit,
    missions: missionService,
    ledger: ledgerService,
    traces: traceReader,
    now: iso,
  });
  const procurementRoutes = createProcurementRoutes({
    service: procurementService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const orderService = new OrderService({
    sql,
    audit,
    missions: missionService,
    now: iso,
  });
  const orderRoutes = createOrderRoutes({
    service: orderService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const fulfillmentService = new FulfillmentService({
    sql,
    audit,
    missions: missionService,
    now: iso,
  });
  const fulfillmentRoutes = createFulfillmentRoutes({
    service: fulfillmentService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const disputeService = new DisputeService({
    sql,
    audit,
    missions: missionService,
    ledger: ledgerService,
    fulfillment: fulfillmentService,
    now: iso,
  });
  const disputeRoutes = createDisputeRoutes({
    service: disputeService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const obligationService = new ObligationService({
    sql,
    audit,
    missions: missionService,
    now: iso,
  });
  const obligationRoutes = createObligationRoutes({
    service: obligationService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const portfolioService = new PortfolioService({
    sql,
    missions: missionService,
    fulfillment: fulfillmentService,
    now: iso,
  });
  const portfolioRoutes = createPortfolioRoutes({
    service: portfolioService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
  });
  const talentScopeService = new TalentScopeService({
    sql,
    audit,
    missions: missionService,
    now: iso,
  });
  const talentScopeRoutes = createTalentScopeRoutes({
    service: talentScopeService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const talentCandidateService = new TalentCandidateService({
    sql,
    audit,
    missions: missionService,
    scopes: talentScopeService,
    sources:
      options.talentSources ??
      new TalentSourceRegistry().register(sandboxTalentSource),
    now: iso,
  });
  const workspaceService = new WorkspaceService({
    sql,
    audit,
    missions: missionService,
    sources: options.workspaceSources ?? builtinWorkspaceSources(),
    now: iso,
  });
  const automation = new AutomationService({ sql, now: iso });
  const bookingService = new BookingService({
    sql,
    audit,
    missions: missionService,
    ledger: ledgerService,
    now: iso,
    automation,
  });
  // The only handlers that exist. A job kind with no handler FAILS; nothing here moves money or contacts anyone.
  const recurringService = new RecurringService({
    sql,
    missions: missionService,
    ledger: ledgerService,
    automation,
    now: iso,
  });
  const serviceMarketService = new ServiceMarketService({
    missions: missionService,
    sources: new Map([[sandboxServiceSource.id, sandboxServiceSource]]),
  });
  const launchRunService = new LaunchRunService({
    sql,
    now: iso,
    missions: missionService,
    automation,
    // the workspace search nests its view; a launch run wants the view itself
    workspace: {
      search: async (c, m, b) => {
        const r = await workspaceService.search(c, m, b);
        return r.ok
          ? { ok: true, value: r.value.search }
          : { ok: false, refusal: r.refusal };
      },
    },
    services: {
      search: async (c, m, b) => {
        const r = await serviceMarketService.search(c, m, b);
        return r.ok
          ? { ok: true, value: r.value }
          : { ok: false, refusal: r.refusal };
      },
    },
  });
  // V3 M55: drives an ACTIVE plan's dependency graph. No specialists are connected, so every task it reaches becomes an
  // honest handoff naming what is missing; it never approves, skips, buys, hires, books, pays or contacts anyone.
  const planRunService = new PlanRunService({
    sql,
    now: iso,
    missions: missionService,
    plans: planService,
    automation,
  });
  const automationHandlers: Record<string, Handler> = {
    [LAUNCH_RUN_KIND]: launchRunService.handler(),
    [PLAN_RUN_KIND]: planRunService.handler(),
    [RECURRING_KIND]: (job) => recurringService.runCheck(job),
    BOOKING_EXPIRE: async (job) => {
      const missionId = job.payload.missionId;
      if (typeof missionId !== "string")
        return { outcome: "FAILED", note: "no mission" };
      await bookingService.expireDue(
        {
          organizationId: job.organizationId,
          environment: job.environment,
          id: "automation",
          kind: "MEMBER",
        },
        missionId,
      );
      return { outcome: "SUCCEEDED" };
    },
  };
  const bookingRoutes = createBookingRoutes({
    service: bookingService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const workspaceRoutes = createWorkspaceRoutes({
    service: workspaceService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const serviceMarketRoutes = createServiceMarketRoutes({
    service: serviceMarketService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const quorumRoutes = createQuorumRoutes({
    service: quorumService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
  });
  const recurringRoutes = createRecurringRoutes({
    service: recurringService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
  });
  const launchRunRoutes = createLaunchRunRoutes({
    service: launchRunService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
  });
  const planRunRoutes = createPlanRunRoutes({
    service: planRunService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
  });
  const automationRoutes = createAutomationRoutes({
    service: automation,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
  });
  const talentCandidateRoutes = createTalentCandidateRoutes({
    service: talentCandidateService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const shortlistService = new ShortlistService({
    sql,
    audit,
    missions: missionService,
    scopes: talentScopeService,
    now: iso,
  });
  const shortlistRoutes = createShortlistRoutes({
    service: shortlistService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
  });
  const talentOfferService = new TalentOfferService({
    sql,
    audit,
    missions: missionService,
    scopes: talentScopeService,
    ledger: ledgerService,
    now: iso,
  });
  const talentOfferRoutes = createTalentOfferRoutes({
    service: talentOfferService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  const contractorService = new ContractorService({
    sql,
    audit,
    missions: missionService,
    ledger: ledgerService,
    traces: traceReader,
    now: iso,
  });
  const contractorRoutes = createContractorRoutes({
    service: contractorService,
    reply: (requestId, status, body) => reply(requestId, status, body),
    authorize: async (requestId, request, permission) =>
      requireMember(
        requestId,
        await resolveActor(request),
        permission,
        request.path,
      ),
    agent: (request) => resolveAgentCaller(request),
    paused: async (caller) =>
      (await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      )) !== null,
  });
  /** An authenticated agent credential → its tenant and agent id. Null for anything else. */
  async function resolveAgentCaller(
    request: RestRequest,
  ): Promise<MissionCaller | null> {
    let access;
    try {
      access = await store.authenticate(request.authorization, iso());
    } catch {
      return null;
    }
    const [c] = await sql`
      select organization_id, environment, agent_id from agent_credentials where credential_id = ${access.clientId}`;
    return c
      ? {
          organizationId: String(c.organization_id),
          environment: c.environment as MissionCaller["environment"],
          id: String(c.agent_id),
          kind: "AGENT",
        }
      : null;
  }
  const delegationStatus = (r: string): number =>
    r === "AUTHORITY_NOT_FOUND" || r === "DELEGATION_NOT_FOUND"
      ? 404
      : r === "IDEMPOTENCY_KEY_REUSED" || r === "DUPLICATE_NONCE"
        ? 409
        : r === "MALFORMED"
          ? 400
          : 403;
  const delegationRefusal = (requestId: string, reason: string) =>
    reply(requestId, delegationStatus(reason), {
      reason,
      recoverable: reason === "MALFORMED",
      humanSummary:
        "No delegation was created. A delegation can only narrow what its parent and the stored Authority already allow.",
      nextAction: "CHECK_THE_PARENT_AND_REQUEST",
    });

  /** Tenant delegation API. Members use /v1/admin/org/...; a delegating AGENT uses /v1/agent/delegations/... */
  async function delegationRoute(
    request: RestRequest,
  ): Promise<RestResponse | null> {
    const root =
      /^\/v1\/admin\/org\/authorities\/([A-Za-z0-9._:-]{1,128})\/delegations$/u.exec(
        request.path,
      );
    const one =
      /^\/v1\/admin\/org\/delegations\/(dlg_[A-Za-z0-9_-]{8,64})(\/hops|\/revoke)?$/u.exec(
        request.path,
      );
    const agentHop =
      /^\/v1\/agent\/delegations\/(dlg_[A-Za-z0-9_-]{8,64})(\/hops)?$/u.exec(
        request.path,
      );
    if (!root && !one && !agentHop) return null;
    const requestId = `req_${randomUUID()}`;
    if (agentHop) {
      let access;
      try {
        access = await store.authenticate(request.authorization, iso());
      } catch {
        return reply(requestId, 401, {
          reason: "AGENT_AUTH_REQUIRED",
          recoverable: false,
          humanSummary: "A valid agent credential is required.",
          nextAction: "PRESENT_AGENT_CREDENTIAL",
        });
      }
      const [c] = await sql`
        select organization_id, environment, agent_id from agent_credentials where credential_id = ${access.clientId}`;
      if (!c)
        return reply(requestId, 401, {
          reason: "AGENT_AUTH_REQUIRED",
          recoverable: false,
          humanSummary: "A valid agent credential is required.",
          nextAction: "PRESENT_AGENT_CREDENTIAL",
        });
      const caller: Caller = {
        organizationId: String(c.organization_id),
        environment: c.environment as Caller["environment"],
        id: String(c.agent_id),
        kind: "AGENT",
      };
      const o = await controls.pausedReason(
        caller.organizationId,
        caller.environment,
      );
      if (agentHop[2] === "/hops" && request.method === "POST") {
        if (o)
          return reply(requestId, 423, {
            reason: "ORGANIZATION_PAUSED",
            recoverable: true,
            humanSummary: "The organization is paused.",
            nextAction: "WAIT_FOR_RESUME",
          });
        const r = await delegations.createHop(
          caller,
          agentHop[1]!,
          request.body,
        );
        return r.ok
          ? reply(requestId, r.replayed ? 200 : 201, {
              delegationId: r.delegationId,
              replayed: r.replayed,
              delegation: r.view,
            })
          : delegationRefusal(requestId, r.refusal);
      }
      if (!agentHop[2] && request.method === "GET") {
        const v = await delegations.inspect(caller, agentHop[1]!);
        // An agent sees only a delegation it holds or issued.
        return v &&
          (v.childAgentId === caller.id || v.parentAgentId === caller.id)
          ? reply(requestId, 200, { delegation: v })
          : delegationRefusal(requestId, "DELEGATION_NOT_FOUND");
      }
      return null;
    }
    const wants: Permission =
      (root && request.method === "POST") ||
      (one?.[2] === "/hops" && request.method === "POST")
        ? "authority:delegate"
        : one?.[2] === "/revoke"
          ? "authority:delegate_revoke"
          : "view:authorities";
    const gate = await requireMember(
      requestId,
      await resolveActor(request),
      wants,
      request.path,
    );
    if (!("member" in gate)) return gate;
    const caller: Caller = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
      id: gate.member.memberId,
      kind: "MEMBER",
    };
    if (root && request.method === "POST") {
      const r = await delegations.createRoot(caller, root[1]!, request.body);
      return r.ok
        ? reply(requestId, r.replayed ? 200 : 201, {
            delegationId: r.delegationId,
            replayed: r.replayed,
            delegation: r.view,
          })
        : delegationRefusal(requestId, r.refusal);
    }
    if (root && request.method === "GET")
      return reply(requestId, 200, {
        delegations: await delegations.list(caller, root[1]!),
      });
    if (one && one[2] === "/hops" && request.method === "POST") {
      const r = await delegations.createHop(caller, one[1]!, request.body);
      return r.ok
        ? reply(requestId, r.replayed ? 200 : 201, {
            delegationId: r.delegationId,
            replayed: r.replayed,
            delegation: r.view,
          })
        : delegationRefusal(requestId, r.refusal);
    }
    if (one && !one[2] && request.method === "GET") {
      const v = await delegations.inspect(caller, one[1]!);
      return v
        ? reply(requestId, 200, { delegation: v })
        : delegationRefusal(requestId, "DELEGATION_NOT_FOUND");
    }
    if (one && one[2] === "/revoke" && request.method === "POST") {
      const reason =
        typeof (request.body as { reason?: unknown } | undefined)?.reason ===
        "string"
          ? String((request.body as { reason: string }).reason)
          : "REVOKED_BY_MEMBER";
      const done = await delegations.revoke(caller, one[1]!, reason);
      return done.found
        ? reply(requestId, 200, {
            result: "REVOKED",
            alreadyRevoked: done.alreadyRevoked,
            note: "Spending under this delegation and its descendants is refused from now on. Charges already reserved stay counted.",
          })
        : delegationRefusal(requestId, "DELEGATION_NOT_FOUND");
    }
    return null;
  }

  const identityMappings = new OAuthIdentityMappings(sql);
  /** Who an external OAuth identity acts as. Owner-managed (member:manage); tenant comes from the MEMBER. */
  async function oauthIdentityRoute(
    request: RestRequest,
  ): Promise<RestResponse | null> {
    const base = request.path === "/v1/admin/org/oauth-identities";
    const revoke =
      /^\/v1\/admin\/org\/oauth-identities\/(oim_[a-f0-9]{24})\/revoke$/u.exec(
        request.path,
      );
    if (!base && !revoke) return null;
    const requestId = `req_${randomUUID()}`;
    if (!options.oauth)
      return reply(requestId, 503, {
        reason: "OAUTH_NOT_CONFIGURED",
        recoverable: false,
        humanSummary: "No external authorization server is configured.",
        nextAction: "ASK_THE_PLATFORM_OPERATOR",
      });
    const gate = await requireMember(
      requestId,
      await resolveActor(request),
      base && request.method === "GET" ? "view:members" : "member:manage",
      request.path,
    );
    if (!("member" in gate)) return gate;
    const tenant = {
      organizationId: gate.member.organizationId,
      environment: gate.member.environment,
    };
    if (base && request.method === "GET")
      return reply(requestId, 200, {
        issuer: options.oauth.issuer,
        identities: await identityMappings.list(tenant),
      });
    if (base && request.method === "POST") {
      const b = (request.body ?? {}) as {
        subject?: unknown;
        agentId?: unknown;
        maxScopes?: unknown;
      };
      if (
        typeof b.subject !== "string" ||
        typeof b.agentId !== "string" ||
        !Array.isArray(b.maxScopes) ||
        !b.maxScopes.every((x) => typeof x === "string")
      )
        return reply(requestId, 400, {
          reason: "MALFORMED",
          recoverable: true,
          humanSummary: "subject, agentId and maxScopes are required.",
          nextAction: "FIX_THE_REQUEST",
        });
      const now = iso();
      const r = await identityMappings.create(
        tenant,
        gate.member.memberId,
        options.oauth.issuer,
        {
          subject: b.subject,
          agentId: b.agentId,
          maxScopes: b.maxScopes,
        },
        now,
      );
      if (!r.ok)
        return reply(
          requestId,
          r.reason === "IDENTITY_ALREADY_MAPPED" ? 409 : 400,
          {
            reason: r.reason,
            recoverable: r.reason === "MALFORMED",
            humanSummary: "No identity mapping was created.",
            nextAction: "CHECK_THE_REQUEST",
          },
        );
      await audit.append({
        organizationId: tenant.organizationId,
        environment: tenant.environment,
        actorKind: "MEMBER",
        actorId: gate.member.memberId,
        action: "OAUTH_IDENTITY_MAPPED",
        subjectKind: "OAUTH_IDENTITY",
        subjectId: r.mapping.mappingId,
        detail: {
          agentId: r.mapping.agentId,
          scopes: r.mapping.maxScopes.join(" "),
        },
        occurredAt: now,
      });
      return reply(requestId, 201, { identity: r.mapping });
    }
    if (revoke && request.method === "POST") {
      const now = iso();
      const done = await identityMappings.revoke(tenant, revoke[1]!, now);
      if (!done.found)
        return reply(requestId, 404, {
          reason: "IDENTITY_NOT_FOUND",
          recoverable: false,
          humanSummary: "No such identity mapping.",
          nextAction: "LIST_IDENTITIES",
        });
      if (!done.alreadyRevoked)
        await audit.append({
          organizationId: tenant.organizationId,
          environment: tenant.environment,
          actorKind: "MEMBER",
          actorId: gate.member.memberId,
          action: "OAUTH_IDENTITY_REVOKED",
          subjectKind: "OAUTH_IDENTITY",
          subjectId: revoke[1]!,
          detail: {},
          occurredAt: now,
        });
      return reply(requestId, 200, {
        result: "REVOKED",
        alreadyRevoked: done.alreadyRevoked,
      });
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
        (opsPath[1] === "reconcile/tick" || opsPath[1] === "automation/run") &&
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
      // Run due automation: turn due schedule slots into jobs, then run due jobs once. Repeating it is safe: a job is claimed under a
      // lease, a repeated slot makes no second job, and only handlers listed above exist.
      if (op === "automation/run") {
        const ticked = await automation.tick();
        const ran = await automation.runOnce(
          `host-${randomUUID().slice(0, 8)}`,
          automationHandlers,
          20,
        );
        // Account emails: sent only when the owner has configured a sender; otherwise they stay queued and nothing is claimed.
        const swept = await emailOutbox.sweep();
        const mail = options.emailSender
          ? await emailOutbox.drain(options.emailSender)
          : { sent: 0, failed: 0, unknown: 0, deferred: 0 };
        return reply(requestId, 200, {
          ...ticked,
          ...ran,
          mail: {
            ...mail,
            ...swept,
            senderConfigured: Boolean(options.emailSender),
          },
          via: cronCall ? "SCHEDULER" : "OPERATOR",
        });
      }
      // Account-email health for the operator: counts and the messages that need a person. No bodies, no tokens, masked recipients.
      if (request.method === "GET" && op === "email-outbox")
        return reply(requestId, 200, {
          senderConfigured: Boolean(options.emailSender),
          ...(await emailOutbox.summary()),
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
    if (path === "/workspace" || path.startsWith("/workspace/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" });
        res.end();
        return true;
      }
      const asset = appAsset(path);
      if (!asset) {
        res.writeHead(404, {
          "content-type": "text/plain",
          "cache-control": "no-store",
        });
        res.end("Not found");
        return true;
      }
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": asset.type.startsWith("text/html")
          ? "no-store"
          : "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      });
      res.end(req.method === "HEAD" ? undefined : asset.body);
      return true;
    }
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
    let authorization = req.headers.authorization;
    // A browser session: the HttpOnly cookie becomes a `Session` credential for the routes, but only after the request proves it
    // came from our own page. Unsafe methods need an allowed Origin AND the CSRF token (derived from the session secret).
    let cookieSession: string | null = null;
    if (!authorization) {
      cookieSession = readSessionCookie(req.headers.cookie);
      if (cookieSession) {
        const view = await userAuth.authenticate(cookieSession);
        if (view) {
          if (method !== "GET") {
            const origin = req.headers.origin;
            const csrf = req.headers["x-pf-csrf"];
            if (
              typeof origin !== "string" ||
              !(options.appOrigins ?? []).includes(origin) ||
              !userAuth.csrfMatches(
                view,
                typeof csrf === "string" ? csrf : undefined,
              )
            ) {
              send(res, {
                status: 403,
                headers: {
                  "content-type": "application/json",
                  "cache-control": "no-store",
                },
                body: {
                  reason: "CSRF_CHECK_FAILED",
                  decision: "DENY",
                  effectCount: 0,
                  recoverable: false,
                  humanSummary:
                    "This request did not come from your signed-in page. Nothing changed.",
                  nextAction: "RELOAD_THE_PAGE_AND_TRY_AGAIN",
                },
              });
              return true;
            }
          }
          if (blockedUntilVerified(view.user.emailVerified, method, path)) {
            send(res, {
              status: 403,
              headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
              },
              body: {
                reason: "EMAIL_NOT_VERIFIED",
                decision: "DENY",
                effectCount: 0,
                recoverable: true,
                humanSummary:
                  "Confirm your email address first. Nothing was changed and no money moved.",
                nextAction: "CONFIRM_EMAIL",
              },
            });
            return true;
          }
          authorization = `Session ${cookieSession}`;
        }
      }
    }
    const request: RestRequest = {
      method,
      path,
      ...(url.search ? { query: url.search } : {}),
      ...(authorization ? { authorization } : {}),
      ...(body === undefined ? {} : { body }),
    };
    // Rate limit every /v1 request before any processing. It protects PayFlow and never alters a
    // decision; a limited request has zero effect by construction.
    {
      // Outer bucket per client ADDRESS, whatever the credential. Per-credential buckets alone are not enough: the credential id
      // is read from the token's shape before it is authenticated, so an attacker could mint unlimited fresh buckets.
      const clientAddress = clientAddressOf(req, options.trustedProxyHops ?? 1);
      let addressDecision;
      try {
        addressDecision = await enforceRateLimit(limiter, {
          bucket: "address",
          subject: `addr:${clientAddress.slice(0, 64)}`,
          limit: options.ipRateLimitPerMinute ?? 600,
          windowSeconds: 60,
          now: iso(),
        });
      } catch {
        addressDecision = { allowed: true, remaining: 0, resetAt: iso() };
      }
      if (!addressDecision.allowed) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "60",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(
          JSON.stringify({
            decision: "DENY",
            effectCount: 0,
            reason: "RATE_LIMITED",
            recoverable: true,
            humanSummary: "Too many requests from this address. $0 moved.",
            nextAction: "WAIT_AND_RETRY",
          }),
        );
        return true;
      }
      const bearer = authorization?.match(
        /^Bearer pf_(?:sbx|live|act)_(pf[cm]_[a-f0-9]{24})\./u,
      )?.[1];
      const forwarded = clientAddress;
      const family = path.startsWith("/v1/admin/")
        ? "admin"
        : path === "/v1/keys"
          ? "keys"
          : "api";
      const limitFor = { admin: 60, keys: 120, api: 120 }[family];
      // One bucket per credential or member; callers with no recognizable identity are keyed by
      // address. A shared bucket would let one noisy or hostile caller lock every organization out
      // of its own administrative API.
      // A signed-in person is keyed by their session cookie (hashed), so people behind one office address do not share a bucket. The cookie
      // is unauthenticated at this point, so a made-up value only buys a fresh bucket inside the per-address cap above.
      const cookie = readSessionCookie(
        typeof req.headers.cookie === "string" ? req.headers.cookie : undefined,
      );
      const subject =
        bearer ??
        (cookie
          ? `sess:${createHash("sha256").update(cookie).digest("hex").slice(0, 32)}`
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
    if (path.startsWith("/v1/app/")) {
      const json = (
        status: number,
        bodyOut: Record<string, unknown>,
        extra: Record<string, string> = {},
      ) =>
        send(res, {
          status,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            ...extra,
          },
          body: bodyOut,
        });
      const origin = req.headers.origin;
      const originOk =
        typeof origin === "string" &&
        (options.appOrigins ?? []).includes(origin);
      const sessionTokenIn = readSessionCookie(req.headers.cookie);
      if (
        method === "POST" &&
        (path === "/v1/app/signup" ||
          path === "/v1/app/login" ||
          path === "/v1/app/password-reset/request" ||
          path === "/v1/app/password-reset/confirm" ||
          path === "/v1/app/invitations/preview" ||
          path === "/v1/app/login/mfa" ||
          path === "/v1/app/email-verification/confirm")
      ) {
        // Login CSRF: an attacker's page must not be able to sign a victim in as the attacker.
        if (!originOk) {
          json(403, { reason: "ORIGIN_NOT_ALLOWED", recoverable: false });
          return true;
        }
        let gate;
        try {
          gate = await enforceRateLimit(limiter, {
            bucket: "auth",
            subject: `auth:${clientAddressOf(req, options.trustedProxyHops ?? 1).slice(0, 64)}`,
            limit: 20,
            windowSeconds: 60,
            now: iso(),
          });
        } catch {
          // The shared limiter cannot answer. These are the actions an attacker wants unmetered (password guessing, mail flooding), so they are
          // NOT waved through: a much tighter per-process bound applies (5 a minute per address and action), and a process that is tracking
          // too many addresses refuses. People behind one address still get in; a guessing run does not.
          const ok = degradedAllows(
            `${path}|${clientAddressOf(req, options.trustedProxyHops ?? 1).slice(0, 64)}`,
            5,
          );
          gate = { allowed: ok, remaining: 0, resetAt: iso() };
        }
        if (!gate.allowed) {
          json(
            429,
            { reason: "RATE_LIMITED", recoverable: true },
            { "retry-after": "60" },
          );
          return true;
        }
        if (path === "/v1/app/invitations/preview") {
          // Holding the token is the credential. The same answer for every token that is not a live invitation.
          const p = await invitations.preview(
            (body as { token?: unknown } | undefined)?.token,
          );
          if (!p)
            json(404, { reason: "INVALID_OR_EXPIRED", recoverable: false });
          else json(200, p);
          return true;
        }
        if (path === "/v1/app/password-reset/request") {
          // The same answer whether or not the address has an account.
          // A failure here can only happen for a real account, so reporting it would reveal which addresses have one: it is answered
          // exactly like success. The failure is logged by code only (no address, no token) and the person can simply ask again.
          await userAuth
            .requestPasswordReset(
              (body as { email?: unknown } | undefined)?.email,
            )
            .catch(() => {
              console.error(
                JSON.stringify({ event: "PASSWORD_RESET_REQUEST_FAILED" }),
              );
            });
          json(202, {
            accepted: true,
            note: "If that address has an account, a reset link has been queued.",
            // Whether the system can send email at all. It says nothing about any address, so it reveals no account.
            emailDelivery: options.emailSender ? "ENABLED" : "NOT_CONFIGURED",
          });
          return true;
        }
        if (path === "/v1/app/password-reset/confirm") {
          const b = body as { token?: unknown; password?: unknown } | undefined;
          const r = await userAuth.resetPassword(b?.token, b?.password);
          json(
            r.ok ? 200 : r.refusal === "WEAK_PASSWORD" ? 400 : 410,
            r.ok ? { ok: true } : { reason: r.refusal, recoverable: true },
          );
          return true;
        }
        if (path === "/v1/app/email-verification/confirm") {
          const ok = await userAuth.confirmEmail(
            (body as { token?: unknown } | undefined)?.token,
          );
          json(
            ok ? 200 : 410,
            ok
              ? { verified: true }
              : { reason: "INVALID_OR_EXPIRED", recoverable: true },
          );
          return true;
        }
        if (path === "/v1/app/signup") {
          const r = await userAuth.signup(body);
          if (!r.ok) {
            json(r.refusal === "EMAIL_UNAVAILABLE" ? 409 : 400, {
              reason: r.refusal,
              recoverable: true,
            });
            return true;
          }
          // Best effort and never a reason to fail the signup: without a configured sender the message simply stays queued.
          await userAuth.requestEmailVerification(r.userId).catch(() => false);
          json(201, { userId: r.userId, organizationId: r.organizationId });
          return true;
        }
        if (path === "/v1/app/login/mfa") {
          const b2 = (body ?? {}) as {
            challenge?: unknown;
            code?: unknown;
            recoveryCode?: unknown;
          };
          const m2 = await userAuth.completeMfaLogin(b2.challenge, {
            code: b2.code,
            recoveryCode: b2.recoveryCode,
          });
          if (!m2.ok) {
            // One answer for a wrong code, a spent challenge and an unknown one.
            json(m2.refusal === "MFA_UNAVAILABLE" ? 503 : 401, {
              reason: m2.refusal,
              recoverable: true,
            });
            return true;
          }
          const g2 = m2.grant;
          json(
            200,
            {
              user: g2.user,
              member: {
                organizationId: g2.member.organizationId,
                environment: g2.member.environment,
                role: g2.member.role,
              },
              csrfToken: g2.csrfToken,
              expiresAt: g2.expiresAt,
            },
            {
              "set-cookie": sessionCookie(
                g2.sessionToken,
                Math.floor(SESSION_ABSOLUTE_MS / 1000),
                secureCookies,
              ),
            },
          );
          return true;
        }
        const r = await userAuth.login(body);
        if (!r.ok) {
          json(r.refusal === "MALFORMED" ? 400 : 401, {
            reason: r.refusal,
            recoverable: true,
          });
          return true;
        }
        if ("mfaChallenge" in r) {
          // The password was right; the second step is still owed. No session and no cookie yet.
          json(200, {
            mfaRequired: true,
            challenge: r.mfaChallenge,
            expiresInSeconds: 300,
          });
          return true;
        }
        const g = r.grant;
        json(
          200,
          {
            user: g.user,
            member: {
              organizationId: g.member.organizationId,
              environment: g.member.environment,
              role: g.member.role,
            },
            csrfToken: g.csrfToken,
            expiresAt: g.expiresAt,
          },
          {
            "set-cookie": sessionCookie(
              g.sessionToken,
              Math.floor(SESSION_ABSOLUTE_MS / 1000),
              secureCookies,
            ),
          },
        );
        return true;
      }
      if (method === "POST" && path === "/v1/app/email-verification/request") {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view || !sessionTokenIn) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        if (req.headers["x-pf-csrf"] !== csrfFor(sessionTokenIn)) {
          json(403, { reason: "CSRF_CHECK_FAILED", recoverable: true });
          return true;
        }
        const queued = await userAuth.requestEmailVerification(
          view.user.userId,
        );
        json(202, {
          queued,
          emailDelivery: options.emailSender ? "ENABLED" : "NOT_CONFIGURED",
        });
        return true;
      }
      if (method === "GET" && path === "/v1/app/me") {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view || !sessionTokenIn) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        json(200, {
          user: view.user,
          member: {
            organizationId: view.member.organizationId,
            environment: view.member.environment,
            role: view.member.role,
          },
          csrfToken: csrfFor(sessionTokenIn),
          expiresAt: view.expiresAt,
          emailDelivery: options.emailSender ? "ENABLED" : "NOT_CONFIGURED",
          verificationRequired: verifiedEmailRequired,
        });
        return true;
      }
      // ---- Invitations and organizations (B3)
      const inviteRoute =
        /^\/v1\/app\/invitations(?:\/(inv_[a-f0-9]{24})\/revoke|\/(accept))?$/u.exec(
          path,
        );
      const orgRoute = /^\/v1\/app\/organizations(\/switch)?$/u.exec(path);
      if (inviteRoute || orgRoute) {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view || !sessionTokenIn) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        const m = view.member;
        const actor = {
          memberId: m.memberId,
          organizationId: m.organizationId,
          environment: m.environment,
        };
        if (orgRoute) {
          if (method === "GET" && !orgRoute[1]) {
            json(200, {
              current: m.organizationId,
              organizations: await invitations.organizationsOf(
                view.user.userId,
              ),
            });
            return true;
          }
          if (method === "POST" && orgRoute[1]) {
            const id = (body as { organizationId?: unknown } | undefined)
              ?.organizationId;
            const ok =
              typeof id === "string" &&
              (await invitations.switchOrganization(
                sessionTokenIn,
                view.user.userId,
                id,
              ));
            if (!ok) json(404, { reason: "NOT_FOUND" });
            else json(200, { switched: true, organizationId: id });
            return true;
          }
          json(405, { reason: "METHOD_NOT_ALLOWED" });
          return true;
        }
        // accept: any signed-in person; the invitation itself decides
        if (inviteRoute![2]) {
          if (method !== "POST") {
            json(405, { reason: "METHOD_NOT_ALLOWED" });
            return true;
          }
          const r = await invitations.accept(
            view.user,
            (body as { token?: unknown } | undefined)?.token,
          );
          if (!r.ok) {
            json(r.refusal === "EMAIL_NOT_VERIFIED" ? 403 : 410, {
              reason: r.refusal,
              recoverable: true,
            });
            return true;
          }
          await audit.append({
            organizationId: r.organizationId,
            environment: m.environment,
            actorKind: "MEMBER",
            actorId: view.user.userId,
            action: "INVITATION_ACCEPTED",
            subjectKind: "USER",
            subjectId: view.user.userId,
            detail: { role: r.role, alreadyMember: r.alreadyMember },
            occurredAt: iso(),
          });
          json(200, {
            joined: true,
            organizationId: r.organizationId,
            role: r.role,
            alreadyMember: r.alreadyMember,
          });
          return true;
        }
        // everything else is member management
        if (!can(m.role, "member:manage")) {
          json(403, {
            reason: "PERMISSION_DENIED",
            requiredPermission: "member:manage",
          });
          return true;
        }
        if (method === "GET" && !inviteRoute![1]) {
          json(200, {
            invitations: await invitations.list(actor),
            emailDelivery: options.emailSender ? "ENABLED" : "NOT_CONFIGURED",
          });
          return true;
        }
        if (method === "POST" && inviteRoute![1]) {
          const done = await invitations.revoke(actor, inviteRoute![1]);
          if (!done) {
            json(404, { reason: "NOT_FOUND" });
            return true;
          }
          await audit.append({
            organizationId: m.organizationId,
            environment: m.environment,
            actorKind: "MEMBER",
            actorId: m.memberId,
            action: "INVITATION_REVOKED",
            subjectKind: "INVITATION",
            subjectId: inviteRoute![1],
            detail: {},
            occurredAt: iso(),
          });
          json(200, { revoked: true });
          return true;
        }
        if (method === "POST" && !inviteRoute![1]) {
          if (verifiedEmailRequired && !view.user.emailVerified) {
            json(403, {
              reason: "EMAIL_NOT_VERIFIED",
              recoverable: true,
              nextAction: "CONFIRM_EMAIL",
            });
            return true;
          }
          // At most 20 invitations an hour per organization; a limiter fault means no invitation.
          let allowed = false;
          try {
            allowed = (
              await enforceRateLimit(limiter, {
                bucket: "invite-org",
                subject: m.organizationId,
                limit: 20,
                windowSeconds: 3600,
                now: iso(),
              })
            ).allowed;
          } catch {
            allowed = false;
          }
          if (!allowed) {
            json(
              429,
              { reason: "RATE_LIMITED", recoverable: true },
              { "retry-after": "300" },
            );
            return true;
          }
          const [org] =
            await sql`select display_name from organizations where id = ${m.organizationId}`;
          const r = await invitations.create(
            actor,
            body,
            String(org?.display_name ?? "your organization"),
          );
          if (!r.ok) {
            json(
              r.refusal === "ALREADY_MEMBER"
                ? 409
                : r.refusal === "NO_OUTBOX"
                  ? 503
                  : 400,
              { reason: r.refusal, recoverable: true },
            );
            return true;
          }
          await audit.append({
            organizationId: m.organizationId,
            environment: m.environment,
            actorKind: "MEMBER",
            actorId: m.memberId,
            action: "INVITATION_CREATED",
            subjectKind: "INVITATION",
            subjectId: r.invitationId,
            // The address and the token are not written to the audit trail.
            detail: { role: String((body as { role?: unknown }).role) },
            occurredAt: iso(),
          });
          json(202, {
            queued: true,
            invitationId: r.invitationId,
            expiresAt: r.expiresAt,
            emailDelivery: options.emailSender ? "ENABLED" : "NOT_CONFIGURED",
          });
          return true;
        }
        json(405, { reason: "METHOD_NOT_ALLOWED" });
        return true;
      }
      // ---- Two-step sign-in (B6): set up with an authenticator app, check status, turn off. Changing it asks for the password again.
      if (/^\/v1\/app\/mfa(?:\/(begin|enable|disable))?$/u.test(path)) {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view || !sessionTokenIn) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        if (!mfa) {
          json(503, { reason: "MFA_NOT_AVAILABLE" });
          return true;
        }
        const action = /^\/v1\/app\/mfa\/(begin|enable|disable)$/u.exec(
          path,
        )?.[1];
        if (!action) {
          if (method !== "GET") {
            json(405, { reason: "METHOD_NOT_ALLOWED" });
            return true;
          }
          json(200, await mfa.status(view.user.userId));
          return true;
        }
        if (method !== "POST") {
          json(405, { reason: "METHOD_NOT_ALLOWED" });
          return true;
        }
        let allowed = false;
        try {
          allowed = (
            await enforceRateLimit(limiter, {
              bucket: "mfa-manage",
              subject: view.user.userId,
              limit: 10,
              windowSeconds: 900,
              now: iso(),
            })
          ).allowed;
        } catch {
          allowed = false;
        }
        if (!allowed) {
          json(
            429,
            { reason: "RATE_LIMITED", recoverable: true },
            { "retry-after": "300" },
          );
          return true;
        }
        const b = (body ?? {}) as {
          password?: unknown;
          code?: unknown;
          recoveryCode?: unknown;
        };
        const uid = view.user.userId;
        const passwordOk = async () =>
          await accountData.verifyOwnPassword(uid, b.password);
        const endOtherSessions = async () => {
          await sql`update user_sessions set revoked_at = ${iso()} where user_id = ${uid} and revoked_at is null and session_hash <> ${createHash("sha256").update(sessionTokenIn).digest("hex")}`;
        };
        const note = (a: string) =>
          audit.append({
            organizationId: view.member.organizationId,
            environment: view.member.environment,
            actorKind: "MEMBER",
            actorId: view.member.memberId,
            action: a,
            subjectKind: "USER",
            subjectId: uid,
            detail: {},
            occurredAt: iso(),
          });
        if (action === "begin") {
          if (!(await passwordOk())) {
            json(403, { reason: "WRONG_PASSWORD", recoverable: true });
            return true;
          }
          const r = await mfa.begin(uid, view.user.email);
          if (!r.ok) json(409, { reason: r.refusal });
          else
            json(200, {
              secret: r.secret,
              otpauthUri: r.uri,
              note: "Add this to your authenticator app, then confirm with a code.",
            });
          return true;
        }
        if (action === "enable") {
          const r = await mfa.enable(uid, b.code);
          if (!r.ok) {
            json(r.refusal === "NOT_STARTED" ? 409 : 400, {
              reason: r.refusal,
              recoverable: true,
            });
            return true;
          }
          // Turning it on ends every other sign-in: whoever else has the account now has to pass the second step.
          await endOtherSessions();
          await note("MFA_ENABLED");
          json(200, {
            enabled: true,
            recoveryCodes: r.recoveryCodes,
            note: "Save these recovery codes now. They are shown once and each works once.",
          });
          return true;
        }
        // disable: the password and a current second factor
        if (!(await passwordOk())) {
          json(403, { reason: "WRONG_PASSWORD", recoverable: true });
          return true;
        }
        if (!(await mfa.isEnabled(uid))) {
          json(409, { reason: "NOT_ENABLED" });
          return true;
        }
        const verdict = await mfa.checkFactor(uid, {
          code: b.code,
          recoveryCode: b.recoveryCode,
        });
        if (verdict !== "OK") {
          json(403, {
            reason: verdict === "UNUSABLE" ? "MFA_UNAVAILABLE" : "WRONG_CODE",
            recoverable: true,
          });
          return true;
        }
        await mfa.disable(uid);
        await endOtherSessions();
        await note("MFA_DISABLED");
        json(200, { enabled: false });
        return true;
      }
      // ---- Your data (B5): export it or close the account. Both ask for the password again.
      if (
        path === "/v1/app/account/export" ||
        path === "/v1/app/account/close"
      ) {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view || !sessionTokenIn) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        if (method !== "POST") {
          json(405, { reason: "METHOD_NOT_ALLOWED" });
          return true;
        }
        // Password guessing through these routes counts like password guessing at sign-in: a small bound per account.
        let allowed = false;
        try {
          allowed = (
            await enforceRateLimit(limiter, {
              bucket: "account-data",
              subject: view.user.userId,
              limit: 5,
              windowSeconds: 900,
              now: iso(),
            })
          ).allowed;
        } catch {
          allowed = false;
        }
        if (!allowed) {
          json(
            429,
            { reason: "RATE_LIMITED", recoverable: true },
            { "retry-after": "300" },
          );
          return true;
        }
        const b = (body ?? {}) as { password?: unknown; confirm?: unknown };
        if (path === "/v1/app/account/export") {
          const r = await accountData.exportData(view.user.userId, b.password);
          if (!r.ok) {
            json(403, { reason: r.refusal, recoverable: true });
            return true;
          }
          await audit.append({
            organizationId: view.member.organizationId,
            environment: view.member.environment,
            actorKind: "MEMBER",
            actorId: view.member.memberId,
            action: "ACCOUNT_DATA_EXPORTED",
            subjectKind: "USER",
            subjectId: view.user.userId,
            detail: {},
            occurredAt: iso(),
          });
          json(200, r.data, {
            "content-disposition":
              'attachment; filename="payflow-my-data.json"',
          });
          return true;
        }
        if (b.confirm !== "CLOSE MY ACCOUNT") {
          json(400, {
            reason: "CONFIRMATION_REQUIRED",
            hint: 'Send confirm: "CLOSE MY ACCOUNT".',
          });
          return true;
        }
        const r = await accountData.closeAccount(view.user.userId, b.password);
        if (!r.ok) {
          json(r.refusal === "WRONG_PASSWORD" ? 403 : 409, {
            reason: r.refusal,
            ...(r.organizations ? { organizations: r.organizations } : {}),
            recoverable: true,
          });
          return true;
        }
        await audit.append({
          organizationId: view.member.organizationId,
          environment: view.member.environment,
          actorKind: "MEMBER",
          actorId: view.member.memberId,
          action: "ACCOUNT_CLOSED",
          subjectKind: "USER",
          subjectId: view.user.userId,
          detail: {
            organizationsLeft: r.organizationsLeft,
            organizationsOrphaned: r.organizationsOrphaned,
          },
          occurredAt: iso(),
        });
        json(
          200,
          { closed: true, ...r },
          { "set-cookie": clearedSessionCookie(secureCookies) },
        );
        return true;
      }
      // ---- Members (B4): see who is in the organization, change a role, remove someone, or leave.
      const memberRoute =
        /^\/v1\/app\/members(?:\/(pfm_[a-f0-9]{24})\/(role|remove))?$/u.exec(
          path,
        );
      if (memberRoute || path === "/v1/app/leave") {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view || !sessionTokenIn) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        const m = view.member;
        const endMemberSessions = async (memberId: string) => {
          await sql`update user_sessions set revoked_at = ${iso()} where member_id = ${memberId} and revoked_at is null`;
        };
        const record = async (
          action: string,
          subject: string,
          detail: Record<string, string | number | boolean | null>,
        ) =>
          audit.append({
            organizationId: m.organizationId,
            environment: m.environment,
            actorKind: "MEMBER",
            actorId: m.memberId,
            action,
            subjectKind: "MEMBER",
            subjectId: subject,
            detail,
            occurredAt: iso(),
          });
        // leaving: any member may leave; the last owner may not
        if (path === "/v1/app/leave") {
          if (method !== "POST") {
            json(405, { reason: "METHOD_NOT_ALLOWED" });
            return true;
          }
          const r = await members.revoke(
            m.organizationId,
            m.environment,
            m.memberId,
            iso(),
          );
          if (r !== "REVOKED") {
            json(r === "LAST_OWNER" ? 409 : 404, {
              reason: r,
              hint:
                r === "LAST_OWNER"
                  ? "Make someone else an owner first."
                  : undefined,
            });
            return true;
          }
          await endMemberSessions(m.memberId);
          await record("MEMBER_LEFT", m.memberId, {});
          json(
            200,
            { left: true },
            { "set-cookie": clearedSessionCookie(secureCookies) },
          );
          return true;
        }
        const manage = can(m.role, "member:manage");
        if (method === "GET" && !memberRoute![1]) {
          if (!manage && !can(m.role, "view:members")) {
            json(403, {
              reason: "PERMISSION_DENIED",
              requiredPermission: "view:members",
            });
            return true;
          }
          const rows =
            await sql`select m.member_id, m.role, m.status, m.display_name, u.email, u.user_id
            from organization_members m
            left join user_memberships um on um.member_id = m.member_id
            left join user_accounts u on u.user_id = um.user_id
            where m.organization_id = ${m.organizationId} and m.environment = ${m.environment} and m.status = 'ACTIVE'
            order by m.created_at, m.member_id`;
          json(200, {
            you: m.memberId,
            canManage: manage,
            members: rows.map((r) => ({
              memberId: String(r.member_id),
              name: String(r.display_name),
              role: String(r.role),
              // Only a person with member-management rights sees addresses; bearer-token members have none.
              ...(manage && r.email ? { email: String(r.email) } : {}),
              kind: r.user_id ? "PERSON" : "SERVICE",
            })),
          });
          return true;
        }
        if (method !== "POST" || !memberRoute![1]) {
          json(405, { reason: "METHOD_NOT_ALLOWED" });
          return true;
        }
        if (!manage) {
          json(403, {
            reason: "PERMISSION_DENIED",
            requiredPermission: "member:manage",
          });
          return true;
        }
        if (verifiedEmailRequired && !view.user.emailVerified) {
          json(403, {
            reason: "EMAIL_NOT_VERIFIED",
            recoverable: true,
            nextAction: "CONFIRM_EMAIL",
          });
          return true;
        }
        const target = memberRoute![1];
        if (memberRoute![2] === "role") {
          const role = (body as { role?: unknown } | undefined)?.role;
          if (
            typeof role !== "string" ||
            !(ROLES as readonly string[]).includes(role)
          ) {
            json(400, { reason: "MALFORMED", recoverable: true });
            return true;
          }
          const [before] =
            await sql`select role from organization_members where member_id = ${target} and organization_id = ${m.organizationId} and environment = ${m.environment}`;
          const r = await members.changeRole(
            m.organizationId,
            m.environment,
            target,
            role as Role,
            iso(),
          );
          if (r === "CHANGED") {
            await record("MEMBER_ROLE_CHANGED", target, {
              from: String(before?.role),
              to: role,
            });
            json(200, { changed: true, role });
          } else if (r === "UNCHANGED") json(200, { changed: false, role });
          else json(r === "LAST_OWNER" ? 409 : 404, { reason: r });
          return true;
        }
        // remove
        if (target === m.memberId) {
          json(409, {
            reason: "USE_LEAVE",
            hint: "Use leave to remove yourself.",
          });
          return true;
        }
        const r = await members.revoke(
          m.organizationId,
          m.environment,
          target,
          iso(),
        );
        if (r !== "REVOKED") {
          json(r === "LAST_OWNER" ? 409 : 404, { reason: r });
          return true;
        }
        await endMemberSessions(target);
        await record("MEMBER_REMOVED", target, {});
        json(200, { removed: true });
        return true;
      }
      // ---- Sign-ins: the person sees where they are signed in and can end the others.
      const signIns =
        /^\/v1\/app\/sessions(?:\/([a-f0-9]{16})\/revoke)?$/u.exec(path);
      if (
        signIns ||
        path === "/v1/app/sessions/revoke-others" ||
        path === "/v1/app/sessions/revoke-all"
      ) {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view || !sessionTokenIn) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        const uid = view.user.userId;
        if (method === "GET" && signIns && !signIns[1]) {
          json(200, {
            sessions: await userAuth.listSessions(uid, sessionTokenIn),
          });
          return true;
        }
        if (method === "POST" && path === "/v1/app/sessions/revoke-all") {
          await userAuth.revokeAll(uid);
          json(
            200,
            { revokedAll: true },
            { "set-cookie": clearedSessionCookie(secureCookies) },
          );
          return true;
        }
        if (method === "POST" && path === "/v1/app/sessions/revoke-others") {
          json(200, {
            revoked: await userAuth.revokeOthers(uid, sessionTokenIn),
          });
          return true;
        }
        if (method === "POST" && signIns?.[1]) {
          const out = await userAuth.revokeSession(
            uid,
            signIns[1],
            sessionTokenIn,
          );
          if (out === "NOT_FOUND") json(404, { reason: "SESSION_NOT_FOUND" });
          else if (out === "IS_CURRENT")
            json(409, {
              reason: "IS_CURRENT_SESSION",
              hint: "Use sign out for this device.",
            });
          else json(200, { revoked: true });
          return true;
        }
        json(405, { reason: "METHOD_NOT_ALLOWED" });
        return true;
      }
      // ---- Safety packs (M69): named ceilings. Applying one only ever lowers what the person asked for, and says what it changed.
      if (
        path === "/v1/app/policy-packs" ||
        path === "/v1/app/policy-packs/apply"
      ) {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        if (method === "GET" && path === "/v1/app/policy-packs") {
          json(200, { packs: PACKS });
          return true;
        }
        if (method === "POST" && path === "/v1/app/policy-packs/apply") {
          const Ask = z
            .object({
              pack: z.enum(["CAUTIOUS", "STANDARD", "EXPLORATORY_ONLY"]),
              limits: z
                .object({
                  totalBudgetMinor: z.number().int().safe().min(0),
                  maxPurchaseMinor: z.number().int().safe().min(0),
                  approveAboveMinor: z.number().int().safe().min(0),
                  durationDays: z.number().int().min(0).max(3650),
                })
                .strict(),
            })
            .strict();
          const a = Ask.safeParse(body);
          if (!a.success) {
            json(400, { reason: "MALFORMED", recoverable: true });
            return true;
          }
          json(200, {
            ...applyPack(
              PACKS.find((x) => x.id === a.data.pack)!,
              a.data.limits,
            ),
          });
          return true;
        }
      }
      // ---- AI assist: a model SUGGESTS wording and rough numbers for the wizard. It decides nothing and is optional.
      if (method === "POST" && path === "/v1/app/missions/draft") {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        if (!can(view.member.role, "mission:create")) {
          json(403, {
            reason: "PERMISSION_DENIED",
            requiredPermission: "mission:create",
          });
          return true;
        }
        // Cost discipline: a per-minute and a per-day cap for each member, before any model call.
        for (const [windowSeconds, limit] of [
          [60, 6],
          [86_400, 40],
        ] as const) {
          let gate;
          try {
            gate = await enforceRateLimit(limiter, {
              bucket: `ai-draft-${windowSeconds}`,
              subject: view.member.memberId,
              limit,
              windowSeconds,
              now: iso(),
            });
          } catch {
            gate = { allowed: false, remaining: 0, resetAt: iso() };
          }
          if (!gate.allowed) {
            json(
              429,
              { reason: "RATE_LIMITED", recoverable: true },
              { "retry-after": "60" },
            );
            return true;
          }
        }
        const text = (body as { text?: unknown } | undefined)?.text;
        const result = await draftMission(options.draftModel, text);
        await audit.append({
          organizationId: view.member.organizationId,
          environment: view.member.environment,
          actorKind: "MEMBER",
          actorId: view.member.memberId,
          action: "MISSION_DRAFT_SUGGESTED",
          subjectKind: "MISSION_DRAFT",
          subjectId: view.member.memberId,
          // The text itself is never stored in the audit trail.
          detail: {
            status: result.status,
            characters: typeof text === "string" ? text.length : 0,
          },
          occurredAt: iso(),
        });
        if (result.status === "DRAFTED") {
          json(200, {
            source: "MODEL",
            notice:
              "Suggested by an AI model. Review every field: nothing is created or approved until you do it yourself.",
            draft: result.draft,
          });
          return true;
        }
        json(
          result.status === "INVALID_INPUT"
            ? 400
            : result.status === "MODEL_NOT_CONFIGURED"
              ? 503
              : 502,
          {
            reason: result.status,
            recoverable: true,
          },
        );
        return true;
      }
      // ---- agents: a person enrolls the agents their missions will use, and issues each one a credential (shown once).
      const agentRoute =
        /^\/v1\/app\/agents(?:\/(agt_[a-f0-9]{24})\/credentials)?$/u.exec(path);
      if (agentRoute) {
        const view = sessionTokenIn
          ? await userAuth.authenticate(sessionTokenIn)
          : null;
        if (!view) {
          json(401, { reason: "NOT_SIGNED_IN", recoverable: true });
          return true;
        }
        if (
          method !== "GET" &&
          verifiedEmailRequired &&
          !view.user.emailVerified
        ) {
          json(403, {
            reason: "EMAIL_NOT_VERIFIED",
            recoverable: true,
            nextAction: "CONFIRM_EMAIL",
          });
          return true;
        }
        const m = view.member;
        const tenant = {
          organizationId: m.organizationId,
          environment: m.environment,
        };
        if (method === "GET" && !agentRoute[1]) {
          if (!can(m.role, "view:agents")) {
            json(403, {
              reason: "PERMISSION_DENIED",
              requiredPermission: "view:agents",
            });
            return true;
          }
          const rows =
            await sql`select oa.agent_id, a.display_name, oa.lifecycle, a.issued_at, a.expires_at
            from organization_agents oa join agent_passports a on a.id = oa.agent_id
            where oa.organization_id = ${tenant.organizationId} and oa.environment = ${tenant.environment}
            order by a.display_name, oa.agent_id`;
          json(200, {
            agents: rows.map((r) => {
              const expiresAt = new Date(r.expires_at as string).toISOString();
              return {
                agentId: String(r.agent_id),
                displayName: String(r.display_name),
                lifecycle: String(r.lifecycle),
                expiresAt,
                // Derived from the same lifecycle and expiry the gateway enforces: no second truth (M68).
                readiness: agentReadiness(
                  String(r.lifecycle) as AgentState,
                  {
                    issuedAt: new Date(r.issued_at as string).toISOString(),
                    expiresAt,
                  },
                  iso(),
                ),
              };
            }),
          });
          return true;
        }
        if (!can(m.role, "credential:issue")) {
          await audit.append({
            organizationId: m.organizationId,
            environment: m.environment,
            actorKind: "MEMBER",
            actorId: m.memberId,
            action: "PERMISSION_DENIED",
            subjectKind: "ROUTE",
            subjectId: path.slice(0, 120),
            detail: { permission: "credential:issue", role: m.role },
            occurredAt: iso(),
          });
          json(403, {
            reason: "PERMISSION_DENIED",
            requiredPermission: "credential:issue",
          });
          return true;
        }
        if (method === "POST" && !agentRoute[1]) {
          const parsed = z
            .object({ displayName: z.string().trim().min(1).max(80) })
            .strict()
            .safeParse(body);
          if (!parsed.success) {
            json(400, { reason: "REQUEST_MALFORMED" });
            return true;
          }
          const now = clock();
          const agentId = `agt_${randomBytes(12).toString("hex")}`;
          const principalId = principalIdOf(m.organizationId);
          await repo.saveAgent({
            id: agentId,
            principalId,
            displayName: parsed.data.displayName,
            issuedAt: new Date(now.getTime() - 60_000).toISOString(),
            expiresAt: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
            status: "ACTIVE",
            capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
          });
          await sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id, lifecycle)
            values (${m.organizationId}, ${agentId}, ${m.environment}, ${principalId}, 'ACTIVE')`;
          await audit.append({
            organizationId: m.organizationId,
            environment: m.environment,
            actorKind: "MEMBER",
            actorId: m.memberId,
            action: "AGENT_ENROLLED",
            subjectKind: "AGENT",
            subjectId: agentId,
            detail: {},
            occurredAt: now.toISOString(),
          });
          json(201, { agentId, displayName: parsed.data.displayName });
          return true;
        }
        if (method === "POST" && agentRoute[1]) {
          // The agent must belong to THIS organization: a credential is never issued across tenants.
          const [owned] = await sql`select 1 from organization_agents
            where organization_id = ${m.organizationId} and environment = ${m.environment} and agent_id = ${agentRoute[1]}
              and lifecycle not in ('SUSPENDED','REVOKED','RETIRED')`;
          if (!owned) {
            json(404, { reason: "AGENT_NOT_FOUND" });
            return true;
          }
          const issued = await store.issue(
            {
              organizationId: m.organizationId,
              environment: m.environment,
              agentId: agentRoute[1],
              scopes: ["action:request", "proof:read"],
              ttlSeconds: 30 * 86_400,
              label: `issued by ${m.displayName}`.slice(0, 128),
            },
            iso(),
          );
          await audit.append({
            organizationId: m.organizationId,
            environment: m.environment,
            actorKind: "MEMBER",
            actorId: m.memberId,
            action: "CREDENTIAL_ISSUED",
            subjectKind: "CREDENTIAL",
            subjectId: issued.credential.credentialId,
            detail: { agentId: agentRoute[1] },
            occurredAt: iso(),
          });
          json(201, {
            credentialId: issued.credential.credentialId,
            // Shown exactly once. PayFlow stores only a digest.
            token: issued.token,
            expiresAt: issued.credential.expiresAt,
            notice: "Store this token now. It cannot be retrieved again.",
          });
          return true;
        }
        json(404, { reason: "ROUTE_NOT_FOUND" });
        return true;
      }
      if (method === "POST" && path === "/v1/app/logout") {
        // The edge already required Origin + CSRF for a live cookie session. Logging out always clears the cookie.
        if (sessionTokenIn) await userAuth.logout(sessionTokenIn);
        json(
          200,
          { signedOut: true },
          {
            "set-cookie": clearedSessionCookie(secureCookies),
          },
        );
        return true;
      }
      json(404, { reason: "ROUTE_NOT_FOUND" });
      return true;
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
    if (method === "GET" && path === "/v1/issuer/directory") {
      if (!directoryPublisher) {
        send(res, {
          status: 404,
          headers: { "content-type": "application/json" },
          body: { reason: "ISSUER_NOT_CONFIGURED" },
        });
        return true;
      }
      try {
        await ensureKeys();
        const document = await directoryPublisher.current();
        // Recovery closes the alert; failure below opens it. Alerting is best-effort and never changes the response.
        await alerts
          .resolveSubject(
            "ISSUER_DIRECTORY_UNAVAILABLE",
            "ISSUER",
            options.credentialIssuer ?? "unknown",
            iso(),
          )
          .catch(() => false);
        send(res, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=60",
          },
          body: document,
        });
      } catch {
        await alerts
          .raise(
            {
              severity: "P1",
              code: "ISSUER_DIRECTORY_UNAVAILABLE",
              subjectKind: "ISSUER",
              subjectId: options.credentialIssuer ?? "unknown",
              organizationId: options.organizationId,
              detail: { endpoint: "directory" },
            },
            iso(),
          )
          .catch(() => undefined);
        // Nothing is published rather than something wrong: a verifier keeps its previous directory until it expires.
        send(res, {
          status: 503,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "retry-after": "30",
          },
          body: { reason: "DIRECTORY_UNAVAILABLE" },
        });
      }
      return true;
    }
    if (method === "GET" && path === "/v1/issuer/status") {
      if (!credentialIssuer) {
        send(res, {
          status: 404,
          headers: { "content-type": "application/json" },
          body: { reason: "ISSUER_NOT_CONFIGURED" },
        });
        return true;
      }
      try {
        const list = await credentialIssuer.statusList();
        await alerts
          .resolveSubject(
            "ISSUER_STATUS_UNAVAILABLE",
            "ISSUER",
            options.credentialIssuer ?? "unknown",
            iso(),
          )
          .catch(() => false);
        send(res, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=60",
          },
          body: list,
        });
      } catch {
        // No status list is better than a wrong one: verifiers fail closed on a missing or stale list.
        await alerts
          .raise(
            {
              severity: "P1",
              code: "ISSUER_STATUS_UNAVAILABLE",
              subjectKind: "ISSUER",
              subjectId: options.credentialIssuer ?? "unknown",
              organizationId: options.organizationId,
              detail: { endpoint: "status" },
            },
            iso(),
          )
          .catch(() => undefined);
        send(res, {
          status: 503,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "retry-after": "30",
          },
          body: { reason: "STATUS_UNAVAILABLE" },
        });
      }
      return true;
    }
    if (method === "POST" && path === "/v1/verify/proofs") {
      // Public and read-only, so it is rate limited per address AND globally, and it fails closed: no working limiter
      // means no anonymous verification, never unmetered verification.
      const ip = clientAddressOf(req, options.trustedProxyHops ?? 1);
      let limited = false;
      try {
        const perIp = await enforceRateLimit(limiter, {
          bucket: "verify-proofs",
          subject: ip,
          limit: 30,
          windowSeconds: 60,
          now: iso(),
        });
        const global = await enforceRateLimit(limiter, {
          bucket: "verify-proofs-all",
          subject: "all",
          limit: 1200,
          windowSeconds: 60,
          now: iso(),
        });
        limited = !perIp.allowed || !global.allowed;
      } catch {
        send(res, {
          status: 503,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "retry-after": "30",
          },
          body: { reason: "VERIFY_TEMPORARILY_UNAVAILABLE" },
        });
        return true;
      }
      if (limited) {
        send(res, {
          status: 429,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "retry-after": "60",
          },
          body: {
            reason: "VERIFY_RATE_LIMITED",
            humanSummary:
              "Too many verifications from here. Nothing was checked. Try again in a minute.",
          },
        });
        return true;
      }
      const reply = await verifyProofRequest(body, {
        issuer: options.organizationId,
        keys: publishedKeys,
        now: iso,
      });
      send(res, {
        status: reply.status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: reply.body,
      });
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
      const ip = clientAddressOf(req, options.trustedProxyHops ?? 1);
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
    if (
      path.startsWith("/v1/agent/delegations/") ||
      path === "/v1/agent/missions" ||
      path.startsWith("/v1/agent/missions/") ||
      path.startsWith("/v1/agent/bookings/") ||
      path === "/v1/agent/tasks" ||
      path.startsWith("/v1/agent/tasks/") ||
      path.startsWith("/v1/agent/ledger/") ||
      path === "/v1/agent/connectors" ||
      path.startsWith("/v1/agent/candidates/") ||
      path.startsWith("/v1/agent/suppliers/") ||
      path.startsWith("/v1/agent/quotes/") ||
      path.startsWith("/v1/agent/negotiations/") ||
      path.startsWith("/v1/agent/messages/") ||
      path.startsWith("/v1/agent/acceptances/") ||
      path.startsWith("/v1/agent/purchase-orders/") ||
      path.startsWith("/v1/agent/orders/") ||
      path.startsWith("/v1/agent/disputes/") ||
      path.startsWith("/v1/agent/talent-offers/") ||
      path.startsWith("/v1/agent/contracts/") ||
      path.startsWith("/v1/agent/deliverables/") ||
      path.startsWith("/v1/agent/contractor-payments/")
    ) {
      send(
        res,
        (await safely(() => delegationRoute(request))) ??
          (await safely(() => missionRoutes.agent(request))) ??
          (await safely(() => planRoutes.agent(request))) ??
          (await safely(() => ledgerRoutes.agent(request))) ??
          (await safely(() => connectorRoutes.agent(request))) ??
          (await safely(() => discoveryRoutes.agent(request))) ??
          (await safely(() => qualificationRoutes.agent(request))) ??
          (await safely(() => quoteRoutes.agent(request))) ??
          (await safely(() => sourcingRoutes.agent(request))) ??
          (await safely(() => negotiationRoutes.agent(request))) ??
          (await safely(() => communicationRoutes.agent(request))) ??
          (await safely(() => acceptanceRoutes.agent(request))) ??
          (await safely(() => procurementRoutes.agent(request))) ??
          (await safely(() => orderRoutes.agent(request))) ??
          (await safely(() => fulfillmentRoutes.agent(request))) ??
          (await safely(() => disputeRoutes.agent(request))) ??
          (await safely(() => obligationRoutes.agent(request))) ??
          (await safely(() => portfolioRoutes.agent(request))) ??
          (await safely(() => talentScopeRoutes.agent(request))) ??
          (await safely(() => talentCandidateRoutes.agent(request))) ??
          (await safely(() => workspaceRoutes.agent(request))) ??
          (await safely(() => bookingRoutes.agent(request))) ??
          (await safely(() => serviceMarketRoutes.agent(request))) ??
          (await safely(() => shortlistRoutes.agent(request))) ??
          (await safely(() => talentOfferRoutes.agent(request))) ??
          (await safely(() => contractorRoutes.agent(request))) ?? {
            status: 404,
            headers: { "content-type": "application/json" },
            body: { reason: "ROUTE_NOT_FOUND" },
          },
      );
      return true;
    }
    if (path.startsWith("/v1/admin/")) {
      const planeReply =
        (await orgRoute(request)) ??
        (await safely(() => credentialRoute(request))) ??
        (await safely(() => delegationRoute(request))) ??
        (await safely(() => missionRoutes.member(request))) ??
        (await safely(() => planRoutes.member(request))) ??
        (await safely(() => ledgerRoutes.member(request))) ??
        (await safely(() => connectorRoutes.member(request))) ??
        (await safely(() => discoveryRoutes.member(request))) ??
        (await safely(() => qualificationRoutes.member(request))) ??
        (await safely(() => quoteRoutes.member(request))) ??
        (await safely(() => sourcingRoutes.member(request))) ??
        (await safely(() => negotiationRoutes.member(request))) ??
        (await safely(() => communicationRoutes.member(request))) ??
        (await safely(() => acceptanceRoutes.member(request))) ??
        (await safely(() => procurementRoutes.member(request))) ??
        (await safely(() => orderRoutes.member(request))) ??
        (await safely(() => fulfillmentRoutes.member(request))) ??
        (await safely(() => disputeRoutes.member(request))) ??
        (await safely(() => obligationRoutes.member(request))) ??
        (await safely(() => portfolioRoutes.member(request))) ??
        (await safely(() => talentScopeRoutes.member(request))) ??
        (await safely(() => talentCandidateRoutes.member(request))) ??
        (await safely(() => workspaceRoutes.member(request))) ??
        (await safely(() => bookingRoutes.member(request))) ??
        (await safely(() => serviceMarketRoutes.member(request))) ??
        (await safely(() => automationRoutes.member(request))) ??
        (await safely(() => quorumRoutes.member(request))) ??
        (await safely(() => recurringRoutes.member(request))) ??
        (await safely(() => launchRunRoutes.member(request))) ??
        (await safely(() => planRunRoutes.member(request))) ??
        (await safely(() => shortlistRoutes.member(request))) ??
        (await safely(() => talentOfferRoutes.member(request))) ??
        (await safely(() => contractorRoutes.member(request))) ??
        (await safely(() => oauthIdentityRoute(request))) ??
        (await controlRoute(request));
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
