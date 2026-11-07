import { useConvexAuth, useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "@/convex/_generated/api";

// Test-only seed hop (NEO-433). An E2E spec visits
// /testing/killed-drain?platform=<platform>&redirect=<final>; this page waits
// for the Convex client to pick up the Clerk session, calls the auth-scoped
// seedMyTestKilledDrain mutation (the caller's own rows only), then forwards.
//
// It exists because the state is otherwise unreachable from a test: only the
// platform can kill a running action, and never on demand.
//
// Only functional when VITE_CLERK_TESTING_ENABLED=true; the mutation itself
// also fails closed on production Convex (no TESTING_RESET_SECRET there).
export default function TestingKilledDrainPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const seed = useMutation(api.testing.seedMyTestKilledDrain);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";
  // Required and not defaulted: a typo'd param must not seed a platform the flow never meant to touch.
  const platform = searchParams.get("platform");
  const [status, setStatus] = useState("Initializing...");
  const ranRef = useRef(false);

  useEffect(() => {
    if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- status readout of an async driver effect; test-only page
      setStatus("Testing mode is not enabled in this environment.");
      return;
    }
    if (platform !== "bsc" && platform !== "ebay") {
      setStatus("Missing or unknown ?platform= parameter.");
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
        setStatus(`Seeding a killed ${platform} run...`);
        await seed({ platform });
        navigate(redirect);
      } catch (e: unknown) {
        setStatus(`Error: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
      }
    })();
  }, [isAuthenticated, isLoading, navigate, platform, redirect, seed]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-surface">
      <p className="text-ink-3 font-mono text-sm">[testing-killed-drain] {status}</p>
    </div>
  );
}
