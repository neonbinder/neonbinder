import { defineApp } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";

/**
 * Convex component wiring (NEO-170).
 *
 * `preprocessPool` is the queue in front of the preprocess Cloud Run service.
 * It exists because the preprocess side is deliberately stateless and
 * capacity-bound: `container_concurrency = 1` (a single full-BiRefNet inference
 * transiently allocates multiple GB, so concurrent requests on one instance
 * stack those peaks past any sane limit — see NEO-161) and `max_instances = 3`.
 * That means total concurrent capacity is 3, and the service sheds anything
 * beyond it with a 429 while cold-starting new instances takes tens of seconds.
 *
 * An 18-image print-sheet batch fanned out directly would spend most of itself
 * being shed. Fanning it through a workpool pinned to the same parallelism as
 * Cloud Run's instance ceiling turns "18 requests at once" into "3 in flight,
 * always" — no shedding to recover from, no cold-start stampede, and the retry
 * budget is spent on genuinely transient failures instead of self-inflicted
 * ones.
 *
 * Convex owns all orchestration, progress state and retries; see
 * convex/placeholderPool.ts for the pool instance and
 * convex/placeholderPipeline.ts for the state machine it drives.
 *
 * NOTE: adding another pool means adding another `app.use(workpool, {...})`
 * here with a distinct `name`. Constructing a second `Workpool` class instance
 * against the SAME component does not give you a second pool — the component
 * instance is the pool.
 */
const app = defineApp();
app.use(workpool, { name: "preprocessPool" });

export default app;
