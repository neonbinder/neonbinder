/**
 * NEO-339 — which Convex deployment a run talks to, and the phrase that proves
 * the operator knows.
 *
 * Every write the tool makes is gated on `BUILD <convex host> <scope> <digest>`.
 * The phrase names the deployment, so a command copied from a preview run
 * cannot silently write to production: the host in the phrase stops matching.
 * The digest is the first 8 hex characters of the SHA-256 of the write's
 * content (the parsed spec, or a write tool's arguments) as canonical JSON, so
 * a phrase the operator approved for one spec cannot confirm an edited one.
 */

import { createHash } from "node:crypto";

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

/** True for a loopback host name (`localhost`, `127.0.0.1`, `[::1]`). */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

/**
 * Refuse a site URL that is not the `.convex.site` twin of the Convex URL.
 *
 * The machine token source posts the Clerk API key to the site URL, and the
 * confirm phrase names only the Convex URL's host. A site URL the phrase does
 * not bind could send that key anywhere, so for machine auth the two must be
 * the same deployment. A local backend (both on loopback) is the one
 * exception: its site is on another port, and nothing leaves the machine.
 */
export function assertSiteIsTwin(t: Target): void {
  const cloud = new URL(t.convexUrl);
  const site = new URL(t.convexSite);
  if (isLocalHost(cloud.hostname) && isLocalHost(site.hostname)) return;
  const twin =
    cloud.protocol === "https:" && cloud.hostname.endsWith(".convex.cloud")
      ? parseTarget(t.convexUrl).convexSite
      : undefined;
  if (twin === undefined || site.origin !== twin) {
    throw new TargetError(
      `--auth machine sends the API key to the Convex site URL, so it must be ${twin ?? "the .convex.site twin of an https://<deployment>.convex.cloud URL"}` +
        ` (the deployment the confirm phrase names), not ${site.origin}. Drop --convex-site-url / NB_SETBUILD_CONVEX_SITE_URL.`,
    );
  }
}

/**
 * JSON with every object's keys sorted (by UTF-16 code unit), no whitespace,
 * and `undefined` members dropped, as `JSON.stringify` drops them. Two values
 * that mean the same thing serialise to the same text whatever order their
 * keys were written in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    // undefined, a function or a symbol at the top level: JSON has no spelling.
    return text === undefined ? "null" : text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined || typeof v === "function" || typeof v === "symbol" ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const members = Object.keys(obj)
    .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function" && typeof obj[k] !== "symbol")
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${members.join(",")}}`;
}

/** The first 8 hex characters of SHA-256 over `canonicalJson(value)`. */
export function contentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex").slice(0, 8);
}

const DIGEST_RE = /^[0-9a-f]{8}$/;

/** `BUILD <host> <scope> <digest>` — the exact string a write must be confirmed with. */
export function confirmPhrase(t: Target, scope: string, digest: string): string {
  const trimmed = scope.trim();
  if (!trimmed) throw new TargetError("A confirm phrase needs a non-empty scope.");
  if (!DIGEST_RE.test(digest)) throw new TargetError("A confirm phrase needs an 8-character content digest.");
  return `BUILD ${t.host} ${trimmed} ${digest}`;
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

/** Throw `ConfirmMismatch` unless `given` is exactly `expected`. */
export function assertPhrase(expected: string, given: string | undefined): void {
  if (given !== expected) throw new ConfirmMismatch(expected, given);
}

/** Throw `ConfirmMismatch` unless `given` is exactly the phrase for `t` + `scope` + `digest`. */
export function assertConfirm(t: Target, scope: string, digest: string, given: string | undefined): void {
  assertPhrase(confirmPhrase(t, scope, digest), given);
}
