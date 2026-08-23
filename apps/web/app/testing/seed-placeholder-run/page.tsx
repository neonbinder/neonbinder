import { useConvexAuth, useMutation } from "convex/react";
import { Suspense, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only "give me a run to abort" landing page (NEO-170). A Maestro flow
// signs in via /testing/sign-in, visits
// /testing/seed-placeholder-run?redirect=/pipeline-runs, and lands on the
// operator view with exactly one non-terminal run waiting for it.
//
// It exists for the same reason /testing/needs-reauth does: the state the flow
// asserts against is unreachable from the UI in test time. A genuine
// "collecting" run means opening a scanner session and pushing a real image
// through GCS and Cloud Run — minutes of work, real spend, and none of it what
// the abort flow is testing. `seedMyTestPlaceholderStream` writes the one row
// instead (see convex/testing.ts), owned by the CALLER, with no images behind
// it.
//
// The seeded run is the newest, and /pipeline-runs is newest-first, so the flow
// can act on the FIRST row without needing to carry an id around. The short id
// is still printed below for a flow that would rather `copyTextFrom` it.
//
// RESET FIRST, like /testing/seed-placeholder-upload: this page also leaves a
// `collecting` job behind (that IS its output — the abort flow's fixture), so
// it feeds the same 2-active-per-user cap on the same worker account. Left
// unchecked, a second run — or an earlier abort flow that failed before it
// aborted — would leave two active jobs and `seedMyTestPlaceholderStream` would
// refuse. Cancelling the caller's active jobs first (through the real cancel
// path, which reaches a terminal status and frees the slot) makes the seed
// idempotent across repeated runs. Gated identically, so it is safe here and
// nowhere a real user can reach.
//
// Only functional when VITE_CLERK_TESTING_ENABLED=true; the mutations also fail
// closed on production Convex (no TESTING_RESET_SECRET there).
function TestingSeedPlaceholderRunContent() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const resetSessions = useMutation(
    api.placeholderPipeline.seedCancelMyActivePlaceholderJobs,
  );
  const seedRun = useMutation(api.testing.seedMyTestPlaceholderStream);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/pipeline-runs";
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
      // Transient during the Clerk → Convex handoff; the effect re-runs when
      // isAuthenticated flips true.
      setStatus("Waiting for authentication...");
      return;
    }
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        // FIRST: free any active slot this worker account is still holding, so
        // the seed below cannot hit the 2-active cap. Unconditional — see the
        // "RESET FIRST" note above.
        setStatus("Resetting previous sessions...");
        const reset = await resetSessions();
        // Held through the seed's own await so it actually paints; a bare
        // second setStatus in the same tick would batch it away.
        setStatus(`Reset ${reset.canceled} previous sessions.`);
        const result = await seedRun();
        setStatus(`Seeded ${result.jobId.slice(0, 8)} — redirecting...`);
        navigate(redirect);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        setStatus(`Error: ${msg}`);
      }
    })();
  }, [isAuthenticated, isLoading, navigate, redirect, resetSessions, seedRun]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <p className="text-slate-400 font-mono text-sm">
        [testing-seed-placeholder-run] {status}
      </p>
    </div>
  );
}

export default function TestingSeedPlaceholderRunPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-background">
          <p className="text-slate-400 font-mono text-sm">
            [testing-seed-placeholder-run] Loading…
          </p>
        </div>
      }
    >
      <TestingSeedPlaceholderRunContent />
    </Suspense>
  );
}
