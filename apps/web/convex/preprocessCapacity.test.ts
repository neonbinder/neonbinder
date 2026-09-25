/**
 * Unit tests for the preprocess capacity resolver (NEO-170, per-environment
 * capacity).
 *
 * This number is the pool's `maxParallelism`, and it is read from a deployment
 * environment variable rather than compiled in; the per-environment values
 * live in convex/preprocessCapacity.json (NEO-299). That makes the resolver the
 * single place where a misconfigured deployment either runs on the committed
 * prod value or starts quietly shedding requests, so it is tested as a pure
 * function rather than through the pool.
 *
 * The two properties worth pinning:
 *
 *  - **Out-of-range falls back; it does NOT clamp.** Clamping `999` to 50 would
 *    honour a number nobody meant and leave the misconfiguration alive as
 *    degraded behaviour. Falling back puts the deployment on the committed prod
 *    value.
 *  - **Unset and invalid are both loud, with different messages.** Since
 *    NEO-299 every environment sets its variable, so an unset one is a
 *    misconfiguration too; the old silent fallback of 3 is what hid dev's heavy
 *    pool running below its real capacity.
 */

import { describe, expect, test, vi } from "vitest";
import capacityJson from "./preprocessCapacity.json";
import {
  FAST_FALLBACK_MAX_PARALLELISM,
  HEAVY_FALLBACK_MAX_PARALLELISM,
  HEAVY_MAX_PARALLELISM,
  MAX_ACCEPTED_PARALLELISM,
  PREPROCESS_CAPACITY,
  validateCapacityTable,
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
  ])("falls back to the prod value when %s, with one unset warning", (_label, raw) => {
    // NEO-299: unset is a misconfiguration on every environment now, so it
    // takes the committed PROD value and says so exactly once.
    const { value, warnings } = resolveWithWarnings(raw);
    expect(value).toBe(PREPROCESS_CAPACITY.fast.prod);
    expect(value).toBe(FAST_FALLBACK_MAX_PARALLELISM);
    expect(warnings.map((w) => JSON.parse(w) as unknown)).toEqual([
      {
        msg: "preprocess_capacity_env_unset",
        var: "PREPROCESS_MAX_PARALLELISM",
        fallback: PREPROCESS_CAPACITY.fast.prod,
      },
    ]);
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
    expect(value).toBe(FAST_FALLBACK_MAX_PARALLELISM);
  });

  test("an invalid value is reported with what was configured and what was used", async () => {
    // The fallback is safe but conservative, so it has to be diagnosable:
    // silently serving the fallback where someone set 200 is a mystery outage.
    const { warnings } = resolveWithWarnings("200");

    const lines = warnings
      .filter((w) => w.includes("preprocess_max_parallelism_invalid"))
      .map((w) => JSON.parse(w) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      msg: "preprocess_max_parallelism_invalid",
      configured: "200",
      using: FAST_FALLBACK_MAX_PARALLELISM,
      accepted: "integer 1-50",
    });
  });

  test("999 is refused outright rather than clamped to the ceiling", async () => {
    // Stated as its own test because "clamp" is the other reasonable design and
    // a future reader will wonder which one this is.
    const { value } = resolveWithWarnings("999");
    expect(value).not.toBe(50);
    expect(value).toBe(FAST_FALLBACK_MAX_PARALLELISM);
  });
});

