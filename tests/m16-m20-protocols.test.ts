import { describe, expect, it } from "vitest";
import {
  PAYFLOW_MCP_TOOLS,
  invokePayFlowMcpTool,
} from "../src/protocols/mcp.js";
import {
  createPayFlowAgentCard,
  evaluateDelegatedRequest,
  validateDelegationAttenuation,
  type DelegatedFinancialScope,
} from "../src/protocols/a2a.js";
import { runToolSelectionEval } from "../src/protocols/tool-selection.js";
import {
  anthropicCompatibleTools,
  geminiCompatibleFunctionDeclarations,
  openAiFunctionTools,
} from "../src/protocols/tool-adapters.js";

const services = {
  checkFinancialAuthority: async () => ({ verdict: "ALLOW" }),
  requestAuthorizedAction: async () => ({ decision: "DENY" }),
  verifyAuthority: async () => ({ verdict: "VALID" }),
  verifyFinancialProof: async () => ({ verdict: "VALID" }),
  reconcileFinancialAction: async () => ({ state: "UNKNOWN" }),
};

describe("M16 MCP distribution", () => {
  it("exposes the deliberately small five-tool vocabulary", () => {
    expect(PAYFLOW_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "check_financial_authority",
      "request_authorized_action",
      "verify_authority",
      "verify_financial_proof",
      "reconcile_financial_action",
    ]);
  });

  it("requires authentication and blocks secret-shaped output", async () => {
    await expect(
      invokePayFlowMcpTool(
        "verify_authority",
        {},
        { authenticated: false, requestId: "r1" },
        services,
      ),
    ).rejects.toThrow("MCP_AUTHENTICATION_REQUIRED");
    await expect(
      invokePayFlowMcpTool(
        "verify_authority",
        {
          presentation: {},
          audience: "test",
          challenge: "test-challenge-16chars",
        },
        { authenticated: true, requestId: "r2" },
        { ...services, verifyAuthority: async () => ({ privateKey: "never" }) },
      ),
    ).rejects.toThrow("MCP_SECRET_OUTPUT_BLOCKED");
  });
});

describe("M18 A2A", () => {
  it("builds a v1 Agent Card with per-interface protocol version", () => {
    const card = createPayFlowAgentCard("https://authority.example");
    expect(card.supportedInterfaces[0]?.protocolVersion).toBe("1.0");
    expect(card.supportedInterfaces[0]?.url).toBe(
      "https://authority.example/a2a/v1",
    );
    expect(card.skills.length).toBeGreaterThan(0);
  });

  it("allows attenuation and rejects downstream widening", () => {
    const parent: DelegatedFinancialScope = {
      principalId: "p1",
      parentAgentId: "root",
      childAgentId: "agent-a",
      audience: "payflow",
      actionKinds: ["PURCHASE", "PROCUREMENT_ORDER"],
      currencies: ["USD"],
      counterpartyIds: ["vendor-1", "vendor-2"],
      maxAmountMinor: 10_000,
      issuedAt: "2026-10-28T02:00:00.000Z",
      expiresAt: "2026-10-29T02:00:00.000Z",
      nonce: "delegation-parent-0001",
    };
    const child: DelegatedFinancialScope = {
      ...parent,
      parentAgentId: "agent-a",
      childAgentId: "agent-b",
      actionKinds: ["PURCHASE"],
      counterpartyIds: ["vendor-1"],
      maxAmountMinor: 5_000,
      expiresAt: "2026-10-28T20:00:00.000Z",
      nonce: "delegation-child-0001",
    };
    expect(validateDelegationAttenuation(parent, child)).toEqual([]);
    expect(
      validateDelegationAttenuation(parent, {
        ...child,
        maxAmountMinor: 20_000,
      }),
    ).toContain("AMOUNT_WIDENED");
  });
});

describe("M19 framework adapters and M20 discoverability evals", () => {
  it("keeps equivalent tool vocabulary across model/framework schemas", () => {
    expect(openAiFunctionTools()).toHaveLength(5);
    expect(anthropicCompatibleTools()).toHaveLength(5);
    expect(geminiCompatibleFunctionDeclarations()).toHaveLength(5);
  });

  it("passes the deterministic safe-selection golden set", () => {
    const result = runToolSelectionEval();
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(result.total);
  });
});

describe("M18 delegated A2A request evaluation", () => {
  const scopeOf = (overrides: Record<string, unknown> = {}) => ({
    principalId: "principal-1",
    parentAgentId: "root-agent",
    childAgentId: "child-agent",
    audience: "payflow-a2a-v1",
    actionKinds: ["PURCHASE"],
    currencies: ["USD"],
    counterpartyIds: ["merchant-allowed"],
    maxAmountMinor: 5_000,
    issuedAt: "2026-10-28T02:00:00.000Z",
    expiresAt: "2026-10-28T09:00:00.000Z",
    nonce: "delegation-nonce-000001",
    ...overrides,
  });
  const parent = scopeOf({
    parentAgentId: "human",
    childAgentId: "root-agent",
    maxAmountMinor: 10_000,
    nonce: "parent-nonce-0000000001",
  }) as never;
  const expected = {
    audience: "payflow-a2a-v1",
    now: "2026-10-28T03:00:00.000Z",
  };
  const freshStore = () => {
    const claimed = new Set<string>();
    return {
      claimNonce: async (scopeKey: string, nonce: string) => {
        const key = `${scopeKey}:${nonce}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    };
  };

  it("accepts a narrower child once and treats a repeat as DUPLICATE", async () => {
    const store = freshStore();
    const first = await evaluateDelegatedRequest(
      scopeOf(),
      parent,
      expected,
      store,
    );
    const second = await evaluateDelegatedRequest(
      scopeOf(),
      parent,
      expected,
      store,
    );
    expect([first.verdict, second.verdict]).toEqual(["ACCEPTED", "DUPLICATE"]);
  });

  it.each([
    ["WRONG_AUDIENCE", { audience: "someone-else" }],
    ["EXPIRED", { expiresAt: "2026-10-28T02:30:00.000Z" }],
    ["WIDENED", { maxAmountMinor: 10_001 }],
    ["MALFORMED", { nonce: "short" }],
  ])("refuses %s without consuming the nonce", async (verdict, overrides) => {
    const store = freshStore();
    const result = await evaluateDelegatedRequest(
      scopeOf(overrides),
      parent,
      expected,
      store,
    );
    expect(result.verdict).toBe(verdict);
    const valid = await evaluateDelegatedRequest(
      scopeOf(),
      parent,
      expected,
      store,
    );
    expect(valid.verdict).toBe("ACCEPTED");
  });
});
