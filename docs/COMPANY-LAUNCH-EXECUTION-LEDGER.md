# Company launch execution ledger

Verified 2026-10-29 (Africa/Lagos). This ledger supersedes optimistic classifications in the earlier M7–M60 handoff. No deployment, publication, model evaluation or provider effect is inferred from local tests.

## Independently verified starting point

- Repository: public `VictorCyberDev/PayFlow`; default `main` = `880a890f9e0735d03ee7e0de625907e408f5fc73`.
- PR #16: OPEN, DRAFT, unmerged; current M6 head `36a34c1530a79b487ea382b41094334639146bf2`. M6 acceptance remains unproven.
- PR #18: OPEN, DRAFT, unmerged; branch `m7-m60-master-execution`; head `6bcab82a25a4aca4bf5b3eecbaf6e52bd48bdae6`; base snapshot `9f1aca949c1bb492c83a52772c2fb2b16ef01b6e`. M6 has advanced independently. Do not silently merge its changes.
- GitHub Actions run `40659651703`: completed SUCCESS for the starting PR #18 head. This is historical CI, not validation of future edits.
- GitHub issue search returned no open issues.
- Vercel projects: `payflow`, `payflow-m5-acceptance`, `payflow-m6-acceptance`, team `team_gn8cWAsH7Qmm2KQMl4sHat6f`.
- Latest M6 deployment listed: READY, production, `dpl_H4wNUTfGk3E4Hj5S6Bn4ayGMkKN6`, source `9ce47e4b7087db91378639324a55a7bb6b588a40`; differs from current PR #16 head.
- Main PayFlow project is not live in project metadata; latest listed preview source `e11b8c43c676b7d622853a60884984b540e99194`. Preview uses Vercel SSO protection.
- No M7–M60 deployment shown in inspected deployment results. No deployment initiated by this session.
- Source review: stdio MCP and transport-neutral handler exist; no HTTP MCP transport. Five tools exist. Authentication context is a boolean and does not itself bind scopes/tenant identity.
- A2A module has a card and attenuation function but no wire server/client. Card security requirements need the v1.0 wrapper (`schemes`).
- Tool adapters convert schemas only; no provider request/tool-result loops. Tool-selection artifact uses 14 deterministic cases, no real model.
- Console root is a sandbox home with persistent app shell; no separate public company root. Static Next export and existing root Vercel public output require deliberate packaging.
- Earlier ledger explicitly eliminated PARTIAL and defined COMPLETE_REAL as software-only tests. Both conflict with this mandate.

## Source verification

Official pages fetched on 2026-10-29:

- MCP current transport index: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports (latest redirects here); previous stable transport: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports . Version differences must be negotiated, not conflated.
- OpenAI current integration: https://developers.openai.com/plugins/build/auth and https://developers.openai.com/plugins/deploy/connect-chatgpt (Apps SDK URLs redirect here). OAuth protected-resource discovery, authorization code + S256 PKCE, resource/audience binding and real connection testing are required for authenticated ChatGPT use.
- A2A current: https://a2a-protocol.org/latest/specification/ . v1.0 uses SendMessage JSON-RPC or HTTP+JSON `/message:send`, version header and protobuf JSON representations.
- Claude: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools . Client tools require a tool-use/tool-result loop.
- Gemini: https://ai.google.dev/gemini-api/docs/function-calling . Client executes declared functions and returns results; schema conversion is insufficient.

## Execution policy

Local first. No real-money execution. No M6 acceptance claim. Keep both PRs draft. No new paid projects, previews or model calls without bounded free/authorized access. Every remaining internal task may be PARTIAL; external events are never manufactured.

## Progress

Starting-point verification complete. Corrected milestone audit and implementation evidence follow in the accompanying reports.

## Implemented in this session

