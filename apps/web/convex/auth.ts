import { verifyToken } from "@clerk/backend";

/**
 * Get the current user's Clerk identity from the Convex context
 * For actions ("use node"), we need to manually extract and verify the token
 */
export async function getCurrentUserId(ctx: any) {
  // For queries and mutations, use Convex's built-in auth
  if (ctx.auth) {
    const identity = await ctx.auth.getUserIdentity();
    if (identity && identity.subject) {
      return identity.subject;
    }
  }

  return null;
}

/**
 * Get the current user's ID plus their role from the Clerk JWT.
 * Role is sourced from `publicMetadata.role` via a custom claim on the
 * `convex` JWT template (Clerk Dashboard → JWT Templates → convex → Claims:
 * `{ "role": "{{user.public_metadata.role}}" }`).
 */
export async function getCurrentUserIdentity(
  ctx: any,
): Promise<{ userId: string; role: string | null } | null> {
  if (!ctx.auth) return null;
  const identity = (await ctx.auth.getUserIdentity()) as
    | (Record<string, unknown> & { subject?: string; role?: unknown })
    | null;
  if (!identity?.subject) return null;
  const role = typeof identity.role === "string" ? identity.role : null;
  return { userId: identity.subject, role };
}

/**
 * Throws if the caller is not signed in or not an admin. Use on every
 * admin-only query/mutation/action. Returns the admin's userId so callers
 * can chain without a second identity lookup.
 */
export async function requireAdmin(ctx: any): Promise<string> {
  const id = await getCurrentUserIdentity(ctx);
  if (!id) throw new Error("Not authenticated");
  if (id.role !== "admin") throw new Error("Admin access required");
  return id.userId;
}

/**
 * Get Clerk user ID from a JWT token (for actions that run on Node.js)
 * Use this when ctx.auth.getUserIdentity() returns null in actions
 */
export async function getClerkUserIdFromToken(token: string | null | undefined): Promise<string | null> {
  if (!token) {
    return null;
  }

  try {
    const decoded = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    return decoded.sub || null;
  } catch (error) {
    console.error("Failed to verify Clerk token:", error);
    return null;
  }
}

/**
 * Verify a Clerk token
 * Use this in actions and HTTP handlers when you need to verify a token
 */
export async function verifyClerkToken(token: string) {
  try {
    const decoded = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    return decoded;
  } catch (error) {
    console.error("Token verification failed:", error);
    return null;
  }
}

/**
 * Require any signed-in caller, returning their Clerk user id.
 *
 * ## The rule this exists to make cheap to follow (NEO-154)
 * A Convex function declared with `query` / `mutation` / `action` is PUBLIC:
 * callable by anyone who can reach the deployment URL, with or without a Clerk
 * token. The deployment URL ships in the client bundle, so "only our frontend
 * calls it" is not an access control — it is an assumption about well-behaved
 * clients. **Authorization belongs in the function body.**
 *
 * The audit behind NEO-154 found 23 public functions with no identity check at
 * all, including an unauthenticated write primitive and an SSRF action. Three
 * ways out, in descending order of preference:
 *
 * 1. **`internalQuery` / `internalMutation` / `internalAction`** — unreachable
 *    from any client. Correct whenever the only callers are other Convex
 *    functions, and strictly better than a guard because there is no check to
 *    get wrong.
 * 2. **`requireSignedIn(ctx)` (this) or `requireAdmin(ctx)`** — for functions a
 *    real client genuinely calls.
 * 3. **Public by intent** — legitimate, but say so in a comment naming the
 *    anonymous caller, so the next audit does not re-litigate it. See
 *    `publicProfile.ts` for the two that qualify today.
 *
 * Prefer this over hand-rolling `getCurrentUserId` + a throw: the hand-rolled
 * version is what several of the 23 were missing, and an inconsistent one
 * (`teams.findOrCreate` had none while its `players.findOrCreate` twin did) is
 * how the gap hid in plain sight.
 */
export async function requireSignedIn(ctx: any): Promise<string> {
  const userId = await getCurrentUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}
