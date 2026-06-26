---
name: project-observability-stack-truth
description: Sentry is React-client-only in neonbinder_web; Convex actions have no Sentry — server-side observability is PostHog + structured console logs only
metadata:
  type: project
---

## Fact

The neonbinder_web repo only depends on `@sentry/react` and `@sentry/vite-plugin`. There is no `@sentry/node` / `@sentry/serverless` / `@sentry/google-cloud-serverless` dependency, and `convex/` code has no Sentry import.

**Implication:** Sentry spans/transactions on the Convex action runtime are not available. Any task that says "add Sentry spans to a Convex action" needs to be re-scoped — the only server-side sink we already pay for is PostHog (via `internal.posthog.captureEvent`, see `convex/posthog.ts`). Structured `console.log(JSON.stringify(...))` goes to Convex logs and is the secondary fallback.

The browser service (`neonbinder_browser/`) is also Sentry-free as of 2026-05-26 — its server-side observability is structured Cloud Run logs (stdout JSON) only.

## Why

`CLAUDE.md` says "Sentry: Error tracking, performance monitoring, structured logging" which reads like a full-stack claim, but the actual install scope is client-only. Don't trust that line as a server-side capability statement.

## How to apply

- If asked for Sentry server instrumentation, surface this constraint up front and propose PostHog + structured logs instead, OR scope adding `@sentry/node` as an explicit deliverable (which means a new env var `SENTRY_DSN` in Convex env + a new package dep — needs user approval).
- For new instrumentation on Convex actions, follow the `adapter_sync_call` PostHog event pattern in `convex/observability.ts` (introduced in `jburich/observe-adapter-perf` worktree, NEO-24 follow-up).
- The dashboard query pattern is documented in the header comment of `convex/observability.ts`.
