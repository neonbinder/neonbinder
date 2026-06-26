import { useAuth, useSignIn } from "@clerk/clerk-react";
import { Suspense, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

// Inner component that uses useSearchParams (must be inside Suspense for Next.js static generation).
function TestingSignInContent() {
  const { isSignedIn } = useAuth();
  const { signIn, setActive, isLoaded } = useSignIn();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";
  // Optional account selector — defaults to "main" (TEST_EMAIL). Profile-
  // creation flows pass "new-profile" so they sign in as the always-empty
  // NEW_PROFILE_TEST_EMAIL user. Server validates the value.
  const account = searchParams.get("account") || "main";
  // Optional worker index — picks a per-parallel-worker test account so
  // concurrent flows don't share the same Convex user state. Server resolves
  // TEST_EMAIL_${worker} (falls back to TEST_EMAIL if unset).
  const workerParam = searchParams.get("worker");
  const worker =
    workerParam !== null && workerParam !== "" && /^\d+$/.test(workerParam)
      ? Number(workerParam)
      : null;
  const [status, setStatus] = useState("Initializing...");

  useEffect(() => {
    if (!isLoaded || !signIn) return;

    // Already signed in — redirect immediately, no API calls.
    if (isSignedIn) {
      setStatus("Already signed in — redirecting...");
      navigate(redirect);
      return;
    }

    if (import.meta.env.VITE_CLERK_TESTING_ENABLED !== "true") {
      setStatus("Testing mode is not enabled in this environment.");
      return;
    }

    const ac = new AbortController();

    async function autoSignIn() {
      if (ac.signal.aborted) return;
      // Stagger initial attempt to avoid all parallel flows hitting Clerk
      // at exactly the same time (thundering herd → rate limit cascade).
      const initialJitter = Math.random() * 2000;
      if (initialJitter > 100) {
        await new Promise((r) => setTimeout(r, initialJitter));
      }
      if (ac.signal.aborted) return;

      try {
        setStatus("Requesting testing tokens...");
        const testingSecret = import.meta.env.VITE_TESTING_ENDPOINT_SECRET as
          | string
          | undefined;
        const res = await fetch("/api/auth/testing", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(testingSecret ? { "x-testing-auth": testingSecret } : {}),
          },
          body: JSON.stringify(worker !== null ? { account, worker } : { account }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }

        const { signInToken, testingToken } = await res.json();
        if (ac.signal.aborted) return;

        // Patch window.fetch to append the testing token to all Clerk FAPI
        // requests. This mirrors what @clerk/testing does in Playwright via
        // browserContext.route(), bypassing Clerk's bot detection.
        if (testingToken) {
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url =
              input instanceof Request ? input.url : String(input ?? "");
            const isClerkFapi =
              url.includes(".clerk.accounts.dev") ||
              url.includes(".clerk.com/v1/");
            if (isClerkFapi) {
              const sep = url.includes("?") ? "&" : "?";
              const patched = `${url}${sep}__clerk_testing_token=${testingToken}`;
              if (input instanceof Request) {
                return originalFetch(
                  new Request(patched, {
                    method: input.method,
                    headers: input.headers,
                    body: input.body,
                  }),
                  init,
                );
              }
              return originalFetch(patched, init);
            }
            return originalFetch(input, init);
          };
        }

        // Retry loop — concurrent flows can trigger Clerk's rate limiter.
        // Back off with jitter and retry up to 4 times before giving up.
        const MAX_RETRIES = 4;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          if (ac.signal.aborted) return;
          try {
            setStatus(
              attempt === 1
                ? "Signing in..."
                : `Signing in (retry ${attempt - 1})...`,
            );
            const result = await signIn!.create({
              strategy: "ticket",
              ticket: signInToken,
            });

            if (result.status === "complete") {
              await setActive!({ session: result.createdSessionId });
              navigate(redirect);
              return;
            }
            setStatus(`Unexpected sign-in status: ${result.status}`);
            return;
          } catch (e: unknown) {
            const clerkCode = (
              e as { errors?: Array<{ code?: string; message?: string }> }
            )?.errors?.[0];
            const msgLower = clerkCode?.message?.toLowerCase() ?? "";
            const isRateLimit =
              clerkCode?.code === "too_many_requests" ||
              msgLower.includes("too many requests");
            const isSessionExists =
              clerkCode?.code === "session_already_exists" ||
              msgLower.includes("session already exists");

            // Another tab/flow already signed in with this token — redirect.
            if (isSessionExists) {
              setStatus("Session exists — redirecting...");
              navigate(redirect);
              return;
            }

            if (isRateLimit && attempt < MAX_RETRIES) {
              const jitter = Math.random() * 1000;
              const delay = attempt * 2000 + jitter;
              setStatus(
                `Rate limited — retrying in ${(delay / 1000).toFixed(1)}s…`,
              );
              await new Promise((r) => setTimeout(r, delay));
              if (ac.signal.aborted) return;
              continue;
            }

            const msg =
              clerkCode?.message ??
              (e instanceof Error ? e.message : undefined) ??
              JSON.stringify(e);
            setStatus(`Error: ${msg}`);
            return;
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        setStatus(`Error: ${msg}`);
      }
    }

    autoSignIn();
    return () => ac.abort();
  }, [isLoaded, signIn, isSignedIn, redirect, account, worker, navigate, setActive]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <p className="text-slate-400 font-mono text-sm">[testing] {status}</p>
    </div>
  );
}

// Automated sign-in page for E2E testing.
// Only functional when NEXT_PUBLIC_CLERK_TESTING_ENABLED=true.
// Maestro flows navigate here instead of filling out the sign-in form.
export default function TestingSignInPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen bg-background">
          <p className="text-slate-400 font-mono text-sm">[testing] Loading…</p>
        </div>
      }
    >
      <TestingSignInContent />
    </Suspense>
  );
}
