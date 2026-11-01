import { describe, expect, it } from "vitest";
import type { CaptureResult } from "posthog-js";
import {
  E2E_DIAGNOSTIC_EVENTS,
  e2eDiagnosticConfig,
  keepDiagnosticEvent,
  readE2ETags,
} from "./e2e-diagnostics";

const event = (name: string) => ({ event: name }) as CaptureResult;

describe("E2E diagnostics (NEO-392)", () => {
  it("keeps only the named diagnostic events", () => {
    for (const name of E2E_DIAGNOSTIC_EVENTS) {
      expect(keepDiagnosticEvent(event(name))).not.toBeNull();
    }
    for (const name of ["$pageview", "$autocapture", "$pageleave", "$snapshot", "$web_vitals", "$rageclick"]) {
      expect(keepDiagnosticEvent(event(name))).toBeNull();
    }
    expect(keepDiagnosticEvent(null)).toBeNull();
  });

  it("reads only known tags with primitive values, and caps their length", () => {
    const tags = readE2ETags({
      run_id: "123",
      worker: "2",
      retry: 1,
      test: "x".repeat(500),
      token: "never forwarded",
      project: { nested: true },
    });
    expect(tags).toEqual({
      e2e: "true",
      e2e_run_id: "123",
      e2e_worker: "2",
      e2e_retry: 1,
      e2e_test: "x".repeat(200),
    });
  });

  it("tags an untagged page as E2E and nothing more", () => {
    expect(readE2ETags(undefined)).toEqual({ e2e: "true" });
    expect(readE2ETags("run")).toEqual({ e2e: "true" });
  });

  it("turns off everything automatic and filters before sending", () => {
    const config = e2eDiagnosticConfig();
    expect(config).toMatchObject({
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      opt_out_useragent_filter: true,
      advanced_disable_flags: true,
      request_batching: false,
      persistence: "memory",
    });
    expect(config.before_send).toBe(keepDiagnosticEvent);
  });
});
