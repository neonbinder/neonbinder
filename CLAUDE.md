# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NeonBinder is a platform for trading card collectors to manage collections and sell across marketplaces (eBay, SportLots, BuySportsCards, MySlabs, MyCardPost).

**This is the consolidated monorepo `neonbinder/neonbinder` (NEO-18, NEO-123).** One git repo, one CI pipeline (`.github/workflows/`), path-filtered lanes. Three deployable projects live side by side plus shared Claude config:

| Path | Purpose | Tech Stack | Deploy target |
|------|---------|-----------|---------------|
| `apps/web/` | Vite SPA + Convex backend | Vite 6, React 19, React Router 7, Convex, Clerk, TypeScript | Vercel (SPA) + Convex |
| `services/browser/` | Puppeteer automation service for marketplace login/scraping | Node.js, Puppeteer, Express 5, TypeScript | GCP Cloud Run |
| `services/preprocess/` | Image preprocessing (crop cascade + SAM, Vision OCR orient, Anthropic classify) | **Python 3.12**, FastAPI, PyTorch, pip | GCP Cloud Run |
| `.claude/`, `CLAUDE.md` | Shared Claude Code config (agents, skills, memory) | — | — |
| `.github/workflows/` | Unified CI/CD (see **CI/CD** below) | GitHub Actions | — |

> A monorepo doesn't merge runtimes: `apps/web` still deploys to Vercel/Convex, and `services/browser` and `services/preprocess` each deploy to their own Cloud Run service — they're just one repo now.
>
> **`services/preprocess/` is the only Python in the repo.** pip + pinned `requirements.txt` / `requirements-dev.txt` (no npm, no workspace), `ruff` + `pytest` rather than eslint + vitest, and all its commands run from `services/preprocess/` (its `pyproject.toml` sets `pythonpath = ["."]`). Nothing in `apps/web` or `services/browser` imports it yet — it is deployed and standalone.
>
> **Not in this repo:** GCP infrastructure is a separate Terraform repo, **`neonbinder/neonbinder_ioc`** (GitFlow: `develop`→dev apply, `main`→prod apply). The React Native mobile client (`NeonBinderApp`) is **paused** and not part of the monorepo today; it's expected to return after the web stabilizes (keep cross-platform concerns like Maestro in mind).

## Code Search & Navigation

Application code lives under `apps/web/`, `services/browser/` and `services/preprocess/`. When searching:

1. **Scope to the relevant project** — `apps/web/` (frontend + Convex), `services/browser/` (Puppeteer service), or `services/preprocess/` (Python image service).
2. **If unsure**, search all three. Example: `Glob("**/*.ts", path="apps/web")` or `Grep("functionName", path="services/browser/src")`. Note `services/preprocess/` is `**/*.py` — a TypeScript-only glob silently misses it.
3. The repo root holds only config (`.claude/`, `.github/`, `CLAUDE.md`) — no application source.

## Git & Branching

One repository, one git history. Standard model:

1. **Branch off latest `main`** (`git fetch origin && git pull`), ideally in a worktree named for the ticket.
2. **One commit captures all changes** across `apps/web` and `services/browser` — they share a history now. No more per-subdirectory commits.
3. **Feature branch → PR → squash-merge.** Trunk-based; never push directly to `main`.
4. Terraform lives in the separate `neonbinder_ioc` repo and follows **GitFlow** there (feature → `develop` → `main`).

End commit messages with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

### The PR loop — cheap gates locally, E2E in CI, local for debugging

**Do not use CI as your first check that the code compiles.** Do not use your
laptop to run the full E2E suite. Those are different tools and the split is
about wall-clock, not virtue.

The economics, measured on 2026-08-25:

| | Workers | E2E wall-clock | Actions cost | Vercel cost |
|---|---|---|---|---|
| CI | 8 shards | ~17–25 min | **$0** — public repo | 1 preview build |
| Local | 1 | ~90 min | $0 | $0 |

A dev laptop runs an individual flow at roughly CI's pace (median x1.08 over 18
matched flows). CI is not faster per flow — it is faster because it runs eight
at once. So **CI is the right place to discover E2E failures, and the laptop is
the right place to fix them.**

#### The loop

