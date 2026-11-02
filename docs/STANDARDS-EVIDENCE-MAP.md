# Standards and protocol evidence map

Checked against current protocol families on 2026-10-28. This is an interoperability/control map, not a certification statement.

| Area           | PayFlow implementation evidence                                                               | Status / boundary                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| MCP            | Five small tools, auth gate, read/write separation, secret-output guard, tool-selection evals | Implemented locally against MCP 2026-07-28 concepts; registry/public endpoint external                |
| A2A            | v1 Agent Card, authenticated interface model, delegation attenuation, replay-bound contexts   | Implemented locally; external interoperability endpoint/pilot not claimed                             |
| OpenID AuthZEN | PDP/PEP-style authorization concepts map to Gateway/Trust Kernel decisions                    | Mapping only; AuthZEN never replaces financial Authority semantics                                    |
| AP2            | Mandate/receipt concepts can be normalized into candidate action/evidence inputs              | Adapter boundary; external AP2 assertion cannot widen Authority                                       |
| ACP            | Checkout/session material is commerce context normalized before Authority evaluation          | Adapter boundary; merchant/payment stack remains external                                             |
| UCP            | Commerce capabilities can be transported over REST/MCP/A2A into PayFlow adapters              | Adapter boundary; protocol capability is not financial permission                                     |
| OAuth/OIDC     | Trusted upstream token claims map to bounded external-agent access/scopes                     | Compatible model; token signature verification remains an upstream IdP/resource-server responsibility |

## Control interpretation

Implemented controls include deterministic authorization, server-loaded Authority state, delegation attenuation, replay resistance, one-time/bounded execution grants, provider-effect evidence, UNKNOWN/reconciliation and read-only verification. Items such as formal certification, legal compliance opinions, standards-body endorsement or production partner conformance are explicitly outside this local evidence map.
