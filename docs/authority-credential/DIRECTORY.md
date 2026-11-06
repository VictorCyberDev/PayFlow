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
