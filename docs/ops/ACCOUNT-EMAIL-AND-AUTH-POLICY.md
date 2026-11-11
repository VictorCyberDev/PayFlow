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

## Invitations and organizations (B3, migration 062)

- **Who can invite:** only a member the server lets manage members (`member:manage`: OWNER today). The inviter's own email must be confirmed when email delivery is configured. At most 20 invitations an hour per organization; if the limiter cannot answer, no invitation is made. An invitation can never grant OWNER (database check and schema).
- **What an invitation is:** one row per (organization, address) while open; inviting again withdraws the earlier one in the same transaction and queues a new email (template `INVITE`, 7 days). The token is random, stored only as a digest, and carried in the URL fragment of the emailed link; the page removes it from the address bar and keeps it in memory only.
- **Who can accept:** the signed-in account whose address **equals** the invited address, **and** that address must be confirmed. Every other case (unknown, used, withdrawn, expired, or someone else's link) is the same `410 INVALID_OR_EXPIRED`, so a wrong holder learns nothing; only the right address with an unconfirmed email is told to confirm. Acceptance is one transaction under a row lock: four simultaneous accepts make exactly one member.
- **Preview:** `POST /v1/app/invitations/preview {token}` (public, Origin-checked, rate-limited) shows the organization name, the role and a masked address; nothing else.
- **After joining:** the person belongs to two or more organizations. `GET /v1/app/organizations` lists them and `POST /v1/app/organizations/switch` re-binds the **current session** to one of the person's own memberships (it cannot reach anyone else's). The role in force is the role in the organization currently selected.
- **Audit:** created / revoked / accepted are recorded with the role only; the address and the token are never written to the audit trail.
- **Database:** `organization_invitations` is excluded from `payflow_readonly` entirely; finished invitations are immutable and none can be deleted.
- **Not covered:** changing an existing member's role, removing a member, and transferring ownership are not built; a member cannot yet leave an organization. Invitation email delivery is as unproven as all email until the owner supplies a Resend key and verified sender.

## Members, your data, and closing an account (B4, B5)

- **Members (B4):** `GET /v1/app/members` lists active people; addresses are shown only to someone who can manage members. Changing a role, removing someone and leaving use the same advisory lock as the existing member revocation, so the last active owner can never be demoted, removed or leave, even when two owners act at once. A role change applies to the person's live session on their next request. Removal and leaving end that member's sessions.
- **Export (B5):** `POST /v1/app/account/export` with the password returns the person's own account, memberships, sign-in history (no digests) and accepted invitations as a download. It never contains another person's data, a secret or a digest. Wrong password: `403`; five wrong attempts in 15 minutes are refused with `429` even if the next one is right (the same bound as password guessing).
- **Closing (B5):** `POST /v1/app/account/close` needs the password **and** the typed confirmation `CLOSE MY ACCOUNT`. It is refused (`409`) while the person is the only owner of an organization that still has other active members. Otherwise, in one transaction: all their memberships are revoked and renamed "Former member", all sessions end, unused tokens and any queued or unclear mail to the address are erased, open invitations to the address are withdrawn, and the account keeps only its pseudonymous id (the audit trail refers to it): the address becomes `deleted-…@deleted.invalid`, the name "Deleted account", the password an unknown random one, the status DISABLED. The address can then be used for a new account.
- **What closing does not do:** an organization where the person was the only active member stays in the database with nobody able to act on it (its records are kept for the audit trail; everything is Sandbox). Organization records, audit events and Proof are not deleted. There is no grace period or undo. Backups made before closing still contain the earlier data until they expire.
