# Financial Authority Schema v1

`spec/financial-authority-v1.schema.json` is the public, transport-neutral expression layer for bounded financial Authority. It captures principal, agent, action scope, money/currency bounds, counterparties, conditions, validity, delegation references, runtime revalidation requirements and Proof references.

The schema is not the Trust Kernel. A conforming document is still untrusted input until issuer trust, signature/evidence, revocation, delegation attenuation and current runtime conditions are evaluated.

Internal storage may evolve independently so long as published compatibility and financial semantics are preserved.
