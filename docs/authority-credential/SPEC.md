# PayFlow Authority Credential v1 (M22)

Status: **COMPLETE_LOCAL** for the format, the reference verifier (`@payflow/open-verifier/authority`) and 26 tests. Not
standardised, not implemented by anyone else, not wired into issuing from the Gateway yet, and no status-list endpoint is
published. See "Not claimed".

## Purpose

Let a merchant, platform or another agent decide, **offline**, whether the agent in front of it carries authority from an
issuer it trusts that covers one specific action. It is evidence, not a payment instrument: paying is still decided by
the Authority and Trust Kernel in the Gateway.

## Objects

- **Root credential**: signed by the issuer (Ed25519). Names the agent (`sub`), its public key (`holder`), the bounds
  (`scope`: action kinds, currencies, counterparties, maximum amount), a validity window, optional permitted verifiers
  (`aud`), and the maximum delegation depth.
- **Link**: the current holder signs a narrower slice for another key. It names its parent by id **and by digest of the
  exact parent element**, so it cannot be moved under another credential.
- **Presentation**: the last holder signs the digest of the whole credential together with one verifier (`aud`), one
  `challenge`, a `nonce` and a window of at most 5 minutes. This proves possession and stops reuse elsewhere.
- **Status list**: signed by the issuer; lists revoked credential ids and carries `validUntil`.

All signatures are Ed25519 over canonical JSON (keys sorted, no whitespace) with a per-object-type domain prefix, so a
signature for one kind of object can never validate as another.

## Verification (what the verifier decides, in order)

1. **Trust**: the verifier, not the credential, decides which issuers it believes and where their keys come from. Unknown,
   suspended or revoked issuer → refuse. Unknown key id or bad root signature → refuse.
2. **Chain**: each link is signed by the previous holder, bound to its exact parent, and may only narrow (amount, every
   list, validity window, audience set). A widening is refused **even though the holder signed it**. Depth ≤ min(credential
   `maxDepth`, library cap 5, the verifier's limit for that issuer).
3. **Lifecycle**: inside the validity window (±60 s skew); the verifier's audience is permitted; the issuer's signed status
   list is present, authentic and fresh, and lists no id anywhere in the chain. A missing, forged or stale list **fails
   closed**.
4. **Possession and binding**: the presentation names this verifier and this challenge, is short-lived, and is signed by
   the last holder over the exact credential.
5. **Bounds and action**: the effective (narrowest) authority stays within what the verifier allows this issuer to vouch
   for, and covers the exact action the verifier is about to rely on.
6. **Replay**: only a presentation that passed everything consumes its nonce, so a refused attempt does not burn a good one.

Every refusal reason is returned (not only the first), as a stable code.

## Tested (26 tests, no network, no database)

Three-hop chain with the narrowest authority carried through; each action axis out of scope; widening on every axis;
validity widening; audience-restriction dropping; depth; forged and re-signed roots; a wrong-signer link; a valid link moved
under another root; cross-type signature reuse; stolen credential without the key; wrong verifier / challenge; edited
audience; replay; presentation window; validity window and skew; revocation of root, middle and leaf (and an unrelated id
not revoking); missing / stale / forged / foreign status list; unknown, suspended and revoked issuers; issuer bounds;
malformed input.

Mutation checks (each fails the suite): removing the parent binding, the amount narrowing, the revocation check, or the
status-list staleness check.

## Not claimed

- **Not a standard.** It does not implement W3C Verifiable Credentials, SD-JWT, UCAN or Biscuit, and nothing outside this
  repository reads it. The canonical JSON is this project's own.
- **Issuing is not wired to the Gateway**: nothing yet turns a stored Authority into a credential, and there is no
  endpoint publishing status lists or the issuer directory (M24).
- Revocation freshness is only as good as the verifier's last status list; a verifier that accepts a long-lived list
  accepts the same delay in revocation. There is no push notification.
- No selective disclosure: a verifier sees the whole chain, including every intermediate agent id.
- Ed25519 only. Key rotation and revocation of an _issuer key_ live in the directory, not here.
- Holder keys are held by agents; protecting them is the agent platform's problem.
