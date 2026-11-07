# Issuer directory (M24)

Status: **COMPLETE_LOCAL** for the format and the reference client (`@payflow/directory-client`, `packages/directory-client`), 21 tests, 11
mutation checks. **No issuer publishes a directory**: PayFlow does not serve one yet, and nothing signs credentials from the
Gateway. No external issuer exists.

## What it solves

A verifier of Authority credentials (M22/M23) needs the issuer's current public keys and revocation list, and must not be
fooled by whoever happens to answer the request. The attacks it is built against:

| Attack                                                                 | Defence                                                                                                                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Serve the attacker's own key set at the issuer's URL                   | A directory must be **signed by a key the verifier already trusts**: a **pinned** root thumbprint the first time                                                                  |
| Serve a valid-looking directory for a different issuer                 | The document's `issuer` must equal the origin it was fetched for                                                                                                                  |
| Take over rotation with a retired or revoked key                       | After the first directory, only **ACTIVE keys of the previously accepted directory** may vouch for the next (a chain)                                                             |
| Roll the verifier back to a set where a since-revoked key still worked | `sequence` only increases; lower is `ROLLBACK`                                                                                                                                    |
| Show different verifiers different key sets                            | Same `sequence` with different content is `EQUIVOCATION`                                                                                                                          |
| Reassign a key id to a different key                                   | `KEY_ID_REUSED`                                                                                                                                                                   |
| Quietly delete or undo a revocation                                    | A revoked key must stay listed as revoked (`REVOCATION_DROPPED` / `REVOCATION_REVERSED`)                                                                                          |
| A document signed only by a key it revokes                             | That signature does not count                                                                                                                                                     |
| Keep stale keys alive after the issuer stopped publishing              | Cache lifetime ≤ 24 h; once `validUntil` passes the directory is **not used**; a failed refresh extends nothing                                                                   |
| Make the verifier fetch an internal URL (SSRF)                         | Only configured issuers are fetched; URL must be https on the issuer's origin, no credentials, no redirects, resolved addresses must be public, 64 KB cap, 5 s timeout, JSON only |
| Poison the revocation list (stale list, forged list, "future" list)    | A status list is **authenticated against a directory key before it is stored**, and older lists never replace newer                                                               |

It lives in its own package, not in `@payflow/open-verifier`, because that package is deliberately offline and import-checked (no network, database or server code). `IssuerDirectoryClient.environment()` plugs directly into the M22 verifier (`issuerKey`, `statusList`). Which issuers are
trusted, and how far (`IssuerTrust`), remain the verifier's own decision.

## Tested

Pinned acceptance; four substitution variants; unconfigured issuer is never fetched; two-step rotation with retirement grace;
retired keys cannot vouch; rollback/equivocation/unchanged; revocation permanence; kid reuse; revoked-signer; expiry,
clock and cache-length limits; `notBefore`; private-range classification (IPv4, IPv6, IPv4-mapped, metadata address);
redirect, oversize, wrong content type, error status and hang against a **real local HTTP server**; end to end with the M22
verifier: valid, revoked credential, revoked signing key, expired directory, older/forged status lists.

## Not claimed

- **No published directory.** Nothing in PayFlow serves one yet and credentials are not issued from the Gateway.
- **DNS rebinding is only mitigated, not eliminated**: addresses are checked before the request, but Node's `fetch` does
  not let us pin the connection to the checked address. The allow-list of configured issuers is the primary defence; run the
  verifier where egress to private ranges is also blocked at the network layer.
- The pin must reach the verifier **out of band** (configuration, a reviewed registry). If an attacker controls the pin they
  control trust. Compromise of the root key's private half is not recoverable by this protocol.
- Revocation is as fresh as the last successful status-list fetch; there is no push channel.
- Ed25519 only; JSON canonicalisation is this project's own; no interop with any existing directory standard.

## Publication (A2): PayFlow's own issuer directory

`GET /v1/issuer/directory` (public) and `GET /v1/issuer/status` (public), from the same host that issues the credentials
(`docs/authority-credential/ISSUANCE.md`). Status: **COMPLETE_LOCAL** — a separate `IssuerDirectoryClient`, pinned only to the
root key and talking to a real local HTTP host with PostgreSQL, discovers the directory, verifies a credential, follows
rotation, and learns of revocations. Not deployed; the public Neon database needs migrations 025 and 026.

- **Immutable documents.** A sequence is stored (the exact bytes) and re-served unchanged until the key set or signer changes,
  or it is within 15 minutes of expiry (valid 1 h). Ten concurrent requests and a process restart returned identical bytes;
  cutting a sequence takes a database advisory lock, so two instances cannot disagree (no equivocation).
- **Keys.** ACTIVE, RETIRED (explicit end of grace, 24 h after retirement) and REVOKED tombstones from the existing signing-key
  registry. A revoked key can never be re-activated.
- **Signer.** The directory is signed by this process's key, which must be in the registry and not revoked; otherwise the
  endpoint answers `503 DIRECTORY_UNAVAILABLE` and publishes nothing (a client keeps its previous directory until it expires,
  then fails closed).
- **Rotation (two steps; the second document must be signed by a key the first already trusted):**
  1. `SigningKeyRegistry.announce(issuer, newKid, newPublicJwk)` — status NEXT. The process still signs with the OLD key.
     The directory rolls to the next sequence listing the new key as trusted, signed by the old key. Nothing else changes:
     the ACTIVE key, `/v1/keys` and Proof signing are untouched.
  2. Wait at least the directory lifetime (1 h) so verifiers have fetched it.
  3. Change the deployment's signing secret and `PAYFLOW_M6_SIGNING_KID` to the new key and redeploy. Starting with the new
     key promotes it to ACTIVE and retires the old one (the existing M14 rule, including rollback by redeploying the old
     key). The next sequence is signed by the new key, which the previous directory already named.
     A cold start of an old-key process between steps 1 and 3 changes nothing, because announcing never moves the ACTIVE key
     (tested). While designing this, a simpler approach (never re-activating a known key at start-up) broke the accepted M14
     "rollback by redeploy" contract and was dropped.
- **Compromise.** `SigningKeyRegistry.revoke(kid)`: the key appears as REVOKED and every credential it signed stops verifying
  at the verifier's next refresh. If the revoked key is the one the process signs with, publication stops until the
  deployment is switched to a good key.

Mutation checks (each fails a test): re-serving vs always cutting a sequence, revoked signer allowed, tombstones omitted,
announced keys not trusted, retired keys never expiring.

Remaining: the signing key is still the Proof key; no dedicated credential key. No monitoring alert on `DIRECTORY_UNAVAILABLE`
yet. The hosted public deployment does not exist, so nothing here has been fetched from a public URL.