1. Write the change.
2. **Run the fast local gates.** These cost ~2 min for `apps/web`, ~30s for
   `services/browser` — they are not the expensive part, and they catch most
   breakage without a round trip.
3. Push and open the PR. CI runs the full suite.
4. On a red flow: **run that one flow locally**, with Vite pointed at the PR's
   own preview stack (below).
5. Push again **only once that flow passes locally.** This step is the actual
   cost control — push-and-hope is what burns CI cycles, not the first push.
6. Watch to green.
7. Merge via the `pr-close` skill (merge → verify the prod deploy actually
   reached READY → smoke → Linear → reclaim the worktree).

#### The fast gates, by area

| You changed | Run before pushing |
|---|---|
| `apps/web/**` | `npm run lint`, `npm run test:unit`, `npm run build`, `npx tsc -p convex/tsconfig.json --noEmit` |
| `services/browser/**` | `npm run build && npm test` |
| `services/preprocess/**` | `ruff check . && ruff format --check . && pytest tests/unit` |
| Dependencies | see the `deps-batch` skill — gate each bump separately |

**The one case that still wants the full local suite before pushing:** changes to
`.maestro/**`, the maestro-runner action, or a pinned tool version. Those ARE the
harness — a change there invalidates every other result, so a green CI run proves
less than usual.

#### Debugging a red flow against the PR's own services

Local E2E normally points at **shared dev**, which means it cannot exercise the
PR's `services/browser` or `services/preprocess` code at all. To close that gap,
point Vite at the PR's Convex preview instead of dev:

```bash
# in apps/web/.env.local
VITE_CONVEX_URL=<the PR's Convex preview URL>
```

`wire-browser-url` and `wire-preprocess-url` have already pointed that preview's
`NEONBINDER_BROWSER_URL` / `NEONBINDER_PREPROCESS_URL` at the PR's own `pr-<N>`
Cloud Run revisions, so this gives you local Vite → PR Convex → PR browser +
preprocess: the whole stack of the change, debuggable locally.

Then run the single flow: `npm run test:e2e:pick -- <flow>` (it resolves the
prerequisite closure for you).

> **Unverified as of 2026-08-25.** The preview's `TESTING_ENDPOINT_SECRET` must
> match what `/testing/sign-in` expects, and protected previews may need
> `VERCEL_AUTOMATION_BYPASS_SECRET`. Prove this on one PR before relying on it.

#### Check `node --version` at the moment the gate runs

Not before you `cd`. `node` here is a shell function that re-runs `load-nvmrc` on
every invocation, so it re-reads `.nvmrc` and silently overrides an exported
PATH. Wrong Node produces failures that look exactly like your change broke
something — on 2026-08-24 a stale 22.5.1 (below the 22.12 `require(ESM)` floor)
turned a clean `services/browser` suite into 175 pass / 63 fail.

#### When something genuinely cannot run locally

Some things cannot, and that is fine — what is not fine is silence. Say so
**explicitly in the PR body**: what you could not run, why, and what covers it
instead. Two live examples:

* `services/preprocess` pytest — `requirements-dev.txt` pulls `torch==2.5.1+cpu`,
  which publishes no macOS wheel, so the deps will not install on an arm64 Mac.
  CI's `preprocess-test` job is the cover.
* Anything needing the PR's own deployed services, if you have not wired the
  preview stack above.

An unrunnable test is a disclosure. An unrun one is a defect.

If the local environment is what is blocking you, fix that rather than skipping
— see NEO-181, and `.maestro/README.md` for the pinned toolchain.
## Development Commands

### apps/web (main development)
```bash
cd apps/web
npm run dev              # Start Vite frontend only (port 3000)
npm run dev:backend      # Start Convex dev server only (wraps ./dev-backend.sh)
npm run dev:all          # Start Vite + Convex in parallel (runs setup-env.sh first)
npm run dev:backend:tunnel  # Convex dev with cloudflared tunnel for browser service
npm run build            # Vite production build
npm run preview          # Preview built bundle
npm run lint             # ESLint
npm run test:e2e         # Maestro E2E locally (see E2E Testing below)
```

### services/browser
```bash
cd services/browser
npm run dev              # Start with ts-node (development)
npm run build            # Compile TypeScript
npm start                # Run compiled server (port 8080)
npm test                 # Unit tests
npm run test:prod-gate   # Real BSC + SportLots login integration tests (node --test tests/integration/*.test.mjs)
```

