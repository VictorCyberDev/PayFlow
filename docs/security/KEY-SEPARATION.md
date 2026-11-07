# Signing-key separation review (Phase 0, item 12.1)

Date: 2026-11-07. Scope: the Ed25519 key that signs Proofs, portable Authority credentials, status lists and the issuer
directory on the hosted Gateway.

## What was found

One signing key (`PAYFLOW_M6_SIGNING_KEY`, id `PAYFLOW_M6_SIGNING_KID`) signs all four artifacts.

| Artifact                                   | Signed bytes                                             | Domain separation                                                      |
| ------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Portable Proof                             | bare canonical JSON (starts with `{`)                    | none (historical format; changing it would break every accepted Proof) |
| Portable Authority credential, status list | `<domain>\n<canonical JSON>`                             | domain string per message type                                         |
| Issuer directory                           | `payflow-issuer-directory/v1/document\n<canonical JSON>` | domain string                                                          |

## Decision

1. **Cross-protocol confusion is not possible today.** Every non-Proof message begins with an ASCII domain string; a Proof begins
   with `{`. No domain string starts with `{`, so no byte string is valid in two protocols, and a signature over one cannot
   verify as another. `tests/phase0-hardening.integration.test.ts` pins this for the directory (a Proof-style signature over
   the same document is rejected). Do not introduce a domain string beginning with `{`.
2. **Historical Proofs must keep verifying,** so the Proof format is not changed.
3. **Key separation is NOT done, and the residual risk is stated:** compromise of the one key lets an attacker forge Proofs,
   credentials and a directory that vouches for further keys. The directory is pinned by thumbprint, so a verifier that pinned
   this key trusts whatever the key signs. Mitigations that exist: key revocation tombstones in the directory, short directory
   and status lifetimes, rotation as a chain.
4. **Recommended follow-up (owner decision, not done here):** a separate offline _issuer root_ key that signs only the directory
   and lists the operational signing key as ACTIVE. Verifiers pin the root. That changes what operators pin, so it needs a
   migration plan, an announce-then-switch window, and updated pin documentation. Do not rotate production keys as part of
   routine work.

Status: **COMPLETE_LOCAL for the review and the confusion test; key separation itself is a documented, unimplemented
recommendation.**
