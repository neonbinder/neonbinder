# Marketplace login alerting (NEO-43)

How we find out that SportLots or BSC login has broken in production, without
waiting for a seller to complain.

The GCP half is Terraform-managed in `neonbinder_ioc` (`main.tf`, the
"Browser login alerting" sections). The PostHog half **cannot** be — there is
no PostHog Terraform provider in use — so this document is the source of truth
for it. If you rebuild the PostHog alerts from scratch, rebuild them from here.

---

## 1. Why this exists

On 2026-06-02 the SportLots login-warm on the dev browser service hung for
about ten minutes. BSC was fine; the service itself was up and answering in
0.35s. It surfaced **only** because someone happened to be running E2E at the
time. In production that would have been silent until a seller reported "I
can't connect my SportLots account."

All the data already existed. Nothing was watching it.

---

## 2. The three facts that shape everything here

Read these before changing any alert, or you will reintroduce a bug we already
fixed.

### 2.1 A hang emits no log line at all

`logBrowserOp` (`services/browser/src/observability.ts`) writes its line only
when the request handler **returns**. There is no server-side timeout on the
login path, so a wedged upstream fetch holds the request open until Cloud Run
kills it — and no `browser_login_call` entry is ever written.

**A metric on `success=false` catches 100% of failures and 0% of hangs.**

Hangs are caught by three other things instead: the Cloud Run *request* log
(`browser_login_http_status`), the Cloud Scheduler attempt deadline, and the
canary-absence policy. If you ever find yourself "simplifying" the alerting
down to the failure metric alone, you have deleted hang detection.

### 2.2 Login status codes carry meaning — and 5xx is always ours

`services/browser/src/index.ts` answers a failed login with:

| Status | Meaning | Pages? |
|---|---|---|
| `422` | The marketplace processed the credentials and refused them, or the stored secret was incomplete. **The seller's problem.** | Never |
| `502` | We could not complete the exchange — the marketplace was unreachable, returned something unusable, or served a block page. | Yes |
| `500` | An uncaught throw in our own code, or a container that died mid-request. | Yes |
| `400` | Missing or malformed credential key. | Never |

So a 5xx on `/login/*` is **always** our problem, and the hang policy matches
`499|5[0-9][0-9]`.

**This was not always true, and the history explains a subtlety.** Until
NEO-98, a bad BSC password returned `500` while the identical SportLots
failure returned `400`. The obvious rule — "alert on elevated 5xx on
`/login/*`" — was therefore wrong twice over: it paged on an ordinary seller
typo **and** never fired for SportLots. The policy had to exclude `500`, which
cost it the one thing it most needed to catch: a genuine container crash.

The fix could not be a blanket "422 on failure". `bsc-adapter.ts` returns the
identical string `"Authentication failed"` from five structurally different
failures, and only one is a rejection — so NEO-98 added
`AdapterResponse.credentialRejected`, set only where the marketplace
demonstrably refused the credentials. **Anything the adapter cannot positively
identify as a rejection returns 502 and pages.** If you add a failure branch
to an adapter and forget to classify it, it errs toward waking someone up.
That is deliberate; do not "fix" it by defaulting the flag to true.

> **Diagnosing a 422 spike?** It is seller behavior, not an incident — unless
> it is a *cliff*. A sudden collapse in 422 volume can mean logins stopped
> reaching the marketplace at all. The `browser_login_http_status` metric
> captures from `>=400`, so the 422 series is there to compare against.

### 2.3 Cloud Run's built-in request metrics have no path label

`run.googleapis.com/request_count` and `request_latencies` carry
`response_code` / `response_code_class` plus the `cloud_run_revision` resource
labels. There is no path, route, or URL dimension.

Since this service also serves `/health`, `/sites` and the `/credentials/*`
CRUD routes, any policy built on those metrics is a service-wide aggregate in
which two slow logins a day are statistically invisible. **Everything is built
on log-based metrics.** The path split comes only from
`httpRequest.requestUrl` in the Cloud Run request log.

---

## 3. Event and field dictionary

### `browser_login_call` — Cloud Run structured log

