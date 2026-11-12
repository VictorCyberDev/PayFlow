# V4 external blockers

Only items that are genuinely outside this session's reach belong here.
Difficult engineering is not a blocker (mandate §39, Condition B). Each item
names the exact thing that would unblock it.

| ID  | Item                                                                         | Status               | What would unblock it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-1 | `payflow-public.vercel.app` answers 302 to Vercel SSO for anonymous visitors | **WAITING_APPROVAL** | The owner changes the project's Deployment Protection (it is currently `all_except_custom_domains`, which gates the `*.vercel.app` address), or attaches a custom domain. This is a settings change on an existing project, no new cost. Until then the public site is `payflow-one-kappa.vercel.app` from the separate `payflow` project.                                                                                                                                                                             |
| E-2 | Live PayPal money capture from the public app                                | **WAITING_APPROVAL** | Explicit owner authorization. The mandate itself forbids enabling it silently (§20.9, §35). The credentials on this project are marked inert by their own comments and must stay that way.                                                                                                                                                                                                                                                                                                                             |
| E-3 | Real talent discovery                                                        | **RESOLVED**         | Done without a new account. GitHub's public user search returns real people who have themselves set `hireable`, which is consent the person gave on their own profile — no fixtures, no stock photos, no profile shown that its owner did not publish. `src/partner/talent.ts`. One caveat stands: this session's proxy refuses `/users/{login}`, so profile enrichment is unavailable here and the surface degrades to an empty list rather than inventing one. It works from a deployment, which is not proxy-bound. |
| E-4 | Flight booking                                                               | **RESOLVED**         | The owner supplied Duffel credentials. Real search, offer comparison, itinerary selection, and booking in sandbox, with the airline's own reference returned. A live token may search but is refused a booking from this surface, the price is re-read from the provider before ordering, and an expired offer is not bookable. `src/partner/flights.ts`, `docs/v4/D-FLIGHTS-AND-TALENT.md`. Hotels and workspaces remain unbuilt: no provider account for either.                                                     |
| E-5 | Authorized outreach email                                                    | **BLOCKED_EXTERNAL** | A verified sending domain, a consented sender identity, and opt-out handling. Sending on a founder's behalf without these is spam (§12.1).                                                                                                                                                                                                                                                                                                                                                                             |
| E-6 | Verifying the live Groq path                                                 | **WAITING_PROVIDER** | A production deployment. The project's `GROQ_API_KEY` has a value on `production` only — the `preview` and `development` entries carry the comment _"Development/Preview entries neutralized"_. So `/api/partner` can be proved end-to-end only after a production deploy, and that deploy is E-1's decision. Everything the endpoint does with a model answer is covered by tests that inject the model.                                                                                                              |
| E-7 | The planning model serves about one plan per several minutes on this account | **WAITING_APPROVAL** | An upgrade of the Groq account. The planning model's throughput for this account is far lower than this session could work with, and **where the ceiling actually sits is not yet known** -- see below. The owner opening <https://console.groq.com/settings/limits> would settle it in one look, and granting this session Vercel log access would make the already-merged diagnostic readable. Raising the limit costs money, so it was not bought.                                                                  |

## E-7 in more detail

This is the item behind the defect reported as "the same goal planned once and
failed the next".

### What is established

The failure is rate-related, and the provider is the one refusing. The response
body is the `MODEL_UNAVAILABLE` message, not `MODEL_NOT_CONFIGURED`, so the key is
present and Groq is answering 429 or 5xx. A single request after several minutes of
silence succeeds in under two seconds; requests sent while the endpoint has been
busy fail in 200-400ms, which is too fast to have reached the model at all. That
combination -- recovery after idle, instant refusal under load -- is a rate limit.

The first experiment, run against the deployed site with one identical goal string:

| Arm                          | Result        |
| ---------------------------- | ------------- |
| 8 requests, 20 seconds apart | 8 / 8 succeed |
| 8 requests, concurrent       | 7 / 8 succeed |