> Deploys are driven by CI, not by hand — see **CI/CD**. Vercel owns the Convex deploy (the SPA build runs `convex deploy`); Cloud Run is deployed from `browser.yml`.

## Architecture

```
Frontend (apps/web SPA)
    ↓
Convex Backend (apps/web/convex/)
    ↓ calls (OIDC, server-side only)
Browser Service (services/browser/) for marketplace automation
    ↓
External Marketplaces (via Puppeteer / direct HTTP)
```

**Data Flow:** Image → Recognition → Structured Card → Collection → (Optional) Listing

**Security boundary (do not collapse):** the frontend never calls the browser service directly. It goes FE → Convex → browser. Convex proxies all privileged operations (credentials, marketplace calls) and is the only caller of the browser service. The `apps/web/convex/adapters/` and `services/browser/src/adapters/` layers are an intentional duplication across that boundary — only non-privileged wire types/taxonomy are shareable, never the adapter logic.

### Key Entry Points
- **Web entry point:** `apps/web/src/main.tsx` — Vite entry; mounts `BrowserRouter`, sets up providers (Clerk, Convex, PostHog, Sentry, Radix Theme), declares all routes
- **Route layouts:** `apps/web/src/layouts/ProtectedLayout.tsx` (auth-gated), `apps/web/src/layouts/binder-layout.tsx` (binder shell)
- **Page components:** under `apps/web/app/<route>/page.tsx` — imported into `src/main.tsx` and mapped to React Router `<Route>` elements (no Next.js file-system routing)
- **Convex schema:** `apps/web/convex/schema.ts`
- **Convex functions:** `apps/web/convex/myFunctions.ts`
- **Marketplace adapters (Convex side):** `apps/web/convex/adapters/`
- **Browser automation:** `services/browser/src/index.ts` — Express server with adapter routes

> `apps/web/app/layout.tsx` is a leftover Next.js stub kept only for migration reference — not the active root layout. Provider setup lives in `src/main.tsx`.

## Convex Development Patterns

**Function syntax** - Always use the new format with validators:
```typescript
import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";

export const myQuery = query({
  args: { id: v.id("tableName") },
  returns: v.object({ name: v.string() }),
  handler: async (ctx, args) => {
    // Use ctx.db for database operations
    return { name: "result" };
  },
});
```

**Key rules:**
- Use `query`/`mutation`/`action` for public functions, `internalQuery`/`internalMutation`/`internalAction` for private
- Always include `args` and `returns` validators
- Use `v.null()` for functions that return nothing
- Queries should use `.withIndex()` instead of `.filter()` for performance
- Use `Id<"tableName">` type for document IDs
- Actions cannot access `ctx.db` - call mutations/queries via `ctx.runMutation`/`ctx.runQuery`

**Client usage:**
```tsx
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

const data = useQuery(api.myFunctions.myQuery, { id });
const mutate = useMutation(api.myFunctions.myMutation);
```

> No `"use client"` directives — this is a Vite SPA, every component runs in the browser.

## Authentication

Uses **Clerk + Convex Auth**:
- Clerk handles user authentication via `<ClerkProvider>` in `apps/web/src/main.tsx`
- JWT passed to Convex with `aud: "convex"` claim
- Get current user in Convex: `getCurrentUserId(ctx)` from `./auth`
- Protected routes are wrapped with `<ProtectedLayout>` in `src/main.tsx` (no `middleware.ts` — that was Next.js)
- Public routes (rendered without `ProtectedLayout`): `/`, `/signin/*`, `/sign-up/*`, `/binder-tracking`, `/ai-card-identification`, `/managing-inventory`

## Environment Setup

### GCP Service Accounts

Each service uses a dedicated service account, managed by Terraform in the **`neonbinder_ioc`** repo. All NeonBinder GCP projects live under the `neonbinder.io` organization (org ID redacted). Project topology:

- **Prod:** `neonbinder` (project number redacted)
- **Dev:** `neonbinder-dev` (project number redacted)

