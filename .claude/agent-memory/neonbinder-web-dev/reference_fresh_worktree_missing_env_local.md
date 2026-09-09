---
name: fresh-worktree-missing-env-local
description: A fresh apps/web worktree has no .env.local, so every route renders a blank black page and the only clue is a ClerkProviderBase warning — not a code bug
metadata:
  type: reference
---

A newly created monorepo worktree does **not** inherit `apps/web/.env.local` (it is
gitignored, so `git worktree add` never brings it across). Without it the Clerk
publishable key is undefined, `<ClerkProviderBase>` throws during the provider
tree render, and **the entire app fails to mount** — every route, public or
protected, paints a blank near-black page.

The failure is nearly silent. There is no error overlay and no red console
error; the only signal is a React *warning*:

> An error occurred in the `<ClerkProviderBase>` component. Consider adding an
> error boundary to your tree…

It reads exactly like the page you just wrote is broken. It is not.

**Fix:** copy the file from any sibling worktree, e.g.
`cp ../<other-worktree>/apps/web/.env.local apps/web/.env.local`. It stays
gitignored, so it creates no diff.

**Caveat after copying:** the borrowed `VITE_CONVEX_URL` points at the *other*
branch's Convex preview deployment. If that preview has been garbage-collected
you get "Waiting for authentication" hangs — the known stale-preview-URL trap,
not a bug in your code.

Check this BEFORE debugging a blank page in a new worktree; it is the first
thing to rule out, alongside the rolldown native-binding bug that `npm ci` does
not fix and the Node 24.3.0 pin.

Related: [[vercel-build-runs-convex-typecheck]].
