import { Navigate, Outlet } from "react-router";
import { useIsAdmin } from "@/src/hooks/useIsAdmin";

/**
 * Route guard for admin-only pages. Sits inside ProtectedLayout + BinderLayout
 * so non-admins who type the URL directly get bounced to /dashboard without
 * losing the binder shell. This is one of three defense layers:
 *
 *   1. Nav filter (binder-tabs.tsx#useVisibleNavItems) — hides the link
 *   2. This route guard — blocks direct URL navigation
 *   3. convex/auth.ts#requireAdmin — the actual authorization boundary
 *
 * Do not rely on this component for security; it is UX only.
 */
export default function AdminLayout() {
  const { isAdmin, isLoaded } = useIsAdmin();

  // While Clerk is hydrating, render nothing rather than flash the page
  // and then yank it away. ProtectedLayout already handled the spinner for
  // the auth load; this is a much shorter gap for the metadata read.
  if (!isLoaded) return null;

  if (!isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
