/**
 * NEO-333 — split one marketplace free-text value into the several players or
 * teams it names.
 *
 * BSC's per-card `card-listing` endpoint answered "Cleveland Guardians,
 * Washington Nationals" for a two-team card, and that string reached the
 * entity-review wizard as ONE new team. A separated value is several entities;
 * this is the one place that says how a marketplace value is cut into them.
 *
 * ## Players and teams split on DIFFERENT separators, on purpose
 *
 * - **Players** split on `,`, `/` and `|`. BSC separates a roster with commas
 *   and slashes; SportLots uses `/` and `|`. No NB player name contains any of
 *   the three.
 * - **Teams** split on `,` ONLY. Real NB team names contain `/` ("Bodø/Glimt",
 *   Negro League clubs such as "Browns/Stogies"), so a slash split would cut a
 *   real team in two. A comma is the separator BSC actually sent.
 *
 *   A comma is not a perfect separator either: real team names and aliases
 *   carry one ("Korea, South"), and BSC has sent a single team as
 *   "Scranton, Wilkes-Barre RailRiders". That is why `fetchBscCardTeamNameRaw`
 *   keeps the raw, unsplit string beside the split, and why every resolver
 *   tries the WHOLE string against existing team names and aliases first: the
 *   split applies only when the whole string does not resolve to one team.
 *
 * The two rules are two named separators and two thin wrappers, so a caller
 * cannot reach for the wrong one by accident.
 *
 * ## What the splitter does, in order
 *
 * 1. Split on the separator, trim each part, drop empty parts (a trailing
 *    comma, a doubled separator).
 * 2. Re-attach a generational suffix. A part that is ONLY `Jr`/`Sr`/`II`/
 *    `III`/`IV` (period optional, any case) belongs to the name before it:
 *    "Ken Griffey, Jr., Mike Trout" is two names, the first "Ken Griffey Jr.".
 *    A suffix with no name before it is dropped; it names nobody.
 * 3. Dedupe case-insensitively, keeping the first spelling.
 * 4. Bound with `boundParsedNames`: an over-length name is dropped, and a list
 *    longer than the limit is refused whole.
 *
 * Pure, and deliberately carries NO `"use node"` directive, so both Node
 * adapters (and anything in the default runtime) can import it.
 */

import { MAX_PLAYER_NAME_LENGTH } from "../../lib/players/name-limits";
import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "../features/cardAttention";

/** Player values: comma, slash or pipe. No NB player name contains one. */
export const PLAYER_NAME_SEPARATOR = /[,/|]/;

/**
 * Team values: comma only. Real NB team names contain `/` and `|` is not a
 * team separator any marketplace has sent; see the module header.
 */
export const TEAM_NAME_SEPARATOR = /,/;

/**
 * A part that is only a generational suffix: "Jr", "jr.", "III", "iv.". No
 * surrounding whitespace — callers test a trimmed value. Exported so the
 * NEO-333 stored-data report flags exactly what this splitter re-attaches.
 */
export const GENERATIONAL_SUFFIX_ONLY = /^(?:jr|sr|ii|iii|iv)\.?$/i;

/** What a split produced, plus whether anything was dropped or refused. */
export type SplitMarketplaceNames = {
  names: string[];
  /**
   * `true` when this value carried text NB could not represent (an
   * over-length name, or more names than `limit`). A flag only, never the
   * text: see `boundParsedNames`.
   */
  unrepresentable: boolean;
};

