import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Skip PostHog under Maestro/E2E tests. PostHog's session-recording
    // and surveys load worker scripts and same-origin iframes; Maestro's
    // CdpWebDriver `detectWindowChange` latches onto those transient
    // handles and never switches back, causing subsequent CDP JS calls
    // to fail with `null cannot be cast to non-null type kotlin.Int`.
    // See NEO-13 / Maestro issues #3176, #3271, #3289.
    if (import.meta.env.VITE_CLERK_TESTING_ENABLED === "true") {
      return;
    }

    const posthogKey = import.meta.env.VITE_POSTHOG_KEY;

    if (!posthogKey) {
      console.warn(
        "PostHog key not found. PostHog analytics will not be initialized.",
      );
      return;
    }

    posthog.init(posthogKey, {
      api_host:
        import.meta.env.VITE_POSTHOG_HOST || "https://us.posthog.com",
      ui_host: "https://us.posthog.com",
      capture_exceptions: true,
      debug: import.meta.env.MODE === "development",
    });
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
