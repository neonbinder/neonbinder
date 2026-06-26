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