- Corrected the M7–M60 vocabulary/table and created a conservative M6–M60 audit with exact internal residue.
- Added HTTP MCP and local A2A wire profile/client, server-owned identity/scope interfaces, OAuth JWT verification, strict MCP outer arguments and stable safe errors.
- Connected two official MCP SDK clients over loopback HTTP and exercised local kernel-backed invocation. Added A2A HTTP exchange tests.
- Added OpenAI/Claude/Gemini request/tool-result loops and opt-in provider eval capability; no live model calls.
- Built separate public company root and /app, public docs/security/status/pricing/evidence/legal/contact/research, brand V2 and reusable assets. No publication or deployment.
- Fixed concrete invalid-time/counter, reconciliation binding and NaN epoch bugs discovered during review; preserved benchmark semantics and historical artifacts.
- Public-browser QA covers seven widths, interaction with UNKNOWN/denial, automated homepage WCAG checks and destination smoke tests. Native authenticated DB E2E remains unrun locally.
- Disabled automatic deployment of this integration branch in each of the three existing Vercel roots. No new project, preview, deployment or paid model run was requested.

## Browser/account observations

- ChatGPT: current browser redirected to the signed-out login page. No connection, scan or submission performed.
- M6 acceptance: stable site loaded successfully but shows Demo access / Access code. Existing session is signed out. Latest deployed source is behind current M6 head, so logging into that deployment would not satisfy current exact-head acceptance.
- Vercel connector lists configured M6 Sandbox credential names. Sensitive values were not printed or copied into source. No OpenAI/Anthropic/Gemini credential was available in the workspace. No other product's live credential was reused.

Remaining work is enumerated in COMPANY-LAUNCH-MILESTONE-AUDIT.md, COMPANY-LAUNCH-SECURITY-REVIEW.md and COMPANY-LAUNCH-MANDATE-COVERAGE.md. These documents deliberately retain PARTIAL milestones.

## Final verified CI checkpoint — 2026-10-29

Exact tested head: `5e7dd5b30c0cbc935dd1f43bf747ed4f37701fc3`. GitHub Actions run [40803546231](https://github.com/VictorCyberDev/PayFlow/actions/runs/40803546231) completed **SUCCESS**. Jobs `verify`, `console`, and `console-e2e` all succeeded. The workflow checks out the exact PR head and runs native PostgreSQL integration/coverage and authenticated browser E2E, in addition to public company browser QA. The earlier E2E failure was an outdated test waiting for collapsed raw Proof; commit 5e7dd5b opens the progressive disclosure before inspecting it. No retry was used to conceal the failure.

The local no-database counts above remain local counts; they are not substituted for native CI totals. Detailed native counts were not retrieved, so no total is invented. This documentation update does not alter runtime code. The report intentionally names the validated checkpoint rather than claiming its own future documentation commit was already tested. Full company status remains PARTIAL for the enumerated engineering/commissioning work.

## Retrieved native CI metrics

The coverage-summary artifact from run 40803546231 confirms **1,892 passed / 0 failed / 3 skipped** of 1,895 total, and **823/823 PostgreSQL integration tests passed** with none skipped. Native coverage: 90.41% statements/lines, 90.01% functions, 86.39% branches. This does not establish external model, provider or production acceptance.

The artifact's old `headSha` field used GitHub's event GITHUB_SHA (a synthetic PR merge id) despite explicit PR-head checkout. The current workflow corrects that field to `git rev-parse HEAD` and preserves the event SHA separately, so future receipts identify the actual tested checkout. The run API identifies the validated PR head as 5e7dd5b30c0cbc935dd1f43bf747ed4f37701fc3.

## Clock-dependent CI defect corrected

Run 40843418969 failed the stdio subprocess test after the fixed benchmark Authority expired at 2026-10-29T03:00:00Z. Earlier green run 40803546231 occurred before that expiry. This was a test-clock defect, not permission to weaken the kernel or retry blindly. A test-only Node Date preload now fixes the subprocess clock to its fixture timestamp; a second subprocess runs at the actual expiry boundary and must report fits=false. Production expiry code is unchanged. No result from the failed head is called green.

Local post-staging validation also exposed generated Next export chunks being linted/formatted as source. The source checks now ignore generated public/_next and export output, while tracked payer-return source remains checked. Staging clears only its generated _next directory before copying a fresh export, avoiding stale build-chunk accumulation. No deployment is involved.
