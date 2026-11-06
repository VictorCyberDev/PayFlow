import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildStatusList,
  CREDENTIAL_VERSION,
  holderJwk,
  issueCredential,
  present,
  verifyPresentation,
  type IssuerTrust,
} from "../packages/verifier/src/authority.js";
import {
  DIRECTORY_VERSION,
  IssuerDirectoryClient,
  isPrivateAddress,
  signDirectory,
  thumbprint,
  type DirectoryDocument,
  type DirectoryKey,
  type SignedDirectory,
} from "../packages/directory-client/src/index.js";

const ISS = "https://issuer.example";
const DIR_URL = `${ISS}/.well-known/payflow-issuer-directory.json`;
const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const pair = () => generateKeyPairSync("ed25519");
type Pair = ReturnType<typeof pair>;
const key = (
  kid: string,
  p: Pair,
  status: DirectoryKey["status"] = "ACTIVE",
  over: Partial<DirectoryKey> = {},
): DirectoryKey => ({
  kid,
  alg: "Ed25519",
  jwk: holderJwk(p.publicKey),
  status,
  notBefore: "2026-11-01T00:00:00.000Z",
  ...over,
});
const doc = (
  sequence: number,
  keys: DirectoryKey[],
  over: Partial<DirectoryDocument> = {},
): DirectoryDocument => ({
  v: DIRECTORY_VERSION,
  issuer: ISS,
  sequence,
  issuedAt: iso(T0 - 60_000),
  validUntil: iso(T0 + 3600_000),
  keys,
  statusListUrl: `${ISS}/status.json`,
  ...over,
});

