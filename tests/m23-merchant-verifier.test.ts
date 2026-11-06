import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildStatusList,
  CREDENTIAL_VERSION,
  holderJwk,
  issueCredential,
  present,
  type Credential,
  type IssuerTrust,
} from "../packages/verifier/src/authority.js";
import {
  MerchantVerifier,
  renderGateMarkHtml,
  type AgentVerification,
  type MerchantOrder,
  type ProofCheck,
  type ProofVerifier,
} from "../packages/merchant-sdk/src/verifier.js";

const ISS = "https://issuer.example";
const AUD = "https://shop.example";
const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const order: MerchantOrder = {
  orderId: "order-1",
  amountMinor: 8_400,
  currency: "USD",
  merchantId: "shop-1",
};

function setup(
  over: {
    proofVerifier?: ProofVerifier;
    trustStatus?: IssuerTrust["status"];
  } = {},
) {
  let clock = T0;
  const issuer = generateKeyPairSync("ed25519");
  const agent = generateKeyPairSync("ed25519");
  const credential: Credential = issueCredential(
    {
      v: CREDENTIAL_VERSION,
      iss: ISS,
      kid: "k1",
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
      maxDepth: 2,
    },
    issuer.privateKey,
  );
  const status = (
    revoked: string[] = [],
    validUntil = "2026-11-06T13:00:00.000Z",
  ) =>
    buildStatusList(
      {
        iss: ISS,
        kid: "k1",
        issuedAt: "2026-11-06T11:00:00.000Z",
        validUntil,
        revoked,
      },
      issuer.privateKey,
    );
  let currentStatus: ReturnType<typeof status> | null = status();
  const trust: IssuerTrust = {
    issuer: ISS,
    status: over.trustStatus ?? "TRUSTED",
    maxDelegationDepth: 3,
    allowedActionKinds: ["PURCHASE"],
    allowedCurrencies: ["USD"],
    maxAmountMinor: 10_000,
  };
  const never: ProofVerifier = () => Promise.reject(new Error("not used"));
  const merchant = new MerchantVerifier({
    audience: AUD,
    now: () => new Date(clock).toISOString(),
    env: {
      issuerKey: (iss, kid) =>
        iss === ISS && kid === "k1" ? holderJwk(issuer.publicKey) : null,
      trust: (iss) => (iss === ISS ? trust : null),
      statusList: () => currentStatus,
    },
    proofVerifier: over.proofVerifier ?? never,
  });
  const show = (
    challenge: string,
    aud = AUD,
    nonce = `n-${Math.random().toString(36).slice(2)}-0123456`,
  ) =>
    present(credential, agent.privateKey, {
      aud,
      challenge,
      nonce,
      iat: new Date(clock).toISOString(),
      exp: new Date(clock + 120_000).toISOString(),
    });
  return {
    merchant,
    show,
    issuer,
    status,
    setStatus: (s: typeof currentStatus) => (currentStatus = s),
    advance: (ms: number) => (clock += ms),
  };
}
const ok = (v: AgentVerification) => {
  if (!v.valid) throw new Error(`expected valid, got ${v.reasons.join(",")}`);
  return v.bound;
};

