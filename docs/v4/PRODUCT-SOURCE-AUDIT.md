# PayFlow V4 — Product source audit

Status: **Phase 0 complete.** Written from direct inspection of the repository at
`fcad674` and from live probes of the deployment, not from earlier reports.
Date of inspection: 2026-11-12.

Every claim below names how it was verified. Where a previous document and the
source disagree, the source wins and the disagreement is recorded.

---

## 1. The finding that reorders everything else

**The deployed customer application has no backend, and the customer
application is not publicly reachable.**

Three separate facts combine into that single conclusion.

### 1.1 The canonical frontend is `apps/console`, exported as static HTML

`apps/console/next.config.ts` sets `output: "export"`. `vercel.json` sets
`buildCommand: "npm run build:company"` and `outputDirectory: "public"`;
`scripts/stage-company.mjs` copies `apps/console/out` into `public`. So the
artifact Vercel serves is a **static export** — there is no Next.js server, no
route handler, no server component executing at request time.

`app-ui/` (5,339 lines of `app.js`) is a _second_ customer application. It is
not part of the Vercel artifact at all: `scripts/embed-app-ui.mjs` compiles it
into `src/network/app-assets.generated.ts`, and `src/network/hosted-gateway.ts`
serves it. That gateway is a Node server. **No Vercel project deploys it.**

This confirms audit item (I) in the mandate — two interface generations
coexist — and resolves which is which:

| Surface                                     | Where it lives                    | Reachable in production        |
| ------------------------------------------- | --------------------------------- | ------------------------------ |
| Marketing + console (Next.js static export) | `apps/console/`                   | Yes, via the `payflow` project |
| Customer app (`/workspace/`)                | `app-ui/` via `hosted-gateway.ts` | **No. Not deployed anywhere.** |

`apps/console/lib/availability.ts` states this in its own comment and sets
`CUSTOMER_APP_URL = null`, so the site's "Sign in" link points at `/preview/`,
a private-preview page, rather than at an application.

### 1.2 Only one serverless function exists on the site that serves the public

**Corrected after deploying to both projects.** The first version of this
section read the root `vercel.json` and assumed it governed `payflow-public`.
It does not, and the difference matters:

| Project          | Root directory  | Config that governs it   | Serves                                               |
| ---------------- | --------------- | ------------------------ | ---------------------------------------------------- |
| `payflow`        | repository root | root `vercel.json`       | `payflow-one-kappa.vercel.app` — **the public site** |
| `payflow-public` | `hosting/m6`    | `hosting/m6/vercel.json` | nothing reachable; SSO-gated                         |

Proved by headers rather than inference. A preview on `payflow-public` returns
the CSP from `hosting/m6/vercel.json` verbatim, plus
`access-control-allow-origin: https://payflow-m6-acceptance.vercel.app`, which
appears in that file and nowhere else. The live public site returns the root
`vercel.json` CSP, the one that names the PayPal hosts.

Two consequences:

1. **On `payflow-public`, no root-level `api/*` function can ever be reached.**
   `hosting/m6/vercel.json` rewrites `/api/(.*)` to `/api/host`, so every API
   path is swallowed by the M6 acceptance host. That host currently answers
   `503 {"status":"UNAVAILABLE"}` — `hosting/m6/api/host.ts:24`, the branch
   taken when `parseHostedConfig` throws. It is misconfigured on that project.
2. **On `payflow`, `api/paypal.ts` is the only function**, it is a read-only
   payer-return page, and it reads `PAYFLOW_STATUS_DATABASE_URL` — a variable
   that is not set. So it falls back to `STATUS_STORE_UNCONFIGURED`. Verified
   live: `payflow-one-kappa.vercel.app/paypal/status` returns that function's
   own "Payment status unavailable" JSON, which also proves `api/*.ts` really
   is routed and executed in this configuration.

The V4 endpoints target the root `vercel.json`, so they land on the project
that actually serves the public. They are unreachable on `payflow-public`, by
that project's own rewrite.

### 1.3 The provider credentials are configured but nothing reads them

The `payflow-public` Vercel project has production values for `GROQ_API_KEY`,
`CHANNEL3_API_KEY`, `DATABASE_URL` (restricted Neon role
`svc_public_runtime_v2`), `PAYFLOW_M5_BOOTSTRAP_KEY`, `PAYFLOW_M6_SIGNING_KEY`
and PayPal Sandbox credentials.

