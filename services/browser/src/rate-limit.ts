import { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

/**
 * Rate-limit bucket key — PER CREDENTIAL KEY (≈ per user+site), NOT per IP.
 *
 * WHY THIS EXISTS (NEO-47):
 *   Cloud Run IAM gates callers to the single `neonbinder-convex` service
 *   account (see the auth note in index.ts), so EVERY request reaches this
 *   service from that one backend's egress IP. An IP-keyed limit therefore
 *   collapsed to a SINGLE global budget shared by all users — a handful of
 *   concurrent users (or parallel E2E workers) fanned out through Convex would
 *   429 each other almost immediately, including credential STOREs (then the
 *   PUT /credentials seed write, since removed), which silently dropped seeds
 *   and poisoned the parallel suite. Bucketing by the credential key isolates
 *   each user's own budget while
 *   still capping a runaway loop on a single marketplace account.
 *
 * The credential key (`<site>-credentials-<userId>`) is an identifier, not a
 * secret — it's already in the URL/body of every credential request, so using
 * it as a rate-limit bucket leaks nothing that wasn't already present.
 *
 * Keyless routes (e.g. /health) carry no credential key and fall back to a
 * normalized IP via express-rate-limit's `ipKeyGenerator` (IPv6-safe).
 *
 * IMPORTANT — read the key from req.path, NOT req.params. The limiter is
 * installed as GLOBAL middleware (app.use), which runs BEFORE Express matches a
 * route, so `req.params` is still empty here for the URL-keyed routes
 * (GET/DELETE /credentials/:key, /credentials/:key/metadata|/token). Reading
 * req.params would silently collapse every one of those to the IP bucket — the
 * failure mode that produced the credential-write 429s this exists to fix. The
 * path is available pre-routing, so we parse the `:key` segment from it directly.
 * `/credentials/check` is the one /credentials/* route that is body-keyed
 * (keys[]), and /login/* carry body.key — both are parsed (express.json runs
 * before this middleware), so the body fallbacks cover them.
 *
 * NEO-121 — `/easypost/:key/*` is parsed here too, and that is a FIX, not an
 * extension. Every EasyPost route has carried the credential key in the same
 * first-segment position since NEO-120, but this parser only recognised
 * `credentials`, so rate/buy/label — and now tracker and webhooks — all fell
 * through to the IP fallback. Behind Cloud Run IAM that fallback is a single
 * global 60/min budget shared by every seller: exactly the failure NEO-47
 * created this function to fix, quietly reintroduced for the postage routes.
 * Two sellers buying labels at the same moment could 429 each other off the
 * money path.
 *
 * All `/easypost/*` routes share one bucket per seller, read and write alike.
 * That is deliberate — the point is to bound one seller's total pressure on
 * their own EasyPost account, and a read loop that starved the buy path of its
 * budget would be the same outage in a smaller costume. The on-demand tracker
 * refresh has its own server-side cooldown in Convex for that reason.
 */
export function credentialRateLimitKey(req: Request): string {
  const credKey =
    keyFromPath(req.path ?? "") ??
    (req.params as { key?: string } | undefined)?.key ??
    (req.body as { key?: string; keys?: string[] } | undefined)?.key ??
    (req.body as { keys?: string[] } | undefined)?.keys?.[0];
  return credKey ? `cred:${credKey}` : ipKeyGenerator(req.ip ?? "");
}

/**
 * Pull the credential key out of a URL path, pre-routing.
 *
 * segments = ["", "<prefix>", "<key>", ...] for both key-in-path families:
 * `/credentials/:key[/metadata|/token]` and `/easypost/:key[/...]`.
 *
 * `/credentials/check` is the one collision — a route name where a key would
 * be — and it is body-keyed instead. No `/easypost/*` route has a fixed second
 * segment, so it needs no equivalent exclusion; if one is ever added, it needs
 * one here too, or every caller of it shares a bucket named after the route.
 */
function keyFromPath(path: string): string | undefined {
  const [, prefix, candidate] = path.split("/");
  if (!candidate) return undefined;
  if (prefix === "credentials") {
    return candidate === "check" ? undefined : candidate;
  }
  if (prefix === "easypost") return candidate;
  return undefined;
}