| Service Account | Project | Purpose | Local Auth Method |
|---|---|---|---|
| `neonbinder-browser-runtime` | `neonbinder-dev` (dev) / `neonbinder` (prod) | Browser service runtime (Cloud Run + local dev) | SA impersonation via ADC |
| `neonbinder-browser-deployer` | `neonbinder-dev` (dev) / `neonbinder` (prod) | GitHub Actions CI/CD (WIF) | Workload Identity Federation |
| `neonbinder-preprocess-runtime` | `neonbinder-dev` (dev) / `neonbinder` (prod) | Preprocess service runtime (Cloud Run) | SA impersonation via ADC |
| `neonbinder-preprocess-deployer` | `neonbinder-dev` (dev) / `neonbinder` (prod) | GitHub Actions CI/CD for preprocess (WIF) | Workload Identity Federation |
| `neonbinder-convex` | `neonbinder-dev` (dev) / `neonbinder` (prod) | Convex backend (GCS + OIDC to browser) | SA key in Convex env (`GOOGLE_APPLICATION_CREDENTIALS_B64`); Convex runs off-GCP, can't use WIF |

> Browser and preprocess authenticate through **separate WIF providers** (`github` and `github-preprocess`) onto **separate deployer SAs**, so either deploy lane can be scoped or revoked without touching the other. Both providers trust this repo. The GitHub secrets differ per lane: `GCP_WIF_PROVIDER{,_DEV}` / `GCP_SERVICE_ACCOUNT_DEPLOYER{,_DEV}` for browser, `GCP_WIF_PROVIDER_PREPROCESS{,_DEV}` / `GCP_SA_PREPROCESS_DEPLOYER{,_DEV}` for preprocess.

**Org policy:** SA key creation is disabled (`iam.disableServiceAccountKeyCreation`) except for the two `neonbinder-convex` SAs, which have an explicit exception because Convex Cloud requires a key to authenticate to GCS. Everywhere else, use impersonation. **All GCP changes go through `neonbinder_ioc` (Terraform)** — no console/CLI mutations.

Local dev setup (one-time per SA):
```bash
# Browser service — impersonate the dev runtime SA
gcloud auth application-default login \
  --impersonate-service-account=neonbinder-browser-runtime@neonbinder-dev.iam.gserviceaccount.com

# Convex backend — impersonate the convex SA (when needed for GCS operations)
gcloud auth application-default login \
  --impersonate-service-account=neonbinder-convex@neonbinder.iam.gserviceaccount.com
```

Prerequisite: your user account needs `roles/iam.serviceAccountTokenCreator` on the target SA (managed in Terraform).

### Environment Variables

```bash
# Key env vars (in apps/web/.env.local — Vite exposes anything prefixed with VITE_ to the client):
# VITE_CONVEX_URL              - Convex deployment URL
# VITE_CLERK_PUBLISHABLE_KEY   - Clerk public key
# CLERK_SECRET_KEY             - Clerk secret (server-side / Convex only)
# ENCRYPTION_KEY               - 32-char key for credential encryption
# NEONBINDER_BROWSER_URL       - Browser service URL (Convex env; default: http://localhost:8080)
# GCS_PLACEHOLDER_BUCKET       - Convex env only (set via `npx convex env set`, not .env.local).
#                                 Name of the placeholder-uploads GCS bucket (NEO-148), e.g.
#                                 neonbinder-placeholder-uploads-neonbinder-dev. Read by
#                                 convex/adapters/placeholderUploads.ts. Unlike GCP_FEATURES_ENABLED-
#                                 gated prizes code, this feature is NOT gated by that flag — it must
#                                 work in dev. Value comes from the `placeholder_uploads_bucket_name`
#                                 Terraform output in neonbinder_ioc.
```

> Convex dev reads its own env from `.env.convex` when `npm run dev:backend` is used (see `apps/web/dev-backend.sh`).

For marketplace automation testing, start the browser service first:
```bash
cd services/browser && npm start  # Runs on port 8080 (reads .env for GCP credentials)
```

## UI & Styling

