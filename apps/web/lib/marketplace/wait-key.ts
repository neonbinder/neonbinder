/**
 * NEO-487 — a run key for `marketplaceWaits`: at most 64 characters of
 * [A-Za-z0-9_-], fresh per operation (one checklist fetch, one parallel run,
 * one parallel build). The client mints it, passes it to the action, and
 * subscribes to `marketplaceWaits.forRun` with it.
 *
 * Not a secret and not an identity: the server scopes every read of a key to
 * the caller who wrote it. Pure, so any module can mint one without pulling
 * in Convex.
 */
export function mintWaitKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** The server's shape rule for a key, mirrored for callers that take one in. */
export const WAIT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
