import { useConvexAuth, useMutation } from "convex/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only reset landing page. A Maestro flow signs in via /testing/sign-in
// with `redirect=/testing/reset?redirect=<final>`; this page waits for the
// Convex client to pick up the new Clerk session, calls the auth-scoped
// resetMyTestState mutation (wipes the signed-in user's own per-user rows),
// then forwards to the final destination. Only functional when
// VITE_CLERK_TESTING_ENABLED=true; the mutation itself also fails closed on
// production Convex (no TESTING_RESET_SECRET there).
function TestingResetContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const resetMutation = useMutation(api.testing.resetMyTestState);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";
  const [status, setStatus] = useState("Initializing...");
  const ranRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
      setStatus("Testing mode is not enabled in this environment.");
      return;
    }
    // Wait for the Convex client to finish syncing the Clerk session token.
    if (isLoading) return;
    if (!isAuthenticated) {
      // Transient during the Clerk → Convex handoff; the effect re-runs when
      // isAuthenticated flips true.
      setStatus("Waiting for authentication...");
      return;
    }
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        setStatus("Resetting test state...");
        const counts = await resetMutation({});
        setStatus(
          `Reset complete (pp=${counts.publicProfiles} up=${counts.userProfiles} pz=${counts.prizePool}) — redirecting...`,
        );
        navigate(redirect);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        setStatus(`Error: ${msg}`);
      }
    })();
  }, [isAuthenticated, isLoading, navigate, redirect, resetMutation]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <p className="text-slate-400 font-mono text-sm">
        [testing-reset] {status}
      </p>
    </div>
  );
}

export default function TestingResetPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-background">
          <p className="text-slate-400 font-mono text-sm">
            [testing-reset] Loading…
          </p>
        </div>
      }
    >
      <TestingResetContent />
    </Suspense>
  );
}
