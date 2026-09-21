---
name: undici-socket-reuse-and-close
description: Node's global fetch does NOT keep two back-to-back requests on one socket (pool race); use withSingleConnection for IP-bound multi-step flows; an unconsumed body >16 KiB makes undici Client.close() hang forever
metadata:
  type: reference
---

Two measured undici facts that bite in `services/browser` (NEO-288, 2026-09-20):

1. **Global `fetch` gives no same-socket guarantee.** After `await res.text()`
   on request A, undici has not yet returned A's socket to the idle pool, so
   request B dispatched synchronously opens a SECOND connection even though
   A's socket is open and keep-alive. Against a local keep-alive server this
   reproduces 100% (two server-side sockets). Invisible on a laptop (one
   public IP); on a shared egress pool the two sockets can carry different
   IPs, which breaks anything that binds a token to the minting IP. A sleep
   "fixes" it — that is the tell it is a race; never add the sleep. The fix is
   `withSingleConnection(origin, fn)` in `src/services/single-connection.ts`:
   a dedicated `undici.Client` (one connection by construction — `connections`
   is a Pool option, TS rejects it on Client) passed as `dispatcher` to every
   fetch that must share the socket. Works with Node's built-in fetch and an
   external undici 7 Client (cross-version handler compat verified on Node 22).
   `tests/single-connection.test.mjs` pins one-socket vs two-socket.

2. **`Client.close()` never resolves while a response body is unconsumed**
   once the body exceeds the fetch stream's high-water mark (~16 KiB) —
   backpressure holds the socket; measured with a 200 KB 503 body. `close()`
   after `body.cancel()`, after `text()`, or after an AbortSignal abort all
   resolve in ~1 ms. So: every early-return branch on a response must
   `discardBody(response)` (the NEO-281 helper in the SportLots adapter), and
   `withSingleConnection` races `close()` against a bound and falls back to
   `destroy()`.

The DOM lib in this tsconfig hides undici's `dispatcher` option from
`RequestInit`; build the init as `DispatchedRequestInit` (exported from
single-connection.ts) rather than casting at the call site.