**No code in the deployed artifact reads any of them.** The Groq integration
lives in `src/missions/draft-assistant.ts` and `src/intent-model.ts`; the
Channel3 integration lives in `src/missions/channel3-provider.ts`. Both are
server-side modules reachable only from the gateway, which is not deployed.
`apps/console/tests/boundary.test.mjs` _enforces_ that no browser file imports
from `/src/` or touches `process.env` — correctly, but the consequence is that
the shipped app cannot reach those providers at all.

The PayPal variables carry the project comment _"Intentionally inert: PayPal
Sandbox credentials retained on isolated payment acceptance host, not public
app"_, and `PAYFLOW_M6_DEMO_AGENT_DISABLED=true`. That separation is correct
and must be preserved (mandate §20.9). It is not the cause of the gap above.

### 1.4 Deployment reachability, measured

Anonymous `curl`, no cookies, 2026-11-12:

| URL                                               | Result                                              |
| ------------------------------------------------- | --------------------------------------------------- |
| `https://payflow-public.vercel.app/`              | **302 → Vercel SSO login.** Not publicly reachable. |
| `https://payflow-one-kappa.vercel.app/`           | 200. This is the live public site.                  |
| `https://payflow-one-kappa.vercel.app/app/`       | 200 (console shell; demo-code gated)                |
| `https://payflow-one-kappa.vercel.app/workspace/` | 404                                                 |

The mandate names `payflow-public.vercel.app` as the "existing customer
deployment". **It is not one.** The project has a READY production deployment
of `main@fcad674`, but the project's deployment protection gates its
`*.vercel.app` address behind Vercel SSO, so no judge, founder or customer can
open it. The site that actually serves the public is
`payflow-one-kappa.vercel.app`, from the separate `payflow` project — which is
exactly what `apps/console/lib/site.ts` documents.

**Owner decision required (external blocker E-1):** which project is the
customer product, and is its protection to be lifted. This is a Vercel
_settings_ change on an existing project, not new paid infrastructure.

---

## 2. Capability-by-capability audit

"Reachable route" means: a route an ordinary visitor can open on the live
public site today. "Backend" means: code that runs at request time in the
deployed artifact.

| #   | Capability (mandate §)                              | Exists in source                                                                       | Reachable route    | Backend               | Verdict                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Consumer homepage (§9)                              | `app/ui/company.tsx`                                                                   | `/`                | n/a (static)          | **Wrong product.** Headline is "Financial authority for autonomous systems"; the four cards are Developer, Enterprise, Verifier/Merchant, Proof. Infrastructure-first, per mandate item (H).                                              |
| C2  | Zero-code onboarding (§7)                           | `app/ui/access.tsx`                                                                    | `/app/`            | none                  | **Missing.** The only way in is a shared **bootstrap access code** typed into a password field. No signup, no sign-in, no reset.                                                                                                          |
| C3  | Real user accounts (§7)                             | `src/network/user-auth.ts` — scrypt, sessions, CSRF, lockout, MFA hooks                | none               | not deployed          | **Built but unreachable.** Genuine quality code stranded behind the undeployed gateway.                                                                                                                                                   |
| C4  | One-click judge demo (§8)                           | none                                                                                   | none               | none                  | **Missing entirely.**                                                                                                                                                                                                                     |
| C5  | AI business partner (§10)                           | `src/missions/draft-assistant.ts` (Groq, strict Zod schema, injection-resistant)       | none               | not deployed          | **Built, narrow, unreachable.** It suggests _wording and rough numbers for one mission form_. It is not a conversational operator. Confirms mandate item (E).                                                                             |
| C6  | Business memory (§11)                               | none found                                                                             | none               | none                  | **Missing.**                                                                                                                                                                                                                              |
| C7  | Commerce discovery (§14)                            | `src/missions/channel3-provider.ts`                                                    | none               | not deployed          | **Built, read-only, unreachable.** Deliberately returns `priceObservation: null` and `availableQuantity: null` — price and stock are UNKNOWN until normalized. That discipline is right and must survive the redesign. Confirms item (F). |
| C8  | PayPal Orders / checkout (§20.1)                    | `src/paypal.ts`, `src/paypal-commerce.ts`, `src/payment-resume.ts`                     | none in public app | deliberately isolated | **Built and substantial.** Correctly kept off the public host. Confirms item (G).                                                                                                                                                         |
| C9  | PayPal Invoicing (§20.2)                            | none found                                                                             | none               | none                  | **Missing.**                                                                                                                                                                                                                              |
| C10 | PayPal Payouts / Vault / Subscriptions (§20.3–20.5) | `src/paypal-vault-bootstrap.ts` only                                                   | none               | none                  | **Mostly missing.** Eligibility unverified.                                                                                                                                                                                               |
| C11 | Talent discovery (§15)                              | `src/missions/talent-candidates.ts`                                                    | none               | not deployed          | **Fixtures.** Confirms item (C): fictional profiles. Must never appear as live search results.                                                                                                                                            |
| C12 | Workspace / service discovery (§17.3)               | `src/missions/workspace-sources.ts`, `service-market-sources.ts`                       | none               | not deployed          | **Fixtures.** Confirms item (D).                                                                                                                                                                                                          |
| C13 | Travel / booking (§17)                              | `src/missions/booking-service.ts`                                                      | none               | not deployed          | **No real provider.** Search-only semantics at best; nothing can truthfully claim a booking.                                                                                                                                              |
| C14 | Founder launch orchestration (§18)                  | `src/missions/launch-run-service.ts`                                                   | none               | not deployed          | **Read-only sequencing.** Confirms item (B).                                                                                                                                                                                              |
| C15 | Mission execution (§18.2)                           | `src/missions/plan-run-service.ts`                                                     | none               | not deployed          | **Coordination only.** Confirms item (A): it explicitly avoids consequential actions.                                                                                                                                                     |
| C16 | Decision inbox (§19)                                | `app/views/authorities.tsx`                                                            | `/authorities/`    | none                  | **Wrong vocabulary.** Presents Authorities and revocation, not founder decisions.                                                                                                                                                         |
| C17 | Customer growth / outreach (§12)                    | none found                                                                             | none               | none                  | **Missing.**                                                                                                                                                                                                                              |
| C18 | Invoicing & get paid (§13)                          | none found                                                                             | none               | none                  | **Missing.**                                                                                                                                                                                                                              |
| C19 | Trust Kernel invariants (§23.2)                     | `src/kernel.ts`, `src/execution-grant.ts`, `src/intent-activation.ts`, extensive tests | n/a                | n/a                   | **Genuinely strong.** This is the asset the product should be built _on_, not replaced.                                                                                                                                                   |

