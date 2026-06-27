import { useConvexAuth, useAction } from "convex/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only credential-seeding landing page (NEO-29). A Maestro flow signs in
// via /testing/sign-in (optionally through /testing/reset first), redirecting
// to /testing/seed-credentials?redirect=<final>; this page waits for the Convex
// client to pick up the new Clerk session, calls the auth-scoped
// seedMyTestCredentials action (stores the signed-in user's own BSC/SportLots
// creds from server env + warms their session token), then forwards to the
// final destination. Only functional when VITE_CLERK_TESTING_ENABLED=true; the
// action itself also fails closed on production Convex (no TESTING_RESET_SECRET
// there) and never reads secrets from the client.
function TestingSeedCredentialsContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const seedAction = useAction(api.testing.seedMyTestCredentials);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";
  // Optional `sites` (comma-separated platform names, e.g. "sportlots" or
  // "buysportscards") narrows seeding to a subset — the credential-gate fixtures
  // seed exactly one platform so the other reads as missing. Omitted → seed all.
  const sitesParam = searchParams.get("sites");
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
        setStatus("Seeding marketplace credentials...");
        const sites = sitesParam
          ? sitesParam.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
        const result = await seedAction(sites ? { sites } : {});
        const summary = result.seeded
          .map((s) => `${s.site}=${s.skipped ? "skip" : s.stored ? "stored" : "fail"}`)
          .join(" ");
        setStatus(`Seed complete (${summary}) — redirecting...`);
        navigate(redirect);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        setStatus(`Error: ${msg}`);
      }
    })();
  }, [isAuthenticated, isLoading, navigate, redirect, seedAction, sitesParam]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <p className="text-slate-400 font-mono text-sm">
        [testing-seed] {status}
      </p>
    </div>
  );
}

export default function TestingSeedCredentialsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-background">
          <p className="text-slate-400 font-mono text-sm">
            [testing-seed] Loading…
          </p>
        </div>
      }
    >
      <TestingSeedCredentialsContent />
    </Suspense>
  );
}
