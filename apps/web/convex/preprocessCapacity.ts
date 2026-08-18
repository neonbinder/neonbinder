/**
 * How many preprocess requests may be in flight at once (NEO-170).
 *
 * ============================================================
 * MUST EQUAL `preprocess_max_instances` IN THE TERRAFORM REPO
 * (neonbinder_ioc/variables.tf). CHANGE BOTH TOGETHER.
 * ============================================================
 *
 * The equality is exact, not approximate, because the preprocess Cloud Run
 * service runs `container_concurrency = 1` (since NEO-161 — one full-BiRefNet
 * inference transiently allocates multiple GB, so stacking requests on a single
 * instance stacks those peaks). With one request per instance, `max_instances`
 * IS the service's total concurrent capacity: instance count and in-flight
 * request count are the same number.
 *
 * Consequences of the two drifting apart:
 *
 *  - Pool parallelism ABOVE max_instances re-creates the problem the pool was
 *    built to solve. The surplus requests are shed with 429s and burn retry
 *    attempts (~40s each) against capacity that structurally cannot exist.
 *  - Pool parallelism BELOW max_instances silently pays for idle instances and
 *    makes an 18-image batch take longer than the infrastructure allows.
 *
 * Neither failure is loud: the first looks like flaky preprocessing, the second
 * looks like preprocessing simply being slow. Hence this comment rather than a
 * bare constant — nothing mechanical can catch the drift, because the two
 * numbers live in different repositories with different release cadences.
 *
 * Lives in its own module (rather than inside placeholderPool.ts) so it can be
 * imported without pulling in the workpool component — the pool module depends
 * on generated component types, and a plain constant should not.
 */
export const PREPROCESS_MAX_PARALLELISM = 3;
