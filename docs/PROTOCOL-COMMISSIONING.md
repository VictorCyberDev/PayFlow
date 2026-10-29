# Protocol commissioning (2026-10-29)

Status: **PARTIAL**. Local wire implementation is real; public commissioning is not complete.

## Local MCP

`npm run dev:protocols` starts a loopback-only Sandbox server after a private `PAYFLOW_MCP_ACCESS_TOKEN` of at least 32 characters is configured. `/mcp` supports JSON responses over Streamable HTTP. It has exactly five tools, verified subject/scopes, Origin allowlist, bounded JSON, request IDs, explicit timeouts and no automatic write retries. A timed-out action remains UNKNOWN.

`npm run test:protocols` connects two official MCP SDK 1.32.2 clients over real loopback HTTP, discovers tools, invokes the actual kernel-backed check, checks read/write scopes and negative cases. This SDK negotiates MCP 2025-11-25. A direct HTTP test separately exercises the 2026-07-28 metadata-header profile. It does not prove complete conformance with every latest MCP feature.

Supported versions: 2026-07-28, 2025-11-25, 2025-03-26. The latest revision is stateless and removes GET streams. Unsupported GET receives 405. The optional older GET stream is not implemented. No resources, prompts, sampling or elicitation are advertised.

## Authentication

`http-auth.ts` verifies OAuth JWTs with `jose`, fixed HTTPS issuer/JWKS/audience, allowed asymmetric algorithms, required expiration/issued-at/subject and strict PayFlow access claims. `oauth-metadata.ts` builds resource metadata only for a genuinely commissioned issuer. It is not an authorization server.

Local fixed tokens are test credentials, not end-user OAuth. Before public exposure implement/configure authorization-code + S256 PKCE, registered/CIMD/DCR client policy, exact redirect allowlists, resource binding, token revocation/lifecycle and token rotation. Bind verified principal/agent to durable services. Inject a distributed atomic limiter. Never expose the local fake services as a real payment product.

## A2A

`a2a-http.ts` implements a narrow v1.0 synchronous HTTP+JSON profile. Discovery: `/.well-known/agent-card.json`. Message endpoint: `/a2a/v1/message:send`. Send `Content-Type: application/a2a+json`, `A2A-Version: 1.0`, and a bearer credential for the configured audience. A request has one ROLE_USER message with a messageId and one data part `{tool, arguments}`. `sendA2ACommand` is the client; tests exchange actual HTTP messages between independent client/server code.

Card securityRequirements now uses the v1 `schemes` wrapper. No streaming, push or long-running task service is advertised. Replay claims, trusted parent loading and per-subject services are injected. Existing delegation validation enforces audience, parent validity, expiry, attenuation and replay. The current wire profile does NOT yet bind every delegated child constraint to the exact requested action. Do not enable delegated financial execution until that is implemented and tested. No public TCK/Inspector result or remote peer is claimed.

## Vendor models

`model-runtime.ts` implements OpenAI Responses, Anthropic Messages and Gemini generateContent request/tool-result loops, with a three-turn ceiling, bounded HTTP timeout, no automatic retries, local read-only mode and actual PayFlow dispatch. Recorded responses test the wire shape and refusal of read-only widening. These are not model selection results.

`examples/model-tool-flow.ts` requires an explicit provider, model, API key and `PAYFLOW_ALLOW_MODEL_CALL=true`. No default paid model is selected. `scripts/run-model-eval.ts` additionally requires `PAYFLOW_ALLOW_MODEL_EVAL=true`; it runs the curated provider-specific dataset and stores results separately. Argument adjudication stays unscored (`null`) until reviewed. Clarification detection is explicitly heuristic. Do not interpret mocks as live scores.

## Public commissioning sequence still required

1. Finish tenant-bound durable services, delegated-action binding and OAuth service.
2. Pass native PostgreSQL fresh DB, full browser E2E and security gates on exact head.
3. Package static company export and protocol routes in ONE existing project. Validate the actual root/output/runtime binding; root Vercel config is not yet a complete company deployment.
4. Deploy once only when those gates pass. Test TLS, OAuth discovery, external MCP client and A2A peer.
5. Connect ChatGPT, execute positive/negative/ambiguous prompts, then submit current package. Preserve submission id and actual review state.

## Official sources fetched

- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/plugins/deploy/submission
- https://a2a-protocol.org/latest/specification/
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- https://ai.google.dev/gemini-api/docs/function-calling
