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
import { PortableProofIssuer } from "./portable-proof.js";
import { ProofReader } from "./proof-read.js";
import { createExecutingRestHandler } from "./rest-execution.js";
import type { RestRequest, RestResponse } from "./rest.js";

export interface HostedGatewayOptions {
  readonly sql: Sql;
  readonly repo: PostgresTrustRepository;
  readonly demo: DemoShoppingAgent;
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
  const gateway = new ExecutingGateway({
    repo,
    delegated: demo.gatewayPort(),
    ranker: new FakeCommerceRanker(),
    now: iso,
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
    const mandate: Mandate = {
      id: `sandbox-authority-${randomUUID()}`,
      principalId: options.principalId,
      authorizedAgentId: options.agentId,
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
    await repo.saveMandate(mandate);
    await sql`insert into organizations (id, display_name) values (${options.organizationId}, 'PayFlow Sandbox') on conflict (id) do nothing`;
    await sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id)
      values (${options.organizationId}, ${options.agentId}, 'SANDBOX', ${options.principalId}) on conflict do nothing`;
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
    if (path.startsWith("/v1/admin/")) {
      if (!admin) {
        send(res, {
          status: 404,
          headers: { "content-type": "application/json" },
          body: { reason: "ROUTE_NOT_FOUND" },
        });
        return true;
      }
      send(
        res,
        path === "/v1/admin/sandbox/authority" && method === "POST"
          ? await provisionSampleAuthority(request)
          : await admin(request),
      );
      return true;
    }
    send(res, await executing(request));
    return true;
  };
}
