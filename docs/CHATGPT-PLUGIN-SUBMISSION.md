# ChatGPT / OpenAI submission

Status: **PARTIAL**. Publication state: **not submitted**. Not connected, scanned, approved or published.

The prior COMPLETE_LOCAL classification was incorrect. A portable manifest, stdio server and schema conversions did not complete authenticated ChatGPT integration.

Checked official OpenAI documentation on 2026-10-29. Apps SDK URLs currently redirect to the Plugins documentation. A portable package can contain root plugin.json, mcp.json, optional skills and assets. OpenAI listing fields live under extensions.com.openai.interface. Public submission requires a real remote HTTPS MCP connection and actual automated scan/review. Fixed API-key declarations do not provide the portal's end-user OAuth connection flow.

## Present

- Real local HTTP MCP handler and two official SDK client connections.
- Five tools, read/write hints, scope checks, strict outer arguments and safe error/output handling.
- Local public website, contact, legal drafts and brand assets.
- Portable listing metadata; mcp.json.example uses a deliberately invalid hostname and OAuth/CIMD example.
- Model request/tool-result loops with recorded-response tests and separate evaluation capability.

## Not ready for upload

No final mcp.json is generated because no commissioned endpoint exists. Listing URLs target the existing intended PayFlow origin but these new routes are NOT yet deployed. Legal pages are drafts. This package must not be uploaded as launch-ready.

Internal work: commissioned OAuth issuer with S256 PKCE/resource binding; tenant-bound durable services; distributed rate/replay controls; exact output schemas and final tool metadata; package/schema validation; full integration acceptance. External work: eligible publisher login, real ChatGPT connection, prompt evaluation, submission, review and approval. The browser is signed out of ChatGPT in this session.

## Privacy and safety

Never return provider credentials, bearer tokens, signing keys or raw financial records. Verify/check tools do not request execution. request_authorized_action submits to the deterministic boundary; it cannot grant Authority. UNKNOWN requires lookup of the original attempt.

Sources: https://developers.openai.com/plugins/build/plugins , https://developers.openai.com/plugins/build/auth , https://developers.openai.com/plugins/deploy/connect-chatgpt , https://developers.openai.com/plugins/deploy/submission .
