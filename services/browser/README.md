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

`GET /health` reports `contractVersion` — and deliberately not the serving
revision name, since this route carries no app-layer auth of its own. Before any
authenticated call, Convex
probes it (`assertBrowserContract` in `apps/web/convex/credentials.ts`) and
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
