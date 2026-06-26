# CLAUDE.md

> **⚠️ MONOREPO (NEO-18, 2026-06-26):** This is now the consolidated monorepo
> `neonbinder/neonbinder` — **`apps/web`** (Vite SPA + Convex) and **`services/browser`**
> (Puppeteer → Cloud Run). One git repo, one CI pipeline (`.github/workflows/`), path-filtered
> lanes. The "**This is NOT a monorepo**" + "commit in each subdirectory separately" guidance
> below is **OBSOLETE** and pending a full rewrite (see `CUTOVER.md`). Deploy targets remain
> separate (Vercel / Convex / Cloud Run) — a monorepo doesn't merge runtimes.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NeonBinder is a multi-repository platform for trading card collectors to manage collections and sell across marketplaces (eBay, SportLots, BuySportsCards, MySlabs, MyCardPost).

**This is NOT a monorepo.** Each subdirectory is an independent project with its own git repository, package.json, and deployment pipeline. The root directory (`neonbinder/`) is a wrapper that holds shared Claude Code configuration (`.claude/`, `CLAUDE.md`) — it contains no application source code.

| Directory | Purpose | Tech Stack | Own Git Repo |
|-----------|---------|-----------|:---:|
| `neonbinder_web/` | Vite SPA + Convex backend | Vite 6, React 19, React Router 7, Convex, Clerk, TypeScript | Yes |
| `neonbinder_browser/` | Puppeteer automation service for marketplace scraping | Node.js, Puppeteer, Express 5, TypeScript | Yes |
| `NeonBinderApp/` | React Native mobile client | Expo 54, React Native, NativeWind | Yes |
| `neonbinder_terraform/` | GCP infrastructure provisioning | Terraform | Yes |

## Code Search & Navigation (CRITICAL)

**There is no source code at the root level.** All application code lives inside the project subdirectories above. When searching for code, files, functions, or patterns:

1. **Always search within the specific project directory** relevant to the task — e.g., `neonbinder_web/`, `neonbinder_browser/`, etc.
2. **If unsure which project**, search across all four: `neonbinder_web/`, `neonbinder_browser/`, `NeonBinderApp/`, `neonbinder_terraform/`.
3. **Never assume a search from the root that returns nothing means the code doesn't exist.** Narrow your search to the correct subdirectory and try again.
4. **Use path-scoped searches:** `Glob("**/*.ts", path="neonbinder_web")` or `Grep("functionName", path="neonbinder_browser/src")`.

## Git Commits (CRITICAL)

Each subdirectory is its own git repository. When the user asks for a git commit:

1. **Identify which project(s) have changes** — run `git status` inside each affected subdirectory (e.g., `cd neonbinder_web && git status`).
2. **Commit within each subdirectory separately** — `cd neonbinder_web && git add ... && git commit ...`.
3. **Never run git commands from the root expecting them to capture changes in subdirectories** — the root repo only tracks `.claude/` config and `CLAUDE.md`.
4. If changes span multiple projects, create a separate commit in each project directory.

## Development Commands

### neonbinder_web (main development)
```bash
npm run dev              # Start Vite frontend only (port 3000)
npm run dev:backend      # Start Convex dev server only (wraps ./dev-backend.sh)
npm run dev:all          # Start Vite + Convex in parallel (runs setup-env.sh first)
npm run dev:backend:tunnel  # Convex dev with cloudflared tunnel for browser service
npm run build            # Vite production build
npm run preview          # Preview built bundle
npm run lint             # ESLint
npx convex dev           # Convex dev server with hot reload (used by dev:backend)
npx convex deploy        # Deploy Convex functions to production
```

### neonbinder_browser
```bash
npm run dev              # Start with ts-node (development)
npm run build            # Compile TypeScript
npm start                # Run compiled server
npm run deploy           # Deploy to GCP Cloud Run
```

### NeonBinderApp
```bash
npm start                # Start Expo dev server
npm run ios              # Run on iOS simulator
npm run android          # Run on Android emulator
npm run storybook        # Component development with Storybook
```

## Architecture

```
Frontend (Web/Mobile)
    ↓
Convex Backend (neonbinder_web/convex/)
    ↓ calls
Browser Service (neonbinder_browser/) for marketplace automation
    ↓
External Marketplaces (via Puppeteer)
```

**Data Flow:** Image → Recognition → Structured Card → Collection → (Optional) Listing

### Key Entry Points
- **Web entry point:** `neonbinder_web/src/main.tsx` - Vite entry; mounts `BrowserRouter`, sets up providers (Clerk, Convex, PostHog, Sentry, Radix Theme), and declares all routes
- **Route layouts:** `neonbinder_web/src/layouts/ProtectedLayout.tsx` (auth-gated routes), `neonbinder_web/src/layouts/binder-layout.tsx` (binder shell)
- **Page components:** still under `neonbinder_web/app/<route>/page.tsx` — imported into `src/main.tsx` and mapped to React Router `<Route>` elements (no Next.js file-system routing)
- **Convex schema:** `neonbinder_web/convex/schema.ts` - database tables
- **Convex functions:** `neonbinder_web/convex/myFunctions.ts`
- **Marketplace adapters:** `neonbinder_web/convex/adapters/` - platform integrations
- **Browser automation:** `neonbinder_browser/src/index.ts` - Express server with adapter routes

