---
name: Blank bootstrap page is a stale Vite dep cache
description: A local run whose bootstrap fails on a pure-white page with no ARIA tree, after a merge that changed dependencies, is Vite's optimize-dep cache being stale (504 "Outdated Optimize Dep"), not the spec or the sign-in hop
type: pattern
---
Signature: `worker-bootstrap` fails at its first heading wait; the screenshot
is all white; `error-context.md` has no page snapshot. In the trace's
console: several `Failed to load resource: ... 504 (Outdated Optimize Dep)`.
A rerun does not fix it.

Cause: a long-running Vite was started before a merge that changed
`package.json`/lockfile; its pre-bundled deps no longer match. Not an app bug,
not a sign-in/secret problem (the sign-in URL still returns 200).

How to check fast (no spec edits): unzip the failed run's `trace.zip` into a
scratch dir and grep the `*.trace` console entries for `Outdated Optimize Dep`.

Fix belongs to whoever owns that Vite: restart it with `--force`. It shares
`node_modules/.vite` with any other Vite in that worktree, so do not start a
second one to work around it without telling the owner. One check, then stop
and report (GUIDE: environment stalls are not spec bugs).
