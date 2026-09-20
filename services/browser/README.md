# Neonbinder Browser

A TypeScript-based web automation service for card delisting operations.

> **CI — per-PR preview (NEO-18):** every PR that changes `services/browser/**`
> deploys a `pr-<N>` tagged, no-traffic Cloud Run preview on the dev service and
> runs a real BSC + SportLots login probe against it (`browser.yml`). The
> top-level deployment pipeline (`pr-pipeline.yml`) then points the Convex
> preview's `NEONBINDER_BROWSER_URL` at that `pr-<N>` URL and only afterward runs
> the web Maestro E2E — so a PR is validated against its OWN browser code
> end-to-end. (Vercel never talks to the browser service; the wiring lives in the
> deployment pipeline, preserving the FE → Convex → browser boundary.)

## Features

- Express.js server with TypeScript
- Puppeteer for web automation
- Docker support
- Type-safe API endpoints

## Development

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
npm install
```

### Development Mode

```bash
npm run dev
```

This will start the server using `ts-node` for development with hot reloading.

### Building for Production

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` folder.

### Running Production Build

```bash
npm start
```

## API Endpoints

### POST /delist

Delists a card using web automation.

**Request Body:**
```json
{
  "username": "string",
  "password": "string", 
  "cardId": "string"
}
```

**Response:**
```json
{
  "success": true
}
```

### EasyPost postage routes

Convex never holds a seller's EasyPost API key (NEO-20's credential boundary),
so it asks this service to make every EasyPost call. Every route below is
scoped by `EASYPOST_KEY_PATTERN` — none of them will touch a secret that is not
an `easypost-credentials-*` secret.

| Route | What it does |
|---|---|
| `PUT /easypost/:key` | Store (replace) the seller's EasyPost API key |
| `DELETE /easypost/:key` | Delete it. Idempotent (NEO-121 — moved off the unguarded `DELETE /credentials/:key`) |
| `POST /easypost/:key/rate` | Price a First-Class letter. Charges nothing |
| `POST /easypost/:key/buy` | Buy a quoted rate. **Spends the seller's money** |
| `GET /easypost/:key/label/:shipmentId` | Re-fetch a bought label for reprinting (NEO-213) |
| `GET /easypost/:key/tracker/:shipmentId` | Current USPS scans for a bought shipment (NEO-121) |
| `GET /easypost/:key/webhooks` | List the account's webhooks, for reconciliation (NEO-121) |
| `POST /easypost/:key/webhooks` | Register `{url, secret}`. The URL must be https on a `*.convex.site` host (NEO-121) |
| `DELETE /easypost/:key/webhooks/:webhookId` | Unregister a webhook (NEO-121) |

Two status contracts on this router are load-bearing and must not drift:

- **A JSON `404` means "no EasyPost key saved for this user" and nothing else.**
  Convex branches on it to prompt for a key. A shipment EasyPost itself cannot
  find is a `502`; a shipment with no tracker yet is a `409` (`no_tracker`); a
  request this service refuses to send upstream at all is a `400`
  (`invalid_input`). EasyPost's *own* 404 on a webhook delete is turned into
  success inside the client, never here.
- **No response body or log line carries a webhook URL token.** The registered
  URL contains a per-seller bearer token in its path and EasyPost quotes the URL
  it rejected in its error text, so `redactWebhookToken` scrubs
  `/webhooks/easypost/<token>` on the way out of both the client and the router.

## Docker

Build and run with Docker:

```bash
docker build -t neonbinder-browser .
docker run -p 8080:8080 neonbinder-browser
```

## Project Structure

```
├── src/
│   └── index.ts          # Main application file
├── dist/                 # Compiled JavaScript (generated)
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── Dockerfile           # Docker configuration
└── README.md            # This file
```

## TypeScript Configuration

The project uses strict TypeScript settings with:
- ES2020 target
- CommonJS modules
- Source maps enabled
- Declaration files generated
- Strict type checking

## Deployment

This service deploys to Cloud Run from the consolidated monorepo
(`neonbinder/neonbinder`). As of the NEO-18 cutover (2026-06-27), the monorepo
is the sole deploy source of truth for the browser service; the standalone
`neonbinder_browser` repo is retired.

Two workflows, deliberately split (NEO-143):

| Workflow | Trigger | What it does |
|---|---|---|
| `browser.yml` | `pull_request` | build + unit tests, per-PR no-traffic Cloud Run preview, login probe |
| `browser-deploy.yml` | `workflow_call` (from `release.yml`), `workflow_dispatch` | the prod lane: build once → dev at 0% → probe → promote → prod at 0% → probe → promote |

`browser-deploy.yml` has **no `push:` trigger on purpose**. `release.yml` is the
single driver of push-to-main deploys and must be able to order this service
ahead of the web/Convex release. Adding a push trigger back here re-creates the
outage described below.

