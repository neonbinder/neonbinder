/**
 * How many preprocess requests may be in flight at once (NEO-170; per-pool
 * NEO-175; one source of truth NEO-299).
 *
 * ================================================================
 * THE NUMBERS LIVE IN convex/preprocessCapacity.json, AND ONLY THERE:
 *
 *   { heavy: { prod, dev, preview }, fast: { prod, dev, preview } }
 *
 * Each value is BOTH the Convex pool's `maxParallelism` for that environment
 * AND the matching Cloud Run service's max instance count. A parity check
 * compares this file against the terraform tfvars and the PR-preview workflow
 * literals, so a change here that is not made there too fails CI instead of
 * drifting silently. CHANGE THEM TOGETHER, IN THE JSON.
 * ================================================================
 *
 * A deployment still reads its own value from the environment
 * (`PREPROCESS_MAX_PARALLELISM` for the fast pool,
 * `HEAVY_PREPROCESS_MAX_PARALLELISM` for the heavy pool), because one compiled
 * bundle serves prod, dev and every preview, and a bundle cannot know which of
 * those it is running as. The JSON is where the value each environment SHOULD
 * carry is written down; the env var is how the deployment is told which row it
 * is.
 *
 * The equality with max instances is exact, not approximate, because both
 * preprocess Cloud Run services run `container_concurrency = 1` (since NEO-161 —
 * one full-BiRefNet inference transiently allocates multiple GB, so stacking
 * requests on a single instance stacks those peaks). With one request per
 * instance, max instances IS the service's total concurrent capacity: instance
 * count and in-flight request count are the same number.
 *
 * Consequences of the two drifting apart, in either direction:
 *
 *  - Pool parallelism ABOVE max instances re-creates the problem the pool was
 *    built to solve. The surplus requests are shed with 429s and burn retry
 *    attempts against capacity that structurally cannot exist. On the heavy pool
 *    that is worse than waste: a 429 during a ~180-240s cold model load could
 *    exhaust a short retry ladder and fail the photo (NEO-299).
 *  - Pool parallelism BELOW max instances silently pays for idle instances and
 *    makes a batch take longer than the infrastructure allows.
 *
 * Lives in its own module (rather than inside placeholderPool.ts) so it can be
 * imported without pulling in the workpool component — the pool modules depend
 * on generated component types, and a plain capacity number should not.
 */

import capacity from "./preprocessCapacity.json";

/** The per-environment capacity table, exactly as committed. */
export const PREPROCESS_CAPACITY: {
  readonly heavy: { readonly prod: number; readonly dev: number; readonly preview: number };
  readonly fast: { readonly prod: number; readonly dev: number; readonly preview: number };
} = capacity;

/**
 * What the FAST pool runs with when `PREPROCESS_MAX_PARALLELISM` is unset or
 * unusable: the PROD value.
 *
 * Why prod and not the smallest environment. The old fallback was 3, justified
 * by a comment saying dev and preview deliberately leave the variable unset and
 * 3 is what their terraform says. That claim was false for the heavy pool (see
 * below) and the reasoning behind it was backwards: the deployment that most
 * needs the right number is prod, and a prod whose variable went missing
 * silently ran at a fraction of its capacity. Every environment is expected to
 * set its variable explicitly, so the fallback only fires on a
 * misconfiguration — and when it does, prod keeps its full width and the
 * warning below says so. On a smaller environment the surplus shows up as
 * 429s, which the adapter treats as retryable: slower, never lost.
 */
export const FAST_FALLBACK_MAX_PARALLELISM = PREPROCESS_CAPACITY.fast.prod;

/**
 * What the HEAVY pool runs with when `HEAVY_PREPROCESS_MAX_PARALLELISM` is
 * unset or unusable: the PROD value, for the same reason as the fast one.
 *
 * The old silent fallback of 3 is part of what NEO-299 fixed: the Convex value,
 * the terraform value and the live service's ceiling had drifted to three
 * different numbers, and a quiet fallback made one of them invisible.
 */
export const HEAVY_FALLBACK_MAX_PARALLELISM = PREPROCESS_CAPACITY.heavy.prod;

/**
 * Widest value we will accept from the environment.
 *
 * Not a capacity opinion — a typo guard. Cloud Run could legitimately be
 * configured past this, and if it ever is, this bound moves in the same change.
 * What it catches is the shape of mistake that costs real money: a stray digit
 * turning 20 into 200, pointing 200 concurrent dispatches at a service that can
 * serve a handful, every surplus one burning a retry ladder.
 */
