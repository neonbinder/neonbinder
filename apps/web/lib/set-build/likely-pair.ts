/**
 * NEO-339 — the likely partner of a marketplace set nobody pairs: what the
 * Set Builder can SUGGEST for an unpaired set, never a pairing. The set-
 * building tool's draft puts it on each unpaired set's open decision
 * (tools/setbuild/runner/draft.ts); it reads names through the matcher's own
 * comparison (`nameAffinity`, convex/lib/setNameMatch.ts), and the caller
 * still checks a suggestion against the cards (`pairCardEvidence`). Pure.
 */
import { nameAffinity } from "../../convex/lib/setNameMatch";

type Side = "bsc" | "sportlots";

/** One marketplace set nobody pairs, with the marketplace's name for it. */
export interface UnpairedSet {
  side: Side;
  id: string;
  name: string;
}

/** A name at least this alike (`nameAffinity`, 0 to 1) is listed as a candidate partner. */
export const LISTED_PAIR_SCORE = 0.5;
/** A sole best candidate at least this alike, and the set its sole best back, is the suggested pair. */
export const LIKELY_PAIR_SCORE = 0.65;
/** Candidate partners listed per unpaired set. */
export const LISTED_PAIRS = 3;

/**
 * Something an unpaired set could be paired with: another unpaired set of
 * the type (on the other marketplace), or a drafted row that has ids on the
 * other marketplace only (`row`, its `id` the row's spec location).
 */
export interface PairCandidate {
  id: string;
  name: string;
  side: Side;
  bsc: string[];
  sportlots: string[];
  row?: boolean;
}

/**
 * The candidates an unpaired set could be paired with, by how alike their
 * names read (`nameAffinity`, the matcher's own normalisation, with the
 * manufacturer word and SportLots' prefixes folded): those at
 * `LISTED_PAIR_SCORE` or more, best first, at most `LISTED_PAIRS`. The best
 * is `suggested` only when it is at least `LIKELY_PAIR_SCORE`, no other
 * candidate reads as alike (a tie suggests nothing), and `set` is in turn the
 * one set of its side (`sameSide`) that reads most like it. A ranking for
 * the operator, never a pairing. Pure.
 */
export function rankPairCandidates(
  set: UnpairedSet,
  pool: readonly PairCandidate[],
  sameSide: readonly UnpairedSet[],
  ctx: { manufacturer?: string; slPrefixes?: readonly string[] },
): { listed: PairCandidate[]; suggested?: PairCandidate } {
  const score = (a: { side: Side; name: string }, b: { side: Side; name: string }) =>
    a.side === "bsc" ? nameAffinity(a.name, b.name, ctx) : nameAffinity(b.name, a.name, ctx);
  const scored = pool
    .filter((c) => c.side !== set.side)
    .map((c) => ({ c, s: score(set, c) }))
    .filter((x) => x.s >= LISTED_PAIR_SCORE)
    .sort((a, b) => b.s - a.s);
  const listed = scored.slice(0, LISTED_PAIRS).map((x) => x.c);
  const [best, next] = scored;
  if (!best || best.s < LIKELY_PAIR_SCORE || (next && next.s >= best.s)) return { listed };
  // Reciprocal: no other set of this side reads as much like the candidate.
  const rival = sameSide.some((o) => o.side === set.side && o.id !== set.id && score(o, best.c) >= best.s);
  return rival ? { listed } : { listed, suggested: best.c };
}

