import { defineApp } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";

/**
 * Convex component wiring (NEO-170, split into fast/heavy for NEO-175).
 *
 * `fastPreprocessPool` and `heavyPreprocessPool` are the two queues in front of
 * the preprocess Cloud Run services. The split exists because preprocessing an
 * image is two very different amounts of work depending on the card:
 *
 *   - the FAST service runs the classical-only fast path — it never loads a
 *     model, cold-starts in seconds, and settles the identity-majority of cards.
 *     Every image is enqueued here FIRST (`fastPreprocessPool`).
 *   - the HEAVY service runs the full BiRefNet+SAM cascade, cold-loads ~191s,
 *     and is the one the fast service escalates to when the classical path
 *     cannot settle a card. Only escalations reach it (`heavyPreprocessPool`).
 *
 * Each service is deliberately stateless and capacity-bound: `container_
 * concurrency = 1` (a single full-BiRefNet inference transiently allocates
 * multiple GB, so concurrent requests on one instance stack those peaks past any
 * sane limit — see NEO-161). With one request per instance, each service's
 * `max_instances` IS its total concurrent capacity, and each pool's
 * `maxParallelism` is pinned to its own service's ceiling so a batch fanned out
 * through it turns "N requests at once" into "at most `max_instances` in flight,
 * always" — no shedding to recover from, no cold-start stampede.
 *
 * Convex owns all orchestration, progress state and retries; see
 * convex/placeholderPool.ts for the fast pool instance,
 * convex/placeholderHeavyPool.ts for the heavy pool + escalation enqueue, and
 * convex/placeholderPipeline.ts for the state machine that drives both.
 *
 * `wikidataPool` (NEO-99) is the queue in front of query.wikidata.org's SPARQL
 * endpoint. Wikidata documents a hard limit of 5 parallel queries per client IP,
 * and Convex Cloud sends every deployment's outbound requests from one IP — so
 * the entity-review wizard's per-batch pacing was not enough: several review
 * batches (plus the E2E runners) draining concurrently blew past 5 parallel,
 * Wikidata throttled the IP, a lookup stalled, and the wizard hung on
 * "Looking up…" forever. Pinning this pool to `maxParallelism: 5` makes every
 * SPARQL caller in the deployment share ONE 5-wide lane regardless of how many
 * batches are running. See convex/wikidataPool.ts for the instance.
 *
 * NOTE: adding another pool means adding another `app.use(workpool, {...})`
 * here with a distinct `name`. Constructing a second `Workpool` class instance
 * against the SAME component does not give you a second pool — the component
 * instance is the pool. That is exactly why the fast and heavy queues are TWO
 * `app.use` calls: they must be independently capacity-bound, so they cannot
 * share one component.
 */
const app = defineApp();
app.use(workpool, { name: "fastPreprocessPool" });
app.use(workpool, { name: "heavyPreprocessPool" });
app.use(workpool, { name: "wikidataPool" });

export default app;
