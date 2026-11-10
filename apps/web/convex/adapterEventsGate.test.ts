/**
 * NEO-475 (D1) — `adapter_*` events reach PostHog from production only. The
 * structured console line is written on every deployment.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "./_generated/server";
import {
  recordAdapterCall,
  recordAdapterPhase,
  shouldCaptureAdapterEvents,
} from "./observability";

const CALL = {
  requestId: "req-gate",
  operation: "fetchBscSelectorOptions",
  platform: "bsc" as const,
  duration_ms: 5,
  success: true,
};
const PHASE = {
  requestId: "req-gate",
  operation: "fetchBscSelectorOptions",
  platform: "bsc" as const,
  phase: "token_ready" as const,
  elapsed_ms: 3,
};

function stub() {
  const scheduled: unknown[] = [];
  const ran: unknown[] = [];
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "user_1" }) },
    runAction: async (...a: unknown[]) => {
      ran.push(a);
      return null;
    },
    scheduler: {
      runAfter: async (...a: unknown[]) => {
        scheduled.push(a);
        return "id";
      },
    },
  } as unknown as ActionCtx;
  return { ctx, scheduled, ran };
}

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  process.env.POSTHOG_API_KEY = "k";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TESTING_RESET_SECRET;
  delete process.env.POSTHOG_API_KEY;
});

describe("adapter_* PostHog capture gate", () => {
  test("a deployment without TESTING_RESET_SECRET (production) captures", () => {
    delete process.env.TESTING_RESET_SECRET;
    expect(shouldCaptureAdapterEvents()).toBe(true);
  });

  test("production schedules adapter_sync_call and runs adapter_phase", async () => {
    delete process.env.TESTING_RESET_SECRET;
    const { ctx, scheduled, ran } = stub();
    await recordAdapterCall(ctx, CALL);
    recordAdapterPhase(ctx, PHASE);
    await new Promise((r) => setTimeout(r, 0));
    expect(scheduled).toHaveLength(1);
    expect(ran).toHaveLength(1);
  });

  test("a testing deployment sends neither event, but still logs both", async () => {
    process.env.TESTING_RESET_SECRET = "x";
    expect(shouldCaptureAdapterEvents()).toBe(false);
    const { ctx, scheduled, ran } = stub();
    await recordAdapterCall(ctx, CALL);
    recordAdapterPhase(ctx, PHASE);
    await new Promise((r) => setTimeout(r, 0));
    expect(scheduled).toHaveLength(0);
    expect(ran).toHaveLength(0);
    expect(lines.some((l) => l.includes('"msg":"adapter_sync_call"'))).toBe(true);
    expect(lines.some((l) => l.includes('"msg":"adapter_phase"'))).toBe(true);
  });
});
