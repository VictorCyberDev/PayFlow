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
import { generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
import { mandateFingerprint } from "../src/canonical.js";
import {
  fetchIssuerStatus,
  PayFlowMemberClient,
} from "../packages/sdk-typescript/src/member.js";
import { PostgresTrustRepository } from "../src/persistence.js";
import {
  createHostedConsole,
  parseHostedConfig,
} from "../src/console-hosted.js";
import {
  holderJwk,
  present,
  verifyPresentation,
  type Credential,
  type IssuerTrust,
  type StatusList,
} from "../packages/verifier/src/authority.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * M22 against the real host composition: PostgreSQL, the real hosted Gateway and a deterministic provider double.
 * The Proofs verified here are real signed Proofs of real (sandbox) payments made through the Gateway.
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m22-host-private-bootstrap-".repeat(3);
const adminToken = "m22-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const pem = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

(url ? describe : describe.skip)(
  "M22 portable credential issuance from stored Authorities (PostgreSQL + real HTTP)",
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
      owners.clear();
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

    const ISSUER = "http://127.0.0.1";
    const AUD = "https://shop.example";
    const NOW = "2026-10-23T10:00:00.000Z";
    const keyId = (n: number) => `m22-idem-key-${String(n).padStart(8, "0")}`;
    let n = 0;
    const holder = generateKeyPairSync("ed25519");

    const owners = new Map<string, string>();
    const ownerOf = async (organizationId: string) => {
      const cached = owners.get(organizationId);
      if (cached) return cached;
      await repo.sql`insert into organizations (id, display_name) values (${organizationId}, 'T') on conflict (id) do nothing`;
      const r = await fetch(`${origin}/v1/admin/members`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          organizationId,
          environment: "SANDBOX",
          displayName: "m22 owner",
          role: "OWNER",
        }),
      });
      const token = ((await r.json()) as { token: string }).token;
      owners.set(organizationId, token);
      return token;
    };
    /** Other roles are created by the organization's own OWNER, as in a real deployment. */
    const member = async (role: string, organizationId = "payflow-sandbox") => {
      const ownerToken = await ownerOf(organizationId);
      if (role === "OWNER") return ownerToken;
      const r = await fetch(`${origin}/v1/admin/members`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ displayName: `m22 ${role}`, role }),
      });
      const body = (await r.json()) as { token?: string };
      if (!body.token)
        throw new Error(`member ${role}: ${r.status} ${JSON.stringify(body)}`);
      return body.token;
    };
    const call = (
      token: string | null,
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ) =>
      fetch(origin + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const request = (over: Record<string, unknown> = {}) => ({
      holder: holderJwk(holder.publicKey),
      idempotencyKey: keyId(++n),
      ...over,
    });
    async function storedAuthority() {
      const a = (await (
        await admin("/v1/admin/sandbox/authority", {})
      ).json()) as { authority: { id: string } };
      const [row] = await repo.sql<
        { document: Record<string, unknown> }[]
      >`select document from mandates where id = ${a.authority.id}`;
      return { id: a.authority.id, mandate: row!.document };
    }
    const issue = async (token: string, id: string, body: unknown) =>
      call(token, "POST", `/v1/admin/org/authorities/${id}/credentials`, body);

    /** An independent verifier: it learns the issuer's key and revocations only from the host's public endpoints. */
    async function verifyAsMerchant(
      credential: Credential,
      action?: {
        kind: string;
        currency: string;
        counterpartyId: string;
        amountMinor: number;
      },
      aud = AUD,
    ) {
      const keys = (await (await fetch(`${origin}/v1/keys`)).json()) as {
        keys: { keyId: string; jwk: JsonWebKey }[];
      };
      const status = (await (
        await fetch(`${origin}/v1/issuer/status`)
      ).json()) as StatusList;
      const trust: IssuerTrust = {
        issuer: ISSUER,
        status: "TRUSTED",
        maxDelegationDepth: 2,
        allowedActionKinds: ["PURCHASE"],
        allowedCurrencies: ["USD"],
        maxAmountMinor: 1_000_000,
      };
      const challenge = "challenge-0123456789-m22";
      return verifyPresentation(
        present(credential, holder.privateKey, {
          aud,
          challenge,
          nonce: `nonce-${Math.random().toString(36).slice(2)}-0123456`,
          iat: NOW,
          exp: new Date(Date.parse(NOW) + 120_000).toISOString(),
        }),
        {
          aud,
          challenge,
          now: NOW,
          ...(action ? { action } : {}),
        },
        {
          issuerKey: (iss, kid) =>
            iss === ISSUER
              ? (keys.keys.find((k) => k.keyId === kid)?.jwk ?? null)
              : null,
          trust: (iss) => (iss === ISSUER ? trust : null),
          statusList: () => status,
        },
      );
    }

    it("issues a credential that says exactly what the stored Authority allows, and an independent verifier accepts it", async () => {
      const a = await storedAuthority();
      const m = a.mandate as {
        authorizedAgentId: string;
        principalId: string;
        currency: string;
        maxSingleTransactionMinor: number;
        autonomousPurchaseThresholdMinor: number;
        merchantScope: { ids: string[] };
      };
      const owner = await member("OWNER");
      const res = await issue(owner, a.id, request({ audience: [AUD] }));
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as {
        credentialId: string;
        credential: Credential;
      };
      const claims = body.credential.root.claims;
      expect(claims).toMatchObject({
        iss: ISSUER,
        sub: m.authorizedAgentId,
        principal: m.principalId,
        aud: [AUD],
        ref: { authority: a.id },
      });
      expect(claims.scope).toEqual({
        actionKinds: ["PURCHASE"],
        currencies: [m.currency],
        counterpartyIds: m.merchantScope.ids,
        maxAmountMinor: Math.min(
          m.maxSingleTransactionMinor,
          m.autonomousPurchaseThresholdMinor,
        ),
      });
      const ok = await verifyAsMerchant(body.credential, {
        kind: "PURCHASE",
        currency: m.currency,
        counterpartyId: m.merchantScope.ids[0]!,
        amountMinor: 1_000,
      });
      expect(ok).toMatchObject({ valid: true, agent: m.authorizedAgentId });
      // The same credential does not cover more than the Authority does, and cannot be used elsewhere.
      expect(
        (
          await verifyAsMerchant(body.credential, {
            kind: "PURCHASE",
            currency: "EUR",
            counterpartyId: m.merchantScope.ids[0]!,
            amountMinor: 1_000,
          })
        ).reasons,
      ).toEqual(["ACTION_NOT_IN_SCOPE"]);
      expect(
        (
          await verifyAsMerchant(
            body.credential,
            undefined,
            "https://other.example",
          )
        ).reasons,
      ).toContain("AUDIENCE_NOT_PERMITTED");
    });

    it("a request can only narrow: inflation of amount, merchant, currency, action kind or scope is refused", async () => {
      const a = await storedAuthority();
      const m = a.mandate as {
        maxSingleTransactionMinor: number;
        autonomousPurchaseThresholdMinor: number;
      };
      const ceiling = Math.min(
        m.maxSingleTransactionMinor,
        m.autonomousPurchaseThresholdMinor,
      );
      const owner = await member("OWNER");
      const refuse = async (
        over: Record<string, unknown>,
        status: number,
        reason: string,
      ) => {
        const r = await issue(owner, a.id, request(over));
        expect(r.status).toBe(status);
        expect(await r.json()).toMatchObject({ reason });
      };
      await refuse(
        { maxAmountMinor: ceiling + 1 },
        403,
        "AMOUNT_ABOVE_AUTHORITY",
      );
      await refuse(
        { counterpartyIds: ["evil-merchant"] },
        403,
        "COUNTERPARTY_NOT_IN_AUTHORITY",
      );
      for (const forbidden of [
        { currencies: ["EUR"] },
        { currency: "EUR" },
        { actionKinds: ["PAYOUT"] },
        { scope: { maxAmountMinor: 999999999 } },
        { sub: "someone-else" },
        { principal: "other" },
        { authority: "other-authority" },
        { exp: "2099-01-01T00:00:00.000Z" },
      ])
        await refuse(forbidden, 400, "MALFORMED_REQUEST");
      await refuse(
        { holder: { kty: "RSA", n: "x", e: "AQAB" } },
        400,
        "MALFORMED_REQUEST",
      );
      await refuse({ ttlSeconds: 999_999 }, 400, "MALFORMED_REQUEST");
      // Nothing was issued by any of those.
      const [count] = await repo.sql<
        { n: number }[]
      >`select count(*)::int n from portable_credentials`;
      expect(count!.n).toBe(0);
      // Narrowing is allowed.
      const narrowed = await issue(
        owner,
        a.id,
        request({ maxAmountMinor: 100, ttlSeconds: 120 }),
      );
      expect(narrowed.status).toBe(201);
    });

    it("only roles that may attest can issue; others cannot, and the operator token has no role", async () => {
      const a = await storedAuthority();
      for (const role of ["OWNER", "FINANCE_ADMIN"]) {
        expect((await issue(await member(role), a.id, request())).status).toBe(
          201,
        );
      }
      for (const role of [
        "DEVELOPER",
        "SECURITY_ADMIN",
        "APPROVER",
        "AUDITOR",
        "VIEWER",
      ]) {
        const r = await issue(await member(role), a.id, request());
        expect(r.status).toBe(403);
        expect(await r.json()).toMatchObject({
          reason: "PERMISSION_DENIED",
          requiredPermission: "authority:attest",
        });
      }
      expect((await issue(adminToken, a.id, request())).status).toBe(403);
      expect(
        (
          await call(
            null,
            "POST",
            `/v1/admin/org/authorities/${a.id}/credentials`,
            request(),
          )
        ).status,
      ).toBe(401);
    });

    it("is tenant isolated: another organization cannot issue from, list or revoke this one's Authority or credentials", async () => {
      const a = await storedAuthority();
      const mine = await member("OWNER");
      const theirs = await member("OWNER", "other-org");
      const made = (await (await issue(mine, a.id, request())).json()) as {
        credentialId: string;
      };
      const r = await issue(theirs, a.id, request());
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ reason: "AUTHORITY_NOT_FOUND" });
      expect(
        await (await call(theirs, "GET", "/v1/admin/org/credentials")).json(),
      ).toMatchObject({ credentials: [] });
      const rev = await call(
        theirs,
        "POST",
        `/v1/admin/org/credentials/${made.credentialId}/revoke`,
        {},
      );
      expect(rev.status).toBe(404);
      const [row] = await repo.sql<
        { revoked_at: Date | null }[]
      >`select revoked_at from portable_credentials where jti = ${made.credentialId}`;
      expect(row!.revoked_at).toBeNull();
      const audit = (await (
        await call(theirs, "GET", "/v1/admin/org/audit")
      ).json()) as { events: { action: string }[] };
      expect(
        audit.events.some((e) => e.action === "PORTABLE_CREDENTIAL_ISSUED"),
      ).toBe(false);
    });

    it("is idempotent and concurrency safe: one key means one credential", async () => {
      const a = await storedAuthority();
      const owner = await member("OWNER");
      const body = request();
      const first = await issue(owner, a.id, body);
      const again = await issue(owner, a.id, body);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      const [f, g] = [await first.json(), await again.json()] as {
        credentialId: string;
        credential: unknown;
        replayed: boolean;
      }[];
      expect(g).toMatchObject({
        credentialId: f!.credentialId,
        replayed: true,
      });
      expect(g!.credential).toEqual(f!.credential);
      // Same key, different request: refused, nothing new.
      const clash = await issue(owner, a.id, { ...body, maxAmountMinor: 50 });
      expect(clash.status).toBe(409);
      expect(await clash.json()).toMatchObject({
        reason: "IDEMPOTENCY_KEY_REUSED",
      });
      // A burst of identical requests yields exactly one row.
      const burst = request();
      const results = await Promise.all(
        Array.from({ length: 12 }, () => issue(owner, a.id, burst)),
      );
      const ids = new Set(
        (await Promise.all(results.map((r) => r.json()))).map(
          (j) => (j as { credentialId: string }).credentialId,
        ),
      );
      expect(ids.size).toBe(1);
      const [rows] = await repo.sql<
        { n: number }[]
      >`select count(*)::int n from portable_credentials where idempotency_key = ${burst.idempotencyKey}`;
      expect(rows!.n).toBe(1);
      const audit = (await (
        await call(owner, "GET", "/v1/admin/org/audit")
      ).json()) as { events: { action: string; subjectId: string }[] };
      expect(
        audit.events.filter(
          (e) =>
            e.action === "PORTABLE_CREDENTIAL_ISSUED" &&
            e.subjectId === [...ids][0],
        ),
      ).toHaveLength(1);
    });

    it("revocation reaches an independent verifier through the signed status list, by credential and by Authority", async () => {
      const a = await storedAuthority();
      const owner = await member("OWNER");
      const security = await member("SECURITY_ADMIN");
      const one = (await (await issue(owner, a.id, request())).json()) as {
        credentialId: string;
        credential: Credential;
      };
      const two = (await (await issue(owner, a.id, request())).json()) as {
        credentialId: string;
        credential: Credential;
      };
      expect((await verifyAsMerchant(one.credential)).valid).toBe(true);
      // A security admin may withdraw a credential (containment) but could not have issued it.
      const rev = await call(
        security,
        "POST",
        `/v1/admin/org/credentials/${one.credentialId}/revoke`,
        { reason: "suspected leak" },
      );
      expect(rev.status).toBe(200);
      expect(await rev.json()).toMatchObject({
        result: "REVOKED",
        alreadyRevoked: false,
      });
      expect(
        await (
          await call(
            security,
            "POST",
            `/v1/admin/org/credentials/${one.credentialId}/revoke`,
            {},
          )
        ).json(),
      ).toMatchObject({ alreadyRevoked: true });
      expect((await verifyAsMerchant(one.credential)).reasons).toEqual([
        "REVOKED",
      ]);
      expect((await verifyAsMerchant(two.credential)).valid).toBe(true);
      // Revoking the source Authority withdraws every credential made from it.
      await repo.sql`update mandates set revoked_at = ${NOW} where id = ${a.id}`;
      expect((await verifyAsMerchant(two.credential)).reasons).toEqual([
        "REVOKED",
      ]);
      const listed = (await (
        await call(
          owner,
          "GET",
          `/v1/admin/org/authorities/${a.id}/credentials`,
        )
      ).json()) as { credentials: { credentialId: string; status: string }[] };
      expect(
        Object.fromEntries(
          listed.credentials.map((c) => [c.credentialId, c.status]),
        ),
      ).toEqual({
        [one.credentialId]: "REVOKED",
        [two.credentialId]: "AUTHORITY_REVOKED",
      });
      // And no new credential can be made from a revoked Authority.
      const after = await issue(owner, a.id, request());
      expect(after.status).toBe(403);
      expect(await after.json()).toMatchObject({ reason: "AUTHORITY_REVOKED" });
    });

    it(
      "refuses an expired Authority, a suspended agent, a merchant scope it cannot enumerate, and a tampered stored Authority",
      { timeout: 30_000 },
      async () => {
        const owner = await member("OWNER");
        const a = await storedAuthority();
        const [saved] = await repo.sql<
          {
            document: Record<string, unknown>;
            fingerprint: string;
            created_at: Date;
            expires_at: Date;
          }[]
        >`select document, fingerprint, created_at, expires_at from mandates where id = ${a.id}`;
        const restore = () =>
          repo.sql`update mandates set document = ${repo.sql.json(saved!.document as never)}, fingerprint = ${saved!.fingerprint},
            created_at = ${saved!.created_at}, expires_at = ${saved!.expires_at} where id = ${a.id}`;
        /** Rewrites the stored Authority consistently (document, columns AND fingerprint), as a legitimate edit would. */
        const rewrite = async (
          patch: Record<string, unknown>,
          columns: { created?: string; expires?: string } = {},
        ) => {
          const doc = { ...saved!.document, ...patch };
          await repo.sql`update mandates set document = ${repo.sql.json(doc as never)}, fingerprint = ${mandateFingerprint(doc as never)},
            created_at = coalesce(${columns.created ?? null}::timestamptz, created_at),
            expires_at = coalesce(${columns.expires ?? null}::timestamptz, expires_at) where id = ${a.id}`;
        };
        const reasonOf = async () =>
          (
            (await (await issue(owner, a.id, request())).json()) as {
              reason: string;
            }
          ).reason;
        try {
          await rewrite(
            {
              createdAt: "2026-10-22T09:00:00.000Z",
              expiresAt: "2026-10-23T09:59:59.000Z",
            },
            {
              created: "2026-10-22T09:00:00.000Z",
              expires: "2026-10-23T09:59:59.000Z",
            },
          );
          expect(await reasonOf()).toBe("AUTHORITY_EXPIRED");
          await restore();
          // A credential never outlives the Authority it came from, whatever lifetime was asked for.
          await rewrite(
            { expiresAt: "2026-10-23T10:10:00.000Z" },
            { expires: "2026-10-23T10:10:00.000Z" },
          );
          const capped = await issue(
            owner,
            a.id,
            request({ ttlSeconds: 86_400 }),
          );
          expect(capped.status).toBe(201);
          expect(
            ((await capped.json()) as { expiresAt: string }).expiresAt,
          ).toBe("2026-10-23T10:10:00.000Z");
          await restore();
          await repo.sql`update organization_agents set lifecycle = 'SUSPENDED'`;
          expect(await reasonOf()).toBe("AGENT_NOT_ACTIVE");
          await repo.sql`update organization_agents set lifecycle = 'REGISTERED'`;
          await rewrite({ merchantScope: { mode: "ANY" } });
          expect(await reasonOf()).toBe("MERCHANT_SCOPE_NOT_ENUMERABLE");
          await restore();
          // Someone edits the stored document directly (here the purpose; a raised limit would be refused the same way, or by the schema) without a matching fingerprint.
          await repo.sql`update mandates set document = jsonb_set(document, '{purpose}', '"edited behind the fingerprint"') where id = ${a.id}`;
          const tampered = await issue(owner, a.id, request());
          expect(tampered.status).toBe(403);
          expect(await tampered.json()).toMatchObject({
            reason: "AUTHORITY_INTEGRITY_FAILED",
          });
        } finally {
          await restore();
          await repo.sql`update organization_agents set lifecycle = 'REGISTERED'`;
        }
      },
    );

    it("works end to end through the SDK client: issue, retry, list, refuse inflation, revoke, and read the status", async () => {
      const a = await storedAuthority();
      const client = new PayFlowMemberClient({
        baseUrl: origin,
        memberToken: await member("OWNER"),
      });
      const input = {
        holder: holderJwk(holder.publicKey) as {
          kty: "OKP";
          crv: "Ed25519";
          x: string;
        },
        idempotencyKey: keyId(++n),
        maxAmountMinor: 500,
      };
      const first = await client.credentials.issue(a.id, input);
      const retry = await client.credentials.issue(a.id, input);
      if (!first.ok || !retry.ok) throw new Error("issue failed");
      expect(first.replayed).toBe(false);
      expect(retry).toMatchObject({
        replayed: true,
        credentialId: first.credentialId,
      });
      expect(first.credential.root.claims.scope.maxAmountMinor).toBe(500);
      const inflated = await client.credentials.issue(a.id, {
        ...input,
        idempotencyKey: keyId(++n),
        maxAmountMinor: 99_999_999,
      });
      expect(inflated).toMatchObject({
        ok: false,
        httpStatus: 403,
        reason: "AMOUNT_ABOVE_AUTHORITY",
      });
      expect(await client.credentials.list(a.id)).toHaveLength(1);
      expect(
        await client.credentials.revoke(first.credentialId, "done"),
      ).toEqual({ found: true, alreadyRevoked: false });
      expect((await fetchIssuerStatus(origin)).revoked).toEqual([
        first.credentialId,
      ]);
      const other = new PayFlowMemberClient({
        baseUrl: origin,
        memberToken: await member("OWNER", "other-org"),
      });
      expect(await other.credentials.revoke(first.credentialId, "x")).toEqual({
        found: false,
        alreadyRevoked: false,
      });
    });

    it("never exposes a private key or a secret, in responses, rows, or audit", async () => {
      const a = await storedAuthority();
      const owner = await member("OWNER");
      const res = await issue(owner, a.id, request());
      const text = await res.text();
      const everything = [
        text,
        JSON.stringify(await repo.sql`select * from portable_credentials`),
        JSON.stringify(await repo.sql`select * from organization_audit_events`),
        JSON.stringify(
          await (await fetch(`${origin}/v1/issuer/status`)).json(),
        ),
      ].join("\n");
      expect(everything).not.toMatch(
        /PRIVATE KEY|"d":|pkcs8|m22-gateway-admin-secret|m22-host-private/iu,
      );
      expect(
        (JSON.parse(text) as { credential: Credential }).credential.root.claims
          .holder,
      ).not.toHaveProperty("d");
    });

    it("the status list is signed by the issuer's published key and a tampered one is rejected", async () => {
      const a = await storedAuthority();
      const owner = await member("OWNER");
      const made = (await (await issue(owner, a.id, request())).json()) as {
        credentialId: string;
      };
      await call(
        owner,
        "POST",
        `/v1/admin/org/credentials/${made.credentialId}/revoke`,
        {},
      );
      const status = (await (
        await fetch(`${origin}/v1/issuer/status`)
      ).json()) as StatusList;
      expect(status).toMatchObject({
        iss: ISSUER,
        revoked: [made.credentialId],
      });
      const { verifyStatusListSignature } =
        await import("../packages/verifier/src/authority.js");
      const keys = (await (await fetch(`${origin}/v1/keys`)).json()) as {
        keys: { keyId: string; jwk: JsonWebKey }[];
      };
      const jwk = keys.keys.find((k) => k.keyId === status.kid)!.jwk;
      expect(verifyStatusListSignature(status, jwk)).toBe(true);
      expect(verifyStatusListSignature({ ...status, revoked: [] }, jwk)).toBe(
        false,
      );
    });
  },
);
