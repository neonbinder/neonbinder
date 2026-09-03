/**
 * NEO-212 — near-match ranking for the entity review wizard.
 *
 * Commit-time dedup for `players` and `teams` is normalized-equality only
 * (`normalizePlayerName` / `normalizeTeamName`: lowercase, strip punctuation,
 * token-sort). That key is right for the *write* — it is what makes
 * `findOrCreate` idempotent — but it is far too strict for the *review*: it
 * files "Yankees", "New York Yankees" and "NY Yankees" as three unrelated
 * franchises, and the wizard, which only ever asked "does this exact key
 * exist?", showed the operator nothing at all before creating the third row.
 *
 * This module is the softer comparison the wizard needs in front of that
 * write. It answers "which existing rows might this name already be?", never
 * "which row is it" — every result is a prompt for a human decision, and
 * nothing here may be used to merge or skip automatically.
 *
 * **Pure by contract.** No `_generated/server` import, no Convex types, no I/O.
 * The wizard imports it directly in the browser to rank locally-held
 * candidates and to dedupe a pasted name list by the same key the server
 * writes, so a Convex import here would break the client build. Keep it that
 * way.
 */

import { playerNamesMatch, teamNamesMatch } from "./pairing/names";

/**
 * How sure we are that a candidate is the same entity as the query.
 *
 * Deliberately two-valued and deliberately coarse. A numeric score would
 * invite a threshold, and a threshold in this position is an automatic merge
 * with extra steps — see the module docstring.
 */
export type NearMatchConfidence = "exact" | "close";

/** One ranked candidate: its position in the input array, and how sure we are. */
export interface RankedNearMatch {
  index: number;
  confidence: NearMatchConfidence;
}

/** The minimum a candidate must expose for ranking — the display name. */
export interface NamedCandidate {
  name: string;
}

/**
 * Tokens too generic to constitute evidence on their own.
 *
 * Only "team" and "club" actually bite: the rest are shorter than
 * `MIN_SIGNIFICANT_TOKEN_LENGTH` and are already excluded by length. They are
 * listed anyway so the intent survives a future change to that constant.
 *
 * City words are deliberately NOT here. "Boston" shared between two names is
 * real evidence for a hobby database, where the same city rarely fields two
 * teams in one sport — and where it does ("New York"), the operator is exactly
 * the right party to disambiguate.
 */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "team",
  "club",
  "the",
  "fc",
  "of",
]);

/**
 * A shared token shorter than this is noise ("new", "red", "los", "st").
 * Four characters is where a shared token starts being a nickname or a city
 * rather than a connective.
 */
const MIN_SIGNIFICANT_TOKEN_LENGTH = 4;

/**
 * Below this length the substring-containment rung of `teamNamesMatch` matches
 * essentially everything ("a" is a substring of "chicago cubs"), so it is
 * skipped. `teamNamesMatch` was written for OCR'd card text where both sides
 * are whole names; here the query can be anything an operator typed.
 */
const MIN_CONTAINMENT_CHARS = 3;

/**
 * Lowercase, strip punctuation, collapse whitespace, sort the tokens.
 *
 * **A verbatim copy of `normalizeTeamName` (convex/teams.ts) — which is itself
 * the same algorithm as `normalizePlayerName` (convex/players.ts).** Copied
 * rather than imported because both of those live in modules that import
 * `./_generated/server`, and this module must stay client-importable. The copy
 * is load-bearing, not incidental: the wizard dedupes a pasted list with this
 * function and the server then writes `nameNormalized` with those, so any
 * divergence shows up as the wizard promising "3 new teams" and the commit
 * creating 2. `entityNearMatch.test.ts` asserts the parity against fixtures;
 * if you change one of the three, change all three and extend those fixtures.
 *
 * Note the hyphen survives `[^a-z0-9\s-]`, so "Wilkes-Barre" stays one token.
 */
export function normalizeEntityName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"`’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * The normalised tokens of a name, **in source order**.
 *
 * Source order, not the sorted order `normalizeEntityName` produces, because
 * position carries meaning that sorting destroys: the last token of a player
 * name is the surname, and that is what `players.nearMatches` searches on when
 * the full-name query misses. Callers that want the dedup key want
 * `normalizeEntityName`, which sorts these.
 */