Emitted by `logBrowserOp` in `services/browser/src/observability.ts`, called
at all 8 exit points of the two login handlers in
`services/browser/src/index.ts`. Plain `console.log(JSON.stringify(...))` →
Cloud Logging `jsonPayload`, **DEFAULT severity** (there is no `severity`
field, so never filter on it).

| Field | Values | Notes |
|---|---|---|
| `msg` | `"browser_login_call"` | |
| `operation` | `login_sportlots` \| `login_bsc` | |
| `platform` | `bsc` \| `sportlots` | ⚠️ PostHog uses `buysportscards`, not `bsc` |
| `duration_ms` | number | From handler entry — **excludes** container cold start |
| `success` | boolean | |
| `status_code` | 200 / 400 / 422 / 500 / 502 | See §2.2. Tracks the status actually put on the wire |
| `error_class` | see below | |
| `challenge_detected` | boolean, **or absent** | Absent = no diagnostic captured. Absent ≠ `false` |
| `canary` | boolean | Always present |

`error_class`, from `classifyBrowserError`: `bad_key_format`, `timeout`,
`invalid_credentials`, `challenge`, `oom`, `other`, plus `missing_key` set
inline. A closed set — it never interpolates the raw error.

**`challenge_detected` is the highest-value field here.** It separates "the
marketplace is blocking us" (act now) from "the seller mistyped their
password" (do nothing). Before NEO-43 it lived only in the HTTP response body
and Cloud Monitoring could not see it.

> **It did not actually make that separation until NEO-98.** The pattern list
> behind the flag was written for NEO-18 diagnostics, where it answered the
> broad question "why did this login fail", and it included SportLots' tell
> for an ordinary bad login — `not a valid email address`. When NEO-43
> repurposed the same boolean as an *alerting* discriminator, that entry
> quietly inverted the distinction: a plain seller typo reported
> `challenge_detected=true`, i.e. "we are being blocked, page someone".
>
> NEO-98 split the list. Genuine block signals (captcha, Cloudflare, rate
> limit) stay in `CHALLENGE_PATTERNS`; rejection tells moved to
> `CREDENTIAL_REJECTION_PATTERNS` and set a separate
> `credentialRejectionDetected`. The guidance below — "`challenge_detected=true`
> means this is not a credential problem" — is now true. If you are reading
> logs from before that shipped, it is not.

> **Security:** only the `challengeDetected` boolean crosses into Cloud
> Logging. The diagnostic's `snippet` (up to 1500 chars of marketplace page
> text), `title` and `url` must never be added to a log line. There are
> explicit negative assertions in `services/browser/tests/observability.test.mjs`.

### `credential_test_failed` / `credential_test_succeeded` — PostHog

Emitted via `recordCredentialTest` in `apps/web/convex/observability.ts`, from
`authenticateBsc` and `authenticateSportlots` in `apps/web/convex/credentials.ts`.

| Property | Notes |
|---|---|
| `platform` | `buysportscards` \| `sportlots` |
| `reason` | Free text. **High cardinality — never group on it** |
| `error_class` | Low-cardinality tag. Group and alert on this |
| `duration_ms` | Convex→browser round trip, includes any 503 backoff |
| `challengeDetected`, `url`, `title`, `snippet` | Sanitized + clamped by `sanitizeLoginDiagnostic` |

`distinctId` is the Clerk user id.

**These fire on background token refresh too**, not just when a user presses
"Test" — `refreshSiteToken` and both marketplace adapters re-auth through the
same functions. One seller with a permanently-bad stored password therefore
emits a steady drip of failures forever. **This is why the PostHog alert
aggregates on unique users, not event count.**

`error_class = "timeout"` here is the *only* event-level record of a hang,
because the 60s `AbortSignal` fires while the browser service is still
running and has written nothing.

---

## 4. GCP alert policies

Terraform-managed in `neonbinder_ioc/main.tf`. **Never edit these in the
console — the next apply reverts it.** To silence, flip
`enable_browser_login_alerts` in `environments/prod.tfvars`.

Prod only. Dev deliberately has none: its E2E suites fail logins on purpose.

