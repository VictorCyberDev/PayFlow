import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  DIRECTORY_VERSION,
  IssuerDirectoryClient,
  signDirectory,
  thumbprint,
  type DirectoryDocument,
} from "../packages/directory-client/src/index.js";
import { holderJwk } from "../packages/verifier/src/authority.js";
import { portableProofPayloadBytes } from "../packages/verifier/src/index.js";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { PayFlowClient } from "../packages/sdk-typescript/src/index.js";
import type { Mandate } from "../src/domain.js";
import { authorize } from "../src/kernel.js";
import { mandateFingerprint } from "../src/canonical.js";
import { hostHarness, DEMO_MERCHANT } from "./helpers/host-harness.js";

/**
 * Phase 0 hardening against the real host (PostgreSQL + real HTTP): a true Authority-ceiling denial, directory/status outage
 * visibility and recovery, and abuse limits on public endpoints.
 */
const url = process.env.TEST_DATABASE_URL;

(url ? describe : describe.skip)(
  "Phase 0 hardening (PostgreSQL + real HTTP)",
  () => {
    const h = hostHarness({
      extraTruncate: "operational_alerts,rate_limit_windows",
    });

    it("a genuine Authority-ceiling overflow is refused by the Trust Kernel with valid trusted terms, and nothing is reserved or executed", async () => {
      const original = await h.authority();
      // A second stored Authority for the same tenant whose per-transaction ceiling is BELOW the trusted price ($84).
      const [row] = await h.repo.sql<
        { document: Mandate }[]
      >`select document from mandates where id = ${original}`;
      const low: Mandate = {
        ...row!.document,
        id: `ceiling-authority-${randomBytes(6).toString("hex")}`,
        maxSingleTransactionMinor: 5_000,
        autonomousPurchaseThresholdMinor: 5_000,
        humanApprovalThresholdMinor: 5_000,
        nonce: randomBytes(16).toString("hex"),
      };
      await h.repo.saveMandate(low);
      await h.repo
        .sql`insert into authority_ownership (mandate_id, organization_id, environment, owner_principal_id)
      values (${low.id}, 'payflow-sandbox', 'SANDBOX', 'p')`;
      const client = new PayFlowClient({
        baseUrl: h.origin,
        accessToken: await h.agentToken(),
      });
      const reservationsBefore = await h.repo
        .sql`select count(*)::int n from authorization_reservations`;
      const result = await client.actions.execute({
        item: "Quiet keyboard",
        amount: 8_400, // exactly the trusted catalog price: the terms are valid, only the Authority ceiling is exceeded
        currency: "USD",
        merchant: DEMO_MERCHANT,
        nonce: `ceil-nonce-${randomBytes(6).toString("hex")}`,
        authority: low.id,
        agent: "a",
      });
      // The Gateway filters offers by the stored Authority BEFORE any proposal exists: precise reason, no proposal id.
      expect(result).toMatchObject({
        decision: "DENY",
        status: "DENIED",
        effectCount: 0,
        reason: "NO_OFFER_INSIDE_AUTHORITY",
        proof: { proposalId: null },
      });
      // And the Trust Kernel itself, given that same stored Authority and the same valid $84 proposal, refuses on the ceiling.
      const receipt = authorize(
        low,
        {
          id: "a",
          principalId: "p",
          displayName: "A",
          issuedAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-11-15T00:00:00.000Z",
          status: "ACTIVE",
          capabilities: ["CREATE_ORDER", "CAPTURE_PAYMENT"],
        },
        {
          id: "tx-ceiling",
          agentId: "a",
          mandateId: low.id,
          mandateFingerprint: mandateFingerprint(low),
          amount: { currency: "USD", minor: 8_400 },
          merchant: { id: DEMO_MERCHANT, displayName: "Demo" },
          category: "KEYBOARD",
          condition: "NEW",
          requestedCapability: "CAPTURE_PAYMENT",
          proposedAt: h.iso(),
          nonce: "ceiling-proposal-nonce",
          metadata: {},
        },
        {
          now: h.iso(),
          merchantRisk: "LOW",
          cumulativeSpentMinor: 0,
          replaySeen: false,
        },
      );
      expect(receipt.decision).toBe("DENY");
      expect(receipt.reasonCodes).toContain("AMOUNT_EXCEEDS_LIMIT");
      expect(h.provider.createCalls + h.provider.captureCalls).toBe(0);
      const reservationsAfter = await h.repo
        .sql`select count(*)::int n from authorization_reservations`;
      expect(reservationsAfter[0]!.n).toBe(reservationsBefore[0]!.n);
      // Control: the same terms under the original ($100) Authority succeed, so the denial was the ceiling and nothing else.
      const ok = await client.actions.execute({
        item: "Quiet keyboard",
        amount: 8_400,
        currency: "USD",
        merchant: DEMO_MERCHANT,
        nonce: `ceil-nonce-${randomBytes(6).toString("hex")}`,
        authority: original,
        agent: "a",
      });
      expect(ok).toMatchObject({ status: "COMPLETED", effectCount: 1 });
    });

    it("a directory outage is visible (503 + P1 alert), never a silent success, and recovery closes the alert", async () => {
      const dir = () => fetch(`${h.origin}/v1/issuer/directory`);
      const alerts = () =>
        h.repo
          .sql`select code, state, occurrences from operational_alerts where code = 'ISSUER_DIRECTORY_UNAVAILABLE'`;
      expect((await dir()).status).toBe(200);
      expect(await alerts()).toHaveLength(0);
      await h.repo
        .sql`alter table issuer_directory_publications rename to issuer_directory_publications_off`;
      try {
        const down = await dir();
        expect(down.status).toBe(503);
        expect(await down.json()).toEqual({ reason: "DIRECTORY_UNAVAILABLE" });
        expect(down.headers.get("cache-control")).toBe("no-store");
        await dir();
        const open = await alerts();
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({ state: "OPEN" });
        expect(Number(open[0]!.occurrences)).toBe(2);
      } finally {
        await h.repo
          .sql`alter table issuer_directory_publications_off rename to issuer_directory_publications`;
      }
      expect((await dir()).status).toBe(200);
      expect((await alerts())[0]).toMatchObject({ state: "RESOLVED" });
    });

    it("a status-list outage is a 503 with a P1 alert, not a hang or an empty list", async () => {
      const status = () => fetch(`${h.origin}/v1/issuer/status`);
      expect((await status()).status).toBe(200);
      await h.repo
        .sql`alter table portable_credentials rename to portable_credentials_off`;
      try {
        const down = await status();
        expect(down.status).toBe(503);
        expect(await down.json()).toEqual({ reason: "STATUS_UNAVAILABLE" });
      } finally {
        await h.repo
          .sql`alter table portable_credentials_off rename to portable_credentials`;
      }
      const [a] = await h.repo
        .sql`select state from operational_alerts where code = 'ISSUER_STATUS_UNAVAILABLE'`;
      expect(a).toMatchObject({ state: "OPEN" });
      expect((await status()).status).toBe(200);
      const [b] = await h.repo
        .sql`select state from operational_alerts where code = 'ISSUER_STATUS_UNAVAILABLE'`;
      expect(b).toMatchObject({ state: "RESOLVED" });
    });

    it("rate limits key on the trusted-proxy address: forged leading x-forwarded-for entries and invented bearer ids do not mint fresh buckets, and another address is unaffected", async () => {
      await h.restart({ PAYFLOW_IP_RATE_LIMIT_PER_MINUTE: "10" });
      const get = (xff: string, bearer?: string) =>
        fetch(`${h.origin}/v1/keys`, {
          headers: {
            "x-forwarded-for": xff,
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
        });
      const statuses: number[] = [];
      for (let i = 0; i < 16; i++) {
        const fakeBearer = `pf_act_pfm_${randomBytes(12).toString("hex")}.${randomBytes(24).toString("base64url")}`;
        statuses.push(
          (await get(`198.51.100.${i}, 203.0.113.9`, fakeBearer)).status,
        );
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(
        5,
      );
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      // A different real client address (behind the same proxy) is not blocked by that one's exhaustion.
      expect((await get("203.0.113.10")).status).toBe(200);
    });

    it("anonymous Verify cannot be enabled outside the verify-only profile even if the parser is bypassed, and an oversized body is refused", async () => {
      await h.restart({}, (c) => ({ ...c, mcpAnonymousVerify: true }));
      const ping = (body: string, headers: Record<string, string> = {}) =>
        fetch(`${h.origin}/v1/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
          body,
        });
      const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      // Profile "full" (default) + anonymous flag set directly on the config object: still 401.
      expect(
        (await ping(rpc, { "x-forwarded-for": "203.0.113.20" })).status,
      ).toBe(401);
      // verify-only + anonymous: allowed, but a body over the limit is refused before parsing.
      await h.restart({
        PAYFLOW_MCP_PROFILE: "verify-only",
        PAYFLOW_MCP_ANONYMOUS_VERIFY: "true",
      });
      expect(
        (await ping(rpc, { "x-forwarded-for": "203.0.113.21" })).status,
      ).toBe(200);
      const big = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "ping",
        params: { pad: "x".repeat(40_000) },
      });
      const refused = await ping(big, { "x-forwarded-for": "203.0.113.22" });
      expect([400, 413]).toContain(refused.status);
      expect(h.provider.createCalls + h.provider.captureCalls).toBe(0);
    });
  },
);

/**
 * 12.1 signing-key domain separation. Proofs, portable credentials and the issuer directory may be signed by the same
 * Ed25519 key, so a signature over one kind of message must never verify as another kind. Credentials and the directory
 * sign `<domain>\n<canonical JSON>`; a Proof signs the bare canonical JSON, which begins with `{`. No domain string begins
 * with `{`, so the signed byte strings are disjoint. These tests pin that property; they do not claim key separation, which
 * would reduce the blast radius of a key compromise (documented in docs/security/KEY-SEPARATION.md).
 */
describe("12.1 cross-protocol signature confusion", () => {
  const root = generateKeyPairSync("ed25519");
  const doc: DirectoryDocument = {
    v: DIRECTORY_VERSION,
    issuer: "https://issuer.example",
    sequence: 1,
    issuedAt: "2026-10-23T10:00:00.000Z",
    validUntil: "2026-10-23T11:00:00.000Z",
    keys: [
      {
        kid: "k1",
        alg: "Ed25519",
        jwk: holderJwk(root.publicKey),
        status: "ACTIVE",
        notBefore: "2026-10-01T00:00:00.000Z",
      },
    ],
  };
  const client = () =>
    new IssuerDirectoryClient({
      issuers: {
        "https://issuer.example": {
          directoryUrl: "https://issuer.example/d",
          pins: [thumbprint(holderJwk(root.publicKey))],
        },
      },
      now: () => "2026-10-23T10:00:00.000Z",
    });
  const pins = { pins: [thumbprint(holderJwk(root.publicKey))] };

  it("a properly signed directory is accepted (control)", () => {
    expect(
      client().accept(
        "https://issuer.example",
        pins,
        signDirectory(doc, [{ kid: "k1", privateKey: root.privateKey }]),
      ),
    ).toBe("ACCEPTED");
  });

  it("a signature made the way a Proof is signed (bare canonical JSON of the same document) is not a valid directory signature", () => {
    const proofStyle = cryptoSign(
      null,
      portableProofPayloadBytes(doc as never),
      root.privateKey,
    ).toString("base64url");
    expect(
      client().accept("https://issuer.example", pins, {
        doc,
        signatures: [{ kid: "k1", sig: proofStyle }],
      }),
    ).toBe("UNTRUSTED_SIGNATURE");
  });
});
