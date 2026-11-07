# M17 — OAuth: provider evaluation and decision

Status: **PARTIAL.** The PayFlow side (resource server) is built and tested locally. No identity provider has been chosen,
configured or connected, nothing is deployed, and **no real ChatGPT client has invoked PayFlow.** Nothing here is a claim of
a ChatGPT connection.

Sources read 2026-11-07: OpenAI "Authentication – Plugins" (developers.openai.com/plugins/build/auth), the MCP
authorization specification and tutorial (modelcontextprotocol.io), and vendor pages named below. Vendor comparison tables
are **vendor marketing** (the WorkOS comparison ranks WorkOS first) and were used only to find candidates, not as evidence.

## What ChatGPT / MCP require (from OpenAI's and MCP's own documents)

| Requirement                                                                                                                                                                                               | Where                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Protected-resource metadata (RFC 9728): `resource` (canonical HTTPS id, sent back as the `resource` parameter) and `authorization_servers`; also advertised in `WWW-Authenticate` on 401                  | OpenAI auth guide           |
| Authorization-server metadata (RFC 8414 or OIDC discovery) with `issuer`, `authorization_endpoint`, `token_endpoint`, and `code_challenge_methods_supported` **including `S256`** (omitted ⇒ unsupported) | OpenAI auth guide, MCP spec |
| Authorization-code + PKCE; client registration by **CIMD** (preferred), **DCR** (`registration_endpoint`), or a predefined client                                                                         | OpenAI auth guide           |
| `resource` echoed into issued tokens so the audience is this server                                                                                                                                       | MCP spec / OpenAI           |
| No machine-to-machine grants (client credentials, service accounts, JWT bearer); ChatGPT presents an OpenAI-managed client certificate for optional mTLS                                                  | OpenAI auth guide           |
| "Many plugin MCP servers can operate in a **read-only, anonymous mode**"; anything with customer data or writes should authenticate                                                                       | OpenAI auth guide           |
| "We **strongly** recommend that you use an existing established identity provider rather than implementing authentication from scratch"                                                                   | OpenAI auth guide           |

## Decision

1. **PayFlow will not build an OAuth authorization server.** The requirement list above is exactly the surface an
   authorization server has to get right (single-use codes, PKCE, consent, CIMD fetching hardened against SSRF, DCR abuse
   limits, refresh rotation, revocation). A proven provider already does it, and OpenAI's own guide recommends against
   writing one. No missing capability was found that would justify a custom component, so no custom component and no
   security review of one are needed.
2. **PayFlow is only a resource server.** It validates tokens a provider issued and maps them to a tenant it controls
   (below). That part is unavoidable regardless of provider and is built.
