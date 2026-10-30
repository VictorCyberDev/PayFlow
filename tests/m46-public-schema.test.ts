import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type Ajv2020Class from "ajv/dist/2020.js";
import type addFormatsFn from "ajv-formats";
import { describe, expect, it } from "vitest";
import { kernelFixture } from "../src/network/benchmark.js";
import { toPublicAuthorityDocument } from "../src/network/public-authority.js";

// ajv ships CommonJS: load it with require so NodeNext typing stays honest.
const nodeRequire = createRequire(import.meta.url);
const Ajv2020 = (nodeRequire("ajv/dist/2020") as typeof Ajv2020Class).default;
const addFormats = (nodeRequire("ajv-formats") as typeof addFormatsFn).default;
const schema = JSON.parse(
  readFileSync("spec/financial-authority-v1.schema.json", "utf8"),
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const now = "2026-10-28T03:00:00.000Z";

describe("M46 public Financial Authority Schema v1", () => {
  it("accepts the projection of a real Mandate and exposes no internal fingerprint or nonce", () => {
    const { mandate } = kernelFixture();
    const doc = toPublicAuthorityDocument(mandate, "ACTIVE", {
      now,
      organizationId: "org-1",
    });
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
    expect(JSON.stringify(doc)).not.toContain(mandate.nonce);
    expect(JSON.stringify(doc)).not.toMatch(
      /fingerprint|approvalThreshold|humanApproval/iu,
    );
  });

  it("reports EXPIRED and lifecycle truth, never ACTIVE past expiry", () => {
    const { mandate } = kernelFixture();
    expect(
      toPublicAuthorityDocument(mandate, "ACTIVE", {
        now: "2026-12-01T00:00:00.000Z",
      }).validity.status,
    ).toBe("EXPIRED");
    expect(
      toPublicAuthorityDocument(mandate, "REVOKED", { now }).validity.status,
    ).toBe("REVOKED");
  });

  it.each([
    [
      "unknown top-level property",
      (d: Record<string, unknown>) => ({ ...d, standingPrivilege: true }),
    ],
    [
      "runtime revalidation disabled",
      (d: Record<string, unknown>) => ({
        ...d,
        execution: { ...(d.execution as object), runtimeRevalidation: false },
      }),
    ],
    [
      "one-time grant disabled",
      (d: Record<string, unknown>) => ({
        ...d,
        execution: { ...(d.execution as object), oneTimeGrant: false },
      }),
    ],
    [
      "proof not required",
      (d: Record<string, unknown>) => ({ ...d, proof: { required: false } }),
    ],
    [
      "lowercase currency",
      (d: Record<string, unknown>) => ({
        ...d,
        scope: { ...(d.scope as object), currencies: ["usd"] },
      }),
    ],
    [
      "fractional amount",
      (d: Record<string, unknown>) => ({
        ...d,
        scope: { ...(d.scope as object), maxAmountMinor: 10.5 },
      }),
    ],
    [
      "negative amount",
      (d: Record<string, unknown>) => ({
        ...d,
        scope: { ...(d.scope as object), maxAmountMinor: -1 },
      }),
    ],
    [
      "missing validity",
      (d: Record<string, unknown>) => ({ ...d, validity: undefined }),
    ],
    [
      "wrong version",
      (d: Record<string, unknown>) => ({
        ...d,
        version: "financial-authority/v2",
      }),
    ],
  ])("rejects %s", (_name, mutate) => {
    const { mandate } = kernelFixture();
    const doc = toPublicAuthorityDocument(mandate, "ACTIVE", {
      now,
    }) as unknown as Record<string, unknown>;
    expect(validate(JSON.parse(JSON.stringify(mutate(doc))))).toBe(false);
  });
});
