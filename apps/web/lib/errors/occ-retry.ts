/**
 * NEO-189 — retry a Convex call that lost an optimistic-concurrency race.
 *
 * ## What this is for, and what it is NOT for
 *
 * Convex mutations are optimistic: a mutation records the documents it read,
 * and if any of them changed before it committed, the mutation is rolled back
 * and retried by the platform. When a background writer keeps touching the same
 * documents, the platform exhausts its own retries and surfaces:
 *
 *   Documents read from or written to the "<table>" table changed while this
 *   mutation was being run and on every subsequent retry. A call to
 *   "<module>.js:<fn>" changed the document with ID "<id>"
 *
 * That is what killed the seed job's `commitCardChecklist`: the commit's
 * prelude reads a whole `entityReviewQueue` batch while the Wikidata pool's
 * lookups are still landing on those same rows (CI had an ESPN 403 retry storm,
 * so hundreds of them were in flight). The real fix is to stop the contending
 * writer — `applyLookupResult` now no-ops on a decided row. This helper is the
 * belt-and-braces behind it, for the straggler that slips in during the window
 * before its own guard can see the decision.
 *
 * It is NOT a general "retry anything" wrapper. Everything that is not an OCC
 * conflict is rethrown untouched and immediately, because the operations this
 * wraps are only safely repeatable for THIS failure: an OCC-failed mutation
 * rolled back completely, so re-running it starts from the same state it did
 * the first time. A mutation that failed halfway through for any other reason
 * has no such guarantee.
 */

/** Attempts INCLUDING the first — so 3 means one try plus two retries. */
export const OCC_RETRY_ATTEMPTS = 3;

/** Base backoff; multiplied by the attempt number, so 250ms then 500ms. */
export const OCC_RETRY_BACKOFF_MS = 250;

/**
 * Convex does not expose a stable machine-readable code for an OCC conflict to
 * the caller of `ctx.runMutation` — the message text is the signal available.
 * Both spellings are matched: the human sentence the platform composes, and the
 * internal error name, in case a future version surfaces that instead.
 */
const OCC_CONFLICT_PATTERN =
  /changed while this mutation was being run|OptimisticConcurrencyControlFailure/i;

function errorText(error: unknown): string {
  if (error instanceof Error) {
    // A ConvexError carries its payload on `data`; include it so a conflict
    // rethrown through one is still recognised.
    const data = (error as { data?: unknown }).data;
    return typeof data === "string" ? `${error.message} ${data}` : error.message;
  }
  return String(error);
}

/** True when `error` is Convex's optimistic-concurrency conflict. */
export function isOccConflict(error: unknown): boolean {
  return OCC_CONFLICT_PATTERN.test(errorText(error));
}

export type OccRetryOptions = {
  attempts?: number;
  backoffMs?: number;
  /** Injectable so tests do not spend real wall-clock in backoff. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Run `run`, retrying ONLY on an OCC conflict, with a linear backoff.
 *
 * Rethrows the last conflict once the attempts are spent, so the caller's own
 * error handling (a phase label, say) still wraps something truthful.
 */
export async function runWithOccRetry<T>(
  run: () => Promise<T>,
  options: OccRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? OCC_RETRY_ATTEMPTS;
  const backoffMs = options.backoffMs ?? OCC_RETRY_BACKOFF_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isOccConflict(error)) throw error;
      lastError = error;
      if (attempt < attempts) await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}