- **Theme:** Dark UI with neon accents (90s hobby-shop aesthetic)
- **Colors:** Primary=Neon Green (#00D558), Cancel=Neon Pink (#FF2EB3), Accent=Blue (#00B7FF)
- **Font:** Lexend
- **Components:** Radix UI Themes, Tailwind CSS 4.x
- **Structure:** `apps/web/components/primitives/` (base), `apps/web/components/modules/` (composed)
- **Keyboard-first:** every flow must be fully operable from the keyboard (Enter confirms, Escape cancels, preselect sensible defaults).

## Observability

- **Sentry:** client-side error tracking + performance monitoring (no `@sentry/node` — the frontend only).
- **PostHog:** product analytics, feature flags, user tracking.
- **Server-side (Convex / browser service):** PostHog events + structured JSON logs (not Sentry).
- Correlation: include `requestId`, `userId` across systems. Check GCP Cloud Run + Convex logs (via `gcloud` / `npx convex logs`) before diagnosing runtime errors.

## File Naming Conventions

- **Files:** kebab-case (`card-service.ts`, `use-card-lookup.ts`)
- **Components:** PascalCase exports (`CardDetail.tsx`)
- **Tests:** Co-locate as `.test.ts` / `.test.tsx`
- **Types:** `*.types.ts`

## Secrets Management

Sensitive credentials are stored in **Google Cloud Secret Manager**, not `.env` files. Access via `services/browser/src/services/secrets-manager.ts`. The Convex backend proxies credential operations through the browser service HTTP API (`apps/web/convex/credentials.ts`) — only the browser service touches Secret Manager.

## CI/CD

All workflows live in `.github/workflows/`. `pr-pipeline.yml` is the single all-PR orchestrator; area CI is keyed on `apps/web/**` vs `services/browser/**` vs `services/preprocess/**`:

- **`pr-pipeline.yml`** — the top-level per-PR orchestrator (runs on **every** PR, no path filter). `changes` (paths filter → `web` / `browser` / `preprocess` outputs) → conditional **`web-lint`** + **`web-unit`** (apps/web eslint + vitest), **`browser-test`** (services/browser build + unit) and **`preprocess-test`** (services/preprocess ruff + pytest) → **`web-preview`** (builds the PR's Vercel preview) → `wire-browser-url` (when `services/browser` changed: point the Convex preview's `NEONBINDER_BROWSER_URL` at this PR's `pr-<N>` browser preview) → **`e2e`** (calls the reusable `e2e.yml`) → **`ci-gate`**.
  - **`web-preview`** (NEO-162) builds the preview with the Vercel CLI. The Vercel **git integration is disabled for every branch** (`apps/web/vercel.json`), so nothing deploys itself — same reasoning as NEO-143's production lane, applied to previews. It exists because Vercel built for every PR including ones touching no web code, while `changes` already knew better; the decision now lives on the side that has the information. It also collapsed three byte-identical copies of a "poll the GitHub Deployments API for the vercel[bot] deployment" block (both wire jobs + `e2e.yml`'s setup) into one job output, so they can no longer disagree about which preview a PR has.
  - **The preview is not just a preview.** `vercel.json`'s `buildCommand` runs `npx convex deploy`, so building it is also what creates the per-PR **Convex** preview that both wire jobs write env vars to and that E2E runs against. That is why `web-preview`'s condition is `deps_only` — matching `e2e` exactly, *not* the narrower `changes.outputs.web`. **If you ever narrow one, narrow both**, or you get a PR that runs E2E with no backend to run it against.
  - `web-preview` also records the preview as a **GitHub Deployment**. That is not bookkeeping: `preview-cleanup.yml` finds the PR's Convex preview through that record, and its "no record ⇒ nothing to clean up" guard exits 0 — so without it, every Convex preview would leak silently. **`ci-gate`** is the single **required** status check: it `always()` runs and passes iff every in-scope job succeeded (out-of-area jobs skip), so web/browser lint+unit+E2E all block merge **without wedging** out-of-area PRs. A PR touching web + browser is validated end-to-end against its **own** browser code; web-only PRs run E2E against the dev browser default. **Vercel stays "dumb"** (SPA build + `convex deploy` only — it never calls the browser service); the browser-URL wiring is a deployment concern that lives here. *(web lint/unit are inlined here; there is no separate `web-ci.yml`.)*
- **`release.yml`** — ⚠️ **the single driver of every push-to-`main` production deploy** (NEO-143). `changes` (path diff → `browser` / `preprocess`) → those services' deploy lanes **to 100% traffic** → **then** the web job: `vercel pull` / `vercel build` (this is where `npx convex deploy` pushes production Convex) → `vercel deploy --prebuilt --prod --skip-domain` → smoke the staged build → `vercel promote`. Servers lead their clients: Convex is a client of the browser service, the SPA is a client of Convex. Before NEO-143 all three deployed in parallel from the same commit, putting ~5.5 minutes of new-Convex-against-old-browser-service in front of real users. **Do not add a `push:` trigger to any other workflow** — that is exactly what re-creates the race. Note Convex itself *cannot* be staged (one production deployment, and it owns its database), so the Convex push is a hard mid-job cutover; read `services/browser/README.md` → **Release contract** before changing anything on the Convex ↔ browser boundary.
- **`browser.yml`** — `services/browser` build + unit tests + the **per-PR browser preview** (builds the image, deploys a `pr-<N>` tagged, **no-traffic** Cloud Run revision on the dev service, runs a real BSC + SportLots login probe against it). **Pre-merge only.**
- **`browser-deploy.yml`** / **`preprocess-deploy.yml`** — the prod deploy lanes, `workflow_call`-only (invoked by `release.yml`; `workflow_dispatch` is retained for dev-only validation). **Both** dev and prod use blue/green — deploy at 0% under a `sha-<short>` tag, probe/smoke the tagged URL, then one atomic `update-traffic` that promotes *and* drops the tag (NEO-114). There is deliberately **no rollback job**: nothing is promoted until the probe passes, so there is nothing to roll back (NEO-67). Gated on the `BROWSER_DEPLOY_ENABLED` / `PREPROCESS_DEPLOY_ENABLED` repo variables.
- **`preprocess.yml`** — `services/preprocess` lint + unit tests + the **per-PR preprocess preview** (`pr-<N>` tagged no-traffic revision on the dev service + smoke + sticky PR comment). **Pre-merge only.**
- **`e2e.yml`** — reusable (`workflow_call`) Maestro suite on the NEO-49 dynamic Convex work-queue: a homogeneous pool of work-stealing runners drains a shared queue; the single required **`e2e`** gate is green iff every queued flow passed and the queue fully drained. Note it runs on **every** PR including preprocess-only ones — E2E cannot observe preprocess, but no carve-out exists, deliberately: `preprocess.yml` is path-filtered and therefore cannot block a merge, so `e2e` plus `preprocess-test` are what gate a preprocess PR.
- **`preview-cleanup.yml`** — on PR close, removes the `pr-<N>` Cloud Run tag + image, and deletes the PR's Convex preview. Browser and preprocess get **separate jobs**, because each authenticates as its own deployer SA and `google-github-actions/auth` rewrites ADC in place — a second auth in one job would silently run later steps as the wrong identity. The Convex job finds its target via the PR head SHA's GitHub Deployment record; since NEO-162 it accepts **both** `vercel[bot]` (PRs opened before the cutover) and `github-actions[bot]` (previews built by `web-preview`), so the pre-cutover backlog stays reclaimable.
- **`refresh-flow-timings.yml`** — weekly chore PR keeping the LPT flow-timings table aligned to main's flow set.
- **`e2e-repeat.yml`** — manual flakiness sampler (runs the suite N times).

## E2E Testing (Maestro)

Maestro flows live in `apps/web/.maestro/flows/`, mirroring app routes.

**Run locally** (validates against local Vite → the remote **dev** browser service):
```bash
cd apps/web
APP_URL=http://localhost:3000 npm run test:e2e
npm run test:e2e:pick -- <flow>   # run a subset (name / list / regex / tag) with prereq closure
```

> Local Maestro web runs headless at CI's **1024×629** viewport — always run via the npm scripts (bare `maestro test` is non-headless and hides CI-only fold/layout gotchas). Use parallelism 1 locally (higher crashes Chrome tabs on a laptop).

**In CI:** the suite runs via `pr-pipeline.yml` → `e2e.yml` on every PR (see CI/CD). The `e2e` check is the merge-blocking gate. Test users are provisioned per work-queue runner (`dev+e2e-<N>@neonbinder.io`); flows must be self-contained and parallel-safe (create-and-use their own data; no shared global state).

**Test tags:** `smoke`, `regression`, plus feature groupings (`auth`/`dashboard`/`profile`/...). Never add a `wip` tag — fix the underlying bug instead.
