/**
 * NEO-253 — ONE normalisation of an entity name, for every side of the wire.
 *
 * `players.nameNormalized`, `teams.nameNormalized`, `leagues.nameNormalized`,
 * the `entityReviewSkips` key, the `entityReviewQueue` resume key and the
 * commit prelude's own inline helper all have to answer "is this the same
 * name?" identically. Before this module there were SIX hand-written copies of
 * the same regex chain (`convex/players.ts`, `convex/teams.ts`,
 * `convex/leagues.ts`, two in `convex/selectorOptions.ts`, one in
 * `convex/lib/entityNearMatch.ts`), each with its own comment claiming parity
 * with the others, and `convex/lib/entityNearMatch.test.ts` existed solely to
 * assert that the copies had not drifted. A shared module makes the drift
 * unrepresentable instead of merely detectable.
 *
 * It lives in `lib/` rather than in `convex/` because the browser needs it too:
 * the entity review wizard dedupes a pasted name list with the SAME key the
 * commit then writes, and `convex/players.ts` pulls in `./_generated/server`,
 * so a browser bundle cannot import it. Same reasoning, and the same shelf, as
 * `lib/players/name-limits.ts`.
 *
 * ## What changed in NEO-253: diacritics fold
 *
 * The old chain lowercased and then dropped every character outside
 * `[a-z0-9\s-]`. An accented letter is outside that class, so "José Ramírez"
 * did not merely lose its accents — it SHREDDED into "e jos ram rez", a key
 * that resembles nothing. SportLots spells the name with accents and BSC
 * without, so one player arrived as two unrelated keys and the entity wizard
 * offered to create a second `players` row for a person NB already knew.
 *
 * Jason, 2026-09-04: "We DO need to match José and Jose: if a card says Jose
 * but the player in the database is José we should just link that player, not
 * consider them new."
 *
 * ## Why there is NO backfill, and what that means for existing rows
 *
 * Jason, 2026-09-04: "There are no players in production that are staying —
 * when we start building data there I intend to wipe and reload." Dev and
 * preview data is reseeded from the UI on every E2E run, so the only rows
 * carrying a pre-NEO-253 `nameNormalized` are rows that are about to be thrown
 * away.
 *
 * The consequence, stated plainly so nobody has to rediscover it: **a
 * `nameNormalized` written before this change is STALE for any name that
 * carried a diacritic.** Such a row is unreachable through
 * `by_name_normalized_and_sport_id` with the new key, and a fresh lookup will
 * create a sibling rather than find it. That is acceptable ONLY because the
 * data is disposable. If that ever stops being true, the fix is a re-key pass
 * over `players`, `teams`, `leagues` and `entityReviewSkips` — not a softening
 * of this function.
 *
 * ## What is deliberately NOT normalised here
 *
 * A letter with no canonical decomposition survives the fold and is then
 * dropped by the character class, exactly as it was before: "Ø", "ß", "Æ", "Ł",
 * and every non-Latin script. Folding those needs a transliteration table with
 * per-language rules, and getting one of those subtly wrong silently MERGES two
 * different people — the failure this module exists to prevent, running in
 * reverse. The narrow, reversible fold is the whole of the change.
 */

/** Combining marks left behind by NFD — the accents themselves. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Punctuation deleted rather than replaced with a space, so "O'Neal" stays one
 * token and "St. Louis" does not gain an empty one. The curly apostrophe is
 * listed alongside the straight one because marketplace HTML uses both.
 */
const DROPPED_PUNCTUATION = /[.,'"`’]/g;

/**
 * Everything else that is not a key character becomes a separator. Note the
 * hyphen is INSIDE the class, so "Wilkes-Barre" stays one token.
 */
const NON_KEY_CHARS = /[^a-z0-9\s-]/g;

/**
 * Strip diacritics without touching anything else.
 *
 * Decompose to NFD so "é" becomes "e" + U+0301, then drop the combining marks.
 * Exported because `lib/cards/card-name.ts` does the same thing for the pairing
 * modal's disagreement check and the two must not drift — that function was the
 * one place in the codebase that already folded, which is exactly how the
 * divergence NEO-253 fixes stayed invisible for so long.
 *
 * Pure ASCII is unchanged (NFD is the identity on ASCII), which is what lets
 * this be inserted ahead of the old chain without altering any existing
 * unaccented key.
 */
export function foldDiacritics(raw: string): string {
  return raw.normalize("NFD").replace(COMBINING_MARKS, "");
}

/**
 * The normalised tokens of a name, **in source order**.
 *
 * Source order, not the sorted order the dedup keys use, because position
 * carries meaning that sorting destroys: the last token of a player name is the
 * surname, and that is what `players.nearMatches` falls back to searching on
 * when the full-name query misses. Callers that want a dedup key want
 * `normalizeEntityName`, which sorts these.
 */
export function entityNameTokens(raw: string): string[] {
  return foldDiacritics(raw)
    .toLowerCase()
    .replace(DROPPED_PUNCTUATION, "")
    .replace(NON_KEY_CHARS, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The dedup key for `players` and `teams`: fold, lowercase, strip punctuation,
 * collapse whitespace, **token-sort**.
 *
 * The sort is what makes "Smith, John" and "John Smith" one row — marketplaces
 * disagree about that ordering constantly, and a duplicate player row is far
 * more expensive than the theoretical collision between two real names that are
 * anagrams of each other at the token level.
 */
export function normalizeEntityName(raw: string): string {
  return entityNameTokens(raw).sort().join(" ");
}

/**
 * The same key WITHOUT the token sort — `leagues.nameNormalized`.
 *
 * Sorting is a dedup trick for names that arrive in either order ("Yankees, New
 * York"). League names never do, and sorting would collapse "National League"
 * and "League National" into one row.
 */
export function normalizeOrderedEntityName(raw: string): string {
  return entityNameTokens(raw).join(" ");
}