export function nameTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[.,'"`’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The longest normalised token, or null when the name has none.
 *
 * The fallback search term: in "New York Yankees" it is "yankees", the token
 * that actually identifies the franchise, while the leading tokens are shared
 * with every other New York club. Ties go to the earlier token in source order
 * — arbitrary but deterministic, which is what a query term needs to be.
 */
export function longestToken(raw: string): string | null {
  let best: string | null = null;
  for (const token of nameTokens(raw)) {
    if (best === null || token.length > best.length) best = token;
  }
  return best;
}

/**
 * Tokens present in both names that are long enough and generic enough to
 * count as evidence. Used both as a match rung (teams) and as the secondary
 * sort key (both), so a candidate sharing "york yankees" outranks one sharing
 * only "york".
 */
function sharedSignificantTokens(a: string, b: string): string[] {
  const bTokens = new Set(nameTokens(b));
  const seen = new Set<string>();
  const shared: string[] = [];
  for (const token of nameTokens(a)) {
    if (seen.has(token)) continue;
    if (token.length < MIN_SIGNIFICANT_TOKEN_LENGTH) continue;
    if (GENERIC_TOKENS.has(token)) continue;
    if (!bTokens.has(token)) continue;
    seen.add(token);
    shared.push(token);
  }
  return shared;
}

/** A candidate that survived matching, carrying the keys the sort needs. */
interface ScoredCandidate extends RankedNearMatch {
  name: string;
  shared: number;
}

/**
 * Exact first, then most shared significant tokens, then name, then input
 * order. The last rung exists only to make the result stable across engines —
 * two candidates with the same name and score are genuinely interchangeable,
 * but a wizard that reorders them between renders is not.
 */
function orderCandidates(scored: ScoredCandidate[]): RankedNearMatch[] {
  return scored
    .sort((a, b) => {
      if (a.confidence !== b.confidence) return a.confidence === "exact" ? -1 : 1;
      if (a.shared !== b.shared) return b.shared - a.shared;
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return a.index - b.index;
    })
    .map(({ index, confidence }) => ({ index, confidence }));
}

/**
 * Rank existing teams against a team name the operator is about to create.
 *
 * `exact` is normalised equality — the same key `teams.nameNormalized` holds,
 * so an exact hit here is a row `findOrCreate` would have returned anyway.
 *
 * `close` is either rung of `teamNamesMatch` (case-folded equality, or
 * containment either way: "Yankees" ⊂ "New York Yankees"), or a shared
 * significant token, which is what catches the abbreviation case containment
 * misses — "NY Yankees" is not a substring of "New York Yankees", but they
 * share "yankees".
 *
 * Candidates matching neither are dropped rather than returned with a third
 * confidence: an unranked row in a "did you mean?" list is just noise the
 * operator has to read past.
 */
export function rankTeamCandidates(
  query: string,
  candidates: readonly NamedCandidate[],
): RankedNearMatch[] {
  const normalizedQuery = normalizeEntityName(query);
  // An empty query would match every candidate through containment
  // (`"anything".includes("")`), which is the opposite of useful.
  if (!normalizedQuery) return [];

  const scored: ScoredCandidate[] = [];
  candidates.forEach((candidate, index) => {
    const shared = sharedSignificantTokens(query, candidate.name).length;

    if (normalizeEntityName(candidate.name) === normalizedQuery) {
      scored.push({ index, confidence: "exact", name: candidate.name, shared });
      return;
    }

    const containmentUsable =
      query.trim().length >= MIN_CONTAINMENT_CHARS &&
      candidate.name.trim().length >= MIN_CONTAINMENT_CHARS;
    const fuzzy = containmentUsable && teamNamesMatch(query, candidate.name).match;

    if (fuzzy || shared > 0) {
      scored.push({ index, confidence: "close", name: candidate.name, shared });
    }
  });

  return orderCandidates(scored);
}

/**
 * Rank existing players against a player name the operator is about to create.
 *
 * `exact` is normalised equality, as for teams. `close` is any rung of the
 * `playerNamesMatch` ladder — surname agreement plus an initial ("S. Ohtani"),
 * a surname on its own ("Ohtani"), or a truncated first name ("Rob"/"Robert").
 * That ladder's own `exact` flag is deliberately ignored: it strips
 * generational suffixes, so it calls "Ken Griffey Jr" and "Ken Griffey" an
 * exact match, and those are two different people often enough that the
 * operator should see the prompt rather than a settled answer.
 */
export function rankPlayerCandidates(
  query: string,
  candidates: readonly NamedCandidate[],
): RankedNearMatch[] {
  const normalizedQuery = normalizeEntityName(query);
  if (!normalizedQuery) return [];

  const scored: ScoredCandidate[] = [];
  candidates.forEach((candidate, index) => {
    const shared = sharedSignificantTokens(query, candidate.name).length;

    if (normalizeEntityName(candidate.name) === normalizedQuery) {
      scored.push({ index, confidence: "exact", name: candidate.name, shared });
      return;
    }

    if (playerNamesMatch(query, candidate.name).match) {
      scored.push({ index, confidence: "close", name: candidate.name, shared });
    }
  });

  return orderCandidates(scored);
}