describe("M23 merchant checkout: challenge-bound agent verification", () => {
  it("issues a challenge for an order, verifies the agent against exactly that order, and the mark can say VERIFIED", async () => {
    const s = setup();
    const { challenge } = s.merchant.issueChallenge(order);
    const v = await s.merchant.verifyAgent(s.show(challenge), order);
    expect(ok(v)).toMatchObject({
      orderId: "order-1",
      agent: "agent-1",
      issuer: ISS,
    });
    const mark = s.merchant.gateMark(
      v,
      order,
      "https://shop.example/verify/order-1",
    );
    expect(mark).toMatchObject({
      state: "VERIFIED",
      verificationUrl: "https://shop.example/verify/order-1",
    });
  });

  it("a challenge works once: the same agent cannot be 'verified' twice from one challenge", async () => {
    const s = setup();
    const { challenge } = s.merchant.issueChallenge(order);
    expect((await s.merchant.verifyAgent(s.show(challenge), order)).valid).toBe(
      true,
    );
    const again = await s.merchant.verifyAgent(s.show(challenge), order);
    expect(again).toEqual({ valid: false, reasons: ["UNKNOWN_CHALLENGE"] });
  });

  it("a challenge belongs to one order: it cannot be used for a different amount, order id, merchant or currency", async () => {
    const s = setup();
    const { challenge } = s.merchant.issueChallenge(order);
    for (const other of [
      { ...order, amountMinor: 8_000 },
      { ...order, orderId: "order-2" },
      { ...order, merchantId: "shop-2" },
      { ...order, currency: "EUR" },
    ])
      expect(await s.merchant.verifyAgent(s.show(challenge), other)).toEqual({
        valid: false,
        reasons: ["UNKNOWN_CHALLENGE"],
      });
    // None of those attempts spent it.
    expect((await s.merchant.verifyAgent(s.show(challenge), order)).valid).toBe(
      true,
    );
  });

  it("an unknown, expired or made-up challenge is refused", async () => {
    const s = setup();
    expect(
      (
        await s.merchant.verifyAgent(
          s.show("a-challenge-we-never-issued"),
          order,
        )
      ).valid,
    ).toBe(false);
    const { challenge } = s.merchant.issueChallenge(order);
    s.advance(301_000);
    expect(await s.merchant.verifyAgent(s.show(challenge), order)).toEqual({
      valid: false,
      reasons: ["UNKNOWN_CHALLENGE"],
    });
    expect((await s.merchant.verifyAgent({ junk: true }, order)).valid).toBe(
      false,
    );
  });

  it("a presentation made for another merchant is refused, and a refusal does not spend the challenge", async () => {
    const s = setup();
    const { challenge } = s.merchant.issueChallenge(order);
    const wrong = await s.merchant.verifyAgent(
      s.show(challenge, "https://other-shop.example"),
      order,
    );
    expect(wrong).toEqual({
      valid: false,
      reasons: ["PRESENTATION_AUDIENCE_MISMATCH"],
    });
    expect((await s.merchant.verifyAgent(s.show(challenge), order)).valid).toBe(
      true,
    );
  });

  it("an order beyond what the agent's authority covers is refused for that reason", async () => {
    const s = setup();
    const big = { ...order, amountMinor: 10_001 };
    const { challenge } = s.merchant.issueChallenge(big);
    expect(await s.merchant.verifyAgent(s.show(challenge), big)).toEqual({
      valid: false,
      reasons: ["ACTION_NOT_IN_SCOPE"],
    });
  });

  it("the same presentation cannot be replayed even against a fresh challenge-less retry", async () => {
    const s = setup();
    const { challenge } = s.merchant.issueChallenge(order);
    const p = s.show(challenge);
    expect((await s.merchant.verifyAgent(p, order)).valid).toBe(true);
    const second = s.merchant.issueChallenge(order);
    // Reuse the old presentation (old challenge) against the new challenge: its challenge no longer exists.
    expect((await s.merchant.verifyAgent(p, order)).valid).toBe(false);
    expect(second.challenge).not.toBe(challenge);
  });
});