**Pausing a marketplace's login probe (NEO-287).** The preview probe
(`browser.yml`'s `preview-login-probe`) and both prod-lane probes
(`browser-deploy.yml`'s `dev-login-probe` / `prod-login-probe`) all pass
`PAUSED_PLATFORMS: ${{ vars.NEONBINDER_PAUSED_PLATFORMS }}` — the same GitHub
Actions repository variable that mirrors Convex's `NEONBINDER_PAUSED_PLATFORMS`
env var — into the `test:prod-gate` step. `tests/integration/_helpers.mjs`'s
`isPaused(slug)` reads it (comma-separated, trimmed, case-insensitive) and
`sportlots-login.test.mjs` skips both of its cases with an `::error::`-free
`::notice::` line when SportLots is paused, so a known operator-chosen SL
outage doesn't turn every PR and every promotion red. There is no `if:`
gating on the jobs themselves — BSC's half of the suite always runs
unconditionally, and only the SportLots test cases branch on the variable.

## SportLots automated access (NEO-288)

On 2026-09-17 SportLots put Cloudflare Turnstile in front of `signin.tpl`. A
direct form POST is now refused with a body such as "Security verification
failed" / "Invalid login request" (classified as a *challenge*, never as a
credential rejection — see `CHALLENGE_PATTERNS`). The SportLots owner issued
NeonBinder an **Automated Access** credential and a script path around the
challenge, which the adapter follows on every fresh sign-in:

1. `POST https://www.sportlots.com/u/node/automated-access` with the JSON body
   `{"keyId": "…", "secret": "…"}` → `{"success": true, "authId": "…"}`. The
   `authId` is short-lived and **single-use**, so the adapter mints one per
   signin attempt (the retry loop re-enters `attemptLogin`, so a 5xx retry
   mints a fresh one).
2. The ordinary `POST /cust/custbin/signin.tpl` (`email_val`, `psswd`)
   additionally carries `turnstile_auth_id=<authId>`.

The stored-cookie re-auth path (`validateCachedCookieWithRetry`) and the
`newinven.tpl` validation GET are unchanged — no handshake there.

**The secret.** `src/services/sportlots-automated-access.ts` reads Secret
Manager secret `sportlots-automated-access` in the service's project
(`GOOGLE_CLOUD_PROJECT`, default `neonbinder`). Its payload is a JSON object
with exactly two non-empty string fields:

```json
{ "keyId": "…", "secret": "…" }
```

Seed or rotate it from a `0600` file (never from the shell history — no
`--data-file=-` with an inline echo):

```bash
gcloud secrets versions add sportlots-automated-access \
  --data-file=<0600 file> --project=neonbinder-dev   # or --project=neonbinder
```

The read is cached in-process for ~10 minutes; a refused handshake drops the
cache so a rotated key is picked up on the next attempt without a restart.
Keep-one pruning applies as for every other secret here (NEO-115).

**Failure semantics.** The handshake never skips silently. A missing,
unreadable or malformed secret, a `401`/`403`/other `4xx`, a `2xx` whose body is
not `{"success": true, "authId": "<non-empty>"}`, a `3xx` (the endpoint is
fetched with `redirect: "manual"` — a redirect is a refusal, fail closed; if
every login fails at attempt 1 check for a redirect as well as the key), or an
unparsable body fails the login with `error_class: automated_access` →
**502, pages** — this is our key and our outage, never the seller's password,
so `credentialRejected` is never set and Convex writes nothing about the
user's session. `429`, `5xx`, a network error or the 8 s timeout are retryable
within the normal `MAX_ATTEMPTS` budget and classify the same way; the bounded
worst case (5 × 8 s + jittered backoffs ≈ 50 s) is pinned under Convex's 60 s
abort by a unit test. The signin POST and the post-login validation GET remain
unbounded, as they were before this change. The `browser_login_call` log
line carries `automated_access: true|false` (omitted when the login never
reached the handshake, e.g. a cached-cookie re-auth).

**Same-IP requirement — one TCP connection per attempt.** SportLots binds the
`authId` to the client IP that minted it, so the handshake and the signin have
to leave through the same address. Measured 2026-09-20: the handshake succeeded
on every attempt from Cloud Run, and every signin was refused with "Security
verification failed" — while the identical code logged in first try from a
laptop. The cause is a race in Node's global `fetch`, not the network: after
`await response.text()` on the handshake, undici has **not yet returned that
socket to its pool**, so a signin dispatched straight away opens a **second**
TCP connection even though the first is still open and keep-alive
(`Keep-Alive: timeout=5`). Reproduced against a local keep-alive server: two
back-to-back global fetches land on two server-side sockets, every time. On a
laptop both sockets share one public IP and nobody notices; on Cloud Run's
shared egress pool the two sockets can carry different addresses. A sleep
between the calls also "fixes" it, which is how you know it is a race and not
a delay — do not add one.

The adapter therefore runs each attempt's handshake and signin through
`withSingleConnection` (`src/services/single-connection.ts`): a dedicated
`undici.Client` — one connection by construction — passed as `dispatcher` to
both `fetch` calls, closed in `finally` (bounded: a close blocked by an
unconsumed body falls back to `destroy()` rather than hanging the route).
Every retry gets a fresh client with its fresh single-use `authId`. The
post-login validation GET stays on the global fetch: the signin answers
`Connection: close`, and a session cookie is not IP-bound (stored-cookie
re-auth already worked from Cloud Run). `tests/single-connection.test.mjs`
proves the one-socket property against a real local server and keeps the
two-socket global-fetch behaviour as the regression control.

**No NAT or static egress is needed for this.** The requirement is that the
two requests share a socket, which the single-connection client guarantees on
any egress. If a VPC connector or proxy is ever added, that still holds as long
as one TCP connection maps to one upstream address.

**Security.** The `secret` is transmitted only in the HTTPS POST body to the
handshake endpoint — never a query string, header, log line, error message or
commit. Only the HTTP status and a boolean are logged; the request body, the
response body and the `authId` are never interpolated anywhere, and the
handshake response is never turned into a login diagnostic. The `authId`,
`keyId` and `secret` are passed to `buildLoginDiagnostic` as exact-value
redaction inputs in case SportLots reflects a submitted form field into a page
body. The JSON parse error is never logged or re-thrown (Node embeds the input
in `SyntaxError.message`).

**Tests never touch GCP.** `tests/sportlots-automated-access.test.mjs` stubs
`@google-cloud/secret-manager` in the require cache; the adapter tests
monkey-patch the reader module the way they patch `SecretsManagerService`, so
`npm test` needs no ADC and no real key.

## Release contract

**Read this before changing any request or response shape on the
Convex ↔ browser-service boundary.**

### Why it exists

Merging NEO-141 broke production for ~5.5 minutes. Vercel (web + Convex) and
Cloud Run deployed on independent schedules from the same commit, so new Convex
went live while the old browser service was still serving. NEO-141 had moved the
marketplace password from a stored secret onto a transient field of the login
request; the old service did not know that field, ignored it, read the secret
that had just been cleared, and failed. Nobody could connect SportLots.

The loud failure was the good case. The bad case: where a stored secret still
held a password, the old service logged in with **that** instead of what the
user had just typed — a credential change that reports success while quietly
using the old password. No error anywhere.

No test could have caught it. E2E, previews and unit tests all run both halves
at the same commit; new-client-against-old-server is the one state every deploy
passes through and nothing ever exercised.

### The deploy order, and why it is that way

`release.yml` runs:

```
browser-deploy.yml ─┐
(promoted to 100%)  ├──> web: npx convex deploy, then staged SPA, smoke, promote
preprocess-deploy ──┘
```

Servers lead their clients. Convex is a *client* of this service; the SPA is a
client of Convex. A service must be able to serve the new shape before anything
starts speaking it.

### What cannot be ordered: the Convex flip

Convex has no blue/green. A project has one shared production deployment and
that deployment **owns its database**, so there is no second backend to park a
version on and no traffic to switch. `npx convex deploy` pushes and the new
functions are live immediately. Preview deployments have their own separate,
empty data, so they are not a green copy of production either.

Concretely: the Convex push happens inside `vercel build`, so production Convex
flips *after* this service is at 100% but *before* the new SPA is promoted. The
old SPA therefore runs against new Convex for the smoke+promote window, and
longer for already-open browser tabs.

That window is irreducible. It is what expand/contract exists for.

### The rule

**Any change to this boundary ships so that both sides work in either
combination for one full release.** Concretely, for a shape change:

1. **Release N** — teach this service the new shape *while it still accepts the
   old one*, and bump `CONTRACT_VERSION` in `src/contract-version.ts`.
2. **Release N+1** — raise `REQUIRED_CONTRACT_VERSION` in
   `apps/web/convex/credentials.ts` and switch Convex to the new shape.

The deploy ordering means a single release usually survives, but it leaves no
margin if the ordering ever changes — so use two releases for anything where the
silent-fallback mode above is possible.

Do **not** make this service reject unknown request fields. An older service
400-ing on a newer client's additive field would make additive changes require a
lockstep deploy, which is the opposite of what the rule above needs.
(Contradictory fields *are* rejected — see `parseTransientCredentials`, where
half a credential pair is a 400 rather than a silent fallback.)

### The mechanical check

`GET /health` reports `contractVersion`. It deliberately does not report the
serving revision name — not for exposure reasons (the route is IAM-gated like
every other one), but because nothing needs it. Before any authenticated call,
Convex probes it (`assertBrowserContract` in `apps/web/convex/credentials.ts`) and
refuses to send a request the live service may misinterpret, surfacing a
"service is updating" message instead of guessing. A service predating NEO-143
reports no field at all and is read as version 0 — deliberately failing closed.

The probe is placed in `browserAuthHeaders()`, which every outbound call funnels
through *including* `loginWithRetry` (which calls `fetch` directly rather than
`browserFetch`). That placement is intentional: the login path is the one
NEO-141 broke, and the guard must not be bypassable by adding a call site.

Rollback asymmetry, worth knowing before you need it: the SPA rolls back with
`vercel rollback` and this service by re-pointing Cloud Run traffic, but a Convex
push is reverted only by pushing the previous commit — and schema or data
migrations may not be reversible at all. Expand/contract is what makes the
un-revertable half safe.
