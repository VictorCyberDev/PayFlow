# Protocol versions inspected for M7–M60

Checked 2026-10-28. These are interoperability adapters, not sources of financial authority.

- MCP: released specification `2026-07-28`; stateless core, per-request protocol metadata/headers, extensions and hardened authorization.
- A2A: 1.x specification line; Agent Card discovery uses `/.well-known/agent-card.json` and supports declared interfaces/capabilities.
- OpenID AuthZEN: Authorization API 1.0 is a Final Specification (approved January 2026). It is useful for PDP/PEP interoperability but cannot replace PayFlow's financial Trust Kernel.
- AP2: current public Agentic Payment Protocol specification inspected as v0.2. AP2 mandates/receipts may be mapped to PayFlow inputs/evidence, but AP2 transport assertions cannot widen an Authority.
- OpenAI Agentic Commerce Protocol (ACP): merchant/checkout interoperability; merchant remains responsible for its commerce/payment stack. ACP checkout/session material is untrusted commerce context until normalized and revalidated.
- Google Universal Commerce Protocol (UCP): open commerce protocol with REST/MCP/A2A compatibility. UCP capabilities remain transport/commerce adapters around PayFlow authority decisions.

Version-dependent adapters should be isolated and upgraded without rewriting the Trust Kernel.