> **Note:** `neonbinder_web/app/layout.tsx` is a leftover Next.js stub kept only for migration reference — it is not the active root layout. Provider setup lives in `src/main.tsx`.

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
- Clerk handles user authentication via `<ClerkProvider>` in `src/main.tsx`
- JWT passed to Convex with `aud: "convex"` claim
- Get current user in Convex: `getCurrentUserId(ctx)` from `./auth`
- Protected routes are wrapped with `<ProtectedLayout>` in `src/main.tsx` (no `middleware.ts` — that was Next.js)
- Public routes (rendered without `ProtectedLayout`): `/`, `/signin/*`, `/sign-up/*`, `/binder-tracking`, `/ai-card-identification`, `/managing-inventory`

## Environment Setup

### GCP Service Accounts

Each service uses a dedicated service account, managed by Terraform (`neonbinder_terraform/`):

All NeonBinder GCP projects live under the `neonbinder.io` organization (org ID `250044610272`) billed from the `Neon Binder Billing` account. Project topology:

- **Prod:** `neonbinder` (project number `117170654588`)
- **Dev:** `neonbinder-dev` (project number `339836466983`)

| Service Account | Project | Purpose | Local Auth Method |
|---|---|---|---|
| `neonbinder-browser-runtime` | `neonbinder-dev` (dev) / `neonbinder` (prod) | Browser service runtime (Cloud Run + local dev) | SA impersonation via ADC |
| `neonbinder-browser-deployer` | `neonbinder-dev` (dev) / `neonbinder` (prod) | GitHub Actions CI/CD | Workload Identity Federation |
| `neonbinder-convex` | `neonbinder-dev` (dev) / `neonbinder` (prod) | Convex backend (GCS) | SA key in Convex env (`GOOGLE_APPLICATION_CREDENTIALS_B64`); Convex runs off-GCP, can't use WIF |

**Org policy:** SA key creation is disabled (`iam.disableServiceAccountKeyCreation`) except for the two `neonbinder-convex` SAs, which have an explicit exception because Convex Cloud requires a key to authenticate to GCS. Everywhere else, use impersonation.

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
# Key env vars (in .env.local — Vite exposes anything prefixed with VITE_ to the client):
# VITE_CONVEX_URL              - Convex deployment URL
# VITE_CLERK_PUBLISHABLE_KEY   - Clerk public key
# CLERK_SECRET_KEY             - Clerk secret (server-side / Convex only)
# ENCRYPTION_KEY               - 32-char key for credential encryption
# NEONBINDER_BROWSER_URL       - Browser service URL (default: http://localhost:8080)
```

> Convex dev reads its own env from `.env.convex` when `npm run dev:backend` is used (see `dev-backend.sh`).

For marketplace automation testing, start the browser service first:
```bash
cd neonbinder_browser && npm start  # Runs on port 8080 (reads .env for GCP credentials)
```

## UI & Styling

- **Theme:** Dark UI with neon accents (90s hobby-shop aesthetic)
- **Colors:** Primary=Neon Green (#00D558), Cancel=Neon Pink (#FF2EB3), Accent=Blue (#00B7FF)
- **Font:** Lexend
- **Components:** Radix UI Themes, Tailwind CSS 4.x
- **Structure:** `/components/primitives/` (base), `/components/modules/` (composed)

## Observability

- **Sentry:** Error tracking, performance monitoring, structured logging
- **PostHog:** Product analytics, feature flags, user tracking
- Correlation: Include `requestId`, `userId` in both systems

## File Naming Conventions

- **Files:** kebab-case (`card-service.ts`, `use-card-lookup.ts`)
- **Components:** PascalCase exports (`CardDetail.tsx`)
- **Tests:** Co-locate as `.test.ts` / `.test.tsx`
- **Types:** `*.types.ts`

## Secrets Management

Sensitive credentials stored in **Google Cloud Secret Manager**, not `.env` files. Access via `neonbinder_browser/src/services/secrets-manager.ts`. The Convex backend proxies credential operations through the browser service HTTP API (`neonbinder_web/convex/credentials.ts`).

## E2E Testing (Maestro)

Maestro flows live in `neonbinder_web/.maestro/flows/` mirroring app routes:

| App route | Flow directory |
|---|---|
| `/signin` | `auth/` |
| `/dashboard` | `dashboard/` |
| `/profile` | `profile/` |
| `/u/[username]` | `public-profile/` |

**Run locally:**
```bash
cd neonbinder_web
APP_URL=http://localhost:3000 TEST_EMAIL=... TEST_PASSWORD=... npm run test:e2e
npm run test:e2e:smoke   # smoke-tagged flows only
```

**Known constraint — Clerk bot protection:** Automated sign-in flows may be blocked by Clerk's bot detection. Use [Clerk testing tokens](https://clerk.com/docs/testing/overview) to bypass this in CI/test environments. Set `CLERK_SECRET_KEY` and generate a token server-side to pre-authenticate test sessions.

**GitHub Actions:** `.github/workflows/e2e-tests.yml` waits for the Vercel preview URL then runs the smoke suite via Maestro Cloud. Required secrets: `MAESTRO_API_KEY`, `MAESTRO_TEST_EMAIL`, `MAESTRO_TEST_PASSWORD`, `VERCEL_TOKEN`.

**Test tags:** `smoke` (every PR), `regression` (nightly/main), `auth`/`dashboard`/`profile` (feature groupings).
