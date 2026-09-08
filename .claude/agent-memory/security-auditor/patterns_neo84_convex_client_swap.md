---
name: neo84-convex-client-swap
description: Why rebuilding the ConvexReactClient (NEO-84 socket-stall fix) is auth-safe, and why Convex ConnectionState is safe to render on screen — the two checks to re-run if this code changes
metadata:
  type: project
---

NEO-84 (PR #168) made `ConvexClientProvider` able to rebuild its `ConvexReactClient`
on demand (a `generation` counter keyed into `useMemo`) to escape a half-open
websocket. Two questions get asked every time that code is touched; both were
verified against `convex@1.43.0` and came back clean.

**1. Is `ConnectionState` safe to render on screen / ship to PostHog?**
Yes. `node_modules/convex/dist/cjs-types/browser/sync/client.d.ts` (~line 116)
defines it as booleans + numbers + one `Date`: `hasInflightRequests`,
`isWebSocketConnected`, `timeOfOldestInflightRequest`, `hasEverConnected`,
`connectionCount`, `connectionRetries`, `inflightMutations`, `inflightActions`.
No token, no deployment URL, no identity, no query args. Rendering it into the DOM
is therefore safe even though Maestro E2E artifacts have historically been public
(NEO-29). **If Convex is upgraded, re-check that type** — the safety of the
on-screen banner in `ResilientEntityColumn.tsx` rests entirely on it.

**2. Does swapping the client open an unauthenticated window?**
No. `ConvexProviderWithAuth` (`dist/cjs/react/ConvexAuthState.js`) takes `client`
in its effect deps, so a new client re-runs the wiring, and
`AuthenticationManager.setConfig()` (`dist/cjs/browser/sync/authentication_manager.js:71`)
calls `pauseSocket()` *before* awaiting the token — no query leaves the new socket
until Authenticate is set. The superseded client is `clearAuth()`d by
`ConvexAuthStateLastEffect`'s cleanup (which closes over the OLD client) and then
`close()`d by the provider's own effect; parent effects run after child effects, so
the old client dies only after the tree is reading the new one. A rebuilt client
also starts with an empty query cache, so a swap cannot bleed one session's cached
data into another.

**How to apply:** don't re-litigate these two on every diff that touches the
provider — re-verify only on a `convex` major/minor bump, or if someone starts
rendering more than `ConnectionState` in the stall banner.
