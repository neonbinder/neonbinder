---
name: router-navigation-is-a-transition
description: React Router's BrowserRouter/MemoryRouter commit every navigation (incl. setSearchParams) inside startTransition, so a plain setState in the same handler renders a frame of the OLD URL first; wrap those updates in startTransition to share the navigation's lane
metadata:
  type: reference
---

`BrowserRouter` (and `MemoryRouter` in tests) wraps its history listener's
`setState` in `React.startTransition` unless `useTransitions={false}` is set
(it is not, in `src/main.tsx`). So a handler that calls `setSearchParams(...)`
AND a plain `setState(...)` produces TWO commits: the sync update first,
rendered against the old URL, then the navigation. Every query under the old
selection runs one more pass, and a test that records query args after the
click sees the old args (NEO-224: `SetSelector.baseParallels` "plan query is
skipped" went red on exactly this).

`setSearchParams` also changes identity whenever the params change, and its
functional form closes over the params of the render it was created in — not
the latest. Handlers fed to memoized children need a latest-value ref.

**How to apply:** when moving state into the URL, wrap the sibling local
updates in `startTransition(() => …)` (React gives every transition started in
one event the same lane, so they land in the navigation's commit). A setState
an UNOWNED child makes in the same event (e.g. a column's own `setExpanded`)
still renders first — expect a one-frame stale render there, and do not
"fix" it with a timeout; `flushSync` cannot flush a transition either.

Related: [[url-state-trusted-id-gate]] (NEO-224's `useDrillUrlState`).
