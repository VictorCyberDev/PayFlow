# V4 recovery checkpoint

Written so a later session can resume without re-deriving anything. Updated at
the end of the V4 session.

## Where the work is

| Field        | Value                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Branch       | `claude/busy-fermat-xsieoy`                                                                                               |
| Pull request | VictorCyberDev/PayFlow#89                                                                                                 |
| Base         | `main` @ `fcad674`                                                                                                        |
| Commits      | `96ab0fa` consumer product + partner endpoint · `119dc35` ledgers · `2f70ae0` explore · `5af4a04` sitemap + skip-link fix |

## What exists now that did not before

1. **The public app has request-time code.** `api/partner.ts` and
   `api/explore.ts`. Before this, `api/paypal.ts` was the only function and the
   configured provider keys were read by nothing.
2. **A pattern for adding more.** `src/partner/endpoint.ts` holds the shared
   guard (same-origin, body bound, best-effort rate limit, customer-readable
   refusals). A new provider surface is: a module in `src/partner/` that
   validates the provider's answer strictly, an `api/<name>.ts` that wires the
   guard to it, an entry in `vercel.json` `functions`, a path added to the
   accepted-transport list in `apps/console/tests/boundary.test.mjs`, and a
   route added to `apps/console/app/sitemap.ts` so the accessibility gate sees
   it.
3. **A consumer design system.** `apps/console/app/flow.css` plus
   `app/ui/flow.tsx`, scoped to `/`, `/try/`, `/partner/`, `/explore/` via
   `app/ui/surfaces.tsx`.

## The next executable task

**D3 — accounts on the public host.** Everything still missing (business
memory, durable plans, a real decision inbox, returning-founder journeys) waits
on it. `src/network/user-auth.ts` is a correct scrypt/session/CSRF/lockout
implementation; the work is reaching it from a static export, which means
either deploying the gateway or porting its session handling into functions
against the `DATABASE_URL` already configured on the project.

**This was deliberately not started in this session**, because it writes to the
production customer database and that is the owner's decision to authorize, not
an engineering judgement call. It is honest engineering work, not an external
blocker.

## Verification commands

```bash
npm ci && npm ci --prefix apps/console
npm run format:check && npm run lint && npm run typecheck
npm run secret:scan && npm run orphan:scan && npm run evidence:check
npm test
npm test --prefix apps/console
```

```bash
cd apps/console && npm run build && cd ..
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium node scripts/a11y-acceptance.mjs
```

The last one is the strongest single check: 48 routes x 6 widths, 288 page
checks, and it must report `"failures":0`.

## Things a later session should know

- `payflow-public` has `ssoProtection: all`. **Every** address on it, including
  `payflow-public.vercel.app`, answers 302 to a Vercel login. The public site
  is `payflow-one-kappa.vercel.app`, from the separate `payflow` project. Do
  not report the work as publicly visible until that is changed.
- `GROQ_API_KEY` and `CHANNEL3_API_KEY` have values on **production only**; the
  preview and development entries were deliberately emptied. A preview
  deployment therefore proves routing and degradation, not the live provider
  call.
- The PayPal credentials on `payflow-public` carry the comment _"Intentionally
  inert"_. Leave them that way. Payment execution belongs on the isolated
  acceptance host.
- `scripts/a11y-acceptance.mjs` and `scripts/company-browser-qa.mjs` both honour
  `PLAYWRIGHT_CHROMIUM`; in this container that is `/opt/pw-browsers/chromium`.
  `company-browser-qa.mjs` passes `--single-process --no-zygote` and crashes in
  this sandbox, so it was verified in CI rather than locally.
- The console e2e suite needs `E2E_DATABASE_URL` and a PostgreSQL service; CI
  provides both.