| Policy | Fires when | Threshold rationale |
|---|---|---|
| login failures | >2 non-caller-error failures in 5m, per platform | Excludes `invalid_credentials` / `bad_key_format` / `missing_key`. Paging on caller errors makes an alert ignored within a week. Per-platform because BSC and SportLots break independently — the originating incident was SL hanging while BSC was healthy |
| login hang | any `499\|502\|503\|504` on `/login/*` in 5m | Zero legitimate baseline. 499 = Convex's 60s abort (the seller saw a failure), 504 = Cloud Run timeout, 503 = container died. **See the caveat below — this status set is unverified.** |
| login latency | p99 > 45s over 10m, per platform | **Measured** from prod logs (2026-07-26, 30d): BSC 2.5-3.3s, SL 1.2-1.5s. But `prod-login-probe` does a real login against a **cold** revision on every push to main, at 20-30s — so 30s would false-positive on every deploy. 60s is Convex's hard abort. 45s fires while degrading, not after failing |
| canary absence | no canary login within 90m | The only alert that fires when the service is **hung** rather than erroring. Keep at ~3× the canary interval (3 missed runs at the 30-min cadence); retighten in the same PR that changes the schedules |

> ⚠️ **The hang policy's status set is an unverified hypothesis.** An audit of 30
> days of prod request logs (2026-07-26) found 19 requests to `/login/*`, **all
> HTTP 200** — not one non-2xx. So we have no observed example of what Cloud Run
> actually records when Convex aborts at 60s. If it isn't 499, this policy would
> silently never fire.
>
> Mitigation: the underlying metric `browser_login_http_status` captures **all**
> statuses `>= 400`, not just the four the policy matches, so the data to correct
> this accumulates for free. **First time a real non-2xx appears on `/login/*`,
> check it against the policy's regex and fix the set.**

Three settings that are load-bearing at this traffic level, all easy to
"clean up" and thereby break:

- **`evaluation_missing_data = INACTIVE`** — the provider default leaves a
  condition in its last state when data stops. With sparse traffic, an
  incident opened at 09:00 could stay open indefinitely and never re-fire.
- **`auto_close = 1800s`** (API minimum) — otherwise a still-open incident
  swallows the next burst's notification entirely.
- **`duration = "0s"` + `trigger.count = 1`** — never require *consecutive*
  violating windows; the second window may have no data at all.

Notification channel: email to `neonbinder@neonbinder.io`. Unlike NEO-95's
billing budget (which falls back to emailing billing admins), an alert policy
with no channel opens an incident **nobody ever sees**.

---

## 5. The synthetic canary

Cloud Scheduler → `POST /login/{bsc,sportlots}` with an OIDC token, on a
dedicated credential key, **every 30 minutes and staggered 15 minutes apart**.

