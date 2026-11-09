/**
 * NEO-475 (decision D1) — the press recorder (NEO-417) and the column timeline
 * (NEO-392) no longer send anything to PostHog: together they were 88% of the
 * E2E event volume on a capped plan, and no spec reads them. These tests pin
 * that they stay gone, so a later change cannot bring the flood back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";
const capture = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({ default: { capture } }));

import * as diagnostics from "./e2e-diagnostics";

afterEach(() => {
  vi.unstubAllEnvs();
  capture.mockReset();
});

describe("dropped E2E events", () => {
  it("e2e_column and e2e_press are not allowlisted and are filtered out before sending", () => {
    for (const name of ["e2e_column", "e2e_press"]) {
      expect(diagnostics.E2E_DIAGNOSTIC_EVENTS.has(name)).toBe(false);
      expect(diagnostics.keepDiagnosticEvent({ event: name } as CaptureResult)).toBeNull();
    }
  });

  it("e2eDiagnostic never sends them, even under E2E, but still sends an allowlisted one", () => {
    vi.stubEnv("VITE_CLERK_TESTING_ENABLED", "true");
    diagnostics.e2eDiagnostic("e2e_press", {});
    diagnostics.e2eDiagnostic("e2e_column", {});
    expect(capture).not.toHaveBeenCalled();
    diagnostics.e2eDiagnostic("e2e_page_start", { path: "/" });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("the press listener API is gone", () => {
    expect("holdE2EPressListeners" in diagnostics).toBe(false);
    expect("describePress" in diagnostics).toBe(false);
  });

  it("the page-start event the NEO-434 spec anchors on is still allowlisted", () => {
    expect(diagnostics.E2E_DIAGNOSTIC_EVENTS.has("e2e_page_start")).toBe(true);
  });
});
