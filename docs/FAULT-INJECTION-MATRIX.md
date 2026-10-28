# Fault-injection matrix

`src/network/fault-injection.ts` is the reusable orchestration contract for the mandated fault set. It does **not** turn a string table into a security claim: an injector must return an observed safe outcome plus evidence for each scenario, and any mismatch is a failure. The reference test proves matrix completeness and failure reporting; focused Trust Kernel, replay, grant, PostgreSQL concurrency, PayPal/simulator, Proof, delegation, MCP/A2A and reconciliation tests supply the deeper subsystem evidence.

The matrix covers amount/merchant/SKU/condition/quantity/currency/fee widening; Authority lifecycle; wrong agent; stale/forged assertions; replay; callback/webhook duplication and delay; concurrent execution; provider timeout/loss/ambiguity; database/crash recovery points; reconciliation races; Proof tampering/staleness; delegation/privilege escalation; duplicated A2A/MCP calls; malformed/unsupported inputs/rails; and monetary precision/extreme/cross-currency cases.

For a live-provider assurance run, bind the same harness to the sandbox adapter and durable PostgreSQL fixtures. Do not reinterpret a simulator pass as a real provider capture or independent pentest.