---

## 3. What is good and must be preserved

These are not incidental. They are the reason the product is worth a redesign
rather than a rewrite.

1. **The Trust Kernel and its invariants** — exact-action binding, ceilings,
   expiry, revocation, replay protection, idempotency, UNKNOWN-state
   preservation. Backed by a large integration suite.
2. **The financial separation** — PayPal execution is deliberately not on the
   public host, and the environment comments say so. Keep it.
3. **`boundary.test.mjs`** — a real architectural test that keeps credentials,
   persistence and `/src/` imports out of the browser graph. Keep its
   substance; only its _brand_ assertions are superseded (§5.1).
4. **The provenance discipline in `channel3-provider.ts`** — refusing to
   present a search hit as a verified quote. The mandate asks for exactly this
   (§14.4, §23.3).
5. **`src/network/user-auth.ts`** — a correct password/session implementation
   that only needs a deployment to become useful.

---

## 4. What the redesign must therefore do

The gap is not "the homepage looks dated". The gap is that **the product a
visitor can reach is a static brochure for an infrastructure protocol, and the
actual software is in a server nobody deployed.**

So the V4 work has two halves, and the second is the one that was missing from
earlier plans:

**A. Change the face.** Consumer brand, consumer homepage, consumer
navigation, a one-click demo that needs no code. Deliverable on the static
export alone.

**B. Give the shipped artifact a backend.** Add server-side functions to the
_existing_ Vercel project that read the _already-configured_ production
`GROQ_API_KEY` and `CHANNEL3_API_KEY`. No new infrastructure, no new cost, no
change to the financial boundary — PayPal execution stays off this host.

Without B, every "AI partner" and "product discovery" surface would be theatre,
and the mandate forbids theatre (§34: _"Simulated results labelled as live"_ is
a rejection condition).

---

## 5. Ledger

Statuses follow mandate §32.4.

| ID  | Item                           | Status               | Note                                                            |
| --- | ------------------------------ | -------------------- | --------------------------------------------------------------- |
| E-1 | `payflow-public` is SSO-gated  | **WAITING_APPROVAL** | Owner decision; Vercel setting on an existing project.          |
| E-2 | PayPal live-money capture      | **WAITING_APPROVAL** | Explicitly out of scope without separate authorization (§20.9). |
| E-3 | Real talent provider           | **BLOCKED_EXTERNAL** | No authorized source; fixtures must stay in Sandbox demos only. |
| E-4 | Real flight/hotel provider     | **BLOCKED_EXTERNAL** | No provider account; nothing may claim a booking.               |
| E-5 | Email sending provider consent | **BLOCKED_EXTERNAL** | Outreach needs an authorized sender and opt-out handling.       |