const MAX_ACCEPTED_PARALLELISM = 50;

/**
 * Resolve the configured parallelism, or fall back.
 *
 * **Anything that is not a base-10 integer in [1, MAX_ACCEPTED_PARALLELISM]
 * falls back — out-of-range values are NOT clamped.** Clamping `999` to 50
 * honours a number nobody meant and keeps running with it; falling back puts
 * the deployment on the committed prod value and leaves a log line naming
 * exactly what was rejected and what was used instead.
 *
 * **Both an unset and an invalid variable are loud.** Every environment is now
 * expected to set its variable (prod, dev and each PR preview), so an unset one
 * is a misconfiguration too, not an intended default — the silent fallback is
 * precisely what let dev run at 3 without anyone seeing it. The two
 * cases log different messages because they point at different fixes: unset
 * means "the deploy never set it", invalid means "someone set it wrong".
 *
 * Exported separately from the resolved constants so it can be tested directly:
 * `process.env` is read once at module load, which is right for the runtime and
 * useless for a test.
 */
function resolveMaxParallelism(
  raw: string | undefined,
  opts: { envVar: string; invalidMsg: string; fallback: number },
): number {
  if (raw === undefined || raw.trim() === "") {
    console.warn(
      JSON.stringify({
        msg: "preprocess_capacity_env_unset",
        var: opts.envVar,
        fallback: opts.fallback,
      }),
    );
    return opts.fallback;
  }

  const trimmed = raw.trim();
  // `Number()` rather than `parseInt`, on purpose: `parseInt("20abc")` is 20 and
  // `parseInt("2e3")` is 2 — both would accept a value the operator did not
  // write. `Number` rejects the first outright, and the integer check below is
  // what makes the rest exact (it also rejects `"2.5"` and `"Infinity"`).
  const parsed = Number(trimmed);
  const usable =
    Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_ACCEPTED_PARALLELISM;

  if (!usable) {
    console.warn(
      JSON.stringify({
        // Names which pool was misconfigured — fast and heavy read different
        // env vars, so a shared message would send whoever is debugging to the
        // wrong variable.
        msg: opts.invalidMsg,
        // A capacity number, not a secret — and without it in the line an
        // operator cannot tell a typo from an unset variable.
        configured: trimmed,
        using: opts.fallback,
        accepted: `integer 1-${MAX_ACCEPTED_PARALLELISM}`,
      }),
    );
    return opts.fallback;
  }

  return parsed;
}

/** The FAST pool's parallelism, from `PREPROCESS_MAX_PARALLELISM`. */
export function resolvePreprocessMaxParallelism(raw: string | undefined): number {
  return resolveMaxParallelism(raw, {
    envVar: "PREPROCESS_MAX_PARALLELISM",
    invalidMsg: "preprocess_max_parallelism_invalid",
    fallback: FAST_FALLBACK_MAX_PARALLELISM,
  });
}

/**
 * The HEAVY pool's parallelism, resolved the same way and for the same reasons
 * as the fast pool's — but from `HEAVY_PREPROCESS_MAX_PARALLELISM`, pinned to
 * the HEAVY preprocess service's max instances. The heavy service is the
 * BiRefNet cold-loader (~180-240s model load) that escalations and heavy
 * warm-ups reach, so its ceiling is set independently of the fast service's: a
 * deployment runs many fast instances (every image hits fast) and fewer heavy
 * ones (16 GiB each, and the region's memory quota is shared with fast and the
 * browser service).
 */
export function resolveHeavyPreprocessMaxParallelism(raw: string | undefined): number {
  return resolveMaxParallelism(raw, {
    envVar: "HEAVY_PREPROCESS_MAX_PARALLELISM",
    invalidMsg: "heavy_preprocess_max_parallelism_invalid",
    fallback: HEAVY_FALLBACK_MAX_PARALLELISM,
  });
}

/**
 * The resolved values this deployment runs with.
 *
 * Read once, at module load. Convex sets a deployment's environment before any
 * function runs and it cannot change under a live isolate, so re-reading per
 * call would buy nothing and would re-emit the warnings above on every dispatch.
 */
export const PREPROCESS_MAX_PARALLELISM = resolvePreprocessMaxParallelism(
  process.env.PREPROCESS_MAX_PARALLELISM,
);

export const HEAVY_MAX_PARALLELISM = resolveHeavyPreprocessMaxParallelism(
  process.env.HEAVY_PREPROCESS_MAX_PARALLELISM,
);
