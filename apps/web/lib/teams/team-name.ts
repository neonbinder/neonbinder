/**
 * NEO-236 — the team name split: `name` ("Padres") + optional `location`
 * ("San Diego").
 *
 * ## Why "location" and not "city"
 *
 * The leading part of a franchise name is a *place*, not reliably a city.
 * "Tampa Bay" is a bay, "New England" is a region, "Golden State" is a
 * state-ish nickname, "Carolina" is two states, and college and national
 * sides ("Aztecs", "Nippon-Ham Fighters") carry none at all. Calling the
 * field `city` invited exactly the wrong validation and the wrong UI label.
 *
 * ## The invariant this module exists to protect
 *
 *     nameNormalized === normalizeTeamName(teamFullName(row))
 *
 * `normalizeTeamName` (convex/teams.ts, copied verbatim as
 * `normalizeEntityName` in convex/lib/entityNearMatch.ts) lowercases, strips
 * punctuation and TOKEN-SORTS. Because it sorts, moving a leading word out of
 * `name` and into `location` cannot change the dedup key — "San Diego Padres"
 * and ("San Diego", "Padres") normalise identically. That is what makes the
 * split safe to roll out incrementally: rows that have been split and rows
 * that have not still dedupe against each other.
 *
 * ## Pure by contract
 *
 * No Convex imports, no I/O. This module is imported by Convex functions, by
 * React components, and by tests in all three environments; a
 * `_generated/server` import here would break the client build. Keep it that
 * way — the same rule `convex/lib/entityNearMatch.ts` documents.
 */

/**
 * The minimum a row must expose to be rendered as a team name.
 *
 * `location` is `string | null | undefined` on purpose: Convex stores an
 * absent optional as `undefined`, mutation args model "clear this field" as
 * `null`, and both mean the same thing here — no location.
 */
export type TeamNameParts = { name: string; location?: string | null };

/**
 * The display name a collector recognises: "San Diego Padres".
 *
 * Both parts are trimmed and joined with a single space, so a row whose
 * `location` carries stray whitespace never renders as "San Diego  Padres"
 * (and never as a leading space when the location is empty or absent).
 */
export function teamFullName(row: TeamNameParts): string {
  const name = row.name.trim();
  const location = row.location?.trim() ?? "";
  return location ? `${location} ${name}` : name;
}

/**
 * The short name — the nickname a spine label or a compact row wants:
 * "Padres".
 *
 * Trivially `row.name`, and that is the point. Before NEO-236 this had to be
 * derived by stripping a stored `city` off the front of the full name, which
 * guessed wrong for every team whose location was never filled in. Callers
 * should use this rather than re-deriving, so the guessing has exactly one
 * place it can come back.
 */
export function teamShortName(row: TeamNameParts): string {
  return row.name.trim();
}

/** Collapse runs of whitespace so comparisons are not defeated by typing. */
function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Mechanically split `fullName` at `location`, or return `null` when it does
 * not apply.
 *
 * The split succeeds when `location` is a **whole-word, case-insensitive
 * prefix** of `fullName` and something non-empty is left over:
 *
 * - `("San Diego Padres", "San Diego")` → `{ location: "San Diego", name: "Padres" }`
 * - `("San Diego Padres", "San")` → `{ location: "San", name: "Diego Padres" }`
 * - `("San Diego Padres", "Sa")` → `null` — "Sa" is not a whole word
 * - `("San Diego Padres", "San Diego Padres")` → `null` — nothing left for the name
 * - `("Los Angeles Angels", "Anaheim")` → `null` — not a prefix at all
 *
 * **This is a mechanical operation, not a judgement.** It answers "does this
 * string sit at the front of that one", nothing more. `("San Diego State
 * Aztecs baseball", "San Diego")` → `{ location: "San Diego", name: "State
 * Aztecs baseball" }` is the CORRECT result of that question even though a
 * human would not split a college side that way. Deciding whether a split
 * should be applied is the caller's job — for the backfill that means an
 * operator confirming it, never this function deciding on its own.
 *
 * Whitespace is collapsed in both the comparison and the returned parts, so a
 * double-spaced input cannot produce a value that fails the round-trip
 * invariant in the module docstring.
 */
export function splitTeamName(
  fullName: string,
  location: string,
): { location: string; name: string } | null {
  const full = collapse(fullName);
  const loc = collapse(location);
  if (!full || !loc) return null;
  if (loc.length >= full.length) return null;
  if (full.slice(0, loc.length).toLowerCase() !== loc.toLowerCase()) return null;
  // Whole-word: the character right after the prefix must be the space we
  // collapsed to. Without this, "Sa" would split "San Diego Padres".
  if (full[loc.length] !== " ") return null;
  const name = full.slice(loc.length + 1).trim();
  if (!name) return null;
  return { location: loc, name };
}
