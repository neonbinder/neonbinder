import { Client, type Dispatcher } from "undici";

/**
 * NEO-288: run a group of fetches over ONE TCP connection to one origin.
 *
 * Why this exists — measured on 2026-09-20, not theorised:
 *
 * SportLots binds the automated-access `authId` to the client IP that minted
 * it. The handshake (`POST /u/node/automated-access`) and the signin
 * (`POST /cust/custbin/signin.tpl`) therefore have to leave through the same
 * address. Node's global `fetch` does NOT guarantee that, even though the
 * handshake answers `Keep-Alive: timeout=5` and its socket is still open:
 * when the signin is dispatched synchronously after `await response.text()`,
 * undici's pool has not yet returned the handshake socket to the idle list,
 * so it opens a SECOND connection. Against a local keep-alive server, two
 * back-to-back global fetches land on TWO server-side sockets. From a laptop
 * both sockets carry one public IP and nobody notices; on Cloud Run's shared
 * egress pool the two sockets can carry different addresses, and SportLots
 * refuses the signin with "Security verification failed" on every attempt.
 * A sleep between the calls also "fixes" it, which is how you know it is a
 * race and not a delay — do not add one.
 *
 * A dedicated `undici.Client` is a single connection by construction (a
 * `Pool` is the thing that takes `connections`), so every request dispatched
 * through it shares one socket and therefore one egress IP. Passing it as
 * `dispatcher` works with Node's built-in `fetch` (Node 22's bundled undici
 * accepts an external dispatcher object) as well as `undici.fetch`; the
 * adapter keeps using the global `fetch` so the unit-test stubs still
 * intercept it. `pipelining: 1` keeps the requests strictly sequential on
 * the wire.
 *
 * Lifecycle: `fn` gets the client as `dispatcher`; the client is ALWAYS
 * closed in `finally`, whether `fn` resolves or throws. `close()` is
 * graceful — it lets an in-flight body finish — but it never resolves while
 * a response body is left unconsumed (undici holds the socket under
 * backpressure once the body exceeds the stream's high-water mark, measured
 * with a 200 KB 503 body), so the close is bounded: after `closeTimeoutMs`
 * the client is `destroy()`ed instead. A hung close would otherwise hang the
 * login route until Cloud Run kills it. Callers should still consume or
 * cancel every body they receive; the bound is a backstop, not the plan.
 *
 * One client per attempt: a retry mints a fresh authId, so it also gets a
 * fresh socket pair. Never share a client across attempts or across users.
 */

/** How long a graceful close may take before the client is destroyed instead. */
export const SINGLE_CONNECTION_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Idle keep-alive on OUR side. SportLots hints `Keep-Alive: timeout=5`, which
 * undici honours (minus its threshold) regardless; this is the floor for a
 * server that sends no hint. The signin answers `Connection: close`, so in
 * practice the socket is gone by the time `fn` resolves anyway.
 */
export const SINGLE_CONNECTION_KEEP_ALIVE_MS = 4_000;

export type SingleConnectionOptions = {
  /** Override the bounded-close timeout (tests). Default SINGLE_CONNECTION_CLOSE_TIMEOUT_MS. */
  closeTimeoutMs?: number;
};

export type { Dispatcher };

/**
 * `RequestInit` plus undici's `dispatcher` option. Node's `fetch` accepts it
 * at runtime, but this tsconfig compiles against the DOM lib, whose
 * `RequestInit` does not declare it; build the init as this type and hand it
 * to `fetch` (a subtype of `RequestInit`, so no cast at the call site).
 */
export type DispatchedRequestInit = RequestInit & { dispatcher: Dispatcher };

/**
 * Create a single-connection client for `origin`, run `fn` with it as the
 * `dispatcher`, and always close it afterwards.
 *
 * @param origin e.g. `https://www.sportlots.com` — scheme + host, no path.
 * @param fn     receives the dispatcher to pass as `{ dispatcher }` on every
 *               `fetch` that must share the socket.
 */
export async function withSingleConnection<T>(
  origin: string,
  fn: (dispatcher: Dispatcher) => Promise<T>,
  options: SingleConnectionOptions = {},
): Promise<T> {
  const client = new Client(origin, {
    pipelining: 1,
    keepAliveTimeout: SINGLE_CONNECTION_KEEP_ALIVE_MS,
  });
  try {
    return await fn(client);
  } finally {
    await closeBounded(client, options.closeTimeoutMs ?? SINGLE_CONNECTION_CLOSE_TIMEOUT_MS);
  }
}

/**
 * Graceful close, bounded. `close()` waits for in-flight requests; if it has
 * not resolved within `timeoutMs` (an unconsumed body under backpressure),
 * fall back to `destroy()`, which aborts them and releases the socket. Never
 * throws: the caller's own result — success or error — must not be replaced
 * by a teardown failure.
 */
async function closeBounded(client: Client, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([client.close().then(() => "closed" as const), timedOut]);
    if (outcome === "timeout") {
      await client.destroy();
    }
  } catch {
    // close() or destroy() rejected: the socket is being torn down either
    // way, and there is nothing useful (or safe) to report from here.
    try {
      await client.destroy();
    } catch {
      /* already destroyed */
    }
  } finally {
    clearTimeout(timer);
  }
}
