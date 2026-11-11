/**
 * NEO-487: the arithmetic of `expectAfterMarketplace` (playwright/support).
 *
 * That file is Playwright support code, and vitest.include.mjs excludes the
 * `playwright` directory from collection, so its unit test lives here under
 * `lib/`, where the `convex-lib` project collects `*.test.ts`.
 *
 * The helper reads only `Date.now()`, `target.waitFor` and `status.isVisible`,
 * so the tests drive a fake clock: each `waitFor` call that does not land moves
 * the clock 250 ms (the helper's sample interval) and throws a Playwright
 * TimeoutError. Scenarios are written as "the status is on screen during these
 * windows" and "the target lands at t", and assert the time (since start) at
 * which the helper gives up or succeeds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errors, type Locator, type Page } from "@playwright/test";

const annotations: { type: string; description: string }[] = [];
vi.mock("../../playwright/support/fixtures", () => ({
  test: { info: () => ({ annotations }) },
}));

import { expectAfterMarketplace } from "../../playwright/support/marketplace-wait";

const SAMPLE = 250;
const START = 1_000_000;
const PLATFORM = "BuySportsCards";

type Window = readonly [from: number, to: number];

interface Run {
  /** ms since start at which the helper returned or threw. */
  endedAt: number;
  outcome: "landed" | { error: Error };
}

/**
 * Run the helper against a fake page. `statusWindows` are [from, to) ms since
 * start during which the "Waiting on" status is visible; `landsAt` is when the
 * target becomes visible (Infinity: never).
 */
async function run(
  statusWindows: readonly Window[],
  landsAt: number,
  options: { cap?: number; waitFor?: (t: number) => void } = {},
): Promise<Run> {
  vi.setSystemTime(START);
  const since = () => Date.now() - START;
  const target = {
    waitFor: async () => {
      options.waitFor?.(since());
      if (since() >= landsAt) return;
      vi.setSystemTime(Date.now() + SAMPLE);
      if (since() >= landsAt) return;
      throw new errors.TimeoutError("not yet");
    },
  } as unknown as Locator;
  const status = {
    isVisible: async () => statusWindows.some(([from, to]) => since() >= from && since() < to),
  };
  const page = {
    getByRole: () => ({ filter: () => ({ first: () => status }) }),
  } as unknown as Page;

  try {
    await expectAfterMarketplace(page, target, { platform: PLATFORM, cap: options.cap });
    return { endedAt: since(), outcome: "landed" };
  } catch (error) {
    return { endedAt: since(), outcome: { error: error as Error } };
  }
}

