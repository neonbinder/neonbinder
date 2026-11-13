import { useConvexAuth, useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only hop (NEO-481). An E2E spec uploads real scans first (through
// /testing/seed-placeholder-upload or the Add cards picker), then visits
// /testing/fail-placeholder-entry?file=<originalName>[&jobId=<job>][&redirect=<path>].
// This page waits for the Convex client to pick up the Clerk session, calls
// `testing.failMyTestPlaceholderEntry` (the caller's own photo only), and
// forwards: to `redirect` when given (`{jobId}` and `{runId}` are filled in),
// else to the run's Add cards screen, else the batch's placeholder page.
//
// It exists because a failed photo is otherwise unreachable on demand:
// preprocess always falls back to some crop, so no real fixture fails, and
// "Crop by hand" on a failed photo (read again, paired, matched) needs a live
// proof. The photo's `extracted/` original stays in GCS for the hand crop.
//
// Only functional when VITE_CLERK_TESTING_ENABLED=true; the mutation itself
// also fails closed on production Convex (no TESTING_RESET_SECRET there).
export default function TestingFailPlaceholderEntryPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const fail = useMutation(api.testing.failMyTestPlaceholderEntry);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Required and not defaulted: a typo'd param must not fail some other photo.
  const file = searchParams.get("file");
  const jobId = searchParams.get("jobId");
  const redirect = searchParams.get("redirect");
  const [status, setStatus] = useState("Initializing...");
  const ranRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- status readout of an async driver effect; test-only page
      setStatus("Testing mode is not enabled in this environment.");
      return;
    }
    if (!file) {
      setStatus("Missing ?file= parameter.");
      return;
    }
    if (isLoading) return;
    if (!isAuthenticated) {
      setStatus("Waiting for authentication...");
      return;
    }
    if (ranRef.current) return;
    ranRef.current = true;
    (async () => {
      try {
        setStatus(`Failing ${file}...`);
        const failed = await fail({ file, ...(jobId ? { jobId } : {}) });
        setStatus(`Failed ${file} — redirecting...`);
        if (redirect) {
          navigate(
            redirect
              .replace("{jobId}", encodeURIComponent(failed.jobId))
              .replace("{runId}", encodeURIComponent(failed.runId ?? "")),
          );
        } else if (failed.runId) {
          navigate(`/collection?tab=add&run=${encodeURIComponent(failed.runId)}`);
        } else {
          navigate(`/print/placeholders?jobId=${encodeURIComponent(failed.jobId)}`);
        }
      } catch (e: unknown) {
        setStatus(`Error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
      }
    })();
  }, [fail, file, isAuthenticated, isLoading, jobId, navigate, redirect]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface">
      <p className="font-mono text-sm text-ink-3">[testing-fail-placeholder-entry] {status}</p>
    </div>
  );
}
