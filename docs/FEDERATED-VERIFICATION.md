# Federated verification and external issuers

PayFlow may verify Authority across independent domains without centralizing every issuer. Each domain has explicit trust state, metadata freshness and keys. Unknown, revoked or stale issuers fail distinctly.

Third-party Authority assertions never become trusted merely because they are signed. An issuer trust profile also bounds accepted schema versions, action kinds, currencies, maximum amount and delegation depth. PayFlow still performs runtime checks against the exact proposed financial action.

Key discovery exposes public material only. Rotation/revocation metadata is appendable to a tamper-evident transparency log whose hash chain can be independently checked.
