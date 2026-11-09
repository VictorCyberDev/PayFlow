import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { PostgresTrustRepository } from "../../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../../src/console-hosted.js";
import { VerticalProvider } from "../m4-vertical-fixture.js";
import type { ConnectorRegistry } from "../../src/missions/connectors.js";
import type { ChannelRegistry } from "../../src/missions/channels.js";
import type { TalentSourceRegistry } from "../../src/missions/talent-candidates.js";
import { truncateTenantData } from "./reset.js";

/**
 * Real-host test harness: PostgreSQL, the real hosted Gateway over HTTP, a deterministic provider double, and the helpers
 * every integration test needs (members, agents, a stored Authority). Call `hostHarness()` inside a `describe`; it registers
 * the hooks. Tests then use the returned accessors.
 */
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
export const ADMIN_TOKEN = "harness-gateway-admin-secret-".repeat(3);
const BOOTSTRAP = "harness-host-private-bootstrap-".repeat(3);
export const DEMO_MERCHANT = "payflow.demo.merchant";

export function hostHarness(
  options: {
    env?: Record<string, string>;
    extraTruncate?: string;
    agents?: readonly string[];
    /** Replace the host's connector registry (a test double must never be in a production registry). */
    connectors?: () => ConnectorRegistry;
    channels?: () => ChannelRegistry;
    talentSources?: () => TalentSourceRegistry;
    sendTimeoutMs?: number;
  } = {},
) {
  const url = process.env.TEST_DATABASE_URL;
  const pem = generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  let repo!: PostgresTrustRepository;
  let server!: Server;
  let origin = "";
  let host: ReturnType<typeof createHostedConsole> | undefined;
  let provider!: VerticalProvider;
  let nowMs = Date.parse("2026-10-23T10:00:00.000Z");
  const owners = new Map<string, string>();
  const clock = () => new Date(nowMs);
  const agents = options.agents ?? ["a", "b", "c"];

  const start = (
    over: Record<string, string> = {},
    transform: (
      c: ReturnType<typeof parseHostedConfig>,
    ) => ReturnType<typeof parseHostedConfig> = (c) => c,
  ) => {
    host = createHostedConsole(
      transform(
        parseHostedConfig({
          PAYFLOW_M5_DEMO: "true",
          DATABASE_URL: url,
          PAYFLOW_M5_PRINCIPAL_ID: "p",
          PAYFLOW_M5_AGENT_ID: "a",
          PAYFLOW_M5_BOOTSTRAP_KEY: BOOTSTRAP,
          PAYFLOW_M5_ORIGIN: "http://127.0.0.1",
          PAYFLOW_M6_DEMO_AGENT: "true",
          PAYFLOW_M6_SIGNING_KEY: pem,
          PAYFLOW_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
          PAYFLOW_APP_ORIGINS: origin,
          ...options.env,
          ...over,
        }),
      ),
      {
        clock,
        paymentProvider: provider,
        ...(options.connectors ? { connectors: options.connectors() } : {}),
        ...(options.channels ? { channels: options.channels() } : {}),
        ...(options.talentSources
          ? { talentSources: options.talentSources() }
          : {}),
        ...(options.sendTimeoutMs
          ? { sendTimeoutMs: options.sendTimeoutMs }
          : {}),
      },
    );
  };

  beforeAll(async () => {
    repo = PostgresTrustRepository.connect(url!);
    await repo.sql`drop schema public cascade`;
    await repo.sql`create schema public`;
    for (const f of (await readdir("db/migrations"))
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await repo.migrate(await readFile("db/migrations/" + f, "utf8"));
    server = createServer((req, res) => {
      if (!host) return void res.writeHead(502).end();
      void host.handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(async () => {
    nowMs = Date.parse("2026-10-23T10:00:00.000Z");
    owners.clear();
    await truncateTenantData(
      repo.sql,
      "replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings,proof_signing_keys,issuer_directory_publications,portable_credentials,delegations" +
        (options.extraTruncate ? "," + options.extraTruncate : ""),
    );
    provider = new VerticalProvider();
    provider.payer = false;
    await repo.savePrincipal({ id: "p", displayName: "Human" });
    for (const id of agents)
      await repo.saveAgent({
        id,
        principalId: "p",
        displayName: `Agent ${id}`,
        issuedAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-11-15T00:00:00.000Z",
        status: "ACTIVE",
        capabilities,
      });
    start();
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await repo.close();
  });

  const call = (
    token: string | null,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const ownerOf = async (organizationId = "payflow-sandbox") => {
    const cached = owners.get(organizationId);
    if (cached) return cached;
    await repo.sql`insert into organizations (id, display_name) values (${organizationId}, 'T') on conflict (id) do nothing`;
    const r = await call(ADMIN_TOKEN, "POST", "/v1/admin/members", {
      organizationId,
      environment: "SANDBOX",
      displayName: "owner",
      role: "OWNER",
    });
    const t = ((await r.json()) as { token: string }).token;
    owners.set(organizationId, t);
    return t;
  };
  const member = async (role: string, organizationId = "payflow-sandbox") => {
    if (role === "OWNER") return ownerOf(organizationId);
    const r = await call(
      await ownerOf(organizationId),
      "POST",
      "/v1/admin/members",
      {
        displayName: `harness ${role}`,
        role,
      },
    );
    const body = (await r.json()) as { token?: string };
    if (!body.token) throw new Error(`member ${role}: ${r.status}`);
    return body.token;
  };
  /** A stored Authority owned by the default tenant (the sandbox "keyboard Authority": $100, demo merchant). */
  const authority = async () => {
    const r = await call(
      ADMIN_TOKEN,
      "POST",
      "/v1/admin/sandbox/authority",
      {},
    );
    return ((await r.json()) as { authority: { id: string } }).authority.id;
  };
  /** An agent credential bound to the default tenant. */
  const agentToken = async (
    agentId = "a",
    scopes = ["action:request", "proof:read"],
  ) => {
    await repo.sql`insert into organization_agents (organization_id, agent_id, environment, sponsor_principal_id)
      values ('payflow-sandbox', ${agentId}, 'SANDBOX', 'p') on conflict do nothing`;
    const r = await call(await ownerOf(), "POST", "/v1/admin/credentials", {
      agentId,
      scopes,
      ttlSeconds: 3600,
    });
    const body = (await r.json()) as { token?: string };
    if (!body.token) throw new Error(`credential ${agentId}: ${r.status}`);
    return body.token;
  };

  return {
    get repo() {
      return repo;
    },
    get origin() {
      return origin;
    },
    get provider() {
      return provider;
    },
    get host() {
      return host;
    },
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    iso: () => new Date(nowMs).toISOString(),
    start,
    restart: async (
      over: Record<string, string> = {},
      transform?: Parameters<typeof start>[1],
    ) => {
      await host?.close();
      start(over, transform);
    },
    call,
    ownerOf,
    member,
    authority,
    agentToken,
  };
}
export type Harness = ReturnType<typeof hostHarness>;
