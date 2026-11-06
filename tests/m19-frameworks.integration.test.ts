import { truncateTenantData } from "./helpers/reset.js";
import { ownerFactory } from "./helpers/owner.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { RunContext } from "@openai/agents";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import {
  createPayFlowToolkit,
  type PayFlowToolkit,
} from "../packages/sdk-typescript/src/tools.js";
import {
  handleAnthropicToolUse,
  handleGeminiCall,
  handleOpenAiCall,
} from "../packages/sdk-typescript/src/frameworks/wire.js";
import { aiSdkTools } from "../packages/sdk-typescript/src/frameworks/ai-sdk.js";
import { langchainTools } from "../packages/sdk-typescript/src/frameworks/langchain.js";
import { openAiAgentsTools } from "../packages/sdk-typescript/src/frameworks/openai-agents.js";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * M16 against the real host composition: PostgreSQL, the real hosted Gateway, the real credential store, a
 * deterministic provider double, and the OFFICIAL MCP SDK client over Streamable HTTP. MCP must reach the same single
 * decision path as REST: no second policy engine.
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m16-host-private-bootstrap-".repeat(3);
const adminToken = "m16-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

(url ? describe : describe.skip)(
  "M19 framework adapters: one decision path, equivalent outcomes (PostgreSQL + real HTTP)",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let provider: VerticalProvider;
    const clock = () => new Date("2026-10-23T10:00:00.000Z");

    const owner = ownerFactory(
      () => origin,
      () => repo.sql,
      adminToken,
    );
    // The platform operator seeds the sandbox Authority; credentials are a member (owner) action.
    const admin = async (path: string, body: unknown) =>
      fetch(origin + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${
            path === "/v1/admin/sandbox/authority"
              ? adminToken
              : await owner.token()
          }`,
        },
        body: JSON.stringify(body),
      });
    async function sandbox(scopes = ["action:request", "proof:read"]) {
      const a = (await (
        await admin("/v1/admin/sandbox/authority", {})
      ).json()) as { authority: { id: string } };
      const c = (await (
        await admin("/v1/admin/credentials", {
          agentId: "a",
          scopes,
          ttlSeconds: 3600,
        })
      ).json()) as { token: string };
      return { authority: a.authority.id, token: c.token };
    }
    const startHost = (over: Record<string, string> = {}) => {
      host = createHostedConsole(
        parseHostedConfig({
          PAYFLOW_M5_DEMO: "true",
          DATABASE_URL: url,
          PAYFLOW_M5_PRINCIPAL_ID: "p",
          PAYFLOW_M5_AGENT_ID: "a",
          PAYFLOW_M5_BOOTSTRAP_KEY: bootstrap,
          PAYFLOW_M5_ORIGIN: "http://127.0.0.1",
          PAYFLOW_M6_DEMO_AGENT: "true",
          PAYFLOW_M6_SIGNING_KEY: pem,
          PAYFLOW_GATEWAY_ADMIN_TOKEN: adminToken,
          ...over,
        }),
        { clock, paymentProvider: provider },
      );
    };

    beforeAll(async () => {
      repo = PostgresTrustRepository.connect(url!);
      await repo.sql`drop schema public cascade`;
      await repo.sql`create schema public`;
      for (const n of (await readdir("db/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await repo.migrate(await readFile("db/migrations/" + n, "utf8"));
      server = createServer((req, res) => {
        if (!host) return void res.writeHead(502).end();
        void host.handler(req, res);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    beforeEach(async () => {
      owner.reset();
      await truncateTenantData(
        repo.sql,
        "replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings",
      );
      provider = new VerticalProvider();
      provider.payer = false;
      await repo.savePrincipal({ id: "p", displayName: "Human" });
      await repo.saveAgent({
        id: "a",
        principalId: "p",
        displayName: "Shopping Agent",
        issuedAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-11-15T00:00:00.000Z",
        status: "ACTIVE",
        capabilities,
      });
      startHost();
    });
    afterEach(async () => {
      await host?.close();
      host = undefined;
    });
    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await repo.close();
    });

    type Invoke = (
      toolkit: PayFlowToolkit,
      name: string,
      args: Record<string, unknown>,
      callId: string,
    ) => Promise<string>;

    /** Each driver feeds a tool call to a framework the way that framework's own runtime does. */
    const drivers: Record<string, Invoke> = {
      "openai wire": async (tk, name, args, callId) =>
        (
          await handleOpenAiCall(tk, {
            call_id: callId,
            name,
            arguments: JSON.stringify(args),
          })
        ).output,
      "anthropic wire": async (tk, name, args, callId) =>
        (await handleAnthropicToolUse(tk, { id: callId, name, input: args }))
          .content,
      "gemini wire": async (tk, name, args, callId) =>
        (await handleGeminiCall(tk, { id: callId, name, args }))
          .functionResponse.response.output,
      "vercel ai sdk": async (tk, name, args, callId) => {
        const model = new MockLanguageModelV4({
          doGenerate: () =>
            Promise.resolve({
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: callId,
                  toolName: name,
                  input: JSON.stringify(args),
                },
              ],
              finishReason: { unified: "tool-calls" as const, raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              warnings: [],
            }),
        });
        const result = await generateText({
          model,
          tools: aiSdkTools(tk),
          prompt: "go",
        });
        const out = result.toolResults[0]?.output;
        // The framework itself refused malformed input before running the tool.
        if (out === undefined) {
          const refused = result.content.some((c) => c.type === "tool-error");
          return JSON.stringify({ frameworkRefused: refused });
        }
        return typeof out === "string" ? out : JSON.stringify(out);
      },
      langchain: async (tk, name, args, callId) => {
        const found = langchainTools(tk).find((t) => t.name === name);
        if (!found) throw new Error("no such tool");
        let message: { content: unknown; tool_call_id: string };
        try {
          message = (await (
            found as unknown as { invoke: (call: unknown) => Promise<unknown> }
          ).invoke({
            type: "tool_call",
            id: callId,
            name,
            args,
          })) as { content: unknown; tool_call_id: string };
        } catch {
          // The framework itself refused malformed input before running the tool.
          return JSON.stringify({ frameworkRefused: true });
        }
        expect(message.tool_call_id).toBe(callId);
        return String(message.content);
      },
      "openai agents sdk": async (tk, name, args, callId) => {
        const found = openAiAgentsTools(tk).find((t) => t.name === name);
        if (!found) throw new Error("no such tool");
        const out = await found.invoke(
          new RunContext({}),
          JSON.stringify(args),
          {
            toolCall: {
              type: "function_call",
              callId,
              name,
              arguments: JSON.stringify(args),
              status: "completed",
            },
          },
        );
        return String(out);
      },
    };

    // proposalId and the sandbox Authority id are per-run identifiers; everything else must be identical.
    const normalise = (text: string) => {
      const o = JSON.parse(
        text.replace(
          /sandbox-authority-[0-9a-f-]{36}/gu,
          "sandbox-authority-X",
        ),
      ) as Record<string, unknown>;
      delete o.proposalId;
      return o;
    };
    const buy = {
      item: "Quiet keyboard",
      amount: 8400,
      currency: "USD",
      merchant: "payflow.demo.merchant",
    };
    const seen = new Map<string, Record<string, unknown>[]>();
    let uniq = 0;

    for (const [framework, invoke] of Object.entries(drivers)) {
      it(`${framework}: same Authority decisions, same idempotency`, async () => {
        const s = await sandbox();
        const toolkit = createPayFlowToolkit({
          client: new PayFlowClient({ baseUrl: origin, accessToken: s.token }),
          authority: s.authority,
          agent: "a",
        });
        const id = (label: string) =>
          `call_${framework.replace(/\W/gu, "")}_${label}_${++uniq}`;

        // 1. In policy: paid exactly once.
        const first = id("pay");
        const paid = await invoke(toolkit, "payflow_purchase", buy, first);
        expect(normalise(paid)).toMatchObject({
          decision: "ALLOW",
          status: "COMPLETED",
          effectCount: 1,
        });
        expect(provider.captureCalls).toBe(1);

        // 2. The framework retries the SAME tool call: a replay, never a second payment.
        const replay = await invoke(toolkit, "payflow_purchase", buy, first);
        expect(normalise(replay)).toMatchObject({
          decision: "DENY",
          effectCount: 0,
          reason: "REPLAY_DETECTED",
        });
        expect(provider.captureCalls).toBe(1);

        // 3. Over the limit: refused, $0 moved, nothing sent to the provider.
        const before = provider.createCalls + provider.captureCalls;
        const denied = await invoke(
          toolkit,
          "payflow_purchase",
          { ...buy, amount: 18400 },
          id("deny"),
        );
        expect(normalise(denied)).toMatchObject({
          decision: "DENY",
          status: "DENIED",
          effectCount: 0,
        });
        expect(provider.createCalls + provider.captureCalls).toBe(before);

        // 4. Hostile model arguments (an extra "authority" field) never reach PayFlow.
        const bad = await invoke(
          toolkit,
          "payflow_purchase",
          { ...buy, authority: "other-authority" },
          id("bad"),
        );
        expect(bad).not.toContain("COMPLETED");
        expect(provider.createCalls + provider.captureCalls).toBe(before);

        // 5. Proof round trip through the same framework.
        const proposalId = (JSON.parse(paid) as { proposalId?: string })
          .proposalId;
        const portable = (await (
          await fetch(`${origin}/v1/proofs/${proposalId}/portable`, {
            headers: { authorization: `Bearer ${s.token}` },
          })
        ).json()) as { proof?: Record<string, unknown> };
        expect(portable.proof).toBeTruthy();
        const verified = await invoke(
          toolkit,
          "payflow_verify_proof",
          { proof: portable.proof ?? {} },
          id("verify"),
        );
        expect(normalise(verified)).toMatchObject({
          decision: "ALLOW",
          status: "PROOF_VERIFIED",
          effectCount: 1,
        });
        const forged = await invoke(
          toolkit,
          "payflow_verify_proof",
          {
            proof: { ...portable.proof, effectCount: 0, outcome: "FAILED" },
          },
          id("forged"),
        );
        // An unverified Proof says nothing about money, so its effect is UNKNOWN, never 0.
        expect(normalise(forged)).toMatchObject({
          decision: "UNKNOWN",
          status: "PROOF_NOT_VERIFIED",
          effectCount: null,
        });

        // 6. A lost provider response is UNKNOWN, with no retry advice.
        const s2 = await sandbox();
        const tk2 = createPayFlowToolkit({
          client: new PayFlowClient({ baseUrl: origin, accessToken: s2.token }),
          authority: s2.authority,
          agent: "a",
        });
        provider.loseCapture = true;
        const unknown = await invoke(tk2, "payflow_purchase", buy, id("lost"));
        provider.loseCapture = false;
        expect(normalise(unknown)).toMatchObject({
          decision: "ALLOW",
          status: "UNRESOLVED",
          effectCount: null,
          doNotRetry: true,
        });

        seen.set(
          framework,
          [paid, replay, denied, verified, forged, unknown].map(normalise),
        );
      });
    }

    it("every framework produced exactly the same outcomes for the same requests", () => {
      expect(seen.size).toBe(Object.keys(drivers).length);
      const [reference, ...rest] = [...seen.values()];
      for (const other of rest) expect(other).toEqual(reference);
    });
  },
);