describe("M23 Gate Mark rules", () => {
  it("shows SUPPORTED when nothing was verified, never VERIFIED", () => {
    const s = setup();
    expect(s.merchant.gateMark(undefined, order)?.state).toBe("SUPPORTED");
  });

  it("VERIFIED decays to UNKNOWN once it is old, and never carries over to another order", async () => {
    const s = setup();
    const { challenge } = s.merchant.issueChallenge(order);
    const v = await s.merchant.verifyAgent(s.show(challenge), order);
    expect(s.merchant.gateMark(v, order)?.state).toBe("VERIFIED");
    expect(
      s.merchant.gateMark(v, { ...order, orderId: "order-2" })?.state,
    ).toBe("UNKNOWN");
    s.advance(301_000);
    expect(s.merchant.gateMark(v, order)?.state).toBe("UNKNOWN");
  });

  it("a hand-made 'verified' result gets no mark at all", () => {
    const s = setup();
    const forged = {
      valid: true,
      bound: {
        orderId: "order-1",
        verifiedAt: new Date(T0).toISOString(),
        agent: "x",
        issuer: ISS,
        effective: {},
      },
    } as unknown as AgentVerification;
    expect(s.merchant.gateMark(forged, order)).toBeNull();
  });

  it("maps revocation, expiry and missing revocation data to REVOKED, EXPIRED and UNKNOWN; a failed check shows nothing", async () => {
    const s = setup();
    const attempt = async (setup: () => void) => {
      setup();
      const { challenge } = s.merchant.issueChallenge(order);
      return s.merchant.gateMark(
        await s.merchant.verifyAgent(s.show(challenge), order),
        order,
      );
    };
    expect(
      (await attempt(() => s.setStatus(s.status(["cred-1"]))))?.state,
    ).toBe("REVOKED");
    expect((await attempt(() => s.setStatus(null)))?.state).toBe("UNKNOWN");
    expect(
      (
        await attempt(() =>
          s.setStatus(s.status([], "2026-11-06T11:30:00.000Z")),
        )
      )?.state,
    ).toBe("UNKNOWN");
    s.setStatus(s.status());
    // A failed check (wrong verifier) is not "unknown": it must not look like anything.
    const { challenge } = s.merchant.issueChallenge(order);
    const bad = await s.merchant.verifyAgent(
      s.show(challenge, "https://other.example"),
      order,
    );
    expect(s.merchant.gateMark(bad, order)).toBeNull();
    // An expired credential.
    s.advance(25 * 3600_000);
    s.setStatus(s.status([], "2026-11-08T00:00:00.000Z"));
    const late = s.merchant.issueChallenge(order);
    expect(
      s.merchant.gateMark(
        await s.merchant.verifyAgent(s.show(late.challenge), order),
        order,
      )?.state,
    ).toBe("EXPIRED");
  });

  it("renders state as shape and words (not colour), escapes everything, and drops unsafe links", () => {
    const s = setup();
    const unsafe = s.merchant.gateMark(undefined, order, "javascript:alert(1)");
    expect(unsafe?.verificationUrl).toBeUndefined();
    const html = renderGateMarkHtml({
      state: "VERIFIED",
      geometry: "GATE_COMMITTED",
      label: 'Authority <img src=x onerror=alert(1)> "verified"',
      ariaLabel: "x' onmouseover='alert(1)",
      verificationUrl: 'https://shop.example/v?a=1&b="2"',
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("' onmouseover='");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp;b=&quot;2&quot;");
    expect(html).toContain("Authority"); // words, not just a colour
    expect(html).toMatch(/aria-hidden="true"/u); // the decorative shape is hidden from assistive tech
  });
});

describe("M23 Proof association: a payment is tied to one order, once", () => {
  const check = (over: Partial<ProofCheck> = {}): ProofCheck => ({
    verified: true,
    authentic: true,
    reason: "PROOF_VALID",
    outcome: "SUCCEEDED",
    effectCount: 1,
    actionId: "action-1",
    mismatches: [],
    ...over,
  });
  const merchantFor = (c: ProofCheck | Error) =>
    setup({
      proofVerifier: () =>
        c instanceof Error ? Promise.reject(c) : Promise.resolve(c),
    }).merchant;

  it("fulfils only a genuine Proof of money that moved exactly once for this order", async () => {
    expect(await merchantFor(check()).associateProof({}, order)).toMatchObject({
      verdict: "FULFIL",
      reason: "PAID_ONCE_MATCHES_ORDER",
      actionId: "action-1",
    });
  });

  it("an UNKNOWN outcome holds: it neither ships nor cancels", async () => {
    for (const c of [
      check({ outcome: "UNKNOWN", effectCount: null }),
      check({ effectCount: null }),
      check({ effectCount: undefined as unknown as null }),
    ]) {
      const r = await merchantFor(c).associateProof({}, order);
      expect(r).toMatchObject({ verdict: "HOLD", reason: "OUTCOME_UNKNOWN" });
      expect(r.humanSummary).toMatch(/do not ship and do not cancel/iu);
    }
  });

  it("a verifier outage holds too (it is not evidence of non-payment)", async () => {
    expect(
      await merchantFor(new Error("VERIFIER_UNAVAILABLE")).associateProof(
        {},
        order,
      ),
    ).toMatchObject({
      verdict: "HOLD",
      reason: "VERIFIER_UNAVAILABLE",
    });
  });

  it("a Proof of no payment does not ship; an inauthentic or mismatched Proof is refused", async () => {
    expect(
      await merchantFor(
        check({ outcome: "FAILED", effectCount: 0 }),
      ).associateProof({}, order),
    ).toMatchObject({
      verdict: "DO_NOT_FULFIL",
      reason: "NO_MONEY_MOVED",
    });
    expect(
      await merchantFor(
        check({
          authentic: false,
          verified: false,
          reason: "SIGNATURE_INVALID",
        }),
      ).associateProof({}, order),
    ).toMatchObject({
      verdict: "REFUSE",
      reason: "PROOF_NOT_AUTHENTIC",
    });
    expect(
      await merchantFor(
        check({ verified: false, mismatches: ["amountMinor"] }),
      ).associateProof({}, order),
    ).toMatchObject({
      verdict: "REFUSE",
      reason: "PROOF_DOES_NOT_MATCH_ORDER",
      mismatches: ["amountMinor"],
    });
  });

  it("refuses odd outcomes it does not understand (for example two effects)", async () => {
    expect(
      (await merchantFor(check({ effectCount: 2 })).associateProof({}, order))
        .verdict,
    ).toBe("REFUSE");
    expect(
      (
        await merchantFor(
          check({ actionId: undefined as unknown as string }),
        ).associateProof({}, order)
      ).verdict,
    ).toBe("REFUSE");
  });

  it("one payment cannot pay for two orders, but re-checking the same order is fine", async () => {
    const merchant = merchantFor(check());
    expect((await merchant.associateProof({}, order)).verdict).toBe("FULFIL");
    expect((await merchant.associateProof({}, order)).verdict).toBe("FULFIL");
    expect(
      await merchant.associateProof({}, { ...order, orderId: "order-2" }),
    ).toMatchObject({
      verdict: "REFUSE",
      reason: "PROOF_ALREADY_USED_FOR_ANOTHER_ORDER",
    });
  });
});
