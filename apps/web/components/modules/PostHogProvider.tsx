import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";
import {
  e2eDiagnostic,
  e2eDiagnosticConfig,
  isE2E,
  readE2ETags,
} from "@/lib/observability/e2e-diagnostics";

declare global {
  interface Window {
    /** Set by the Playwright fixture before the app loads (NEO-392). */
    __NB_E2E?: unknown;
  }
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const posthogKey = import.meta.env.VITE_POSTHOG_KEY;

    if (!posthogKey) {
      console.warn(
        "PostHog key not found. PostHog analytics will not be initialized.",
      );
      return;
    }

    const base = {
      api_host:
        import.meta.env.VITE_POSTHOG_HOST || "https://us.posthog.com",
      ui_host: "https://us.posthog.com",
    };

    // Under E2E PostHog is a diagnostic recorder only: no automatic capture,
    // no recordings, surveys or external scripts, and only the named
    // diagnostic events leave the page. See lib/observability/e2e-diagnostics.
    // (NEO-13 switched it off here entirely for Maestro's CDP driver; Maestro
    // is gone since NEO-341.)
    if (isE2E()) {
      posthog.init(posthogKey, { ...base, ...e2eDiagnosticConfig() });
      posthog.register(readE2ETags(window.__NB_E2E));
      e2eDiagnostic("e2e_page_start", { path: window.location.pathname });
      return;
    }

    posthog.init(posthogKey, {
      ...base,
      capture_exceptions: true,
      debug: import.meta.env.MODE === "development",
    });
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
