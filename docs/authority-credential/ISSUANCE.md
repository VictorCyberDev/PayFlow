# Issuing portable Authority credentials from stored Authorities

Status: **COMPLETE_LOCAL** — real PostgreSQL and real HTTP through the hosted Gateway, with an independent verifier that
learns the issuer key and revocations only from the host's public endpoints. Not deployed; the public Neon database needs
migration 025 (see `docs/ops/PUBLIC-DEPLOY-RUNBOOK.md`).

## The contract

`POST /v1/admin/org/authorities/{authorityId}/credentials` — a **member** API (`authority:attest`: OWNER and FINANCE_ADMIN).

1. The member is authenticated; tenant and environment come from the member, never from the request.
2. The Authority is **read from storage**. It must belong to that tenant/environment (otherwise 404, indistinguishable from
   missing), be unrevoked and unexpired, have an enumerable merchant list (`ONLY`), a positive autonomous limit, and an agent
   that is not SUSPENDED/REVOKED/RETIRED. A stored Authority that fails its own integrity check (fingerprint or column
   mismatch, schema failure) is **never vouched for** (`AUTHORITY_INTEGRITY_FAILED`).
3. The credential says what storage says: subject = the stored agent, principal = the stored principal, currency = the
   stored currency, action kind = PURCHASE, merchants = the stored list, per-action amount = `min(single-transaction limit,
autonomous threshold)`, expiry ≤ the Authority's expiry (default 1 h, at most 24 h).
4. The request may only **narrow**: a smaller `maxAmountMinor`, a subset of `counterpartyIds`, an `audience` list, a shorter
   `ttlSeconds`, `maxDepth` ≤ 2. It cannot supply currency, action kind, scope, subject, principal, authority or expiry;
   unknown fields are rejected (400), not ignored.
5. `ref: {authority, fingerprint}` in the signed claims preserves provenance; the row stores the same plus the requester.
6. Signed with the host's existing signing key and kid (the key lifecycle of `/v1/keys`); signatures are domain-separated
   from Proofs. No private key appears in any response, row or audit event (tested).
7. The `idempotencyKey` makes issuance safe to retry; a burst of identical requests yields exactly one credential (tested at
   12-way concurrency); a different request with the same key is 409.
8. Every issuance and revocation is an event in the tenant's own audit trail.

Revocation: `POST /v1/admin/org/credentials/{id}/revoke` (`authority:attest_revoke`: OWNER, FINANCE_ADMIN and SECURITY_ADMIN,
so containment does not require the power to issue). `GET /v1/issuer/status` (public) is the signed list verifiers fetch: it
includes revoked credentials **and every credential whose source Authority was revoked**, until they would have expired.

SDK: `PayFlowMemberClient` in `packages/sdk-typescript/src/member.ts` (`credentials.issue / list / revoke`,
`fetchIssuerStatus`). OpenAPI: `openapi/payflow-v1.yaml`.

## Tested (`tests/m22-credential-issuance.integration.test.ts`, 10 tests)

The credential equals the stored Authority and an independent verifier accepts it (and refuses other currency/audience);
amount, merchant, currency, action kind, scope, subject, principal, authority and expiry inflation all refused with nothing
written; role matrix (OWNER, FINANCE_ADMIN issue; the rest, the operator token and no token do not); tenant isolation for
issue, list, revoke and audit; idempotency and a 12-way race; revocation by credential and by Authority through the signed
status list; expired Authority, expiry capping, suspended agent, un-enumerable merchants, tampered stored Authority; no
secret in any output; status-list signature and tamper detection; the full SDK workflow.

Mutation checks (each fails a test): amount ceiling, counterparty subset, tenant ownership, idempotency comparison, revoked
Authority, Authority-revocation in the status list, expiry cap, and DEVELOPER being given `authority:attest`.

A defect this work found: an exception inside an admin route left the HTTP request hanging. The new routes now fail with a
safe 500 instead.

## Not claimed

- The signing key is the host's existing Proof key (`PAYFLOW_M6_SIGNING_KEY`), separated only by domain prefix. A dedicated
  credential-signing key with its own rotation is better practice; the registry supports it, the host does not yet configure one.
- The holder key is chosen by the authorized member; there is no proof of possession at issuance (the credential is only
  usable with the matching private key, so binding someone else's key gains nothing).
- Delegation links (agent → sub-agent) are signed by agents and are not recorded server-side; they are verified offline.
- Credentials are not yet issued for non-PURCHASE actions or for `ANY` merchant scopes.
