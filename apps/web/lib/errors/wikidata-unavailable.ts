/**
 * NEO-301 — "Wikidata could not be asked" is not "Wikidata has no answer".
 *
 * query.wikidata.org is intermittently slow or erroring on our lookup's query
 * shape, and until this module the adapter answered a timed-out, 5xx, 429 or
 * thrown request with the same `null` it answers a genuine no-match with. A
 * player created during a bad minute was left bare for good, and a review row
 * read "No Wikidata match found" for a name Wikidata knows.
 *
 * The distinction now travels as a THROW of `WikidataUnavailableError` from
 * the four `wikidataPool` work items (`enrichPlayer`, `enrichTeam`,
 * `enrichLeague`, `runEntityReviewLookup`), which the pool retries with
 * backoff (convex/wikidataPool.ts carries the ladder and its arithmetic). The
 * lookup functions themselves stay no-throw — see `LookupTrace` in
 * convex/adapters/wikidata.ts for why the signal is raised by the work item
 * and not by the adapter.
 *
 * Pure on purpose: the throw happens in the node adapter, the verdict is read
 * back in the V8 pool callbacks (convex/wikidataPool.ts,
 * convex/entityReviewQueue.ts), and a V8 module cannot import a `"use node"`
 * one. The error crosses the workpool as a MESSAGE string (`RunResult.error`),
 * so the message is the wire format and `parseWikidataUnavailable` reads it
 * back. It carries a kind and a transport reason, never a name.
 */

import type { RunResult } from "@convex-dev/workpool";

/** The token every unavailable-lookup message starts with. */
export const WIKIDATA_UNAVAILABLE_MARKER = "wikidata_unavailable";

export type WikidataLookupKind = "player" | "team" | "league";

const KINDS: ReadonlySet<string> = new Set<WikidataLookupKind>(["player", "team", "league"]);

/**
 * Thrown by a `wikidataPool` work item when its lookup could not reach an
 * answer: a timeout, a network error, a 5xx or a 429 on the LAST attempt of any
 * SPARQL call the lookup made. A plain `Error`, so the workpool treats it as
 * retryable (only `NonRetryableError` opts out).
 *
 * `reason` is the transport verdict `runSparql` classified (`timeout`,
 * `network`, `http_503` …) — a fixed vocabulary, never response text.
 */
export class WikidataUnavailableError extends Error {
  readonly kind: WikidataLookupKind;
  readonly reason: string;

  constructor(kind: WikidataLookupKind, reason: string) {
    super(`${WIKIDATA_UNAVAILABLE_MARKER} kind=${kind} reason=${sanitizeReason(reason)}`);
    this.name = "WikidataUnavailableError";
    this.kind = kind;
    this.reason = sanitizeReason(reason);
  }
}

/** Keep the reason to the token alphabet the parser reads back. */
function sanitizeReason(reason: string): string {
  const cleaned = reason.replace(/[^a-z0-9_]/gi, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "unknown";
}

const MESSAGE_PATTERN = new RegExp(
  `${WIKIDATA_UNAVAILABLE_MARKER} kind=([a-z]+) reason=([A-Za-z0-9_]+)`,
);

/**
 * Read a `WikidataUnavailableError` back out of whatever string the error
 * became on its way through the workpool. Convex may prefix the message
 * ("Uncaught WikidataUnavailableError: …") or append a stack, so this searches
 * rather than anchors. `null` for anything else.
 */
export function parseWikidataUnavailable(
  message: string | undefined,
): { kind: WikidataLookupKind; reason: string } | null {
  if (!message) return null;
  const match = MESSAGE_PATTERN.exec(message);
  if (!match || !KINDS.has(match[1])) return null;
  return { kind: match[1] as WikidataLookupKind, reason: match[2] };
}

/** True when a pool `RunResult` is a work item that gave up on Wikidata. */
export function isWikidataUnavailableResult(result: RunResult): boolean {
  return result.kind === "failed" && parseWikidataUnavailable(result.error) !== null;
}

/**
 * The structured line an ENRICHMENT work item's completion emits, or `null`
 * for a success (nothing to report).
 *
 * `onComplete` runs exactly once, after the workpool's final attempt, so a
 * `failed` result carrying the unavailable marker means every attempt of the
 * retry ladder ended without reaching Wikidata and the row stays bare:
 * `wikidata_{kind}_unavailable`. Any other failure (a thrown query, a write
 * that failed) or a cancellation gets its own marker so the two are never
 * confused in the log.
 *
 * Ids, kinds and counts only. The error TEXT of a non-Wikidata failure is
 * deliberately not copied: a thrown validator message can quote a value, and
 * the row's name is never logged (observability.ts).
 */
export function enrichmentCompletionLogLine(
  context: { kind: WikidataLookupKind; id: string },
  result: RunResult,
  maxAttempts: number,
): Record<string, unknown> | null {
  if (result.kind === "success") return null;
  if (result.kind === "failed") {
    const unavailable = parseWikidataUnavailable(result.error);
    if (unavailable) {
      return {
        msg: `wikidata_${context.kind}_unavailable`,
        kind: context.kind,
        id: context.id,
        reason: unavailable.reason,
        attempts: maxAttempts,
      };
    }
  }
  return {
    msg: "wikidata_enrichment_failed",
    kind: context.kind,
    id: context.id,
    resultKind: result.kind,
  };
}
