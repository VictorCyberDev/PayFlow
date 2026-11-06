# M17 — ChatGPT

Status ladder (never skip a rung in a claim):

| Rung             | Meaning                                                                   | PayFlow today                                |
| ---------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| **COMPATIBLE**   | Speaks what ChatGPT's MCP connector expects; verified locally             | **Yes (local)**                              |
| **COMMISSIONED** | A real ChatGPT account connected to a deployed PayFlow server and used it | **No** (nothing is deployed; OAuth missing)  |
| **PUBLISHED**    | Reviewed and listed in the ChatGPT directory                              | **No, and see "Publication blockers" below** |

## Supported architecture (from OpenAI's current plugin docs, read 2026-11-06)

ChatGPT connects to a **remote MCP server over HTTPS** (`POST /v1/mcp`, Streamable HTTP). Authentication, when the
server is protected, is **OAuth 2.1 authorization-code + PKCE (S256)** with RFC 9728 protected-resource metadata, the
`resource` parameter echoed through the flow, and client registration by CIMD, DCR or a predefined client. Tools
declare `securitySchemes` per tool. An optional UI is an MCP Apps resource (`ui://…`, `text/html;profile=mcp-app`).

## What exists

- Tool contract: every tool has a title, a description that states its side effects, explicit
  `readOnlyHint`/`destructiveHint`/`openWorldHint`, a per-tool `securitySchemes` entry with the single scope the
  server enforces, and invoking/invoked status text. (`src/protocols/chatgpt-app.ts`)
- Result card: an accessible, injection-safe MCP Apps widget that shows ALLOW / DENY / needs-approval / paid once /
  **UNKNOWN (never rendered as $0)** / Proof valid / Proof not valid. Verified in Chromium at 320–1280px, light and
  dark, with axe, and with a hostile payload (`scripts/chatgpt-widget-check.mjs`, also in CI).
- Discovery: `GET /v1/oauth-protected-resource` and a `WWW-Authenticate: Bearer resource_metadata=…` challenge on
  `401`. `authorization_servers` is `[]` until one is commissioned; no issuer is invented.
- Profiles: `PAYFLOW_MCP_PROFILE=verify-only` removes the payment tool from the surface entirely.

## Gaps (all internal engineering unless stated)

1. **No OAuth authorization server.** PayFlow issues its own Gateway bearer credentials; ChatGPT cannot obtain one by
   itself. An authorization server (authorize + consent by a signed-in member, token with PKCE, resource binding,
   CIMD/DCR, single-use codes, scope-limited tokens that map to a Gateway credential) must be built and reviewed
   before a protected connection can work. Until then the server cannot be COMMISSIONED. _Not built._
2. **Nothing is deployed** (`payflow-public` is owner-gated), and ChatGPT needs a public HTTPS URL.
3. **Domain verification** (`/.well-known/openai-apps-challenge`) and the submission portal are owner actions.
4. No real ChatGPT account has connected. Nothing here is evidence of that.

## Publication blockers (read OpenAI's guidelines before spending effort)

OpenAI's plugin guidelines (2026-11-06) say plugins may conduct commerce only for physical goods, list **"execution
of money transfers, crypto transfers, or investment trades"** as prohibited, reject "trial or demo plugins", and ask
reviewers for a fully featured demo account. PayFlow's payment tool executes payments, and the public host is a
**Sandbox on a simulated rail**. So:

- A directory submission of the **payment-execution** tool is likely to be rejected, and a sandbox-only app is a demo.
- The plausible submission is a **verification app** (`verify-only` profile: check a signed Proof, read an Authority
  decision). It still needs the OAuth server, a published privacy policy, a support contact (owner), and developer
  verification (owner).
- Whether a payment tool could ever qualify is OpenAI's call, not ours; we make no claim.

## Test prompts (for developer-mode connection once COMMISSIONED)

1. "Verify this PayFlow Proof and tell me whether money moved." (paste a portable Proof)
2. "Ask PayFlow whether my agent may buy a $84 keyboard from the demo merchant." (full profile, Sandbox only)
3. "My last payment says UNKNOWN. What should I do?" (expects: do not retry, check Proof)

## Data handling (draft for the owner's privacy policy; not legal advice)

The tools take: an Authority id, an agent id, an amount, a merchant id and a nonce, or a signed Proof. They do not
take conversation history, location, card numbers, passwords or API keys. Responses omit secrets by construction
(`assertSafeOutput`). Requests are logged with a request id and the credential's client id.

## How to reproduce the local checks

```bash
npm run build --if-present
npx vitest run tests/m17-chatgpt-app.test.ts tests/m16-mcp-gateway.integration.test.ts   # needs TEST_DATABASE_URL
PLAYWRIGHT_CHROMIUM=/path/to/chromium node --import tsx scripts/chatgpt-widget-check.mjs  # result-card acceptance
```

The result-card check fails if an UNKNOWN outcome is rendered as `$0` or if tool output is inserted as markup; both
were confirmed by deliberately introducing those faults.
