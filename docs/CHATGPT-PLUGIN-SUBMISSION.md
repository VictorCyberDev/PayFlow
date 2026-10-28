# ChatGPT / OpenAI plugin submission readiness

Status: **COMPLETE_LOCAL / BLOCKED_EXTERNAL** for public submission and publication.

Checked 2026-10-28 against current OpenAI plugin documentation. The current distribution path packages a plugin with a portable Agent Plugins `plugin.json` and an MCP server configuration; public MCP submission requires a stable public HTTPS endpoint and organization/publisher eligibility. Publication is an external review event and is not claimed here.

## Local deliverables

- Five-tool MCP vocabulary with read/write separation.
- Tool metadata that says when each tool should and should not be used.
- `readOnlyHint` on verification/check tools.
- Secret-output guard.
- Deterministic positive, negative and ambiguous tool-selection golden set.
- Portable `plugins/payflow/plugin.json`.
- `mcp.json.example` intentionally uses a non-routable replacement hostname so it cannot be mistaken for a live submitted integration.
- Framework-compatible OpenAI/Anthropic/Gemini tool declarations generated from the same vocabulary.

## External steps before submission

1. Expose the tested MCP server at one stable public HTTPS `/mcp` endpoint without violating the deployment budget.
2. Replace the example MCP URL with that real endpoint and produce the final `mcp.json`.
3. Run ChatGPT plugin connection tests and golden prompt evaluations against the real endpoint.
4. Complete publisher identity/organization requirements.
5. Upload the package, resolve automated findings, submit for review, and publish only after approval.

## Privacy and safety posture

Tool output is intentionally narrow. Do not return payment credentials, bearer tokens, private signing keys, raw provider secrets or unnecessary personal data. `verify_authority` and `verify_financial_proof` are read-only. `request_authorized_action` never means “model permission”; it submits an exact action to deterministic Authority evaluation. UNKNOWN outcomes route to reconciliation instead of retrying money movement.
