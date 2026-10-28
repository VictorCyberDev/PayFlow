import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import { GATEWAY_AUDIENCE } from "../src/network/gateway.js";
import { createGatewayRestHandler } from "../src/network/rest.js";
import {
  accessFor,
  makeGateway,
  requestBody,
} from "../src/network/live-fault-injector.js";
import { kernelFixture } from "../src/network/benchmark.js";
import { accessFromTrustedOAuthClaims } from "../src/network/access.js";

const NOW = "2026-10-28T03:00:00.000Z";
const spec = parse(readFileSync("openapi/payflow-v1.yaml", "utf8")) as {
  openapi: string;
  paths: Record<
    string,
    Record<string, { operationId?: string; responses: Record<string, unknown> }>
  >;
  components: Record<string, Record<string, unknown>>;
};

function collectRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((entry) => collectRefs(entry, out));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") out.push(child);
      else collectRefs(child, out);
    }
  }
  return out;
}

describe("OpenAPI contract", () => {
  it("is OpenAPI 3.1 with unique operationIds and resolvable references", () => {
    expect(spec.openapi).toMatch(/^3\.1/u);
    const ids: string[] = [];
    for (const methods of Object.values(spec.paths)) {
      for (const operation of Object.values(methods)) {
        expect(operation.operationId).toBeTruthy();
        ids.push(operation.operationId as string);
        expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    for (const ref of collectRefs(spec)) {
      const [, section, name] = ref.split("/").slice(1);
      expect(
        section && name && spec.components[section]?.[name],
        ref,
      ).toBeTruthy();
    }
  });

  it("documents exactly the routes the Gateway REST handler serves", async () => {
    const fixture = kernelFixture();
    const { gateway } = makeGateway(fixture.mandate, fixture.agent);
    const handler = createGatewayRestHandler(gateway, {
      authenticate: async () => accessFor(fixture.agent),
      trustedMerchantRisk: async () => "LOW",
      now: () => NOW,
    });
    expect(spec.paths["/v1/authorities/{authorityId}"]?.get).toBeTruthy();
    expect(spec.paths["/v1/actions"]?.post).toBeTruthy();
    expect(
      (
        await handler({
          method: "GET",
          path: "/v1/authorities/benchmark-authority",
          authorization: "Bearer t",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await handler({
          method: "GET",
          path: "/v1/unknown",
          authorization: "Bearer t",
        })
      ).status,
    ).toBe(404);
  });
});

describe("External agent journey: TypeScript SDK → REST → Gateway → Trust Kernel", () => {
  function sdkOverHandler(state: "ACTIVE" | "REVOKED" = "ACTIVE") {
    const fixture = kernelFixture();
    const { gateway, capabilitiesIssued } = makeGateway(
      fixture.mandate,
      fixture.agent,
      state,
    );
    const handler = createGatewayRestHandler(gateway, {
      authenticate: async (authorization) => {
        if (authorization !== "Bearer agent-token") throw new Error("no");
        return accessFor(fixture.agent);
      },
      trustedMerchantRisk: async () => "LOW",
      now: () => NOW,
    });
    const fetchShim: typeof fetch = async (input, init) => {
      const url = new URL(input as URL);
      const headers = new Headers(init?.headers);
      const reply = await handler({
        method: (init?.method ?? "GET") as "GET" | "POST",
        path: url.pathname,
        ...(headers.get("authorization")
          ? { authorization: headers.get("authorization") as string }
          : {}),
        ...(init?.body
          ? { body: JSON.parse(init.body as string) as unknown }
          : {}),
      });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: reply.headers,
      });
    };
    return {
      client: new PayFlowClient({
        baseUrl: "http://localhost:3000",
        accessToken: "agent-token",
        fetch: fetchShim,
      }),
      capabilitiesIssued,
    };
  }

  it("lets an external agent read its Authority and obtain one bounded capability", async () => {
    const { client, capabilitiesIssued } = sdkOverHandler();
    const authority = (await client.readAuthority("benchmark-authority")) as {
      authority: { status: string; fingerprint: string };
    };
    expect(authority.authority.status).toBe("ACTIVE");
    const result = (await client.requestAuthorizedAction(requestBody())) as {
      decision: { decision: string };
      executionCapability?: { grantId: string };
    };
    expect(result.decision.decision).toBe("ALLOW");
    expect(result.executionCapability?.grantId).toBeTruthy();
    expect(capabilitiesIssued()).toBe(1);
  });

  it("blocks drift and replay end to end, and never issues a second capability", async () => {
    const { client, capabilitiesIssued } = sdkOverHandler();
    const drift = (await client.requestAuthorizedAction(
      requestBody({
        nonce: "drift-nonce-00000001",
        amount: { currency: "USD", minor: 99_999 },
        merchant: { id: "evil", displayName: "Evil" },
      }),
    )) as {
      decision: { decision: string; reasonCodes: string[] };
      executionCapability?: unknown;
    };
    expect(drift.decision.decision).toBe("DENY");
    expect(drift.executionCapability).toBeUndefined();
    await client.requestAuthorizedAction(requestBody());
    const replay = (await client.requestAuthorizedAction(requestBody())) as {
      decision: { reasonCodes: string[] };
    };
    expect(replay.decision.reasonCodes).toContain("REPLAY_DETECTED");
    expect(capabilitiesIssued()).toBe(1);
  });

  it("surfaces a stable error for revoked Authority and for a bad token, with no secrets", async () => {
    const { client } = sdkOverHandler("REVOKED");
    await expect(
      client.requestAuthorizedAction(requestBody()),
    ).rejects.toMatchObject({
      status: 403,
      body: { error: { code: "AUTHORITY_INACTIVE" } },
    });
  });

  it("normalizes trusted OAuth claims into bounded scopes only", () => {
    const access = accessFromTrustedOAuthClaims({
      client_id: "c1",
      sub: "agent-1",
      principal_id: "p1",
      aud: GATEWAY_AUDIENCE,
      scope: "authority:read action:request",
      iat: 1_700_000_000,
      exp: 4_000_000_000,
    });
    expect(access.scopes).toEqual(["authority:read", "action:request"]);
    expect(() =>
      accessFromTrustedOAuthClaims({
        client_id: "c1",
        sub: "agent-1",
        principal_id: "p1",
        aud: GATEWAY_AUDIENCE,
        scope: "admin:everything",
        iat: 1,
        exp: 4_000_000_000,
      }),
    ).toThrow();
  });
});
