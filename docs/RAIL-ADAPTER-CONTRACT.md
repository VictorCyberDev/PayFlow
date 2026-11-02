# Rail Adapter Contract

A rail is replaceable infrastructure below the Financial Authority boundary. It may execute only an already-authorized, bounded action whose action digest, idempotency key and grant expiry match the request.

Every adapter must preserve:

- bounded one-time execution capability;
- idempotency;
- no silent action mutation;
- normalized `SUCCEEDED`, `FAILED` or `UNKNOWN` evidence;
- provider reference when known;
- effect count `0`, `1` or `null` when unresolved;
- lookup/reconciliation without creating a second effect;
- Proof inputs that distinguish simulator evidence from real provider evidence.

`DeterministicFakeRail` is a high-fidelity local simulator for conformance and fault testing. It is **not** a real second/third provider and must never be described as a real capture. M26/M27 live-provider validation remains external until authorized sandbox credentials and provider access exist.