const message = (r: Run): string => (r.outcome === "landed" ? "" : r.outcome.error.message);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  annotations.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("expectAfterMarketplace", () => {
  describe("no marketplace time", () => {
    it("passes a target that lands exactly at the 7 s own-time budget", async () => {
      const r = await run([], 7_000);
      expect(r.outcome).toBe("landed");
    });

    it("fails a target that lands later than 7 s, naming our own time", async () => {
      const r = await run([], 7_500);
      expect(r.endedAt).toBe(7_250);
      expect(message(r)).toContain("our own time is");
      expect(message(r)).toContain(`${PLATFORM} held it 0.0 s`);
    });
  });

  describe("n seconds of marketplace time", () => {
    // Status on screen from the 1.5 s announce until the marketplace answers at 30 s.
    const marketplace: Window[] = [[1_500, 30_000]];

    it("passes a target that lands 7 s after the status goes away (n + 7)", async () => {
      const r = await run(marketplace, 30_000 + 7_000);
      expect(r.outcome).toBe("landed");
    });

    it("fails a target that lands later than n + 7 s", async () => {
      const r = await run(marketplace, 30_000 + 7_500);
      expect(r.endedAt).toBe(30_000 + 7_250);
      expect(message(r)).toContain(`${PLATFORM} held it 30.0 s`);
    });

    it("does not fail a slow marketplace whose status never goes away before the target lands", async () => {
      const r = await run([[1_500, 100_000]], 100_000);
      expect(r.outcome).toBe("landed");
    });
  });

  describe("the hard cap", () => {
    it("ends a marketplace that never answers at 180 s, whatever the status says", async () => {
      const r = await run([[1_500, Infinity]], Infinity);
      expect(r.endedAt).toBe(180_000);
      expect(message(r)).toContain("180.0 s cap");
    });

    it("honours a caller-supplied cap", async () => {
      const r = await run([[1_500, Infinity]], Infinity, { cap: 10_000 });
      expect(r.endedAt).toBe(10_000);
      expect(message(r)).toContain("10.0 s cap");
    });

    it("reports the cap, not the own-time rule, when both are past", async () => {
      const r = await run([], Infinity, { cap: 5_000 });
      expect(r.endedAt).toBe(5_000);
      expect(message(r)).toContain("5.0 s cap");
    });

    it("lets a target that lands just before the cap through", async () => {
      const r = await run([[1_500, Infinity]], 179_750);
      expect(r.outcome).toBe("landed");
    });
  });

  describe("the 1.5 s announce back-credit", () => {
    it("counts the 1.5 s before the status first appeared as the marketplace's", async () => {
      // Status shows only for [1.5 s, 2 s): n = 2 s. Without the back-credit n would be 0.5 s.
      const r = await run([[1_500, 2_000]], Infinity);
      expect(r.endedAt).toBe(2_000 + 7_250);
      expect(message(r)).toContain(`${PLATFORM} held it 2.0 s`);
    });

    it("does not credit back before the end of the last counted stretch (no double count)", async () => {
      // Two episodes touching in time: [1.5, 2) then [2.5, 3). The second episode's
      // back-credit may only reach back to 2 s, so n = 3 s, not 3 s + 1.25 s.
      const r = await run(
        [
          [1_500, 2_000],
          [2_500, 3_000],
        ],
        Infinity,
      );
      expect(r.endedAt).toBe(3_000 + 7_250);
      expect(message(r)).toContain(`${PLATFORM} held it 3.0 s`);
    });

    it("credits a later, separate episode its own 1.5 s lead-in", async () => {
      // Episode 1 [1.5, 2) counts 2 s; the gap to 6 s is ours (4 s, within budget);
      // episode 2 [6, 8) brings its own 1.5 s back-credit.
      const r = await run(
        [
          [1_500, 2_000],
          [6_000, 8_000],
        ],
        Infinity,
      );
      // n = 2.0 (episode 1) + 1.5 (lead-in) + 2.0 (shown, to 8 s) = 5.5 s, so the wait
      // fails at n + 7 s (+ one sample).
      expect(r.endedAt).toBe(5_500 + 7_250);
      expect(message(r)).toContain(`${PLATFORM} held it 5.5 s`);
    });
  });

  describe("a wait that is still open", () => {
    it("counts up to now, so the report on landing shows the whole open stretch", async () => {
      const r = await run([[1_500, Infinity]], 60_000);
      expect(r.outcome).toBe("landed");
      expect(annotations).toEqual([
        { type: "marketplace-wait", description: "the step: BuySportsCards held 59.8 s of 60.0 s" },
      ]);
    });

    it("keeps counting while the status stays on, so own time stays near zero", async () => {
      // 170 s of an open wait, then our own 7 s: passes only because the open wait was counted.
      const r = await run([[1_500, 170_000]], 170_000 + 7_000);
      expect(r.outcome).toBe("landed");
    });
  });

  describe("failure handling", () => {
    it("rethrows an error from the target that is not a Playwright timeout", async () => {
      const boom = new Error("page closed");
      const r = await run([], Infinity, {
        waitFor: () => {
          throw boom;
        },
      });
      expect(r.outcome).toEqual({ error: boom });
    });

    it("records the measurement as an annotation when it fails", async () => {
      await run([], Infinity, { cap: 2_000 });
      expect(annotations).toHaveLength(1);
      expect(annotations[0].type).toBe("marketplace-wait");
      expect(annotations[0].description).toContain("held 0.0 s of 2.0 s");
    });
  });
});
