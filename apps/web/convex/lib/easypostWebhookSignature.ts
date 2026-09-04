/**
 * NEO-121 — EasyPost webhook signature verification, as three pure functions.
 *
 * ## Why this is its own module, and why it has no `"use node"`
 * The webhook handler is an `httpAction`, so it runs in the DEFAULT Convex
 * runtime — `node:crypto` (and therefore `createHmac` / `timingSafeEqual`) is
 * unavailable to it. Everything here is built on Web Crypto (`crypto.subtle`)
 * and plain string arithmetic, which the default runtime does have. A helper
 * that reached for `node:crypto` would push cleanly and then fail at request
 * time, on the one code path whose failure mode is "every seller's scans stop
 * arriving, silently".
 *
 * Pure and dependency-free so the whole verification contract can be pinned
 * against a vector computed with `node:crypto` in the test file — i.e. proven
 * equal to the implementation EasyPost's own library uses, rather than merely
 * self-consistent.
 *
 * ## The contract (verified against `easypost-node`'s `validateWebhook`)
 * Header `X-Hmac-Signature: hmac-sha256-hex=<hex>`, where `<hex>` is
 * HMAC-SHA256 over the RAW request body, keyed by the webhook secret
 * **NFKD-normalised**, compared in constant time.
 */

/**
 * EasyPost signs the FLOAT-rendered form of the body, so an integer `weight`
 * has to be rewritten to its float rendering (`17` → `17.0`) before hashing.
 *
 * This is not a nicety: `easypost-node` does exactly this, and without it every
 * real event whose parcel weight happens to be a whole number — which is most
 * of them, since a PWE is quoted in whole ounces — fails verification and is
 * rejected as a forgery. The bug would look like "scans work in testing and
 * never in production".
 *
 * The regex is anchored on both sides and cannot backtrack catastrophically:
 * one literal key, `\s*`, a digit run, and a LOOKAHEAD for the value's
 * terminator. The lookahead is what keeps it honest —
 *
 *   `"weight": 17`    → `"weight": 17.0`   (rewritten)
 *   `"weight": 17.5`  → unchanged (the `.` is not `,` or `}`; the digit run
 *                       cannot backtrack into a match either, since `7` is not
 *                       a terminator)
 *   `"weight": "17"`  → unchanged (a quote is not a digit, so nothing matches)
 *
 * Global on purpose: a shipment payload carries `weight` on both the shipment
 * and its parcel, and EasyPost renders BOTH as floats.
 */
export function rewriteWeightForSignature(body: string): string {
  return body.replace(/("weight":\s*)(\d+)(?=\s*[,}])/g, "$1$2.0");
}

/**
 * `hmac-sha256-hex=<hex>` for `body` under `secret` — the exact string
 * EasyPost puts in `X-Hmac-Signature`.
 *
 * The secret is NFKD-normalised because EasyPost's library normalises before
 * keying; for our own generated secrets (base64url ASCII) the normalisation is
 * a no-op, but matching the reference implementation costs nothing and means a
 * secret rotated in from somewhere else still verifies.
 *
 * Hashes exactly the string it is given. {@link rewriteWeightForSignature} is
 * the caller's responsibility, so the two concerns can be tested apart.
 */
export async function computeEasypostSignature(
  secret: string,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret.normalize("NFKD")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `hmac-sha256-hex=${toHex(new Uint8Array(signature))}`;
}

/**
 * Constant-time string comparison.
 *
 * `===` on a signature leaks, through timing, how many leading characters an
 * attacker got right, which turns forging a signature into 64 sequential
 * guessing games instead of one impossible one. `node:crypto`'s
 * `timingSafeEqual` is not reachable from this runtime (see the module
 * comment), so it is hand-rolled: fixed work per character, no early exit.
 *
 * A length difference IS returned early. That leaks only the length of the
 * expected value, which is a constant (`hmac-sha256-hex=` plus 64 hex chars)
 * and public knowledge.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
