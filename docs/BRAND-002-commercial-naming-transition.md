# BRAND-002 — Commercial naming transition

Status: architecture decision; no legal-clearance claim.

`PayFlow` remains the repository/project codename. Financial semantics must not depend on that literal name. Public product copy, package coordinates, hostnames and marks should be supplied through a replaceable brand configuration layer while protocol identifiers remain versioned technical identifiers.

## Naming risk

`PayFlow` is descriptive and may conflict with existing marks, products or domains. This repository does **not** claim trademark clearance, registrability or domain availability. A commercial rename requires real legal and market clearance.

## Transition architecture

- Preserve repository history, accepted migrations, Authority identifiers, Proof hashes and API compatibility.
- Introduce aliases at presentation/package boundaries rather than rewriting historical evidence.
- Keep protocol/schema identifiers versioned and semantically stable even if the commercial name changes.
- Support a compatibility period in which old SDK/package names can point to the same versioned API with deprecation notices.
- Redirect web/docs domains only after a replacement domain is controlled and tested.
- Preserve signed-evidence verification by key/issuer identity and version, not by logo text.

## SDK/package transition

New packages should expose stable financial-authority concepts. If package coordinates change, publish compatibility shims only after ownership of both coordinates is established. Never silently republish a materially different protocol under an old version.

## Domain transition

Use HTTP redirects for human documentation and explicit issuer-metadata/key-discovery updates for machine endpoints. Cache lifetimes and key-rotation windows must overlap long enough that already-issued Proof remains verifiable.

## Required external step

Before a commercial rename is announced, perform professional trademark clearance in intended markets and independently confirm domains/package handles. No availability is inferred from repository research.
