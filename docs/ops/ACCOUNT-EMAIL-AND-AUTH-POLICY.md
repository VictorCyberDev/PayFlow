# Account email, sign-in limits and unverified accounts — policy and operations

Status: implemented and tested locally (PostgreSQL + real HTTP). **Nothing here is deployed.** No real email has been sent by this system; delivery needs the owner's Resend key and a verified sender (see "Owner steps").

## The chain, end to end

Protected environment → `PAYFLOW_RESEND_API_KEY`, `PAYFLOW_EMAIL_FROM`, `PAYFLOW_EMAIL_FROM_VERIFIED=true` → `parseHostedConfig` (validates; refuses a half-set pair, a malformed key, a header-injecting sender, Resend's shared `@resend.dev` address, a non-https origin) → `createHostedConsole` builds `resendSender` → hosted Gateway `emailSender` → durable `email_outbox` (PostgreSQL) → `GET/POST /v1/admin/ops/automation/run` (scheduler secret or operator token) → `sweep()` then `drain()` → Resend → recorded outcome.

- The key is held in a closure, sent only as an `Authorization` header, never logged, never in an error message, never read back. Redirects are never followed; the provider's reply body is never read, so nothing it says reaches a log or a customer.
- `PAYFLOW_EMAIL_FROM_VERIFIED=true` is the owner's attestation that the sending domain is verified with Resend. The code cannot check this from inside the request path; it refuses to start a sender without the attestation.
- With **no** sender configured: requests are accepted and queued; every response says `emailDelivery: "NOT_CONFIGURED"`; the run reports `senderConfigured: false`. Nothing claims an email was sent.

## Token and email are one commit

`issueAndQueue` runs in one transaction: advisory lock per (account, purpose) → check for a message already waiting → retire the earlier link → store the new link's digest → insert the outbox row (which stores the digest, never the token, and the link's expiry). Failure at any write rolls back all of it; the earlier link keeps working. Tested by injecting a failing trigger at each of the three writes.

- A message already `QUEUED`/`SENDING` (unexpired), or any message made in the last 60 seconds, means a new request makes nothing new. Eight simultaneous requests produce one message and one live link.
- A message whose delivery is `UNKNOWN` does **not** block a new request: after the 60-second cooldown a fresh link is issued and the old one retired, so one lost message never locks a person out.
- Per address, at most 5 recovery/verification messages an hour (shared limiter). If the limiter cannot answer, no mail is made, and the reply is identical.

## Outbox states and crash recovery

`QUEUED → SENDING (lease 2 min) → SENT | FAILED | UNKNOWN`; `429` goes back to `QUEUED` (at most 5 tries, then `FAILED`).

- A worker that claims a message holds a lease. `sweep()` (run before every drain) turns a message still `SENDING` after its lease into `UNKNOWN`: the worker died somewhere between claiming it and recording the answer. We cannot tell whether the provider has it. **It is never sent again.** Resend offers no lookup by idempotency key, so there is no provider outcome lookup; this is stated, not hidden.
- A late answer from a slow worker may still settle an `UNKNOWN` message to `SENT` (body then erased).
- Tested crash points: after claiming and before the provider call; after the provider call and before recording; with the sweep and a real automation run afterwards. In every case the provider is called at most once.
- Expiry: a `QUEUED` message past its link's life becomes `FAILED` with its body erased; an `UNKNOWN`/`FAILED` message past expiry has its body erased. An erased body can never be written back (trigger). `SENT` and `FAILED` erase the body at once.
- Operator visibility: `GET /v1/admin/ops/email-outbox` (operator token only) returns counts by state, age of the oldest queued message, and the messages needing attention (`UNKNOWN`, `SENDING`, recent `FAILED`) with **masked** recipients. It never returns a body, a link, or a token digest.

## Who can read recovery material

- Customer endpoints: none returns a body or a link (tested against `/me`, `/agents`, audit and the operator route with another tenant's session).
- Database roles: `payflow_readonly` has **no access** to `email_outbox`, `user_tokens` or `user_sessions` and cannot read `password_hash`, `session_hash`, `csrf_hash` or `token_hash` anywhere (`db/roles/least-privilege.sql`; tested as a real login role). `payflow_runtime` needs the tables to work but cannot delete from the outbox (trigger).
- At rest: bodies live only while a message is waiting or unclear and are erased on SENT/FAILED/expiry. There is no application-level encryption of the body; Neon encrypts storage and backups, and a backup taken while a message is waiting would contain the link until it expires (30 min for reset, 24 h for verification). This residual is accepted and recorded, not removed.

## Rate limits on account actions and the degraded policy

Signup, login, verification confirm, reset request and reset confirm share a per-address limit of 20 a minute (PostgreSQL limiter). Repeated wrong passwords also lock the account (existing). Distributed addresses guessing one account hit the account lockout; distributed reset requests for one address hit the per-address mail limit and the one-message-at-a-time rule.

**If the limiter cannot answer** these actions are _not_ waved through (this used to be fail-open). A per-process bound applies: 5 a minute per address and action, and a process tracking more than 5,000 addresses refuses. So guessing is cut from 20/min per address to 5/min per instance, mail flooding makes no mail, and a limiter outage cannot be turned into unmetered guessing. The cost: during an outage, people behind one shared address may see `429` after 5 attempts in a minute. The account-lockout and token rules do not depend on the limiter.

Other `/v1` request limits keep their documented behaviour (they protect reads and a fault must not block them); the verify and sandbox-start routes were already fail-closed.

## Unverified accounts

When email delivery is configured (`requireVerifiedEmail` defaults to on exactly then), an account that has not confirmed its address may look around, draft missions, search and compare, ask for verification, and manage its own sign-ins. It is refused with `403 EMAIL_NOT_VERIFIED` **by the server** (not the banner) for every other write under `/v1/admin/` — approvals, supplier messages and contacts, quotes, orders, bookings, disputes, contracts, authorities, credentials, members, connectors — and for creating agents or issuing agent credentials under `/v1/app/agents`. Deny by default: only an explicit allow-list of side-effect-free POSTs passes. `/v1/app/me` reports `verificationRequired` and `emailDelivery`.

When no sender is configured nobody could ever verify, so the rule is off and `/v1/app/me` says so; that is a property of an environment with no email, not a waiver for production.

Bearer-token routes (agents, member keys) are unaffected: they are not browser accounts.

## Owner steps (nothing here can be done from this repository)

1. Verify a sending domain in Resend and choose the sender address.
2. Put `PAYFLOW_RESEND_API_KEY`, `PAYFLOW_EMAIL_FROM` and `PAYFLOW_EMAIL_FROM_VERIFIED=true` into the **payflow-public** project's protected environment through the Vercel dashboard (not the repository, not chat).
3. Ensure `CRON_SECRET` is set so the scheduled `automation/run` drains the outbox, and that `PAYFLOW_M5_ORIGIN` is the https address of the app.
4. After deployment, run one controlled test message to an address you own and confirm receipt. Until that is done the status is **delivery unproven**.
