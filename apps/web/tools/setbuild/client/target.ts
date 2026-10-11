/**
 * NEO-339 — which Convex deployment a run talks to, and the phrase that proves
 * the operator knows.
 *
 * Every write the tool makes is gated on `BUILD <convex host> <scope>`. The
 * phrase names the deployment, so a command copied from a preview run cannot
 * silently write to production: the host in the phrase stops matching.
 */

export interface Target {
  /** `https://<deployment>.convex.cloud` — origin only, no trailing slash. */
  convexUrl: string;
  /** `https://<deployment>.convex.site` — where HTTP actions live. */
  convexSite: string;
  /** `<deployment>.convex.cloud` — the host the confirm phrase names. */
  host: string;
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Parse a Convex deployment URL.
 *
 * - `https://x.convex.cloud` → site `https://x.convex.site`.
 * - A local backend (`http://127.0.0.1:3210`) → site on the next port (3211),
 *   which is where `convex dev --local` serves HTTP actions.
 * - Anything else needs `siteUrl`.
 *
 * Plain `http://` is accepted only for a local backend.
 */
export function parseTarget(convexUrl: string, opts: { siteUrl?: string } = {}): Target {
  let url: URL;
  try {
    url = new URL(convexUrl.trim());
  } catch {
    throw new TargetError("The Convex URL is not a URL (expected https://<deployment>.convex.cloud).");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new TargetError("The Convex URL must be https:// (plain http is allowed only for a local backend).");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new TargetError("The Convex URL must be the deployment origin, with no path or query.");
  }

  let convexSite: string;
  if (opts.siteUrl) {
    try {
      convexSite = new URL(opts.siteUrl.trim()).origin;
    } catch {
      throw new TargetError("The Convex site URL is not a URL.");
    }
  } else if (url.hostname.endsWith(".convex.cloud")) {
    convexSite = `${url.protocol}//${url.hostname.replace(/\.convex\.cloud$/, ".convex.site")}${url.port ? `:${url.port}` : ""}`;
  } else if (local && url.port) {
    convexSite = `${url.protocol}//${url.hostname}:${Number(url.port) + 1}`;
  } else {
    throw new TargetError(
      "Cannot derive the Convex site URL from a custom domain; pass --convex-site-url.",
    );
  }
  return { convexUrl: url.origin, convexSite, host: url.host };
}

/** `BUILD <host> <scope>` — the exact string a write must be confirmed with. */
export function confirmPhrase(t: Target, scope: string): string {
  const trimmed = scope.trim();
  if (!trimmed) throw new TargetError("A confirm phrase needs a non-empty scope.");
  return `BUILD ${t.host} ${trimmed}`;
}

/**
 * Thrown by every write path BEFORE any network call when the supplied phrase
 * is missing or wrong. The message names the expected phrase: the phrase is
 * not a secret, it is proof of attention to the target.
 */
export class ConfirmMismatch extends Error {
  readonly expected: string;
  constructor(expected: string, given: string | undefined) {
    super(
      given === undefined || given === ""
        ? `This write needs the confirm phrase "${expected}".`
        : `The confirm phrase does not match. Expected "${expected}".`,
    );
    this.name = "ConfirmMismatch";
    this.expected = expected;
  }
}

/** Throw `ConfirmMismatch` unless `given` is exactly the phrase for `t` + `scope`. */
export function assertConfirm(t: Target, scope: string, given: string | undefined): void {
  const expected = confirmPhrase(t, scope);
  if (given !== expected) throw new ConfirmMismatch(expected, given);
}
