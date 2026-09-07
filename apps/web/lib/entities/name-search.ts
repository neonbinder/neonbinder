/**
 * NEO-253 (audit) — the key a typeahead FILTERS on, which is not the key the
 * database dedupes on.
 *
 * The three entity pickers (`PlayerPicker`, `TeamPicker`, `CareerTeamEntry`)
 * each filtered with a bare `c.name.toLowerCase().includes(q)` and decided
 * whether to offer "+ Create …" with a bare `c.name.toLowerCase() === q`.
 * Neither folded, so typing "Jose Ramirez" against NB's "José Ramírez" hid the
 * row AND offered to create it — and pressing Create then ran `findOrCreate`,
 * whose key DOES fold, so the operator was shown a create affordance that
 * silently resolved to the row the list had just hidden from them. The UI and
 * the server disagreed about whether a player existed.
 *
 * ## Why this is a separate key from `normalizeEntityName`
 *
 * `normalizeEntityName` token-SORTS. That is right for identity — it is what
 * makes "Smith, John" and "John Smith" one row — and it is fatal for a
 * substring filter: sorted, "New York Yankees" is "new yankees york", which
 * does not contain "new york". Routing the filter through the dedup key would
 * have broken the single most common thing anybody types into these boxes.
 *
 * So the split is by QUESTION, not by convenience:
 *
 *   - "does this row match what I am typing?" → this module. Fold and
 *     lowercase, nothing else, so ASCII behaviour is byte-identical to what it
 *     has always been and only the accents change.
 *   - "does a row already exist that Create would collide with?" →
 *     `normalizeEntityName`, sorting included, because that question must be
 *     answered exactly as `findOrCreate` will answer it. Anything softer offers
 *     Create for a row the server would return; anything harder hides Create
 *     for a name the server would insert.
 */

import { foldDiacritics } from "./normalize-name";

/**
 * Fold diacritics and lowercase. No trimming, no whitespace collapsing, no
 * punctuation handling — deliberately, so that for pure-ASCII input this is
 * exactly `String.prototype.toLowerCase` and every existing filter, prefix rank
 * and ordering behaves as it did. Callers trim the QUERY themselves, as they
 * always have.
 */
export function nameSearchKey(raw: string): string {
  return foldDiacritics(raw).toLowerCase();
}

/**
 * Does `name` contain `query`, ignoring case and accents?
 *
 * An empty query matches everything, which is what the pickers want: the list
 * before you type is the full candidate set, not an empty one.
 */
export function nameMatchesQuery(name: string, query: string): boolean {
  const q = nameSearchKey(query.trim());
  return !q || nameSearchKey(name).includes(q);
}

/**
 * Does `name` START with `query`? The pickers rank a prefix hit above a mere
 * substring hit, so typing "New" surfaces "New York Yankees" before "Newark
 * Eagles" before a random mid-name match. Folded on both sides for the same
 * reason the filter is: an accented row that reached the list must not then be
 * ranked as though it had matched by accident.
 */
export function nameHasQueryPrefix(name: string, query: string): boolean {
  const q = nameSearchKey(query.trim());
  return !!q && nameSearchKey(name).startsWith(q);
}