Identical input, different outcome as a function of request rate. That rules out the
model failing on the content, which is what the original bug report suspected.

### The measurement that settles the symptom

After **ten minutes of complete silence**, three requests one minute apart:

| Request             | Result         |
| ------------------- | -------------- |
| 1st, after 10m idle | **200**, 1.85s |
| 2nd, 60s later      | 503, 0.48s     |
| 3rd, 60s later      | 503, 0.47s     |

One plan, then nothing. Sixty seconds of spacing does not restore it, and the
failures come back in under half a second, far too fast to have reached the model.

**This is the reported defect, exactly.** "The same goal planned once and failed the
next" was never intermittent randomness and never anything about the goal: the
account's planning budget currently allows roughly one plan, then refuses for
minutes. A judge clicking twice would see it the second time.

It also means the retry shipped for this **does not fix the reported symptom**. It
recovers a collision when the provider asks for a short wait, which is the right
behaviour and is covered by tests. Here the provider asks for longer than the cap,
so PayFlow declines immediately -- which is why the failures return in 0.47s. The
cause is the ceiling, and no amount of client-side retrying moves a ceiling.

### What is NOT established, and a correction

An earlier version of this entry claimed the ceiling is **30 RPM / 8K TPM**, giving
"about eight plans a minute". **That figure should not be relied on.** It was read
from Groq's published rate-limit table, which states those are the base limits _for
the Developer plan_. This account's plan was never confirmed, and a free tier is
lower. Citing another plan's numbers as this account's was a mistake.

The observed throughput is far lower than that table would predict -- about one
plan per several minutes, against a predicted eight per minute. Three explanations
fit, and from outside the account they cannot be told apart: a lower tier than the
table shows, a longer-period quota (RPD 1K / TPD 200K) largely spent, or another
consumer on the same organization key. The owner can see which in one look at
<https://console.groq.com/settings/limits>.

A further caution about the measurements above: sustained probing is itself load.
The "8/8 when paced" arm ran against a fresh window; later paced runs at lower rates
failed, because by then hours of testing had been consuming the same budget. Any
figure in this document that came from a burst test should be read as a lower bound
taken under unknown background load, not as the product's capacity.

### What was fixed in code

A 429 now causes PayFlow to wait the interval Groq states in `retry-after` and ask
once more, bounded by half the request's own 20-second budget and abandoned the
moment the deadline passes. The same applies to a provider 5xx and to a generation
that missed its own schema. A bad key and a genuine refusal are never retried.

The retry is only defensible because this call has no side effects: `governPlan`
re-derives every total and stamps authorization `NONE`, so a second attempt cannot
double anything.

Its limits are worth stating plainly. A retry recovers an isolated collision, which
is the common case for one founder clicking once. It cannot raise a ceiling, and
under sustained saturation it doubles the calls a failing request makes, which
deepens the saturation rather than relieving it. Where the provider asks for longer
than the cap, PayFlow declines immediately instead of retrying, which is why
failures under load return in milliseconds.

### What was NOT done, and why

Lowering `max_completion_tokens` looked like an obvious throughput win, and an
earlier note in this work guessed it was the cause. The published rate-limit
documentation does not support it: a 4K reservation per request would have broken a
concurrent burst on the 2nd request, not the 8th. The guess was dropped rather than
shipped, and the reservation is unchanged.

### The observability hole behind all of this

Every cause above reaches the browser as the same 503 and the same sentence, which
is correct for a founder and useless for diagnosis. The diagnostic that distinguishes
them (`PAYFLOW_MODEL_PROVIDER_FAULT`, merged in #91) writes to Vercel's runtime logs,
and this session's token is refused by both `get_runtime_logs` and
`get_runtime_errors` with 403. So the one instrument built for this question cannot
be read from here, which is why the account's real limits are still unknown. Either
granting log access or reading the limits page directly would close it.
