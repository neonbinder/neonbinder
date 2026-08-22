/**
 * How many preprocess requests may be in flight at once (NEO-170).
 *
 * ================================================================
 * THIS DEPLOYMENT'S `PREPROCESS_MAX_PARALLELISM` MUST EQUAL THE
 * SAME ENVIRONMENT'S `preprocess_max_instances` IN THE TERRAFORM
 * REPO (neonbinder_ioc/variables.tf, per-environment tfvars).
 * Prod pairs with prod, dev/preview with dev. CHANGE BOTH TOGETHER.
 * ================================================================
 *
 * This used to be a bare constant, and the comment that lived here argued —
 * correctly, at the time — that a constant beat configuration because there was
 * exactly one number to keep in step. That stopped being true when capacity
 * became per-environment: prod runs 20 instances, dev and preview run 3. One
 * compiled-in constant cannot be both, and picking either makes the other
 * environment silently wrong. So the number is read from the deployment's own
 * environment now, and the invariant grew a qualifier: not "equals
 * max_instances" but "equals the SAME environment's max_instances".
 *
 * The equality is exact, not approximate, because the preprocess Cloud Run
 * service runs `container_concurrency = 1` (since NEO-161 — one full-BiRefNet
 * inference transiently allocates multiple GB, so stacking requests on a single
 * instance stacks those peaks). With one request per instance, `max_instances`
 * IS the service's total concurrent capacity: instance count and in-flight
 * request count are the same number.
 *
 * Consequences of the two drifting apart, in either direction:
 *
 *  - Pool parallelism ABOVE max_instances re-creates the problem the pool was
 *    built to solve. The surplus requests are shed with 429s and burn retry
 *    attempts (~40s each) against capacity that structurally cannot exist. Safe
 *    by design — the adapter treats 429 as retryable, so the work does complete —
 *    but wasteful, and it presents as flaky preprocessing.
 *  - Pool parallelism BELOW max_instances silently pays for idle instances and
 *    makes a batch take longer than the infrastructure allows.
 *
 * Neither failure is loud, which is why the drift is worth a comment this long:
 * nothing mechanical can catch it, because the two numbers live in different
 * repositories on different release cadences.
 *
 * OPS: prod gets `PREPROCESS_MAX_PARALLELISM=20` set on the Convex deployment at
 * release, paired with terraform `preprocess_max_instances = 20` in the prod
 * tfvars (which rides the T1 cycle). Dev and preview deployments leave it UNSET
 * and fall back to 3 — so the fallback is not a guess, it is what their
 * terraform already says.
 *
 * Lives in its own module (rather than inside placeholderPool.ts) so it can be
 * imported without pulling in the workpool component — the pool module depends
 * on generated component types, and a plain capacity number should not.
 */

/**
 * Value used when `PREPROCESS_MAX_PARALLELISM` is unset or unusable.
 *
 * 3 because that is `preprocess_max_instances` in the dev tfvars today, and
 * dev/preview are precisely the deployments that leave the variable unset. It is
 * also the safe direction to fall back in: too low wastes capacity, too high
 * sheds requests.
 */
export const DEFAULT_PREPROCESS_MAX_PARALLELISM = 3;

/**
 * Widest value we will accept from the environment.
 *
 * Not a capacity opinion — a typo guard. Cloud Run could legitimately be
 * configured past this, and if it ever is, this bound moves in the same change.
 * What it catches is the shape of mistake that costs real money: a stray digit
 * turning 20 into 200, pointing 200 concurrent dispatches at a service that can
 * serve a handful, every surplus one burning a ~40s retry ladder.
 */
const MAX_ACCEPTED_PARALLELISM = 50;

/**
 * Resolve the configured parallelism, or fall back.
 *
 * **Anything that is not a base-10 integer in [1, MAX_ACCEPTED_PARALLELISM]
 * falls back to the default — out-of-range values are NOT clamped.** That is a
 * deliberate choice between two defensible behaviours, and the reasoning is
 * about which failure an operator can actually see:
 *
 *   - Clamping `999` to 50 honours a number nobody meant, keeps running, and
 *     leaves a service sized for 3 being handed 50 concurrent dispatches. The
 *     misconfiguration survives as degraded behaviour that looks like flakiness.
 *   - Falling back to 3 puts the deployment in the known-safe configuration and
 *     — because a present-but-invalid value is warned about below — leaves a log
 *     line naming exactly what was rejected and what was used instead.
 *
 * The fallback is loud precisely BECAUSE it is conservative: silently serving 3
 * where someone set 20 would present as "why is prod slow?" with nothing to
 * find. An unset variable is deliberately NOT warned about — on dev and preview
 * that is the intended configuration, and a warning every operator learns to
 * ignore is worse than none.
 *
 * Exported separately from the resolved constant so it can be tested directly:
 * `process.env` is read once at module load, which is right for the runtime and
 * useless for a test.
 */
function resolveMaxParallelism(raw: string | undefined, invalidMsg: string): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PREPROCESS_MAX_PARALLELISM;
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
        // wrong terraform variable.
        msg: invalidMsg,
        // A capacity number, not a secret — and without it in the line an
        // operator cannot tell a typo from an unset variable.
        configured: trimmed,
        using: DEFAULT_PREPROCESS_MAX_PARALLELISM,
        accepted: `integer 1-${MAX_ACCEPTED_PARALLELISM}`,
      }),
    );
    return DEFAULT_PREPROCESS_MAX_PARALLELISM;
  }

  return parsed;
}

export function resolvePreprocessMaxParallelism(raw: string | undefined): number {
  return resolveMaxParallelism(raw, "preprocess_max_parallelism_invalid");
}

/**
 * The heavy pool's parallelism, resolved the same way and for the same reasons
 * as the fast pool's — but from `HEAVY_PREPROCESS_MAX_PARALLELISM`, pinned to the
 * HEAVY preprocess service's `heavy_preprocess_max_instances` (NEO-175 Phase 3
 * terraform). The heavy service is the ~191s BiRefNet cold-loader that only
 * escalations reach, so its ceiling is set independently of the fast service's:
 * a deployment can run many fast instances (every image hits fast) and only a
 * few heavy ones (a minority escalate). Same invariant as the fast one —
 * `HEAVY_PREPROCESS_MAX_PARALLELISM` on the Convex deployment MUST equal the
 * same environment's `heavy_preprocess_max_instances` — and the same failure
 * modes in each direction (above → 429 shedding + wasted retries; below → idle
 * instances). Unset falls back to 3, which is dev/preview's intended value.
 */
export function resolveHeavyPreprocessMaxParallelism(raw: string | undefined): number {
  return resolveMaxParallelism(raw, "heavy_preprocess_max_parallelism_invalid");
}

/**
 * The resolved values this deployment runs with.
 *
 * Read once, at module load. Convex sets a deployment's environment before any
 * function runs and it cannot change under a live isolate, so re-reading per
 * call would buy nothing and would re-emit the warning above on every dispatch.
 */
export const PREPROCESS_MAX_PARALLELISM = resolvePreprocessMaxParallelism(
  process.env.PREPROCESS_MAX_PARALLELISM,
);

export const HEAVY_MAX_PARALLELISM = resolveHeavyPreprocessMaxParallelism(
  process.env.HEAVY_PREPROCESS_MAX_PARALLELISM,
);
