/**
 * NEO-330 security review — the server-side bound on typed search text.
 *
 * `teams.search`, `players.search` and `teams.searchForManagement` take a
 * free-form `query: v.string()` from the client and run it through a search
 * index (and, for the team searches, a per-word matcher). A Convex deployment
 * URL ships in the client bundle, so nothing but this function stops a caller
 * from sending a megabyte of text or a thousand words: tokenising, normalising
 * and matching that costs the deployment, and Convex search itself only
 * honours a handful of terms. Nobody types a team or player name longer than
 * this, so clamping changes no real answer.
 *
 * Applied to the RAW text, before any normalisation, so every reading the
 * handler derives (search terms, the alias key, the every-word filter) is
 * derived from the same bounded string.
 */

/** Characters kept from the front of the typed text. */
export const SEARCH_QUERY_MAX_CHARS = 200;

/** Words kept, counted after the character cut. */
export const SEARCH_QUERY_MAX_TOKENS = 16;

/**
 * A "word" for counting purposes: a run of letters (with their combining
 * marks) and digits. Deliberately broader than any normaliser's split — it
 * counts "O'Neal" as two — so the clamp can only ever cut EARLIER than a
 * downstream tokeniser would, never let more than the cap through.
 */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * The typed text, cut to its first `SEARCH_QUERY_MAX_CHARS` characters and then
 * to its first `SEARCH_QUERY_MAX_TOKENS` words.
 *
 * The cut is a SLICE of the original string, so punctuation and spacing inside
 * the kept part are untouched ("St. Louis" stays "St. Louis"): the handlers
 * normalise it exactly as they would have normalised the whole.
 */
export function clampSearchQuery(raw: string): string {
  const head = raw.slice(0, SEARCH_QUERY_MAX_CHARS);
  let count = 0;
  let keptEnd = 0;
  for (const match of head.matchAll(WORD)) {
    count += 1;
    if (count > SEARCH_QUERY_MAX_TOKENS) return head.slice(0, keptEnd);
    keptEnd = (match.index ?? 0) + match[0].length;
  }
  return head;
}
