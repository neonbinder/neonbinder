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
 *   429 each other almost immediately, including credential STOREs
 *   (PUT /credentials), which silently dropped seeds and poisoned the parallel
 *   suite. Bucketing by the credential key isolates each user's own budget while
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
 * (PUT/GET/DELETE /credentials/:key, /credentials/:key/metadata|/token). Reading
 * req.params would silently collapse every one of those to the IP bucket — which
 * includes PUT /credentials (the seed write whose 429s started this). The path
 * is available pre-routing, so we parse the `:key` segment from it directly.
 * `/credentials/check` is the one /credentials/* route that is body-keyed
 * (keys[]), and /login/* carry body.key — both are parsed (express.json runs
 * before this middleware), so the body fallbacks cover them.
 */
export function credentialRateLimitKey(req: Request): string {
  // segments = ["", "credentials", "<key>", ...] for /credentials/:key routes.
  const segments = (req.path ?? "").split("/");
  const pathKey =
    segments[1] === "credentials" && segments[2] && segments[2] !== "check"
      ? segments[2]
      : undefined;
  const credKey =
    pathKey ??
    (req.params as { key?: string } | undefined)?.key ??
    (req.body as { key?: string; keys?: string[] } | undefined)?.key ??
    (req.body as { keys?: string[] } | undefined)?.keys?.[0];
  return credKey ? `cred:${credKey}` : ipKeyGenerator(req.ip ?? "");
}
