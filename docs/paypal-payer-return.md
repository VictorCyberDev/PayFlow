# Post-M4 payer return

M4 remains closed at accepted implementation `ae2905be5017f9517be2ca704aca5d28a12d1188`, merged in `7333f5fe5886653e9424d2a483877d9d8946d931`.

The env-backed provider previously omitted its supported payer return configuration. `PAYPAL_RETURN_URL` and `PAYPAL_CANCEL_URL` are now required together. HTTPS base URLs must contain no credentials, query, fragment or control characters. Direct provider construction retains its optional return configuration for tests and specialized internal callers.

The small Vercel Node function serves `/paypal/return`, `/paypal/cancel` and `/paypal/status`. It never constructs a provider, execution rail or resume service. The public status projection is a read-only PostgreSQL snapshot joined to the grant and reservation. A token is a strictly validated, opaque order lookup key, not payment authority. No principal, payer details, resume secret, evidence payload or signing material is returned. Responses are uncached with a no-referrer policy and restrictive CSP. Treat the return URL as a private receipt link; it is not an authenticated account history API.

`CAPTURED`, provider order/capture `COMPLETED`, a persisted capture ID/time, grant `CONSUMED` and reservation `COMMITTED` are all required to display success. Browser success claims are ignored. Cancellation is navigation only and cannot downgrade captured state. Unknown or inconsistent outcomes show unavailable. The success amount comes from the durable attempt, not a fixed $84 label or browser input.

Pending returns read status every two seconds for at most 25 seconds. A wall-clock timer aborts even a hung network request. Terminal responses stop polling. Timeout preserves uncertainty and invites a safe refresh, without claiming payment failed. Refreshing only reads; it never captures or changes expiry or historical records.

## Deployment

Configure `PAYFLOW_STATUS_DATABASE_URL` server-side with a least-privilege PostgreSQL login able to SELECT `payment_attempts`, `execution_grants` and `authorization_reservations` in the same durable PayFlow database used by execution. Grant no write privileges. It must be reachable from Vercel; the acceptance sandbox's local Unix socket database is not a hosted deployment database. Do not copy historical attempts into a new database to manufacture success.

Set both PayPal destination variables to the actual publicly accessible HTTPS deployment paths. A return destination protected by Vercel login is not ready for a payer; verify unauthenticated access without weakening unrelated project protection. Missing database configuration fails closed as unavailable. An inaccessible/unconfigured store blocks live return acceptance, even if local tests pass.

The configuration is prospective: it cannot retrofit destinations onto already-created PayPal orders. Live redirect acceptance requires a new authorized Sandbox checkout after the destination and durable store are available. Do not issue a new payment merely to make the UI appear successful.

This change deliberately does not implement approval observation, capture, reconciliation, retries or webhooks. Those remain the responsibility of the existing authorized execution path. A redirect alone cannot complete a pending transaction. If PayPal itself never performs the redirect, PayFlow cannot force-navigation of PayPal's hosted page; the independently accessible status page remains read-safe recovery.