3. **The default publication candidate is the `verify-only` profile with no authentication at all.** Its single tool,
   `verify_financial_proof`, is stateless and checks a signed Proof the caller already holds; it reads no tenant data and
   cannot reach a payment. It exposes nothing the public `POST /v1/verify/proofs` does not, and OpenAI's guide explicitly
   allows read-only anonymous apps. So the first thing that could be submitted needs **no identity provider**, which removes
   the largest dependency. (Whether OpenAI will list it is OpenAI's decision; see "Publication blockers" in README.)
4. **Payment-executing tools stay separate** from that app and are never part of the verify-only surface. A full-profile
   app, if ever pursued, needs an identity provider and per-tenant consent; OpenAI's guidelines list money-transfer
   execution as prohibited, so it is not planned.

## Candidates for the authenticated (tenant-bound) profile

| Provider                       | What a first-party document says                                                                                                                 | Fit / open questions (not verified by running it)                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Auth0**                      | OpenAI's guide names it and links an Auth0-for-MCP setup guide; Auth0 documents metadata discovery, CIMD registration and token exchange for MCP | Established, managed. Needs an account, an API with audience = PayFlow's resource, and a pricing check. Owner action.                                                                                  |
| **Stytch (Connected Apps)**    | OpenAI's guide names it as a hosted example                                                                                                      | Managed; DCR/PKCE/resource indicators per Stytch docs. Acquired by Twilio (Nov 2025, per a vendor blog); roadmap risk is a judgement, not a fact. Owner action.                                        |
| **WorkOS (AuthKit / Connect)** | Vendor documentation and blog claim DCR, CIMD, RFC 8707, RFC 9728                                                                                | Claims come from the vendor's own marketing; verify against its docs before relying. Owner action.                                                                                                     |
| **Keycloak** (self-hosted)     | MCP's own tutorial uses it; DCR is native                                                                                                        | You operate it. RFC 8707 resource binding needs a custom mapper; CIMD is experimental per a vendor blog. Highest operating burden; it would make PayFlow an authorization-server operator in practice. |

**Recommendation:** if an authenticated profile is wanted, start with a managed provider OpenAI itself names (Auth0 or
Stytch) rather than Keycloak. The choice, the account and the spend are the owner's. PayFlow's code does not depend on which
one: it needs only `issuer`, a JWKS URL, and that tokens carry `aud` = the resource.

## What is built (internal, tested)

`src/protocols/oauth-resource.ts`, `db/migrations/029_m17_oauth_identity_mappings.sql`, hosted wiring and
`tests/m17-oauth-resource.integration.test.ts` (10 tests, real PostgreSQL, real HTTP, the official MCP client, tokens signed
by a TEST identity-provider key):

| Property                                                                                                                                                                                        | Enforced                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `iss` equals the one configured issuer **exactly** (no prefix, case, or trailing-slash tolerance)                                                                                               | `jwtVerify` `issuer`         |
| `aud` contains this resource's canonical identifier                                                                                                                                             | `jwtVerify` `audience`       |
| Algorithms allowlisted (RS256, ES256, EdDSA); `none` and others refused                                                                                                                         | `algorithms`                 |
| Keys come from the configured JWKS, never from the token                                                                                                                                        | `createRemoteJWKSet(config)` |
| `exp`, `iat`, `sub` required; a token issued in the future is refused (jose does not do this; found by a failing test)                                                                          | explicit check               |
| Tenant, environment, agent, principal, client id and the **maximum scopes** come only from `oauth_identity_mappings`, created by an OWNER (`member:manage`). Token claims for these are ignored | mapping lookup               |
| Token scope can only narrow the mapping; unknown scopes dropped; nothing left ⇒ 401                                                                                                             | intersection                 |
| Revoked mapping or suspended agent stops working at the next request                                                                                                                            | per-request lookup           |
| Every failure is a bare 401 that does not say which check failed                                                                                                                                | tested                       |
| One ACTIVE mapping per (issuer, subject)                                                                                                                                                        | unique partial index         |
| Anonymous verify requires `PAYFLOW_MCP_PROFILE=verify-only` **and** `PAYFLOW_MCP_ANONYMOUS_VERIFY=true`; one scope (`proof:read`), 60-second access; payment tool absent                        | config + gateway             |
| Protected-resource metadata lists the configured issuer, and still `[]` when none is configured                                                                                                 | tested                       |

Configuration: `PAYFLOW_OAUTH_ISSUER` and `PAYFLOW_OAUTH_JWKS_URL` (both https, together), `PAYFLOW_MCP_ANONYMOUS_VERIFY`.
Mapping API: `POST/GET /v1/admin/org/oauth-identities`, `POST …/{id}/revoke` (audited).

Mutation checks (each fails a test): no audience check, no issuer check, scope beyond mapping, revoked mapping honoured,
algorithm allowlist removed. One mutation **survived and is recorded honestly:** dropping the `verify-only` condition inside
the gateway's anonymous branch. The config parser already refuses that combination, so the gateway condition is defence in
depth that no test exercises.

## Not built / not claimed

- **No identity provider is chosen or configured, and none has been run against PayFlow.** Interop with a real provider
  (its discovery document, `resource` handling, token claims, JWKS rotation) is untested. Expect to adjust: some providers
  emit `scp` or `permissions` instead of `scope`, and opaque tokens (introspection) are not supported here.
- **No consent screen, authorize/token endpoints, CIMD fetching or DCR in PayFlow** — deliberately.
- **JWKS fetching** uses `jose`'s remote key set with a timeout and cool-down; it has not been given the SSRF hardening of
  the issuer-directory client because its URL is operator configuration, not attacker input.
- The mapping is manual (an owner enters the provider's `sub`). No self-service account linking exists.
- No real ChatGPT account has connected; domain verification and the submission portal are owner actions.
- Anonymous verify has IP-based rate limiting only through the hosted limiter already in front of every `/v1` request;
  its adequacy under real abuse is unmeasured.

## Owner actions to take this further

1. Decide whether to publish the **anonymous verify-only** app first (needs the public deployment, domain verification and
   OpenAI developer verification — all owner-gated).
2. If an authenticated profile is wanted: choose a provider, create the account/application, supply the issuer and JWKS URL
   as environment variables (no secrets are needed by PayFlow for token validation), and map identities via the API.