function harness() {
  let clock = T0;
  const served = new Map<string, unknown>();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = ((url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    const body = served.get(String(url));
    if (body === undefined) return Promise.reject(new Error("network"));
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return Promise.resolve(
      new Response(text, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  const root = pair();
  const client = new IssuerDirectoryClient({
    issuers: {
      [ISS]: {
        directoryUrl: DIR_URL,
        pins: [thumbprint(holderJwk(root.publicKey))],
      },
    },
    fetch: fakeFetch,
    now: () => iso(clock),
    resolve: () => Promise.resolve(["93.184.216.34"]),
  });
  const serve = (d: SignedDirectory) => served.set(DIR_URL, d);
  return {
    root,
    client,
    calls,
    served,
    serve,
    advance: (ms: number) => (clock += ms),
    now: () => iso(clock),
  };
}
const sign = (d: DirectoryDocument, ...by: [string, Pair][]) =>
  signDirectory(
    d,
    by.map(([kid, p]) => ({ kid, privateKey: p.privateKey })),
  );

describe("M24 issuer directory: trust, rotation and substitution defences", () => {
  it("accepts a directory signed by the pinned root key and serves its keys", async () => {
    const h = harness();
    h.serve(sign(doc(1, [key("r1", h.root)]), ["r1", h.root]));
    expect(await h.client.refresh(ISS)).toBe("ACCEPTED");
    expect(h.client.issuerKey(ISS, "r1", h.now())).toMatchObject({
      kty: "OKP",
    });
    expect(h.client.issuerKey(ISS, "nope", h.now())).toBeNull();
    expect(
      h.client.issuerKey("https://other.example", "r1", h.now()),
    ).toBeNull();
  });

  it("refuses substitution: an attacker's own directory, a stolen kid, or a wrong issuer is never accepted", async () => {
    const h = harness();
    const mallory = pair();
    // Entirely the attacker's key set, signed by the attacker.
    h.serve(sign(doc(1, [key("m1", mallory)]), ["m1", mallory]));
    expect(await h.client.refresh(ISS)).toBe("UNTRUSTED_SIGNATURE");
    // The pinned key is listed, but the attacker signed it.
    h.serve(
      sign(doc(1, [key("r1", h.root), key("m1", mallory)]), ["m1", mallory]),
    );
    expect(await h.client.refresh(ISS)).toBe("UNTRUSTED_SIGNATURE");
    // Attacker claims the pinned kid for their own key.
    h.serve(sign(doc(1, [key("r1", mallory)]), ["r1", mallory]));
    expect(await h.client.refresh(ISS)).toBe("UNTRUSTED_SIGNATURE");
    // A valid directory for a different issuer served at this URL.
    h.serve(
      sign(doc(1, [key("r1", h.root)], { issuer: "https://evil.example" }), [
        "r1",
        h.root,
      ]),
    );
    expect(await h.client.refresh(ISS)).toBe("ISSUER_MISMATCH");
    expect(h.client.issuerKey(ISS, "r1", h.now())).toBeNull();
  });

  it("never fetches an issuer it was not configured for", async () => {
    const h = harness();
    expect(await h.client.refresh("https://stranger.example")).toBe(
      "UNKNOWN_ISSUER",
    );
    expect(h.calls).toHaveLength(0);
  });

  it("rotation is a chain: a new key is trusted because the old one vouched for it, and the old key can then retire", async () => {
    const h = harness();
    const k2 = pair();
    const k3 = pair();
    h.serve(sign(doc(1, [key("r1", h.root)]), ["r1", h.root]));
    await h.client.refresh(ISS);
    h.serve(sign(doc(2, [key("r1", h.root), key("k2", k2)]), ["r1", h.root]));
    expect(await h.client.refresh(ISS)).toBe("ACCEPTED");
    // The next directory is signed only by the new key: accepted by continuity, not by the pin.
    h.serve(
      sign(
        doc(3, [
          key("r1", h.root, "RETIRED", { notAfter: iso(T0 + 600_000) }),
          key("k2", k2),
          key("k3", k3),
        ]),
        ["k2", k2],
      ),
    );
    expect(await h.client.refresh(ISS)).toBe("ACCEPTED");
    expect(h.client.issuerKey(ISS, "k3", h.now())).not.toBeNull();
    // A retired key still verifies until its grace ends, and not after.
    expect(h.client.issuerKey(ISS, "r1", h.now())).not.toBeNull();
    expect(h.client.issuerKey(ISS, "r1", iso(T0 + 700_000))).toBeNull();
    // A retired key can no longer vouch for new directories.
    h.serve(
      sign(
        doc(4, [
          key("r1", h.root, "RETIRED"),
          key("k2", k2),
          key("k3", k3),
          key("x", pair()),
        ]),
        ["r1", h.root],
      ),
    );
    expect(await h.client.refresh(ISS)).toBe("UNTRUSTED_SIGNATURE");
  });

  it("refuses rollback and equivocation, and treats an identical re-fetch as unchanged", async () => {
    const h = harness();
    const k2 = pair();
    const v1 = sign(doc(1, [key("r1", h.root)]), ["r1", h.root]);
    const v2 = sign(doc(2, [key("r1", h.root), key("k2", k2)]), ["r1", h.root]);
    h.serve(v1);
    await h.client.refresh(ISS);
    h.serve(v2);
    await h.client.refresh(ISS);
    h.serve(v1);
    expect(await h.client.refresh(ISS)).toBe("ROLLBACK");
    h.serve(v2);
    expect(await h.client.refresh(ISS)).toBe("UNCHANGED");
    // Same sequence, different content, still validly signed: someone is showing different people different keys.
    h.serve(
      sign(doc(2, [key("r1", h.root), key("k2", k2), key("k9", pair())]), [
        "r1",
        h.root,
      ]),
    );
    expect(await h.client.refresh(ISS)).toBe("EQUIVOCATION");
  });

  it("a revoked key stops working at once, stays listed as revoked, and cannot return", async () => {
    const h = harness();
    const k2 = pair();
    h.serve(sign(doc(1, [key("r1", h.root), key("k2", k2)]), ["r1", h.root]));
    await h.client.refresh(ISS);
    expect(h.client.issuerKey(ISS, "k2", h.now())).not.toBeNull();
    h.serve(
      sign(doc(2, [key("r1", h.root), key("k2", k2, "REVOKED")]), [
        "r1",
        h.root,
      ]),
    );
    expect(await h.client.refresh(ISS)).toBe("ACCEPTED");
    expect(h.client.issuerKey(ISS, "k2", h.now())).toBeNull();
    h.serve(sign(doc(3, [key("r1", h.root)]), ["r1", h.root]));
    expect(await h.client.refresh(ISS)).toBe("REVOCATION_DROPPED");
    h.serve(sign(doc(3, [key("r1", h.root), key("k2", k2)]), ["r1", h.root]));
    expect(await h.client.refresh(ISS)).toBe("REVOCATION_REVERSED");
    expect(h.client.issuerKey(ISS, "k2", h.now())).toBeNull();
  });

  it("a key id cannot be reassigned to a different key", async () => {
    const h = harness();
    h.serve(
      sign(doc(1, [key("r1", h.root), key("k2", pair())]), ["r1", h.root]),
    );
    await h.client.refresh(ISS);
    h.serve(
      sign(doc(2, [key("r1", h.root), key("k2", pair())]), ["r1", h.root]),
    );
    expect(await h.client.refresh(ISS)).toBe("KEY_ID_REUSED");
  });

  it("a signature by a key the new directory revokes does not count", async () => {
    const h = harness();
    h.serve(sign(doc(1, [key("r1", h.root)]), ["r1", h.root]));
    await h.client.refresh(ISS);
    h.serve(
      sign(doc(2, [key("r1", h.root, "REVOKED"), key("k9", pair())]), [
        "r1",
        h.root,
      ]),
    );
    expect(await h.client.refresh(ISS)).toBe("UNTRUSTED_SIGNATURE");
  });

  describe("caching fails closed", () => {
    it("an expired directory is not used, and a failed refresh does not extend it", async () => {
      const h = harness();
      h.serve(sign(doc(1, [key("r1", h.root)]), ["r1", h.root]));
      await h.client.refresh(ISS);
      h.served.delete(DIR_URL);
      expect(await h.client.refresh(ISS)).toBe("FETCH_FAILED");
      expect(h.client.issuerKey(ISS, "r1", h.now())).not.toBeNull(); // still inside its own validity
      h.advance(3601_000);
      expect(await h.client.refresh(ISS)).toBe("FETCH_FAILED");
      expect(h.client.issuerKey(ISS, "r1", h.now())).toBeNull();
    });
    it("refuses directories that are not current or that claim an excessive cache lifetime", async () => {
      const h = harness();
      const k = key("r1", h.root);
      h.serve(
        sign(
          doc(1, [k], { validUntil: iso(T0 - 1000), issuedAt: iso(T0 - 5000) }),
          ["r1", h.root],
        ),
      );
      expect(await h.client.refresh(ISS)).toBe("NOT_CURRENT");
      h.serve(
        sign(
          doc(1, [k], {
            issuedAt: iso(T0 + 3600_000),
            validUntil: iso(T0 + 7200_000),
          }),
          ["r1", h.root],
        ),
      );
      expect(await h.client.refresh(ISS)).toBe("NOT_CURRENT");
      h.serve(
        sign(doc(1, [k], { validUntil: iso(T0 + 3 * 86400_000) }), [
          "r1",
          h.root,
        ]),
      );
      expect(await h.client.refresh(ISS)).toBe("CACHE_TOO_LONG");
    });
    it("a key is not honoured before its notBefore", async () => {
      const h = harness();
      h.serve(
        sign(
          doc(1, [
            key("r1", h.root),
            key("soon", pair(), "ACTIVE", { notBefore: iso(T0 + 600_000) }),
          ]),
          ["r1", h.root],
        ),
      );
      await h.client.refresh(ISS);
      expect(h.client.issuerKey(ISS, "soon", h.now())).toBeNull();
      expect(h.client.issuerKey(ISS, "soon", iso(T0 + 601_000))).not.toBeNull();
    });
  });

  describe("fetching is hardened", () => {
    it("refuses plain http, another origin, credentials in the URL, and private or metadata addresses", async () => {
      const mk = (directoryUrl: string, resolve?: () => Promise<string[]>) =>
        new IssuerDirectoryClient({
          issuers: { [ISS]: { directoryUrl, pins: ["x"] } },
          fetch: () => {
            throw new Error("must not be called");
          },
          now: () => iso(T0),
          ...(resolve ? { resolve } : {}),
        });
      for (const url of [
        "http://issuer.example/d.json",
        "https://other.example/d.json",
        "https://user:pw@issuer.example/d.json",
        "not a url",
      ])
        expect(await mk(url).refresh(ISS)).toBe("FETCH_REFUSED");
      expect(
        await mk(DIR_URL, () => Promise.resolve(["10.0.0.5"])).refresh(ISS),
      ).toBe("FETCH_REFUSED");
      expect(
        await mk(DIR_URL, () =>
          Promise.resolve(["93.184.216.34", "127.0.0.1"]),
        ).refresh(ISS),
      ).toBe("FETCH_REFUSED");
      expect(await mk(DIR_URL, () => Promise.resolve([])).refresh(ISS)).toBe(
        "FETCH_REFUSED",
      );
    });
    it("classifies private ranges, including IPv6 and IPv4-mapped forms", () => {
      for (const a of [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "fd00::1",
        "fe80::1",
        "::ffff:10.0.0.1",
        "224.0.0.1",
        "not-an-ip",
      ])
        expect(isPrivateAddress(a)).toBe(true);
      for (const a of [
        "93.184.216.34",
        "8.8.8.8",
        "172.32.0.1",
        "2606:4700:4700::1111",
      ])
        expect(isPrivateAddress(a)).toBe(false);
    });
    it("asks for no redirects, a short timeout and JSON", async () => {
      const h = harness();
      h.serve(sign(doc(1, [key("r1", h.root)]), ["r1", h.root]));
      await h.client.refresh(ISS);
      const init = h.calls[0]?.init;
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    describe("against a real HTTP server", () => {
      let server: Server | undefined;
      afterAll(() => {
        server?.close();
      });
      async function serveRaw(handler: Parameters<typeof createServer>[1]) {
        server?.close();
        server = createServer(handler);
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return {
          origin,
          client: new IssuerDirectoryClient({
            issuers: {
              [origin]: {
                directoryUrl: `${origin}/d.json`,
                pins: ["x"],
                allowInsecureLoopback: true,
              },
            },
            now: () => iso(T0),
            timeoutMs: 800,
          }),
        };
      }
      it("treats a redirect, an oversized body, a non-JSON answer, an error status and a hang as failures", async () => {
        const redirect = await serveRaw(
          (_q, s) =>
            void s
              .writeHead(302, { location: "http://169.254.169.254/" })
              .end(),
        );
        expect(await redirect.client.refresh(redirect.origin)).toBe(
          "FETCH_FAILED",
        );
        const big = await serveRaw(
          (_q, s) =>
            void s
              .writeHead(200, { "content-type": "application/json" })
              .end("x".repeat(70_000)),
        );
        expect(await big.client.refresh(big.origin)).toBe("TOO_LARGE");
        const html = await serveRaw(
          (_q, s) =>
            void s
              .writeHead(200, { "content-type": "text/html" })
              .end("<html>"),
        );
        expect(await html.client.refresh(html.origin)).toBe("MALFORMED");
        const err = await serveRaw((_q, s) => void s.writeHead(500).end());
        expect(await err.client.refresh(err.origin)).toBe("FETCH_FAILED");
        const hang = await serveRaw(() => undefined);
        expect(await hang.client.refresh(hang.origin)).toBe("FETCH_FAILED");
      });
    });
  });
});

describe("M24 directory feeds the M22 offline verifier", () => {
  const AUD = "https://shop.example";
  const trust: IssuerTrust = {
    issuer: ISS,
    status: "TRUSTED",
    maxDelegationDepth: 2,
    allowedActionKinds: ["PURCHASE"],
    allowedCurrencies: ["USD"],
    maxAmountMinor: 10_000,
  };
  async function world() {
    const h = harness();
    const signingKey = pair(); // the credential-signing key is rotated separately from the pinned root
    const agent = pair();
    const dirDoc = (seq: number, status: DirectoryKey["status"] = "ACTIVE") =>
      sign(doc(seq, [key("r1", h.root), key("sig1", signingKey, status)]), [
        "r1",
        h.root,
      ]);
    h.serve(dirDoc(1));
    await h.client.refresh(ISS);
    const credential = issueCredential(
      {
        v: CREDENTIAL_VERSION,
        iss: ISS,
        kid: "sig1",
        jti: "cred-1",
        sub: "agent-1",
        principal: "p1",
        holder: holderJwk(agent.publicKey),
        scope: {
          actionKinds: ["PURCHASE"],
          currencies: ["USD"],
          counterpartyIds: ["shop-1"],
          maxAmountMinor: 10_000,
        },
        nbf: "2026-11-06T00:00:00.000Z",
        exp: "2026-11-07T00:00:00.000Z",
        maxDepth: 1,
      },
      signingKey.privateKey,
    );
    const publishStatus = (revoked: string[]) =>
      h.served.set(
        `${ISS}/status.json`,
        buildStatusList(
          {
            iss: ISS,
            kid: "sig1",
            issuedAt: iso(T0 - 600_000),
            validUntil: iso(T0 + 1800_000),
            revoked,
          },
          signingKey.privateKey,
        ),
      );
    publishStatus([]);
    await h.client.refreshStatus(ISS);
    const verify = () =>
      verifyPresentation(
        present(credential, agent.privateKey, {
          aud: AUD,
          challenge: "challenge-0123456789",
          nonce: `n-${Math.random()}-0123456789`,
          iat: h.now(),
          exp: iso(Date.parse(h.now()) + 120_000),
        }),
        { aud: AUD, challenge: "challenge-0123456789", now: h.now() },
        { ...h.client.environment(), trust: () => trust },
      );
    return { h, signingKey, dirDoc, publishStatus, verify };
  }

  it("verifies a credential end to end using only the pinned root and the published directory", async () => {
    const w = await world();
    expect((await w.verify()).valid).toBe(true);
  });

  it("a revocation published in the status list stops the credential", async () => {
    const w = await world();
    w.publishStatus(["cred-1"]);
    await w.h.client.refreshStatus(ISS);
    expect((await w.verify()).reasons).toEqual(["REVOKED"]);
  });

  it("revoking the signing key in the directory stops every credential it signed", async () => {
    const w = await world();
    w.h.serve(w.dirDoc(2, "REVOKED"));
    await w.h.client.refresh(ISS);
    expect((await w.verify()).reasons).toEqual(["UNKNOWN_ISSUER_KEY"]);
  });

  it("an expired directory fails closed instead of trusting stale keys", async () => {
    const w = await world();
    w.h.advance(3601_000);
    expect((await w.verify()).valid).toBe(false);
  });

  it("an older status list cannot replace a newer one (it could un-revoke)", async () => {
    const w = await world();
    w.publishStatus(["cred-1"]);
    await w.h.client.refreshStatus(ISS);
    w.h.served.set(
      `${ISS}/status.json`,
      buildStatusList(
        {
          iss: ISS,
          kid: "sig1",
          issuedAt: iso(T0 - 3600_000),
          validUntil: iso(T0 + 1800_000),
          revoked: [],
        },
        w.signingKey.privateKey,
      ),
    );
    expect(await w.h.client.refreshStatus(ISS)).toBe("ROLLBACK");
    expect((await w.verify()).reasons).toEqual(["REVOKED"]);
  });

  it("a status list that is not signed by the issuer's key is never stored, so it cannot evict a good list or set freshness", async () => {
    const w = await world();
    w.publishStatus(["cred-1"]);
    await w.h.client.refreshStatus(ISS);
    // An attacker serves an empty list "from the future" signed with their own key.
    w.h.served.set(
      `${ISS}/status.json`,
      buildStatusList(
        {
          iss: ISS,
          kid: "sig1",
          issuedAt: iso(T0 + 600_000),
          validUntil: iso(T0 + 1800_000),
          revoked: [],
        },
        pair().privateKey,
      ),
    );
    expect(await w.h.client.refreshStatus(ISS)).toBe("UNTRUSTED_SIGNATURE");
    expect((await w.verify()).reasons).toEqual(["REVOKED"]);
  });
});
