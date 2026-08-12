import { useConvexAuth, useMutation } from "convex/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only "kill this marketplace session" landing page (NEO-141). A Maestro
// flow signs in via /testing/sign-in, seeds credentials, then visits
// /testing/needs-reauth?site=<site>&redirect=<final>; this page waits for the
// Convex client to pick up the Clerk session, calls the auth-scoped
// markSiteNeedsReauth mutation (flags the signed-in user's own row for that
// site, leaving hasCredentials true), then forwards to the final destination.
//
// It exists because the "needs re-authentication" panel state is otherwise
// unreachable from a test: it is set only when the browser service reports a
// stored session that is dead AND cannot be renewed, which no UI action and no
// tolerable amount of waiting can produce on demand.
//
// Only functional when VITE_CLERK_TESTING_ENABLED=true; the mutation itself
// also fails closed on production Convex (no TESTING_RESET_SECRET there).
function TestingNeedsReauthContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const markNeedsReauth = useMutation(api.testing.markSiteNeedsReauth);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";
  // Required: which platform's session to kill ("buysportscards" | "sportlots").
  // Deliberately not defaulted — a typo'd param would otherwise flag a platform
  // the flow never meant to touch.
  const site = searchParams.get("site");
  const [status, setStatus] = useState("Initializing...");
  const ranRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- status readout of an async driver effect; test-only page
      setStatus("Testing mode is not enabled in this environment.");
      return;
    }
    if (!site) {
      setStatus("Missing ?site= parameter.");
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
        setStatus(`Flagging ${site} for re-authentication...`);
        const result = await markNeedsReauth({ site });
        // `updated=false` means the caller had no entry for that site (nothing
        // seeded yet). We still forward: the flow's own assertion on the
        // re-auth card is the gate, and failing there names the problem far
        // better than a page that silently stops.
        setStatus(`Flag complete (${site}=${result.updated}) — redirecting...`);
        navigate(redirect);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        setStatus(`Error: ${msg}`);
      }
    })();
  }, [isAuthenticated, isLoading, markNeedsReauth, navigate, redirect, site]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <p className="text-slate-400 font-mono text-sm">
        [testing-needs-reauth] {status}
      </p>
    </div>
  );
}

export default function TestingNeedsReauthPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-background">
          <p className="text-slate-400 font-mono text-sm">
            [testing-needs-reauth] Loading…
          </p>
        </div>
      }
    >
      <TestingNeedsReauthContent />
    </Suspense>
  );
}
