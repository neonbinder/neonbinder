/**
 * Validation for the transient credentials a login request may carry.
 *
 * NEO-140/NEO-141: `POST /login/<site>` now accepts an OPTIONAL
 * `{username, password}` alongside `{key}`. That pair is the only way a user's
 * marketplace password enters this service, and it is used for exactly one
 * sign-in and then discarded — nothing here or downstream persists it.
 *
 * Lives in its own module for the same reason ./rate-limit does: src/index.ts
 * calls app.listen() at import time, so anything defined inside it is
 * unreachable from a unit test.
 *
 * SECURITY: this module never logs. The value it returns is credential
 * material; callers must pass it straight into an adapter and never into a log
 * line, a response body, or an error message.
 */

/** A validated transient credential pair. */
export interface TransientCredentials {
  username: string;
  password: string;
}

export type TransientCredentialsResult =
  | { ok: true; credentials?: TransientCredentials }
  | { ok: false; error: string };

/**
 * Upper bound on either field.
 *
 * The only other bound on these values is `express.json({limit:"10kb"})` in
 * src/index.ts, which is a bound on the whole BODY, not on a field. Convex caps
 * both at 256 characters before it ever calls us — but this service must not
 * depend on its caller for input bounds. Cloud Run IAM is the single control
 * standing between this endpoint and the internet, and "the caller validates"
 * stacks the whole of input safety onto that one control.
 *
 * 512 is deliberately double Convex's cap: generous enough that no real
 * marketplace credential is near it, tight enough that neither value can be
 * used to push kilobytes into an adapter's exact-value redaction regex or a
 * marketplace's login form.
 */
const MAX_FIELD_LENGTH = 512;

/**
 * Extract and validate the optional `{username, password}` from a login body.
 *
 * Three outcomes:
 *   - neither field present → `{ok: true}` with no credentials. THIS IS THE
 *     CANARY PATH: the two Cloud Scheduler jobs POST `{key, canary:true}` and
 *     nothing else, and must keep falling back to the stored secret.
 *   - both present and non-empty strings → `{ok: true, credentials}`.
 *   - anything else → `{ok: false}`.
 *
 * Half a pair is rejected rather than silently ignored. Ignoring it would let
 * a caller bug (a password that never got read from a form, say) present as a
 * mysterious re-auth loop instead of a 400 at the door.
 *
 * The error strings are fixed and describe only WHICH FIELD was wrong — never
 * a received value.
 */
export function parseTransientCredentials(body: unknown): TransientCredentialsResult {
  const source = (body ?? {}) as { username?: unknown; password?: unknown };
  const { username, password } = source;

  if (username === undefined && password === undefined) {
    return { ok: true };
  }
  if (username === undefined || password === undefined) {
    return {
      ok: false,
      error: "Fields username and password must be supplied together",
    };
  }
  // The length checks reuse the EXISTING fixed error strings rather than
  // adding a "too long" variant: the response would otherwise confirm how long
  // the submitted value was, and the strings are already deliberately free of
  // any received value.
  if (
    typeof username !== "string" ||
    username.length === 0 ||
    username.length > MAX_FIELD_LENGTH
  ) {
    return { ok: false, error: "Invalid field: username" };
  }
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > MAX_FIELD_LENGTH
  ) {
    return { ok: false, error: "Invalid field: password" };
  }
  return { ok: true, credentials: { username, password } };
}
