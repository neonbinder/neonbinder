/**
 * Unit tests for the preprocess capacity resolver (NEO-170, per-environment
 * capacity).
 *
 * This number is the pool's `maxParallelism`, and it is now read from a
 * deployment environment variable rather than compiled in — prod runs 20, dev
 * and preview run 3. That makes the resolver the single place where a
 * misconfigured deployment either fails safe or starts quietly shedding
 * requests, so it is tested as a pure function rather than through the pool.
 *
 * The two properties worth pinning:
 *
 *  - **Out-of-range falls back; it does NOT clamp.** Clamping `999` to 50 would
 *    honour a number nobody meant and leave the misconfiguration alive as
 *    degraded behaviour. Falling back puts the deployment in the known-safe
 *    configuration.
 *  - **A present-but-invalid value is loud; an absent one is not.** The fallback
 *    is conservative, so a silent one would present as "why is prod slow?" with
 *    nothing to find — while warning about an unset variable would fire on every
 *    dev and preview deployment, where unset is the intended configuration.
 */

import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_PREPROCESS_MAX_PARALLELISM,
  HEAVY_MAX_PARALLELISM,
  PREPROCESS_MAX_PARALLELISM,
  resolveHeavyPreprocessMaxParallelism,
  resolvePreprocessMaxParallelism,
} from "./preprocessCapacity";

/** Resolve while capturing the diagnostic, so both halves can be asserted. */
function resolveWithWarnings(raw: string | undefined) {
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string") warnings.push(args[0]);
  });
  try {
    return { value: resolvePreprocessMaxParallelism(raw), warnings };
  } finally {
    warn.mockRestore();
  }
}

/** The same, for the heavy resolver. */
function resolveHeavyWithWarnings(raw: string | undefined) {
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string") warnings.push(args[0]);
  });
  try {
    return { value: resolveHeavyPreprocessMaxParallelism(raw), warnings };
  } finally {
    warn.mockRestore();
  }
}

describe("resolvePreprocessMaxParallelism", () => {
  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("falls back to the dev/preview value when %s, without warning", (_label, raw) => {
    // Unset is the INTENDED configuration on dev and preview, so it must not
    // produce a diagnostic — a warning every operator learns to ignore is worse
    // than none.
    const { value, warnings } = resolveWithWarnings(raw);
    expect(value).toBe(3);
    expect(value).toBe(DEFAULT_PREPROCESS_MAX_PARALLELISM);
    expect(warnings.filter((w) => w.includes("preprocess_max_parallelism"))).toHaveLength(0);
  });

  test.each([
    ["the prod value", "20", 20],
    ["the dev value stated explicitly", "3", 3],
    ["the minimum", "1", 1],
    ["the maximum accepted", "50", 50],
    ["a value with surrounding whitespace", "  20  ", 20],
  ])("accepts %s", (_label, raw, expected) => {
    const { value, warnings } = resolveWithWarnings(raw);
    expect(value).toBe(expected);
    expect(warnings.filter((w) => w.includes("preprocess_max_parallelism"))).toHaveLength(0);
  });

  test.each([
    ["zero", "0"],
    ["negative", "-5"],
    ["above the accepted ceiling", "999"],
    ["a typo'd digit", "200"],
    ["non-numeric", "twenty"],
    ["a trailing-garbage number", "20abc"],
    ["exponent notation", "2e3"],
    ["fractional", "2.5"],
    ["infinity", "Infinity"],
  ])("falls back for %s rather than clamping or coercing", (_label, raw) => {
    // `20abc` and `2e3` are the ones that motivate `Number()` over `parseInt`:
    // parseInt would answer 20 and 2 respectively, silently accepting a value
    // the operator did not write.
    const { value } = resolveWithWarnings(raw);
    expect(value).toBe(DEFAULT_PREPROCESS_MAX_PARALLELISM);
  });

  test("an invalid value is reported with what was configured and what was used", async () => {
    // The fallback is safe but conservative, so it has to be diagnosable:
    // silently serving 3 where someone set 200 is a mystery outage.
    const { warnings } = resolveWithWarnings("200");

    const lines = warnings
      .filter((w) => w.includes("preprocess_max_parallelism_invalid"))
      .map((w) => JSON.parse(w) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      msg: "preprocess_max_parallelism_invalid",
      configured: "200",
      using: 3,
      accepted: "integer 1-50",
    });
  });

  test("999 is refused outright rather than clamped to the ceiling", async () => {
    // Stated as its own test because "clamp" is the other reasonable design and
    // a future reader will wonder which one this is.
    const { value } = resolveWithWarnings("999");
    expect(value).not.toBe(50);
    expect(value).toBe(3);
  });
});

describe("resolveHeavyPreprocessMaxParallelism", () => {
  test("shares the fast resolver's validation — accepts a valid value, falls back otherwise", () => {
    expect(resolveHeavyWithWarnings("2").value).toBe(2);
    expect(resolveHeavyWithWarnings(undefined).value).toBe(
      DEFAULT_PREPROCESS_MAX_PARALLELISM,
    );
    // Out of range falls back, does not clamp — same policy as fast.
    expect(resolveHeavyWithWarnings("999").value).toBe(
      DEFAULT_PREPROCESS_MAX_PARALLELISM,
    );
  });

  test("an invalid value warns with the HEAVY message, not the fast one", async () => {
    // Fast and heavy read different env vars, so the diagnostic must name which
    // pool was misconfigured — otherwise a debugger is sent to the wrong
    // terraform variable.
    const { warnings } = resolveHeavyWithWarnings("200");
    const msgs = warnings
      .map((w) => {
        try {
          return (JSON.parse(w) as { msg?: unknown }).msg;
        } catch {
          return undefined;
        }
      })
      .filter((m): m is string => typeof m === "string");
    // Exactly the heavy message — and NOT the fast one (whose string is a
    // substring of the heavy one, so a substring check would falsely match).
    expect(msgs).toContain("heavy_preprocess_max_parallelism_invalid");
    expect(msgs).not.toContain("preprocess_max_parallelism_invalid");
    const line = warnings
      .map((w) => JSON.parse(w) as Record<string, unknown>)
      .find((l) => l.msg === "heavy_preprocess_max_parallelism_invalid");
    expect(line?.configured).toBe("200");
  });

  test("an unset heavy var is silent — that is dev/preview's intended config", () => {
    const { warnings } = resolveHeavyWithWarnings(undefined);
    expect(warnings).toHaveLength(0);
  });
});

describe("the resolved deployment values", () => {
  test("both are a usable parallelism, resolved once at module load", () => {
    // The test environment sets neither var, so both take the fallback path —
    // which is also what every dev and preview deployment sees.
    expect(PREPROCESS_MAX_PARALLELISM).toBe(DEFAULT_PREPROCESS_MAX_PARALLELISM);
    expect(HEAVY_MAX_PARALLELISM).toBe(DEFAULT_PREPROCESS_MAX_PARALLELISM);
    expect(Number.isInteger(HEAVY_MAX_PARALLELISM)).toBe(true);
    expect(HEAVY_MAX_PARALLELISM).toBeGreaterThanOrEqual(1);
  });
});
