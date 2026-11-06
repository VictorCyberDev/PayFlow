import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildStatusList,
  CREDENTIAL_VERSION,
  extendCredential,
  holderJwk,
  issueCredential,
  present,
  verifyPresentation,
  type Credential,
  type IssuerTrust,
  type Reason,
  type RootClaims,
  type StatusList,
  type VerifierEnvironment,
} from "../packages/verifier/src/authority.js";

const key = () => generateKeyPairSync("ed25519");
const ISS = "https://issuer.example";
const AUD = "https://merchant.example";
const NOW = "2026-11-06T12:00:00.000Z";
const FULL = {
  actionKinds: ["PURCHASE", "INVOICE_SETTLEMENT"],
  currencies: ["USD", "EUR"],
  counterpartyIds: ["m1", "m2"],
  maxAmountMinor: 10_000,
};

/** A world: an issuer, a chain of three agents, a verifier that trusts the issuer. */
function world() {
  const issuer = key();
  const a = key();
  const b = key();
  const c = key();
  const root: RootClaims = {
    v: CREDENTIAL_VERSION,
    iss: ISS,
    kid: "k1",
    jti: "cred-root",
    sub: "agent-a",
    principal: "principal-1",
    holder: holderJwk(a.publicKey),
    scope: FULL,
    nbf: "2026-11-06T00:00:00.000Z",
    exp: "2026-11-07T00:00:00.000Z",
    maxDepth: 3,
  };
  const keys = { a, b, c, issuer };
  const rootCred = issueCredential(root, issuer.privateKey);
  const link = (
    cred: Credential,
    by: KeyObject,
    to: ReturnType<typeof key>,
    jti: string,
    over: Record<string, unknown> = {},
  ) =>
    extendCredential(cred, by, {
      jti,
      sub: `agent-${jti}`,
      holder: holderJwk(to.publicKey),
      scope: { ...FULL, maxAmountMinor: 5_000 },
      nbf: root.nbf,
      exp: root.exp,
      ...over,
    });
  const status = (revoked: string[] = [], over: Partial<StatusList> = {}) =>
    buildStatusList(
      {
        iss: ISS,
        kid: "k1",
        issuedAt: "2026-11-06T11:00:00.000Z",
        validUntil: "2026-11-06T13:00:00.000Z",
        revoked,
        ...over,
      },
      issuer.privateKey,
    );
  const trust: IssuerTrust = {
    issuer: ISS,
    status: "TRUSTED",
    maxDelegationDepth: 3,
    allowedActionKinds: ["PURCHASE", "INVOICE_SETTLEMENT"],
    allowedCurrencies: ["USD", "EUR"],
    maxAmountMinor: 10_000,
  };
  const env = (
    over: Partial<VerifierEnvironment> & { statuses?: StatusList | null } = {},
  ): VerifierEnvironment => {
    const seen = new Set<string>();
    return {
      issuerKey: (iss, kid) =>
        iss === ISS && kid === "k1" ? holderJwk(issuer.publicKey) : null,
      trust: (iss) => (iss === ISS ? trust : null),
      statusList: () =>
        over.statuses === undefined ? status() : over.statuses,
      claimNonce: (scope, nonce) => {
        const k = `${scope}:${nonce}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      },
      ...over,
    };
  };
  const show = (
    cred: Credential,
    by: KeyObject,
    over: Record<string, string> = {},
  ) =>
    present(cred, by, {
      aud: AUD,
      challenge: "challenge-0123456789",
      nonce: `nonce-${Math.random().toString(36).slice(2)}-0123`,
      iat: NOW,
      exp: "2026-11-06T12:03:00.000Z",
      ...over,
    });
  const use = (over: Record<string, unknown> = {}) => ({
    aud: AUD,
    challenge: "challenge-0123456789",
    now: NOW,
    ...over,
  });
  return { keys, root, rootCred, link, status, trust, env, show, use };
}
const reasons = (v: { reasons: readonly Reason[] }) => [...v.reasons].sort();

describe("M22 portable Authority credentials (offline verification)", () => {
  it("a three-hop chain verifies offline, with the narrowest authority carried through", async () => {
    const w = world();
    let cred = w.link(w.rootCred, w.keys.a.privateKey, w.keys.b, "hop1", {
      scope: { ...FULL, maxAmountMinor: 6_000 },
    });
    cred = w.link(cred, w.keys.b.privateKey, w.keys.c, "hop2", {
      scope: { ...FULL, currencies: ["USD"], maxAmountMinor: 2_000 },
    });
    const verdict = await verifyPresentation(
      w.show(cred, w.keys.c.privateKey),
      w.use({
        action: {
          kind: "PURCHASE",
          currency: "USD",
          counterpartyId: "m1",
          amountMinor: 1_500,
        },
      }),
      w.env(),
    );
    expect(verdict).toMatchObject({
      valid: true,
      depth: 2,
      agent: "agent-hop2",
      issuer: ISS,
    });
    expect(verdict.effective).toMatchObject({
      currencies: ["USD"],
      maxAmountMinor: 2_000,
    });
  });

  it("an action outside the carried authority is refused, on every axis", async () => {
    const w = world();
    const cred = w.link(w.rootCred, w.keys.a.privateKey, w.keys.b, "hop1", {
      scope: {
        actionKinds: ["PURCHASE"],
        currencies: ["USD"],
        counterpartyIds: ["m1"],
        maxAmountMinor: 5_000,
      },
    });
    const base = {
      kind: "PURCHASE",
      currency: "USD",
      counterpartyId: "m1",
      amountMinor: 5_000,
    };
    for (const over of [
      { amountMinor: 5_001 },
      { amountMinor: 0 },
      { currency: "EUR" },
      { counterpartyId: "m2" },
      { kind: "INVOICE_SETTLEMENT" },
    ]) {
      const v = await verifyPresentation(
        w.show(cred, w.keys.b.privateKey),
        w.use({ action: { ...base, ...over } }),
        w.env(),
      );
      expect(reasons(v)).toEqual(["ACTION_NOT_IN_SCOPE"]);
    }
    expect(
      (
        await verifyPresentation(
          w.show(cred, w.keys.b.privateKey),
          w.use({ action: base }),
          w.env(),
        )
      ).valid,
    ).toBe(true);
  });

  describe("attenuation: a link can never widen what it was given", () => {
    const widenings: [string, Record<string, unknown>][] = [
      ["amount", { scope: { ...FULL, maxAmountMinor: 10_001 } }],
      [
        "currency",
        { scope: { ...FULL, maxAmountMinor: 100, currencies: ["USD", "GBP"] } },
      ],
      [
        "counterparty",
        {
          scope: {
            ...FULL,
            maxAmountMinor: 100,
            counterpartyIds: ["m1", "m9"],
          },
        },
      ],
      [
        "action kind",
        { scope: { ...FULL, maxAmountMinor: 100, actionKinds: ["PAYOUT"] } },
      ],
    ];
    for (const [name, over] of widenings)
      it(`refuses a widened ${name}, even though the holder signed it`, async () => {
        const w = world();
        const cred = w.link(
          w.rootCred,
          w.keys.a.privateKey,
          w.keys.b,
          "hop1",
          over,
        );
        const v = await verifyPresentation(
          w.show(cred, w.keys.b.privateKey),
          w.use(),
          w.env(),
        );
        expect(v.valid).toBe(false);
        expect(v.reasons).toContain("SCOPE_WIDENED");
      });
    it("refuses a link that outlives its parent or starts before it", async () => {
      const w = world();
      for (const over of [
        { exp: "2026-11-09T00:00:00.000Z" },
        { nbf: "2026-11-05T00:00:00.000Z" },
      ]) {
        const cred = w.link(
          w.rootCred,
          w.keys.a.privateKey,
          w.keys.b,
          "hop1",
          over,
        );
        const v = await verifyPresentation(
          w.show(cred, w.keys.b.privateKey),
          w.use(),
          w.env(),
        );
        expect(v.reasons).toContain("VALIDITY_WIDENED");
      }
    });
    it("a child cannot drop an audience restriction its parent set", async () => {
      const w = world();
      const restricted = issueCredential(
        { ...w.root, aud: [AUD] },
        w.keys.issuer.privateKey,
      );
      const cred = w.link(restricted, w.keys.a.privateKey, w.keys.b, "hop1");
      const v = await verifyPresentation(
        w.show(cred, w.keys.b.privateKey),
        w.use(),
        w.env(),
      );
      expect(v.reasons).toContain("SCOPE_WIDENED");
    });
    it("depth is capped by the credential, the library and the verifier's trust of the issuer", async () => {
      const w = world();
      let cred = w.rootCred;
      let by = w.keys.a;
      const holders = [key(), key(), key(), key()];
      for (const [i, next] of holders.entries()) {
        cred = w.link(cred, by.privateKey, next, `deep${i}`);
        by = next;
      }
      const v = await verifyPresentation(
        w.show(cred, by.privateKey),
        w.use(),
        w.env(),
      );
      expect(v.reasons).toContain("DEPTH_EXCEEDED");
    });
  });

  describe("authenticity", () => {
    it("rejects a root altered after signing, and a credential from a key the verifier does not know", async () => {
      const w = world();
      const forged: Credential = {
        ...w.rootCred,
        root: {
          ...w.rootCred.root,
          claims: { ...w.root, scope: { ...FULL, maxAmountMinor: 999_999 } },
        },
      };
      expect(
        reasons(
          await verifyPresentation(
            w.show(forged, w.keys.a.privateKey),
            w.use(),
            w.env(),
          ),
        ),
      ).toEqual(["ROOT_SIGNATURE_INVALID"]);
      const stranger = issueCredential(
        { ...w.root, kid: "k9" },
        w.keys.issuer.privateKey,
      );
      expect(
        reasons(
          await verifyPresentation(
            w.show(stranger, w.keys.a.privateKey),
            w.use(),
            w.env(),
          ),
        ),
      ).toEqual(["UNKNOWN_ISSUER_KEY"]);
    });
    it("an attacker who signs their own credential as the issuer is not trusted, because the key comes from the verifier", async () => {
      const w = world();
      const mallory = key();
      const own = issueCredential(w.root, mallory.privateKey);
      expect(
        reasons(
          await verifyPresentation(
            w.show(own, w.keys.a.privateKey),
            w.use(),
            w.env(),
          ),
        ),
      ).toEqual(["ROOT_SIGNATURE_INVALID"]);
    });
    it("rejects a link signed by anyone but the previous holder, and a link moved under a different parent", async () => {
      const w = world();
      const wrongSigner = w.link(
        w.rootCred,
        w.keys.c.privateKey,
        w.keys.b,
        "hop1",
      );
      expect(
        (
          await verifyPresentation(
            w.show(wrongSigner, w.keys.b.privateKey),
            w.use(),
            w.env(),
          )
        ).reasons,
      ).toEqual(["LINK_SIGNATURE_INVALID"]);
      const other = world();
      const grafted: Credential = {
        root: other.rootCred.root,
        links: w.link(w.rootCred, w.keys.a.privateKey, w.keys.b, "hop1").links,
      };
      const v = await verifyPresentation(
        w.show(grafted, w.keys.b.privateKey),
        w.use(),
        other.env(),
      );
      expect(v.valid).toBe(false);
    });
    it("a validly signed link cannot be moved under a different root, even one held by the same key and even one with the same id", async () => {
      const w = world();
      // Same issuer, same holder key, so the link's own signature stays valid: only the parent binding can catch this.
      const original = w.link(
        w.rootCred,
        w.keys.a.privateKey,
        w.keys.b,
        "hop1",
      );
      const otherRoot = issueCredential(
        { ...w.root, jti: "cred-root-2" },
        w.keys.issuer.privateKey,
      );
      const sameIdRoot = issueCredential(
        { ...w.root, scope: { ...FULL, maxAmountMinor: 9_000 } },
        w.keys.issuer.privateKey,
      );
      for (const root of [otherRoot, sameIdRoot]) {
        const moved: Credential = { root: root.root, links: original.links };
        const v = await verifyPresentation(
          w.show(moved, w.keys.b.privateKey),
          w.use(),
          w.env(),
        );
        expect(reasons(v)).toEqual(["CHAIN_BROKEN"]);
      }
    });
    it("rejects a signature made for one kind of object presented as another (domain separation)", async () => {
      const w = world();
      const cred = w.link(w.rootCred, w.keys.a.privateKey, w.keys.b, "hop1");
      // Re-present a link signature as if it were the proof.
      const p = w.show(cred, w.keys.b.privateKey);
      const swapped = { ...p, proof: { ...p.proof, sig: cred.links[0]!.sig } };
      expect(
        (await verifyPresentation(swapped, w.use(), w.env())).reasons,
      ).toContain("POSSESSION_NOT_PROVEN");
    });
  });

  describe("possession, audience and replay", () => {
    it("someone who copies a credential cannot use it without the holder's key", async () => {
      const w = world();
      const v = await verifyPresentation(
        w.show(w.rootCred, w.keys.c.privateKey),
        w.use(),
        w.env(),
      );
      expect(reasons(v)).toEqual(["POSSESSION_NOT_PROVEN"]);
    });
    it("a presentation made for one verifier is refused by another, and by the same one for another challenge", async () => {
      const w = world();
      const p = w.show(w.rootCred, w.keys.a.privateKey, {
        aud: "https://other.example",
      });
      expect((await verifyPresentation(p, w.use(), w.env())).reasons).toEqual([
        "PRESENTATION_AUDIENCE_MISMATCH",
      ]);
      const q = w.show(w.rootCred, w.keys.a.privateKey, {
        challenge: "a-different-challenge-1",
      });
      expect((await verifyPresentation(q, w.use(), w.env())).reasons).toEqual([
        "CHALLENGE_MISMATCH",
      ]);
    });
    it("a presentation can't be edited to a different verifier without breaking the holder's signature", async () => {
      const w = world();
      const p = w.show(w.rootCred, w.keys.a.privateKey, {
        aud: "https://other.example",
      });
      const edited = { ...p, proof: { ...p.proof, aud: AUD } };
      expect(
        (await verifyPresentation(edited, w.use(), w.env())).reasons,
      ).toEqual(["POSSESSION_NOT_PROVEN"]);
    });
    it("a credential restricted to named verifiers is refused elsewhere", async () => {
      const w = world();
      const c = issueCredential(
        { ...w.root, aud: ["https://only-this.example"] },
        w.keys.issuer.privateKey,
      );
      expect(
        (
          await verifyPresentation(
            w.show(c, w.keys.a.privateKey),
            w.use(),
            w.env(),
          )
        ).reasons,
      ).toEqual(["AUDIENCE_NOT_PERMITTED"]);
    });
    it("the same presentation is accepted once; a refused one does not burn its nonce", async () => {
      const w = world();
      const env = w.env();
      const good = w.show(w.rootCred, w.keys.a.privateKey);
      const tooBig = {
        action: {
          kind: "PURCHASE",
          currency: "USD",
          counterpartyId: "m1",
          amountMinor: 20_000,
        },
      };
      expect((await verifyPresentation(good, w.use(tooBig), env)).valid).toBe(
        false,
      );
      expect((await verifyPresentation(good, w.use(), env)).valid).toBe(true);
      expect((await verifyPresentation(good, w.use(), env)).reasons).toEqual([
        "REPLAYED",
      ]);
    });
    it("a presentation must be short-lived and current", async () => {
      const w = world();
      const long = w.show(w.rootCred, w.keys.a.privateKey, {
        exp: "2026-11-06T13:00:00.000Z",
      });
      expect(
        (await verifyPresentation(long, w.use(), w.env())).reasons,
      ).toEqual(["PRESENTATION_WINDOW_INVALID"]);
      const old = w.show(w.rootCred, w.keys.a.privateKey, {
        iat: "2026-11-06T10:00:00.000Z",
        exp: "2026-11-06T10:03:00.000Z",
      });
      expect((await verifyPresentation(old, w.use(), w.env())).reasons).toEqual(
        ["PRESENTATION_WINDOW_INVALID"],
      );
    });
  });

  describe("lifecycle: validity window and revocation", () => {
    it("not yet valid, expired, and tolerance for small clock skew", async () => {
      const w = world();
      const p = w.show(w.rootCred, w.keys.a.privateKey);
      expect(
        (
          await verifyPresentation(
            p,
            w.use({ now: "2026-11-05T12:00:00.000Z" }),
            w.env(),
          )
        ).reasons,
      ).toContain("NOT_YET_VALID");
      const late = w.show(w.rootCred, w.keys.a.privateKey, {
        iat: "2026-11-07T00:10:00.000Z",
        exp: "2026-11-07T00:13:00.000Z",
      });
      expect(
        (
          await verifyPresentation(
            late,
            w.use({ now: "2026-11-07T00:10:00.000Z" }),
            w.env({
              statuses: w.status([], {
                issuedAt: "2026-11-07T00:00:00.000Z",
                validUntil: "2026-11-07T01:00:00.000Z",
              }),
            }),
          )
        ).reasons,
      ).toEqual(["EXPIRED"]);
      const edge = w.show(w.rootCred, w.keys.a.privateKey, {
        iat: "2026-11-06T23:59:30.000Z",
        exp: "2026-11-07T00:02:30.000Z",
      });
      const v = await verifyPresentation(
        edge,
        w.use({ now: "2026-11-06T23:59:30.000Z" }),
        w.env({
          statuses: w.status([], {
            issuedAt: "2026-11-06T23:00:00.000Z",
            validUntil: "2026-11-07T01:00:00.000Z",
          }),
        }),
      );
      expect(v.valid).toBe(true);
    });
    it("revoking the root, a middle hop or the leaf each stops the holder; revoking an unrelated id does not", async () => {
      const w = world();
      let cred = w.link(w.rootCred, w.keys.a.privateKey, w.keys.b, "hop1");
      cred = w.link(cred, w.keys.b.privateKey, w.keys.c, "hop2");
      const p = () => w.show(cred, w.keys.c.privateKey);
      for (const id of ["cred-root", "hop1", "hop2"])
        expect(
          reasons(
            await verifyPresentation(
              p(),
              w.use(),
              w.env({ statuses: w.status([id]) }),
            ),
          ),
        ).toEqual(["REVOKED"]);
      expect(
        (
          await verifyPresentation(
            p(),
            w.use(),
            w.env({ statuses: w.status(["someone-else"]) }),
          )
        ).valid,
      ).toBe(true);
    });
    it("fails closed on a missing, stale, forged or wrong-issuer revocation list", async () => {
      const w = world();
      const p = () => w.show(w.rootCred, w.keys.a.privateKey);
      expect(
        reasons(
          await verifyPresentation(p(), w.use(), w.env({ statuses: null })),
        ),
      ).toEqual(["STATUS_LIST_MISSING"]);
      expect(
        reasons(
          await verifyPresentation(
            p(),
            w.use(),
            w.env({
              statuses: w.status([], {
                validUntil: "2026-11-06T11:30:00.000Z",
              }),
            }),
          ),
        ),
      ).toEqual(["STATUS_LIST_STALE"]);
      const forged = { ...w.status(["x"]), revoked: [] };
      expect(
        reasons(
          await verifyPresentation(p(), w.use(), w.env({ statuses: forged })),
        ),
      ).toEqual(["STATUS_LIST_INVALID"]);
      const bySomeoneElse = buildStatusList(
        {
          iss: ISS,
          kid: "k1",
          issuedAt: "2026-11-06T11:00:00.000Z",
          validUntil: "2026-11-06T13:00:00.000Z",
          revoked: [],
        },
        key().privateKey,
      );
      expect(
        reasons(
          await verifyPresentation(
            p(),
            w.use(),
            w.env({ statuses: bySomeoneElse }),
          ),
        ),
      ).toEqual(["STATUS_LIST_INVALID"]);
    });
  });

  describe("trust: the verifier decides who is believed and how far", () => {
    it("an unknown, suspended or revoked issuer is refused", async () => {
      const w = world();
      const p = w.show(w.rootCred, w.keys.a.privateKey);
      expect(
        reasons(
          await verifyPresentation(p, w.use(), w.env({ trust: () => null })),
        ),
      ).toEqual(["UNKNOWN_ISSUER"]);
      for (const status of ["SUSPENDED", "REVOKED"] as const)
        expect(
          reasons(
            await verifyPresentation(
              p,
              w.use(),
              w.env({ trust: () => ({ ...w.trust, status }) }),
            ),
          ),
        ).toEqual(["ISSUER_NOT_TRUSTED"]);
    });
    it("a trusted issuer cannot vouch beyond the bounds the verifier set for it", async () => {
      const w = world();
      const p = w.show(w.rootCred, w.keys.a.privateKey);
      for (const narrower of [
        { maxAmountMinor: 5_000 },
        { allowedCurrencies: ["USD"] },
        { allowedActionKinds: ["PURCHASE"] },
      ])
        expect(
          reasons(
            await verifyPresentation(
              p,
              w.use(),
              w.env({ trust: () => ({ ...w.trust, ...narrower }) }),
            ),
          ),
        ).toEqual(["ISSUER_BOUNDS_EXCEEDED"]);
    });
  });

  it("malformed input never throws and never verifies", async () => {
    const w = world();
    for (const junk of [
      null,
      undefined,
      1,
      "x",
      {},
      { credential: {}, proof: {} },
      { credential: { root: {}, links: [] }, proof: {} },
    ]) {
      const v = await verifyPresentation(junk, w.use(), w.env());
      expect(v.valid).toBe(false);
    }
    const noDepth = { ...w.root, maxDepth: undefined } as unknown as RootClaims;
    const c = issueCredential(noDepth, w.keys.issuer.privateKey);
    expect(
      (
        await verifyPresentation(
          w.show(c, w.keys.a.privateKey),
          w.use(),
          w.env(),
        )
      ).reasons,
    ).toEqual(["MALFORMED"]);
    const nonEd = {
      ...w.root,
      holder: { kty: "RSA" },
    } as unknown as RootClaims;
    expect(
      (
        await verifyPresentation(
          w.show(
            issueCredential(nonEd, w.keys.issuer.privateKey),
            w.keys.a.privateKey,
          ),
          w.use(),
          w.env(),
        )
      ).reasons,
    ).toEqual(["MALFORMED"]);
  });
});