describe("resolveHeavyPreprocessMaxParallelism", () => {
  test("shares the fast resolver's validation — accepts a valid value, falls back otherwise", () => {
    expect(resolveHeavyWithWarnings("2").value).toBe(2);
    expect(resolveHeavyWithWarnings(undefined).value).toBe(
      HEAVY_FALLBACK_MAX_PARALLELISM,
    );
    // Out of range falls back, does not clamp — same policy as fast.
    expect(resolveHeavyWithWarnings("999").value).toBe(
      HEAVY_FALLBACK_MAX_PARALLELISM,
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

  test("an unset heavy var falls back to the heavy PROD value and names the heavy var", () => {
    // NEO-299: the old silent fallback of 3 is the one that hid the drift.
    const { value, warnings } = resolveHeavyWithWarnings(undefined);
    expect(value).toBe(PREPROCESS_CAPACITY.heavy.prod);
    expect(warnings.map((w) => JSON.parse(w) as unknown)).toEqual([
      {
        msg: "preprocess_capacity_env_unset",
        var: "HEAVY_PREPROCESS_MAX_PARALLELISM",
        fallback: PREPROCESS_CAPACITY.heavy.prod,
      },
    ]);
  });
});

describe("the resolved deployment values", () => {
  test("both are a usable parallelism, resolved once at module load", () => {
    // The test environment sets neither var, so both take the fallback path:
    // the committed prod values.
    expect(PREPROCESS_MAX_PARALLELISM).toBe(FAST_FALLBACK_MAX_PARALLELISM);
    expect(HEAVY_MAX_PARALLELISM).toBe(HEAVY_FALLBACK_MAX_PARALLELISM);
    expect(Number.isInteger(HEAVY_MAX_PARALLELISM)).toBe(true);
    expect(HEAVY_MAX_PARALLELISM).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// The committed table itself (security review W1, NEO-299).
//
// preprocessCapacity.json is clamped and warned about at runtime rather than
// thrown on, because a throw at module load would take down every function
// that imports it. So THIS is where a bad edit to the JSON has to fail.
// ---------------------------------------------------------------------------

/**
 * Per-instance memory, in GiB, as sized in the terraform repo (NEO-299
 * decision): heavy 16, fast 8. The browser service is not in the JSON; its
 * counts and sizes here are the ones the NEO-299 capacity decision budgeted
 * with, and must be updated by hand if the browser service is resized.
 */
const HEAVY_GIB = 16;
const FAST_GIB = 8;
const PROD_BROWSER_GIB = 20 * 2;
const DEV_BROWSER_GIB = 20 * 4;
const PREVIEW_BROWSER_GIB = 3 * 2;
/** The default per-region Cloud Run memory quota, in both projects. */
const REGION_MEMORY_QUOTA_GIB = 400;

describe("preprocessCapacity.json", () => {
  const ENVS = ["prod", "dev", "preview"] as const;
  const POOLS = ["heavy", "fast"] as const;

  test("validates with no problems, so the runtime uses it exactly as committed", () => {
    const { table, problems } = validateCapacityTable(capacityJson);
    expect(problems).toEqual([]);
    expect(table).toEqual(capacityJson);
    expect(PREPROCESS_CAPACITY).toEqual(capacityJson);
  });

  test.each(POOLS.flatMap((pool) => ENVS.map((env) => [pool, env] as const)))(
    "%s.%s is an integer in the same bounds the env var must meet",
    (pool, env) => {
      const value = capacityJson[pool][env];
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(MAX_ACCEPTED_PARALLELISM);
    },
  );

  test.each(POOLS)("%s is ordered preview <= dev <= prod", (pool) => {
    const { prod, dev, preview } = capacityJson[pool];
    expect(preview).toBeLessThanOrEqual(dev);
    expect(dev).toBeLessThanOrEqual(prod);
  });

  test("prod fully warm fits the region's memory quota", () => {
    const prodGib =
      capacityJson.heavy.prod * HEAVY_GIB + capacityJson.fast.prod * FAST_GIB + PROD_BROWSER_GIB;
    expect(prodGib).toBeLessThanOrEqual(REGION_MEMORY_QUOTA_GIB);
  });

  test("dev fully warm plus two PR previews fits the region's memory quota", () => {
    // The reason dev's heavy value is lower than prod's: previews deploy into
    // dev's project and share its quota.
    const devGib =
      capacityJson.heavy.dev * HEAVY_GIB + capacityJson.fast.dev * FAST_GIB + DEV_BROWSER_GIB;
    const previewGib =
      capacityJson.heavy.preview * HEAVY_GIB +
      capacityJson.fast.preview * FAST_GIB +
      PREVIEW_BROWSER_GIB;
    expect(devGib + 2 * previewGib).toBeLessThanOrEqual(REGION_MEMORY_QUOTA_GIB);
  });
});

describe("validateCapacityTable", () => {
  test("clamps out-of-bounds values and names each one", () => {
    const { table, problems } = validateCapacityTable({
      heavy: { prod: 999, dev: 0, preview: 2.5 },
      fast: { prod: 20, dev: 3, preview: Number.NaN },
    });
    expect(table).toEqual({
      heavy: { prod: MAX_ACCEPTED_PARALLELISM, dev: 1, preview: 2 },
      fast: { prod: 20, dev: 3, preview: 1 },
    });
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).toMatch(/heavy\.prod=999/);
    expect(problems.join("\n")).toMatch(/fast\.preview=NaN/);
  });

  test("reports an ordering violation without rewriting it", () => {
    const { table, problems } = validateCapacityTable({
      heavy: { prod: 6, dev: 12, preview: 3 },
      fast: { prod: 20, dev: 3, preview: 3 },
    });
    expect(table.heavy).toEqual({ prod: 6, dev: 12, preview: 3 });
    expect(problems).toEqual([
      "heavy must satisfy preview <= dev <= prod; got preview=3 dev=12 prod=6",
    ]);
  });
});