The stagger is about *our* side, not the marketplaces'. Concurrent SportLots
logins from the same egress IP have previously produced `"Not a valid Email
Address"` / zero-cookie failures here — a shared-HTTP-state bug on our end.
Keeping the two platforms (and the canary vs. CI's deploy-time login probes)
from overlapping means a canary failure reads as "the marketplace broke"
rather than "we raced ourselves".

Between deploys, the canary is the *only* thing exercising marketplace login
in prod. It is also what makes the absence policy meaningful: without a
heartbeat, "no login logs today" is indistinguishable from "no sellers logged
in today".

### Why the `canary: true` flag exists

It makes the adapter skip **both** halves of the token cache. Neither half is
optional:

- **Skip the cache read** — SportLots caches its session cookie for **30
  days**. A cache-honouring canary would POST the real signin form roughly
  once a month, and would have been blind to precisely the hang this ticket
  exists to catch.
- **Skip the write-back** — every fresh login otherwise adds a new,
  permanently-enabled Secret Manager version at $0.06/version/month. At canary
  cadence that costs more than the rest of this infrastructure combined. It
  also keeps the canary key permanently cache-free, making the skip above
  structural rather than flag-dependent.

It also caps the SportLots retry budget at 2 (from 5), and tags the log line.

**Verifying the flag actually works:** a canary BSC run should show
`duration_ms` in the **4000-6000ms** band. If you see ~1100ms, the flag is not
reaching the adapter and the canary is proving nothing.

### Seeding the credentials

Terraform creates the secret **shells** only. Values are added out of band and
never touch tfvars or state:

```bash
printf '{"username":"<email>","password":"<password>"}' | \
  gcloud secrets versions add bsc-credentials-canary --data-file=- --project=neonbinder
```

Both `username` and `password` are required or `getCredentials` throws.
Deliberately omit `token`/`expiresAt`.

The `canary` userId segment corresponds to no Clerk user, so collision with a
real seller is impossible. It is also the rate-limit bucket key, so the canary
can never consume a seller's 60/min budget.

**On which marketplace account to use.** The shared `MAESTRO_*` account is
workable. Neither BSC nor SportLots rate-limits or "bot protects" logins, so
there is no throttling risk from the extra volume — see the note at the end of
this section.

A dedicated account is still mildly preferable, for our own reasons: it keeps
canary traffic from interleaving with CI's deploy-time login probes on the same
credentials, which matters because concurrent logins have exposed a
shared-HTTP-state bug on our side before. Not urgent. Swapping later is one
`gcloud secrets versions add` — no code, no Terraform.

### Kill switches, in escalating order

1. **`login_canary_paused = true`** in `prod.tfvars`, merge. Graceful, keeps
   everything in state.
2. **`gcloud scheduler jobs pause neonbinder-login-canary-bsc --location=us-central1 --project=neonbinder`**
   — instant break-glass. ⚠️ **The next apply reverts this**, so always follow
   it with (1).
3. **Revoke the canary SA's `run.invoker`** — hard stop. Requests 403 at the
   Cloud Run edge, never reaching Express or the marketplace, and produce 4xx
   not 5xx so they don't pollute the hang policy.

Do **not** use "disable the secret" as a kill switch — that makes the canary
fail loudly and generates exactly the false alarms you are trying to stop.

`retry_count = 0` (and the canary's reduced SportLots retry budget) is
deliberate — for **monitoring correctness**, not anti-abuse. Retries would let
the canary quietly succeed on attempt 2 and report nothing, hiding an
intermittently-failing marketplace behind a green probe. That is the opposite
of what a probe is for. One attempt per run means every failure is visible;
genuine one-off blips are absorbed by the alert policy, which needs repeated
failures before it fires.

> ### ⚠️ Neither BSC nor SportLots throttles logins
>
> **There is no such thing as "BSC bot protection", and neither site
> rate-limits.** BSC's login is simply *sometimes flaky* — and BSC shipped a fix
> for that on 2026-07-26.
>
> This belief has been raised and disproven repeatedly on this project. It still
> survives in a pre-existing NEO-29 comment in `apps/web/convex/credentials.ts`
> (~line 682-690) blaming "BSC's bot protection" for a burst of failures — **that
> comment is wrong**; don't cite it or let it justify timid design.
>
> If you catch yourself writing a rationale that depends on a marketplace
> punishing us for login volume, stop: the premise is false. Diagnose from Cloud
> Run and Convex logs instead.

---

## 6. PostHog alerts (manual — no IaC)

PostHog is the slow, *semantic* path: it catches "SportLots specifically is
rejecting us while the service looks perfectly healthy". Cloud Monitoring is
the fast path (~5 min). PostHog's check cadence is **hourly at best** — do not
expect paging latency from it.

### Prerequisites

1. `neonbinder@neonbinder.io` must be a **member** of the PostHog project —
   alerts pick recipients from a member list, you cannot type an arbitrary
   address.
2. **Confirm dev Convex does not write into the same project**, or a dev E2E
   run will page you. The cheapest prod-only guarantee is leaving
   `POSTHOG_API_KEY` unset in dev, which is already the de-facto behaviour
   (`apps/web/convex/posthog.ts` no-ops without it).
3. PostHog alerts have historically **not supported insights with a
   breakdown** — hence one insight + one alert *per platform*. Verify in the
   UI; collapse to one if that has changed.

### Alert 1 — failure burst (works on today's data)

| | |
|---|---|
| Insight | Trends on `credential_test_failed`, filtered to one platform |
| Aggregation | **Unique users** (not event count — see §3) |
| Window | Last 24 hours, hourly interval |
| Condition | value **above 2** |
| Recipient | `neonbinder@neonbinder.io` |

Three distinct users failing the same platform in a day is a marketplace-level
break, and is close to unfakeable by one bad account.

### Alert 2 — failure rate (needs ~7 days of data)

Two series, `A = credential_test_failed`, `B = credential_test_succeeded`,
both filtered to one platform; formula `A / (A + B)`; daily; above `0.5`.

PostHog cannot backfill a denominator, so this only becomes meaningful about a
week after `credential_test_succeeded` ships. Treat as advisory until traffic
grows — at low volume a 1-of-1 failure day reads as 100%.

### Alert 3 — hang detector (optional)

Alert 1 plus `error_class = timeout`, threshold above 0, daily.

### Calibrate rather than guess

Run `credential_test_failed`, last 90 days, daily interval, broken down by
`platform` (breakdowns are fine on an *insight*; the restriction is only on
*alerts*). Take the p95 daily unique-user count per platform and set the
threshold one step above.

**Record the observed numbers and the date here when you do:**

| Date | Platform | p95 daily unique users | Threshold set |
|---|---|---|---|
| _(not yet calibrated — thresholds above are initial estimates)_ | | | |

### A note on the ingest host

`apps/web/convex/posthog.ts` posts to `https://us.posthog.com/batch/`, not the
`us.i.posthog.com` ingest host. This **is** correct — verified by probing
both: they return identical capture-service responses, and `/batch/` is not
falling through to the app router. Do not "fix" it.

---

## 7. Triage

1. **Read `error_class` on the failing lines first.** `challenge` → the
   marketplace is blocking us; **pause the canary before debugging** or you
   dig the hole deeper. `timeout` → marketplace slow or wedged. `oom` →
   container memory. `other` → read the raw message.

2. **Alert fired but there is no `browser_login_call` line?** That absence
   *is* the finding — it's a hang. Go to the request log.

3. **Check the benign causes before escalating:**
   - A push to `main` just ran `prod-login-probe`: a real login against a
     cold, freshly deployed revision, 20-30s.
   - Cold start generally — `min-instances=0` is intentional (NEO-95).

4. **Queries** — Logs Explorer, project `neonbinder`:

   ```
   # What the service thought happened
   resource.type="cloud_run_revision"
   resource.labels.service_name="neonbinder-browser"
   jsonPayload.msg="browser_login_call"

   # The only place a hang is visible
   resource.type="cloud_run_revision"
   resource.labels.service_name="neonbinder-browser"
   logName="projects/neonbinder/logs/run.googleapis.com%2Frequests"
   httpRequest.requestUrl=~"/login/"

   # Canary only
   jsonPayload.msg="browser_login_call" jsonPayload.canary=true

   # Scheduler's own view — records an abandoned attempt even when the
   # service logs nothing
   resource.type="cloud_scheduler_job"
   ```

5. **Act.** Marketplace-side outage → nothing to deploy, note it and wait.
   Our regression → `gcloud run services update-traffic neonbinder-browser
   --region=us-central1 --project=neonbinder --to-revisions=<previous>=100`.

---

## 8. Known gaps

- **eBay is not covered — NEO-97.** `apps/web/convex/adapters/ebay.ts`
  `testCredentials` is a placeholder that returns `success: true` without
  contacting eBay. Instrumenting it would inject *fabricated successes* into
  the failure-rate denominator, making the alert progressively less sensitive
  as eBay usage grew. Deliberately excluded, not overlooked.
- **SportLots' no-cookies branch uses a heuristic — NEO-100.** When
  SportLots returns no session cookies, a rejection is inferred from its
  `not a valid email address` tell, falling back to "did SportLots render any
  body at all". A structural fix would parse SportLots' error markup, which we
  do not have documented. The fallback errs toward 502 (pages), so the failure
  mode is a spurious page, not a missed one.
- **PostHog config is not IaC.** PostHog exposes REST endpoints for insights
  and alerts, so a checked-in JSON plus an idempotent apply script is
  possible. Its own ticket.
