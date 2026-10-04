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
 * ## What changed in NEO-322: initials
 *
 * Periods are deleted, not turned into separators (see `DROPPED_PUNCTUATION`),
 * so "C.J. Kayfus" keyed as "cj kayfus" while "C. J. Kayfus" keyed as
 * "c j kayfus". Marketplaces and operators write initials both ways, so a
 * player NB already held was offered on production as a new person.
 *
 * The rule: after tokenising, every maximal run of TWO OR MORE adjacent tokens
 * that are each a single letter `a`–`z` is joined into one token, order kept
 * (`joinInitialRuns`). "C. J. Kayfus", "C J Kayfus", "C.J. Kayfus" and
 * "CJ Kayfus" all become "cj kayfus"; "N. H. L." becomes "nhl" in the ordered
 * league key; "Texas A&M" becomes "texas am" before the sort.
 *
 * The join runs BEFORE the token sort, and that matters in its own right: the
 * sort used to scatter initials, so "A. J. Smith" and "J. A. Smith" both keyed
 * as "a j smith" — two different people on one row. Joined first, they key as
 * "aj smith" and "ja smith".
 *
 * Two things are deliberately left alone:
 *
 * - **Digits.** "Big 12" is unchanged, and single digits standing side by
 *   side are numbers, not initials; joining them would fuse values that the
 *   name deliberately keeps apart.
 * - **A lone initial.** A run of one ("P. Mahomes", "Michael A. Taylor") has
 *   nothing to join with. Absorbing it into a neighbour would change the
 *   key of every name with a middle initial, for no match gained.
 *
 * ## A key change means a re-key on every deployment
 *
 * Until NEO-322 this section explained why NEO-253 shipped without a backfill:
 * no production player was staying. That is no longer true — production now
 * holds data that stays — so `convex/rekeyEntityNames.ts` exists, and it MUST
 * be run on every deployment after any change to the chain in this module.
 *
 * A stored key built by an older version of this chain is not merely
 * cosmetic: lookups go through `by_name_normalized_and_sport_id` with the
 * CURRENT key, so a row carrying a stale key is unreachable, and a fresh lookup
 * creates a sibling rather than finding it. The fix for a stale key is always
 * the re-key pass — never a softening of this function to accept both shapes.
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

/** One token that is a single letter — an initial once periods are gone. */
const SINGLE_LETTER = /^[a-z]$/;

/**
 * NEO-322 — join each maximal run of two or more adjacent single-letter tokens
 * into one token, in order: `["c", "j", "kayfus"]` → `["cj", "kayfus"]`.
 *
 * A run of one is left as it is ("p mahomes" stays two tokens), and digits are
 * never joined ("big 12" is unchanged). Expects tokens already folded,
 * lowercased and stripped, which is what `entityNameTokens` hands it. See the
 * module note for why each exclusion exists.
 */
export function joinInitialRuns(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2) out.push(run.join(""));
    else out.push(...run);
    run = [];
  };
  for (const token of tokens) {
    if (SINGLE_LETTER.test(token)) {
      run.push(token);
    } else {
      flush();
      out.push(token);
    }
  }
  flush();
  return out;
}

/**
 * The normalised tokens of a name, **in source order**, with runs of initials
 * joined (`joinInitialRuns`).
 *
 * Source order, not the sorted order the dedup keys use, because position
 * carries meaning that sorting destroys: the last token of a player name is the
 * surname, and that is what `players.nearMatches` falls back to searching on
 * when the full-name query misses. Callers that want a dedup key want
 * `normalizeEntityName`, which sorts these.
 */
export function entityNameTokens(raw: string): string[] {
  return joinInitialRuns(unjoinedTokens(raw));
}

/** Fold, lowercase, strip and split — every step of the chain before the join. */
function unjoinedTokens(raw: string): string[] {
  return foldDiacritics(raw)
    .toLowerCase()
    .replace(DROPPED_PUNCTUATION, "")
    .replace(NON_KEY_CHARS, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * NEO-322 — the readings of a TYPEAHEAD query, for matching typed text as
 * prefixes of a stored key's tokens. Never a key itself.
 *
 * `entityNameTokens` joins a run of initials, which is right for a finished
 * name and wrong on the keystroke where the operator has typed the first
 * letter of the NEXT word: "J. T. R", on the way to "J. T. Realmuto", joins to
 * "jtr", the prefix of nothing in "jt realmuto". So when the text ends in two
 * or more single letters, a second reading keeps the last one apart —
 * `["jt", "r"]` — and the caller accepts a row either reading matches. Every
 * other query has exactly one reading, `entityNameTokens(raw)`, first.
 */
export function entityNameQueryReadings(raw: string): string[][] {
  const tokens = unjoinedTokens(raw);
  const joined = joinInitialRuns(tokens);
  const n = tokens.length;
  if (n < 2 || !SINGLE_LETTER.test(tokens[n - 1]) || !SINGLE_LETTER.test(tokens[n - 2])) {
    return [joined];
  }
  return [joined, [...joinInitialRuns(tokens.slice(0, -1)), tokens[n - 1]]];
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
