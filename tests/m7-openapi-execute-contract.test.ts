import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { GatewayAccessError } from "../src/network/access.js";
import {
  AdminAuthError,
  createCredentialAdminHandler,
} from "../src/network/admin-rest.js";
import { createExecutingRestHandler } from "../src/network/rest-execution.js";
import type { CredentialStore } from "../src/network/credentials.js";
import type { ExecutingGateway } from "../src/network/gateway-execution.js";

const spec = parse(readFileSync("openapi/payflow-v1.yaml", "utf8")) as {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
};

const exec = createExecutingRestHandler({} as ExecutingGateway, {
  authenticate: () => Promise.reject(new GatewayAccessError("ACCESS_INACTIVE")),
  readProof: () => Promise.resolve(null),
  issuePortableProof: () => Promise.resolve("NOT_ISSUABLE"),
  publicKeys: () => ({ issuer: "i", keys: [] }),
});
const admin = createCredentialAdminHandler({} as CredentialStore, {
  authenticateAdmin: () => {
    throw new AdminAuthError();
  },
  now: () => "2026-11-02T00:00:00.000Z",
});
const concrete = (p: string) =>
  p
    .replace("{proposalId}", "p1")
    .replace("{credentialId}", "pfc_" + "a".repeat(24));

describe("OpenAPI ↔ executing REST handlers do not drift", () => {
  const documented = Object.entries(spec.paths).filter(
    ([p]) =>
      p === "/v1/actions/execute" ||
      p === "/v1/keys" ||
      p.startsWith("/v1/proofs/") ||
      p.startsWith("/v1/admin/"),
  );

  it("documents the executing, credential, proof and key route families", () => {
    expect(documented.map(([p]) => p).sort()).toEqual([
      "/v1/actions/execute",
      "/v1/admin/credentials",
      "/v1/admin/credentials/{credentialId}/revoke",
      "/v1/keys",
      "/v1/proofs/{proposalId}",
      "/v1/proofs/{proposalId}/portable",
    ]);
  });

  it("serves every documented method (never ROUTE_NOT_FOUND) and only emits documented statuses", async () => {
    for (const [path, methods] of documented) {
      for (const method of Object.keys(methods)) {
        const handler = path.startsWith("/v1/admin/") ? admin : exec;
        const res = await handler({
          method: method.toUpperCase() as "GET" | "POST",
          path: concrete(path),
          authorization: "Bearer nope",
          body: {},
        });
        expect(
          (res.body as { reason?: string }).reason,
          `${method} ${path}`,
        ).not.toBe("ROUTE_NOT_FOUND");
        expect(
          Object.keys(methods[method]!.responses),
          `${method} ${path} -> ${res.status}`,
        ).toContain(String(res.status));
      }
    }
  });

  it("answers an undocumented route with a structured 404, not a bare status", async () => {
    const res = await exec({ method: "POST", path: "/v1/actions/exec" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      reason: "ROUTE_NOT_FOUND",
      decision: "DENY",
    });
  });

  it("declares effectCount null (not 0) for UNRESOLVED and unexpected failure", () => {
    const text = readFileSync("openapi/payflow-v1.yaml", "utf8");
    const unresolved = text.slice(
      text.indexOf("    ExecuteUnresolved:"),
      text.indexOf("    ExecuteOutcome:"),
    );
    expect(unresolved).toMatch(/effectCount:\s*\n\s*type: "null"/u);
    const unknown = text.slice(
      text.indexOf("    ExecuteUnknownFailure:"),
      text.indexOf("    ProofEnvelope:"),
    );
    expect(unknown).toMatch(/effectCount: \{ type: "null" \}/u);
  });
});
