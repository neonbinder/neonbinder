/**
 * NEO-339 — a spec check that failed while a step ran.
 *
 * Examples: a count the spec expects (`expectCards`, `expectRows`,
 * `group.expectUngrouped`), a Match Cards answer that names no card in the
 * fetch, or a build the server refused. These are not infrastructure failures.
 * The run worked, and what it found disagrees with the spec. Many of them can
 * only be checked during `apply`, because the rows they read do not exist
 * before it.
 *
 * The engine (runner/engine.ts, `failed`) handles every one of them the same
 * way. It records the step as blocked, with this message. It stops there, as
 * it stops at an open decision. Then it returns the whole report, with every
 * step done so far, so a run that already synced, committed and grouped does
 * not lose that record. Any error that is not a `StepCheckError` (network,
 * auth, a marketplace fetch, a server fault) still ends the run as a
 * `RunFailed` that carries the report so far.
 *
 * Every error class a step throws for a spec check extends this one.
 */
export class StepCheckError extends Error {
  /** What the step had already done when the check failed, for the step report (e.g. the Match Cards summary). */
  readonly progress?: string;
  constructor(message: string, opts: { progress?: string } = {}) {
    super(message);
    this.name = "StepCheckError";
    if (opts.progress) this.progress = opts.progress;
  }
}
