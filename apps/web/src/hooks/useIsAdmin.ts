import { useUser } from "@clerk/clerk-react";

/**
 * Returns whether the current user is an admin. Reads `publicMetadata.role`
 * from the Clerk user object — changes propagate to the client when Clerk
 * refreshes the user record (after the next token refresh or page reload).
 *
 * Admin status is additionally enforced server-side on every Convex
 * function that powers Set Builder (see convex/auth.ts#requireAdmin).
 * This hook is only used for UI gating; it is not a security boundary.
 */
export function useIsAdmin(): { isAdmin: boolean; isLoaded: boolean } {
  const { user, isLoaded } = useUser();
  const role = user?.publicMetadata?.role;
  return { isAdmin: role === "admin", isLoaded };
}
