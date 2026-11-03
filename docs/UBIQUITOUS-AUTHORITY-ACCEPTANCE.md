# Ubiquitous Authority acceptance architecture

Status: architecture/product prerequisites complete locally; ubiquitous external adoption is not claimed.

Broad acceptance is assembled from existing primitives rather than a central dashboard: merchant Verify SDK, challenge/audience-bound presentations, issuer/key directory, key transparency, federation, Gate Mark states, portable Proof, protocol adapters, rail-neutral grants, compatibility/conformance tests and privacy-minimized verification.

A merchant can support Authority without becoming an issuer. An issuer can operate independently if its trust/key metadata is accepted. A payment rail can be replaced without changing the Authority model. An end beneficiary can therefore receive bounded financial protection even when they never open the PayFlow application.

Anti-spoofing remains mandatory: a static logo is not proof; verification must bind to live Authority state and request context.
