/**
 * NEO-463 — is a new player name just a piece of a player NB already knows?
 *
 * A card or a typed name that says only "Walker" in a sport that already holds
 * "Larry Walker" is almost always a surname that lost its first name somewhere
 * (a marketplace title, a fast typist), not a new one-name player. Writing it
 * silently mints a second row for a man NB already has, and every card linked
 * to the stub is invisible from his real row. So a single-token name that
 * equals the FIRST or LAST token of a fuller-named player in the same sport is
 * a question for the operator, never a silent insert.
 *
 * A real mononym with no clash ("Pelé", "Takuya", "Boomer") is not a question
 * and is written as before. One that does clash can still be created, but only
 * when the operator says so (`oneNamePlayer: true` on the write).
 *
 * Pure, so the browser can explain the same rule the server enforces. Tokens
 * come from `entityNameTokens` (fold accents, lowercase, strip punctuation,
 * join initials) so "Walker", "WALKER" and "Wálker" are one fragment. Matching
 * reads the DISPLAY name, never `nameNormalized`: that key is token-SORTED, so
 * its first and last tokens are alphabetical, not first name and surname.
 */
import { entityNameTokens } from "../entities/normalize-name";

/**
 * Generational suffixes dropped from the END of a name before counting, so
 * "Walker Jr." is one token. Only a trailing one, and never the only token.
 */
const GENERATIONAL_SUFFIXES: ReadonlySet<string> = new Set(["jr", "sr", "ii", "iii", "iv"]);

/** True when one written word ("Jr.", "III") is a generational suffix. */
export function isGenerationalSuffix(word: string): boolean {
  const tokens = entityNameTokens(word);
  return tokens.length === 1 && GENERATIONAL_SUFFIXES.has(tokens[0]);
}

/** The folded tokens of a name, in source order, minus a trailing generational suffix. */
export function nameFragmentTokens(raw: string): string[] {
  const tokens = entityNameTokens(raw);
  if (tokens.length > 1 && GENERATIONAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    return tokens.slice(0, -1);
  }
  return tokens;
}

/** True when the name is exactly one token once folded and any trailing suffix is dropped. */
export function isSingleToken(raw: string): boolean {
  return nameFragmentTokens(raw).length === 1;
}

/**
 * The candidates whose first or last token equals `fragment`'s only token.
 *
 * Returns nothing when `fragment` is not a single token, and skips candidates
 * that are themselves a single token: those are not FULLER names, and an exact
 * same-name row is linked by the caller's exact-match path long before this.
 */
export function fragmentMatches<T extends { name: string }>(
  fragment: string,
  candidates: ReadonlyArray<T>,
): T[] {
  const own = nameFragmentTokens(fragment);
  if (own.length !== 1) return [];
  const token = own[0];
  return candidates.filter((c) => {
    const tokens = nameFragmentTokens(c.name);
    if (tokens.length < 2) return false;
    return tokens[0] === token || tokens[tokens.length - 1] === token;
  });
}