/**
 * NEO-246/NEO-251 — bound what a parser is allowed to emit for one card.
 *
 * A free-text marketplace field is split into a list, so the list's length is
 * a property of a marketplace page, not of anything NB controls: a row
 * carrying a checklist blob in the player field, or an upstream change to how
 * that field is punctuated, turns one string into an arbitrary list.
 * `assertCardBatchWithinLimits` refuses such a card at the commit boundary —
 * which is the right answer for a payload a client hands us, but a poor one
 * for a real upstream row, because it fails the operator's whole sync over a
 * page NB merely read. So the bound is closed at the parse too, and the
 * boundary becomes the backstop it was meant to be rather than the only guard.
 *
 * Derived from the shared constants rather than respelled, the same way the
 * SportLots parser does it (`SL_MAX_SUBJECTS = Math.min(4, MAX_CARD_PLAYERS)`,
 * `SL_MAX_SUBJECT_LENGTH = MAX_PLAYER_NAME_LENGTH`), so this can never emit a
 * list the DB side refuses.
 *
 * ## Over-cap is a REFUSED roster, not a trimmed one
 *
 * The count cap returns `[]`. It does not keep the first N. A field holding
 * more names than a card can carry is not a long roster — it is a field whose
 * meaning NB has misread, almost always a checklist blob or a punctuation
 * change upstream. Keeping the first 20 of 27 mints a plausible-looking roster
 * out of one, and a wrong roster that looks right is worse than no roster at
 * all: nothing downstream can tell it from a real one, and it would be
 * committed, listed and read back as fact. This is the same rule
 * `startCandidateBatch` states for the pairing conflict — "refused, never
 * trimmed: a truncated roster is a wrong roster that looks right" — and the
 * two must not disagree about the same field.
 *
 * The card itself still survives; only its roster is dropped, so it lands as
 * `Card #<n>` with no players, exactly as a BSC row with an empty player field
 * always has. The entity-review wizard already handles a card with no names.
 *
 * ## An over-length name is a DROP, and that argument is different
 *
 * A single name past `MAX_PLAYER_NAME_LENGTH` says nothing about its
 * neighbours — "Mike Trout" is still Mike Trout — so the row keeps what is
 * sound. It is dropped rather than truncated because a truncated name is a
 * person who does not exist and would reach `players.findOrCreate` looking
 * exactly like a real one.
 *
 * ## Nothing is silent
 *
 * Either outcome sets `unrepresentable`, which `fetchBscChecklist` counts and
 * reports in its `message`. A COUNT only: the dropped names are the very text
 * NB could not make sense of, and echoing marketplace text into an operator
 * message is what the no-echo rule in `assertCardBatchWithinLimits` exists to
 * prevent.
 */
export function boundParsedNames(
  names: string[],
  limit: number,
): SplitMarketplaceNames {
  const kept = names.filter((n) => n.length <= MAX_PLAYER_NAME_LENGTH);
  // Over the count cap: the whole list is refused, because the field's meaning
  // is in doubt rather than merely its tail.
  if (kept.length > limit) return { names: [], unrepresentable: true };
  // Under it: what survived the length filter stands, and a name having been
  // dropped is still reported.
  return { names: kept, unrepresentable: kept.length !== names.length };
}

/**
 * Split one marketplace value into names on `separator`, re-attach
 * generational suffixes, dedupe case-insensitively and bound the result to
 * `limit`. See the module header for the rules and why players and teams use
 * different separators; prefer the two named wrappers below.
 */
export function splitMarketplaceNames(
  raw: string,
  limit: number,
  separator: RegExp,
): SplitMarketplaceNames {
  const parts = raw
    .split(separator)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const joined: string[] = [];
  for (const part of parts) {
    if (GENERATIONAL_SUFFIX_ONLY.test(part)) {
      // A suffix with nothing before it names nobody: dropped.
      if (joined.length > 0) {
        joined[joined.length - 1] = `${joined[joined.length - 1]} ${part}`;
      }
      continue;
    }
    joined.push(part);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of joined) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }

  return boundParsedNames(unique, limit);
}

/** A player value: split on `,`, `/` and `|`, bounded by `MAX_CARD_PLAYERS`. */
export function splitMarketplacePlayerNames(raw: string): SplitMarketplaceNames {
  return splitMarketplaceNames(raw, MAX_CARD_PLAYERS, PLAYER_NAME_SEPARATOR);
}

/** A team value: split on `,` only, bounded by `MAX_CARD_TEAMS`. */
export function splitMarketplaceTeamNames(raw: string): SplitMarketplaceNames {
  return splitMarketplaceNames(raw, MAX_CARD_TEAMS, TEAM_NAME_SEPARATOR);
}
