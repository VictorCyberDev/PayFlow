# M19 — Agent frameworks

Status: **COMPLETE_LOCAL**. Six adapters (three model-API wire formats and three real framework runtimes) were driven
against the real hosted Gateway with PostgreSQL. No live model was called, and no framework user has adopted this.
Model behaviour (does a real model choose and call these tools correctly?) is what M20 measures; it is not claimed here.

## What you get

One framework-neutral toolkit (`packages/sdk-typescript/src/tools.ts`) with two tools, and thin adapters over it:

| Adapter                                         | Import (`packages/sdk-typescript/src/frameworks/…`)   | Verified against                        |
| ----------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| OpenAI Responses (function tools)               | `wire.ts` `openAiTools` / `handleOpenAiCall`          | wire envelope                           |
| Anthropic Messages (`tool_use` → `tool_result`) | `wire.ts` `anthropicTools` / `handleAnthropicToolUse` | wire envelope                           |
| Gemini (`functionCall` → `functionResponse`)    | `wire.ts` `geminiTools` / `handleGeminiCall`          | wire envelope                           |
| Vercel AI SDK `ai@7`                            | `ai-sdk.ts` `aiSdkTools`                              | real `generateText` with a mock model   |
| LangChain `@langchain/core@1`                   | `langchain.ts` `langchainTools`                       | real `tool.invoke(toolCall)`            |
| OpenAI Agents SDK `@openai/agents@0.21`         | `openai-agents.ts` `openAiAgentsTools`                | real `tool.invoke(RunContext, json, …)` |

Tools: `payflow_purchase` (item, quantity, amount, currency, merchant) and `payflow_verify_proof` (a signed Proof).
Examples: `packages/sdk-typescript/examples/` (type-checked in CI, not run).

## Design rules

- **The model chooses only what to buy.** The Authority id and the agent id are fixed by the developer in
  `createPayFlowToolkit`; a model cannot name another Authority or act as another agent. Extra fields are rejected by a
  strict schema before anything reaches PayFlow.
- **Idempotency comes from the framework's own tool-call id** (OpenAI `call_id`, Anthropic `tool_use.id`, LangChain /
  AI SDK `toolCallId`, Agents `callId`), hashed with the Authority and agent into the nonce. A framework that retries
  the same call gets `REPLAY_DETECTED` and $0 moved, never a second payment. Without a call id a random nonce is used,
  so such a retry is _not_ protected; pass an id.
- **No adapter adds policy.** Each one calls the same Gateway path; the decision is the Authority's.
- **UNKNOWN stays UNKNOWN.** A lost provider response reaches the model as `effectCount: null`, `doNotRetry`. An
  unverifiable Proof is reported as UNKNOWN, never as "nothing moved".

## Equivalence evidence

`tests/m19-frameworks.integration.test.ts` runs, in every adapter, the same scenarios against a real host: in-policy
purchase (paid once, one provider capture), retry of the same call (replay, still one capture), over-limit (DENY, no
provider contact), a hostile extra argument (never sent), Proof verify and forged-Proof verify, and a lost provider
response. A final test asserts the normalised outcomes of all six are deeply equal.

Mutation checks: making the nonce ignore the call id fails every adapter; dropping the call id in the LangChain adapter
alone fails exactly LangChain and the equivalence test.

## Framework behaviours worth knowing (observed)

- Vercel AI SDK and LangChain validate arguments themselves and refuse a call with an unknown field before our code runs.
- The OpenAI Agents SDK requires strict mode for Zod parameters, which cannot express an open JSON Proof object, so
  `payflow_verify_proof` uses a JSON Schema and validates with the shared schema inside the tool.

## Not claimed

- No real model was run through these tools (that is M20, and needs a model key and budget).
- No Python, Java, LlamaIndex, CrewAI, AutoGen or Mastra adapter exists. The Python SDK predates this and has no toolkit.
- Framework versions are pinned in `package-lock.json` as dev dependencies; compatibility with other versions is untested.
