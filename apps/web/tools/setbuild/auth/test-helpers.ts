/**
 * NEO-339 — shared fakes for the set-build auth tests. Not a test file itself
 * (no `.test.` in the name), so it is never collected.
 */

export function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** An unsigned JWT with the given claims; enough for the tool's bookkeeping. */
export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.c2ln`;
}

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/**
 * A fetch stub that routes by `METHOD path` and records every call. An
 * unrouted call fails the test loudly rather than reaching the network.
 * A route may be an array: each call takes the next entry (the last repeats).
 */
export function routedFetch(routes: Record<string, Responder | Responder[]>): {
  fetchFn: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const counters = new Map<string, number>();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const pathKey = url.pathname.replace(/sess_[A-Za-z0-9]+/, "{sid}");
    const key = `${call.method} ${pathKey}`;
    const route = routes[key];
    if (!route) throw new Error(`unrouted fake fetch: ${key}`);
    if (Array.isArray(route)) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      return route[Math.min(n, route.length - 1)](call);
    }
    return route(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A publishable key for `fapiHost` in Clerk's encoding. */
export function publishableKeyFor(fapiHost: string): string {
  return `pk_test_${btoa(`${fapiHost}$`)}`;
}
