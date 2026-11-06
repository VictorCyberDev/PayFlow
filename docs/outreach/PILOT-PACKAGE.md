# PayFlow design-partner pilot (sandbox)

A short, bounded trial for a team that wants to see whether pre-execution authority and portable Proof fit their agent
payment flow. **It moves no real money.**

## What a pilot is (and is not)

| Is                                                                          | Is not                                                         |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Sandbox only: a simulated rail, deterministic decisions, labelled responses | Production payments, a payment licence, or a custody service   |
| 4 weeks, 2 working sessions a week, one named engineer on each side         | An SLA, an uptime commitment, or a certification (none exists) |
| Free during the pilot; any commercial terms are agreed separately           | A price list (PayFlow has no validated pricing)                |
| A written result either side can publish only with the other's consent      | An endorsement or a reference customer claim                   |

## What PayFlow provides today

- Sandbox self-serve (`POST /v1/sandbox/start`) and a hosted Gateway (once the public host is live; today it is owner-gated).
- Decision API (`/v1/actions/execute`), MCP (`/v1/mcp`), A2A (`/v1/a2a`), SDKs and framework adapters (OpenAI, Anthropic,
  Gemini wire formats; Vercel AI SDK, LangChain, OpenAI Agents SDK).
- Signed portable Proof with an explicit UNKNOWN outcome; hosted and offline verification.
- Delegation with a shared, conserved budget and revocation; offline-verifiable Authority credentials; merchant SDK.
- AgentBench v1 (17 sandbox tasks) to measure how a given model behaves with the tools. No model results are published yet.

## Weeks

1. **Map**: their agent flow → PayFlow's canonical action; agree the Authority limits to try; run the stranger journey.
2. **Integrate**: connect their agent runtime (MCP, A2A or an adapter); every decision visible with its reason code.
3. **Attack**: they try to make it wrong: over-limit, replay, widened requests, injected instructions, lost responses.
4. **Review**: results against the success criteria below; written summary; decide next step or stop.

## Success criteria (agreed up front, measured, not asserted)

- Zero payments outside the agreed Authority across all attempted attacks.
- Every UNKNOWN outcome surfaced as UNKNOWN and none retried automatically.
- Their engineer can verify a Proof independently, offline, without PayFlow.
- Time from first call to first governed decision, and the integration changes they had to make, recorded honestly.

## What we ask of the partner

One engineer and one product owner; a sandbox-safe copy of their agent flow; feedback on every confusing error; no
production data. Either side can stop at any time; sandbox data is deleted on request.

## Honest limits to state in every conversation

No production rail; no SOC 2 or other attestation; no external security review yet; no customers; the public deployment may
not be live; a security contact address is still to be published; PayFlow is a small project, not a vendor with a support desk.
