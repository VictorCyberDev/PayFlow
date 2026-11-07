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
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, readdir } from "node:fs/promises";
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
} from "../packages/verifier/src/authority.js";
import {
  IssuerDirectoryClient,
  thumbprint,
} from "../packages/directory-client/src/index.js";
import { PayFlowMemberClient } from "../packages/sdk-typescript/src/member.js";
import { SigningKeyRegistry } from "../src/network/signing-keys.js";
import { VerticalProvider } from "./m4-vertical-fixture.js";

/**
 * M24 against the real host composition: PostgreSQL, the real hosted Gateway and a deterministic provider double.
 * The Proofs verified here are real signed Proofs of real (sandbox) payments made through the Gateway.
 */
const url = process.env.TEST_DATABASE_URL;
const bootstrap = "m24-host-private-bootstrap-".repeat(3);
const adminToken = "m24-gateway-admin-secret-".repeat(3);
const capabilities = ["CREATE_ORDER", "CAPTURE_PAYMENT"] as never;
const rootPair = generateKeyPairSync("ed25519");
const pemOf = (p: { privateKey: KeyObject }) =>
  p.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pem = pemOf(rootPair);

(url ? describe : describe.skip)(
  "M24 published issuer directory and status, consumed by a separate client over real HTTP",
  () => {
    let repo: PostgresTrustRepository;
    let server: Server;
    let origin: string;
    let host: ReturnType<typeof createHostedConsole> | undefined;
    let provider: VerticalProvider;
    let nowMs = Date.parse("2026-10-23T10:00:00.000Z");
    const clock = () => new Date(nowMs);

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
          PAYFLOW_M5_ORIGIN: origin,
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
      nowMs = Date.parse("2026-10-23T10:00:00.000Z");
      owners.clear();
      owner.reset();
      await truncateTenantData(
        repo.sql,
        "replay_keys,agent_credentials,organizations,organization_agents,principals,evidence_events,commerce_merchant_bindings,proof_signing_keys,issuer_directory_publications,portable_credentials",
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

    const AUD = "https://shop.example";
    const iso = (ms: number) => new Date(ms).toISOString();
    const keyId = (n: number) => `m24-idem-key-${String(n).padStart(8, "0")}`;
    let n = 0;
    const holder = generateKeyPairSync("ed25519");
    const trust = (issuer: string): IssuerTrust => ({
      issuer,
      status: "TRUSTED",
      maxDelegationDepth: 2,
      allowedActionKinds: ["PURCHASE"],
      allowedCurrencies: ["USD"],
      maxAmountMinor: 1_000_000,
    });
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
    async function storedAuthority() {
      const a = (await (
        await admin("/v1/admin/sandbox/authority", {})
      ).json()) as { authority: { id: string } };
      const [row] = await repo.sql<
        { document: Record<string, unknown> }[]
      >`select document from mandates where id = ${a.authority.id}`;
      return { id: a.authority.id, mandate: row!.document };
    }

    /** A separate client: its only trust anchor is the pin; everything else it fetches over HTTP. */
    const newClient = (
      pin = thumbprint(holderJwk(rootPair.publicKey)),
      fetchImpl?: typeof fetch,
    ) =>
      new IssuerDirectoryClient({
        issuers: {
          [origin]: {
            directoryUrl: `${origin}/v1/issuer/directory`,
            pins: [pin],
            allowInsecureLoopback: true,
          },
        },
        now: () => iso(nowMs),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    async function merchantVerify(
      client: IssuerDirectoryClient,
      credential: Credential,
    ) {
      const challenge = "challenge-0123456789-m24";
      return verifyPresentation(
        present(credential, holder.privateKey, {
          aud: AUD,
          challenge,
          nonce: `n-${Math.random().toString(36).slice(2)}-0123456789`,
          iat: iso(nowMs),
          exp: iso(nowMs + 120_000),
        }),
        { aud: AUD, challenge, now: iso(nowMs) },
        { ...client.environment(), trust: () => trust(origin) },
      );
    }
    async function issueCredential(authorityId: string) {
      const client = new PayFlowMemberClient({
        baseUrl: origin,
        memberToken: await member("OWNER"),
      });
      const r = await client.credentials.issue(authorityId, {
        holder: holderJwk(holder.publicKey) as {
          kty: "OKP";
          crv: "Ed25519";
          x: string;
        },
        idempotencyKey: keyId(++n),
      });
      if (!r.ok) throw new Error(r.reason);
      return r;
    }
    const registry = () => new SigningKeyRegistry(repo.sql);
    const fetchDirectory = async () =>
      (await fetch(`${origin}/v1/issuer/directory`)).json() as Promise<{
        doc: { sequence: number; keys: { kid: string; status: string }[] };
      }>;

    it("a separate client pinned only to the root key discovers the directory and verifies a credential and its status", async () => {
      const a = await storedAuthority();
      const cred = await issueCredential(a.id);
      const client = newClient();
      expect(await client.refresh(origin)).toBe("ACCEPTED");
      expect(await client.refreshStatus(origin)).toBe("ACCEPTED");
      expect((await merchantVerify(client, cred.credential)).valid).toBe(true);
      const dir = await fetchDirectory();
      expect(dir.doc).toMatchObject({ sequence: 1 });
      expect(dir.doc.keys.map((k) => k.status)).toEqual(["ACTIVE"]);
    });

    it("a client with the WRONG pin refuses the genuine directory (an impostor's key cannot be introduced by the server)", async () => {
      const wrong = thumbprint(
        holderJwk(generateKeyPairSync("ed25519").publicKey),
      );
      expect(await newClient(wrong).refresh(origin)).toBe(
        "UNTRUSTED_SIGNATURE",
      );
    });

    it("the document is immutable: repeated and concurrent requests, and a restart, serve byte-identical documents", async () => {
      const bodies = await Promise.all(
        Array.from({ length: 10 }, () =>
          fetch(`${origin}/v1/issuer/directory`).then((r) => r.text()),
        ),
      );
      expect(new Set(bodies).size).toBe(1);
      const [rows] = await repo.sql<
        { n: number }[]
      >`select count(*)::int n from issuer_directory_publications`;
      expect(rows!.n).toBe(1);
      await host?.close();
      startHost({ PAYFLOW_M6_SIGNING_KEY: pem });
      expect(await (await fetch(`${origin}/v1/issuer/directory`)).text()).toBe(
        bodies[0],
      );
    });

    it("cuts a new sequence only near expiry, and the client follows it (cache expiration, monotonic sequence)", async () => {
      const client = newClient();
      await client.refresh(origin);
      nowMs += 20 * 60 * 1000; // within validity but inside the refresh window
      expect((await fetchDirectory()).doc.sequence).toBe(1);
      nowMs += 30 * 60 * 1000; // 50 minutes: past the 45-minute refresh point
      const next = await fetchDirectory();
      expect(next.doc.sequence).toBe(2);
      expect(await client.refresh(origin)).toBe("ACCEPTED");
      expect(await client.refresh(origin)).toBe("UNCHANGED");
    });

    it("an expired directory is not used: the client fails closed rather than trusting stale keys", async () => {
      const a = await storedAuthority();
      const cred = await issueCredential(a.id);
      const client = newClient();
      await client.refresh(origin);
      await client.refreshStatus(origin);
      expect((await merchantVerify(client, cred.credential)).valid).toBe(true);
      nowMs += 2 * 3600 * 1000;
      expect((await merchantVerify(client, cred.credential)).valid).toBe(false);
    });

    it("rollback is refused: a client that saw a newer directory rejects an older, genuinely signed one", async () => {
      const client = newClient();
      await client.refresh(origin);
      const first = await (await fetch(`${origin}/v1/issuer/directory`)).text();
      nowMs += 50 * 60 * 1000;
      expect(await client.refresh(origin)).toBe("ACCEPTED"); // sequence 2
      const pins = { pins: [thumbprint(holderJwk(rootPair.publicKey))] };
      expect(client.accept(origin, pins, JSON.parse(first))).toBe("ROLLBACK");
    });

    it("key rotation is a chain: announce the new key while the old one signs, then switch; old credentials keep verifying, new ones too", async () => {
      const a = await storedAuthority();
      const oldCred = await issueCredential(a.id);
      const client = newClient();
      await client.refresh(origin);
      await client.refreshStatus(origin);
      // Step 1: the operator ANNOUNCES the new key in the registry; the process still signs with the old one.
      const next = generateKeyPairSync("ed25519");
      await registry().announce(
        "payflow-sandbox",
        "rotated-2",
        next.publicKey.export({ format: "jwk" }),
        iso(nowMs),
      );
      const step1 = await fetchDirectory();
      expect(step1.doc.sequence).toBe(2);
      expect(
        Object.fromEntries(step1.doc.keys.map((k) => [k.kid, k.status])),
      ).toMatchObject({ "rotated-2": "ACTIVE" });
      expect(await client.refresh(origin)).toBe("ACCEPTED");
      // A cold start of a process still holding the OLD key must not flip the rotation back (serverless cold starts).
      await host?.close();
      startHost();
      const afterColdStart = await fetchDirectory();
      expect(
        Object.fromEntries(
          afterColdStart.doc.keys.map((k) => [k.kid, k.status]),
        )["rotated-2"],
      ).toBe("ACTIVE");
      expect(afterColdStart.doc.sequence).toBe(2);
      // Step 2: the deployment switches to the new signing secret.
      await host?.close();
      startHost({
        PAYFLOW_M6_SIGNING_KEY: pemOf(next),
        PAYFLOW_M6_SIGNING_KID: "rotated-2",
      });
      const step2 = await fetchDirectory();
      expect(step2.doc.sequence).toBe(3);
      expect(await client.refresh(origin)).toBe("ACCEPTED");
      // Credentials signed by the old key still verify during its grace; new ones are signed by the new key.
      await client.refreshStatus(origin);
      expect((await merchantVerify(client, oldCred.credential)).valid).toBe(
        true,
      );
      const fresh = await issueCredential(a.id);
      expect(fresh.credential.root.claims.kid).toBe("rotated-2");
      expect((await merchantVerify(client, fresh.credential)).valid).toBe(true);
      // A client that never saw step 1 cannot follow step 2 from the pin alone: the new key is not pinned.
      expect(await newClient().refresh(origin)).toBe("UNTRUSTED_SIGNATURE");
      // A retired key stops verifying when its grace (24 h after retirement) ends, not before and not never.
      const oldKid = Object.keys(
        Object.fromEntries(step2.doc.keys.map((k) => [k.kid, k.status])),
      ).find((k) => k !== "rotated-2")!;
      expect(client.issuerKey(origin, oldKid, iso(nowMs))).not.toBeNull();
      nowMs += 25 * 3600 * 1000;
      expect(await client.refresh(origin)).toBe("ACCEPTED");
      expect(client.issuerKey(origin, oldKid, iso(nowMs))).toBeNull();
      expect(client.issuerKey(origin, "rotated-2", iso(nowMs))).not.toBeNull();
    });

    it("revoking a key publishes a tombstone: credentials it signed stop verifying and it can never come back", async () => {
      const a = await storedAuthority();
      const next = generateKeyPairSync("ed25519");
      const client = newClient();
      await client.refresh(origin);
      await registry().announce(
        "payflow-sandbox",
        "rotated-2",
        next.publicKey.export({ format: "jwk" }),
        iso(nowMs),
      );
      await client.refresh(origin);
      await host?.close();
      startHost({
        PAYFLOW_M6_SIGNING_KEY: pemOf(next),
        PAYFLOW_M6_SIGNING_KID: "rotated-2",
      });
      await client.refresh(origin);
      const keys = (await (await fetch(`${origin}/v1/keys`)).json()) as {
        keys: { keyId: string }[];
      };
      const oldKid = keys.keys.find((k) => k.keyId !== "rotated-2")?.keyId;
      expect(oldKid).toBeTruthy();
      // The old key is compromised.
      await registry().revoke(oldKid!, iso(nowMs));
      const dir = await fetchDirectory();
      expect(dir.doc.keys.find((k) => k.kid === oldKid)?.status).toBe(
        "REVOKED",
      );
      expect(await client.refresh(origin)).toBe("ACCEPTED");
      expect(client.issuerKey(origin, oldKid!, iso(nowMs))).toBeNull();
      await expect(
        registry().activate(
          "payflow-sandbox",
          oldKid!,
          holderJwk(rootPair.publicKey),
          iso(nowMs),
        ),
      ).rejects.toThrow("KEY_REVOKED");
      void a;
    });

    it("safe error semantics: if the signing key is revoked nothing is published, and the client keeps its previous directory", async () => {
      const client = newClient();
      await client.refresh(origin);
      const kid = (
        (await (await fetch(`${origin}/v1/keys`)).json()) as {
          keys: { keyId: string }[];
        }
      ).keys[0]!.keyId;
      await registry().revoke(kid, iso(nowMs));
      nowMs += 50 * 60 * 1000; // a new sequence would be needed
      const r = await fetch(`${origin}/v1/issuer/directory`);
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toEqual({ reason: "DIRECTORY_UNAVAILABLE" });
      expect(await client.refresh(origin)).toBe("FETCH_FAILED");
    });

    it("a revoked SIGNING key publishes nothing even when another key is active", async () => {
      const client = newClient();
      await client.refresh(origin);
      const keys = (await (await fetch(`${origin}/v1/keys`)).json()) as {
        keys: { keyId: string }[];
      };
      const signerKid = keys.keys[0]!.keyId;
      const next = generateKeyPairSync("ed25519");
      await registry().announce(
        "payflow-sandbox",
        "rotated-2",
        next.publicKey.export({ format: "jwk" }),
        iso(nowMs),
      );
      await registry().revoke(signerKid, iso(nowMs)); // the process still holds this (now compromised) key
      nowMs += 50 * 60 * 1000;
      const r = await fetch(`${origin}/v1/issuer/directory`);
      expect(r.status).toBe(503);
      expect(await client.refresh(origin)).toBe("FETCH_FAILED");
    });

    it("revocation of a credential and of its Authority reaches the separate client via the status list", async () => {
      const a = await storedAuthority();
      const one = await issueCredential(a.id);
      const two = await issueCredential(a.id);
      const client = newClient();
      await client.refresh(origin);
      await client.refreshStatus(origin);
      expect((await merchantVerify(client, one.credential)).valid).toBe(true);
      await new PayFlowMemberClient({
        baseUrl: origin,
        memberToken: await member("OWNER"),
      }).credentials.revoke(one.credentialId, "x");
      await client.refreshStatus(origin);
      expect((await merchantVerify(client, one.credential)).reasons).toEqual([
        "REVOKED",
      ]);
      expect((await merchantVerify(client, two.credential)).valid).toBe(true);
      await repo.sql`update mandates set revoked_at = ${iso(nowMs)} where id = ${a.id}`;
      nowMs += 1000;
      await client.refreshStatus(origin);
      expect((await merchantVerify(client, two.credential)).reasons).toEqual([
        "REVOKED",
      ]);
    });

    it("the published documents contain public material only", async () => {
      const text = await (await fetch(`${origin}/v1/issuer/directory`)).text();
      expect(text).not.toMatch(/PRIVATE KEY|"d":|pkcs8/iu);
    });
  },
);
