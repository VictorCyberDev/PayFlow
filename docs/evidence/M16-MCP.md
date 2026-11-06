# M16 — MCP: genuine client acceptance

Status: **COMPLETE_LOCAL** (real official-SDK client, real transports, real PostgreSQL host; not run against a
public deployment, no third-party hosted MCP client such as ChatGPT or Claude Desktop). Nothing here has real-world
status until `payflow-public` is deployed and a connector is exercised against it.

## What was wrong

The official `@modelcontextprotocol/sdk` client (1.32.2, newest on npm) could not connect: our `initialize` always
answered `2026-07-28`, which that SDK does not speak, so it refused with
`Server's protocol version is not supported: 2026-07-28`. The earlier hand-rolled test client hid this.

## What changed

- `src/protocols/mcp-server.ts` is dual-era, deciding per message, with no server-side session:
  - `initialize` selects the legacy handshake and negotiates among `2025-11-25`, `2025-06-18`, `2025-03-26`
    (an unknown request gets the newest legacy one, never an echo).
  - A request carrying `_meta["io.modelcontextprotocol/protocolVersion"]` is served statelessly under `2026-07-28`:
    `server/discover` (`supportedVersions`), `resultType: "complete"`, `serverInfo` in result `_meta`, `-32022`
    with `{supported, requested}`, `-32602` for missing required `_meta`, `404`/`-32601` for unknown methods.
- `src/protocols/mcp-http.ts` enforces `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (incl. the base64 form)
  against the body (`400`/`-32020`), and a modern header with no matching `_meta` is refused.
- `src/protocols/mcp-gateway.ts` + `POST /v1/mcp` on the hosted Gateway: MCP calls
  `ExecutingGateway.requestPurchase` with the caller's own credential — the same single decision path as REST.
  Only the tools the Gateway really backs are advertised (`request_authorized_action`, `verify_financial_proof`).
  When the trace can support one, the result carries a signed portable Proof (`NOT_ISSUABLE` or `null` otherwise); `verify_financial_proof` verifies it against the
  published public keys. Failures are tool results with `isError` and stable codes, never a claim of `$0` when the
  effect is unknown (`effectCount: null`, `doNotRetry`).
- Honest annotations: `request_authorized_action` is destructive and open-world; `reconcile_financial_action`
  is read-only.

## Acceptance (what actually ran)

| Test file                                      | What it proves                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/m16-mcp-clients.test.ts`                | official SDK `Client` over real stdio and real Streamable HTTP; raw-wire 2026-07-28 conformance (discover, headers, -32020/-32022/-32602, 404)                       |
| `tests/m16-mcp-gateway.integration.test.ts`    | official SDK over real HTTP into the real hosted host + PostgreSQL: ALLOW pays once with verifiable Proof; forged Proof rejected; DENY `$0`; replay; UNKNOWN; scope; identity |
| `tests/m16-mcp-server.test.ts`, `company-protocol-http.test.ts` | pre-existing handler/HTTP security cases, updated where the old behaviour was wrong                                                                  |

Mutation check: making `verify_financial_proof` always return `valid: true` fails the Proof test.

## Not claimed

- No hosted client (ChatGPT, Claude, Cursor) has connected; that needs the public deployment (owner-gated).
- The published SDK does not speak `2026-07-28`, so that revision is verified against the specification text, not
  against an independent client.
- The spec pages used do not define `ttlMs`/`cacheScope`; `tools/list` returns `ttlMs: 0, cacheScope: "private"`.
- `check_financial_authority`, `verify_authority`, `reconcile_financial_action` are not offered on the hosted Gateway
  (they have no Gateway backing yet) and are not advertised there. The sandbox server still offers all five.
- OAuth 2.1 protected-resource flow for MCP clients is not implemented on the hosted route; it uses the Gateway
  bearer credential.
