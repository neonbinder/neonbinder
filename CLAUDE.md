# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NeonBinder is a platform for trading card collectors to manage collections and sell across marketplaces (eBay, SportLots, BuySportsCards, MySlabs, MyCardPost).

**This is the consolidated monorepo `neonbinder/neonbinder` (NEO-18).** One git repo, one CI pipeline (`.github/workflows/`), path-filtered lanes. Two deployable projects live side by side plus shared Claude config:

| Path | Purpose | Tech Stack | Deploy target |
|------|---------|-----------|---------------|
| `apps/web/` | Vite SPA + Convex backend | Vite 6, React 19, React Router 7, Convex, Clerk, TypeScript | Vercel (SPA) + Convex |
| `services/browser/` | Puppeteer automation service for marketplace login/scraping | Node.js, Puppeteer, Express 5, TypeScript | GCP Cloud Run |
| `.claude/`, `CLAUDE.md` | Shared Claude Code config (agents, skills, memory) | — | — |
| `.github/workflows/` | Unified CI/CD (see **CI/CD** below) | GitHub Actions | — |

> A monorepo doesn't merge runtimes: `apps/web` still deploys to Vercel/Convex and `services/browser` still deploys to Cloud Run — they're just one repo now.
>
> **Not in this repo:** GCP infrastructure is a separate Terraform repo, **`neonbinder/neonbinder_ioc`** (GitFlow: `develop`→dev apply, `main`→prod apply). The React Native mobile client (`NeonBinderApp`) is **paused** and not part of the monorepo today; it's expected to return after the web stabilizes (keep cross-platform concerns like Maestro in mind).

## Code Search & Navigation

Application code lives under `apps/web/` and `services/browser/`. When searching:

1. **Scope to the relevant project** — `apps/web/` (frontend + Convex) or `services/browser/` (Puppeteer service).
2. **If unsure**, search both. Example: `Glob("**/*.ts", path="apps/web")` or `Grep("functionName", path="services/browser/src")`.
3. The repo root holds only config (`.claude/`, `.github/`, `CLAUDE.md`, `CUTOVER.md`) — no application source.

## Git & Branching

One repository, one git history. Standard model:

1. **Branch off latest `main`** (`git fetch origin && git pull`), ideally in a worktree named for the ticket.
2. **One commit captures all changes** across `apps/web` and `services/browser` — they share a history now. No more per-subdirectory commits.
3. **Feature branch → PR → squash-merge.** Trunk-based; never push directly to `main`.
4. Terraform lives in the separate `neonbinder_ioc` repo and follows **GitFlow** there (feature → `develop` → `main`).

End commit messages with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

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

Each service uses a dedicated service account, managed by Terraform in the **`neonbinder_ioc`** repo. All NeonBinder GCP projects live under the `neonbinder.io` organization (org ID `250044610272`). Project topology:

- **Prod:** `neonbinder` (project number `117170654588`)
- **Dev:** `neonbinder-dev` (project number `339836466983`)

| Service Account | Project | Purpose | Local Auth Method |
|---|---|---|---|
| `neonbinder-browser-runtime` | `neonbinder-dev` (dev) / `neonbinder` (prod) | Browser service runtime (Cloud Run + local dev) | SA impersonation via ADC |
| `neonbinder-browser-deployer` | `neonbinder-dev` (dev) / `neonbinder` (prod) | GitHub Actions CI/CD (WIF) | Workload Identity Federation |
| `neonbinder-convex` | `neonbinder-dev` (dev) / `neonbinder` (prod) | Convex backend (GCS + OIDC to browser) | SA key in Convex env (`GOOGLE_APPLICATION_CREDENTIALS_B64`); Convex runs off-GCP, can't use WIF |

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

All workflows live in `.github/workflows/`. Path-filtered lanes keyed on `apps/web/**` vs `services/browser/**`:

- **`web-ci.yml`** — `apps/web` lint + unit tests (vitest/eslint).
- **`browser.yml`** — `services/browser` build + unit tests, and the **per-PR browser preview**: builds the image, deploys a `pr-<N>` tagged, **no-traffic** Cloud Run revision on the dev service, and runs a real BSC + SportLots login probe against it. (The push-to-`main` prod deploy lane lands at cutover — see `CUTOVER.md`.)
- **`pr-pipeline.yml`** — the top-level per-PR orchestrator: `changes` (paths filter) → `wire-browser-url` (when `services/browser` changed: point the Convex preview's `NEONBINDER_BROWSER_URL` at this PR's `pr-<N>` browser preview) → **`e2e`** (calls the reusable `e2e.yml`). So a PR touching web + browser is validated end-to-end against its **own** browser code; web-only PRs run E2E against the dev browser default. **Vercel stays "dumb"** (SPA build + `convex deploy` only — it never calls the browser service); the browser-URL wiring is a deployment concern that lives here.
- **`e2e.yml`** — reusable (`workflow_call`) Maestro suite on the NEO-49 dynamic Convex work-queue: a homogeneous pool of work-stealing runners drains a shared queue; the single required **`e2e`** gate is green iff every queued flow passed and the queue fully drained.
- **`preview-cleanup.yml`** — on PR close, removes the `pr-<N>` Cloud Run tag + image.
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
