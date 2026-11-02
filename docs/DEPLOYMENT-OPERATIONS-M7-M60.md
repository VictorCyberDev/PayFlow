# Deployment and operations — M7–M60

## Local-first release rule

Vercel is not the primary debug loop. Validate format, lint, typecheck, unit/integration tests, PostgreSQL migrations, fault/benchmark tests, console/browser tests, security audit, secret scan and production builds before any remote deployment.

During the M7–M60 integration execution, Vercel preview deployments were disabled to avoid automatic branch-preview spend. Re-enable only when deliberately required by the owner/release process and after the cost ledger is updated.

## Security headers

`vercel.json` applies nosniff, frame denial, no-referrer, restricted browser permissions, same-origin opener policy and a conservative CSP. Any future third-party browser integration must be explicitly added; do not weaken policy to hide an integration defect. The current CSP permits only self-hosted scripts/images/fonts plus the explicit PayPal API/form origins needed by existing sandbox/production provider flows.

## Secrets

Store database/provider/OAuth/webhook/signing private material in environment/secret management. Logs, Proof, MCP output, verifier responses and browser bundles must never contain raw secrets. Public keys and key-status metadata are intentionally public.

## Health and recovery

Use readiness checks for database/key/provider dependencies, structured audit events with safe correlation IDs, bounded exponential retry and durable reconciliation queues. A provider timeout after possible effect becomes `UNKNOWN`; operations call provider lookup/reconciliation and must not create a replacement execution.

## Backup/restore

Back up PostgreSQL using the hosting provider's supported consistent backup/snapshot mechanism. Restore into an isolated environment first; run migration ordering and consistency checks before traffic. Verify immutable evidence/reservation/payment-attempt relationships and reconcile provider references after restore. Do not overwrite a healthy production database merely to test restore.

## Incident priorities

1. Stop new unsafe financial effects by suspending/revoking affected Authority/keys/agents.
2. Preserve immutable evidence and provider references.
3. Reconcile every ambiguous in-flight attempt before permitting retries.
4. Rotate compromised credentials using lifecycle/key metadata, not history rewriting.
5. Document affected invariants, fix SHA and regression test.

## Remote deployment gate

Deploy only when the local release-candidate report has no ordinary controllable failure and remote validation is actually needed. Do not load-test Vercel or repeatedly redeploy cosmetic changes.
