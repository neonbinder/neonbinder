import { useConvexAuth, useMutation } from "convex/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only "you were away" landing page (NEO-464). An E2E spec opens the
// dashboard, files a card, then visits
// /testing/backdate-dashboard-visit?redirect=<final> (default /dashboard);
// this page waits for the Convex client to pick up the Clerk session, calls
// the caller-scoped backdateMyDashboardVisit mutation (moves the signed-in
// user's last dashboard open back past the visit gap), then forwards.
//
// It exists because "N cards filed since your last visit" shows only on a new
// visit, and a new visit needs thirty minutes away from the dashboard.
//
// Only functional when VITE_CLERK_TESTING_ENABLED=true; the mutation itself
// also fails closed on production Convex (no TESTING_RESET_SECRET there).
function TestingBackdateDashboardVisitContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const backdate = useMutation(api.testing.backdateMyDashboardVisit);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";
  const [status, setStatus] = useState("Initializing...");
  const ranRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- status readout of an async driver effect; test-only page
      setStatus("Testing mode is not enabled in this environment.");
      return;
    }
    // Wait for the Convex client to finish syncing the Clerk session token.
    if (isLoading) return;
    if (!isAuthenticated) {
      setStatus("Waiting for authentication...");
      return;
    }
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        setStatus("Backdating the last dashboard visit...");
        const result = await backdate({});
        // `backdated=false` means the dashboard was never opened. We still
        // forward: the spec's own assertion on the summary names that better.
        setStatus(`Backdated (${result.backdated}) — redirecting...`);
        navigate(redirect);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        setStatus(`Error: ${msg}`);
      }
    })();
  }, [backdate, isAuthenticated, isLoading, navigate, redirect]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-surface">
      <p className="text-ink-3 font-mono text-sm">[testing-backdate-dashboard-visit] {status}</p>
    </div>
  );
}

export default function TestingBackdateDashboardVisitPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-surface">
          <p className="text-ink-3 font-mono text-sm">[testing-backdate-dashboard-visit] Loading…</p>
        </div>
      }
    >
      <TestingBackdateDashboardVisitContent />
    </Suspense>
  );
}
