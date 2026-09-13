/**
 * NEO-277 — the rules for a set-level team (`selectorOptions.teamIds`) and
 * how it reaches the rows beneath it.
 *
 * Three writers apply these rules and must agree about them: the node and
 * card CREATION sites (copy-down), the edit CASCADE
 * (`cascadeSelectorOptionTeams`), and the cascade PREVIEW the confirm dialog
 * shows before the edit. Three copies of "does this row follow?" is three
 * chances for the dialog to promise a count the cascade does not deliver, so
 * the decision lives here once, as pure functions, and is tested as such.
 *
 * Typed against ids only — no generated code, no ctx — so a lib test can
 * exercise every branch without seeding a database.
 */

import type { Id } from "../_generated/dataModel";

/**
 * What a freshly created child inherits from its parent: the parent's
 * `teamIds` when there are any, else nothing. Returns a COPY, so the child's
 * array is never the parent's array by reference. `undefined` (not `[]`) so a
 * caller can spread `...(x ? { teamIds: x } : {})` and an absent set-level
 * team stays absent on the child rather than becoming an empty array — an
 * empty array is never stored (see schema.ts `teamIds`).
 */
export function inheritedTeamIds(
  parent: { teamIds?: ReadonlyArray<Id<"teams">> } | null | undefined,
): Array<Id<"teams">> | undefined {
  const ids = parent?.teamIds;
  return ids && ids.length > 0 ? [...ids] : undefined;
}

/**
 * Order-insensitive equality over two id lists. `teamOnCardIds` is display
 * order, so two rows carrying the same teams in a different order still carry
 * the same teams — a cascade must not read that as an override.
 */
export function sameTeamSet(
  a: ReadonlyArray<Id<"teams">> | undefined,
  b: ReadonlyArray<Id<"teams">> | undefined,
): boolean {
  const left = new Set<string>(a ?? []);
  const right = new Set<string>(b ?? []);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/**
 * The verdict for one descendant row when the set-level team changes from
 * `previous` to `next` — the NEO-24 "equal-to-previous follows" rule:
 *
 *  - `"unchanged"`: the row already carries `next`; nothing to write, and it
 *    counts as neither following nor staying.
 *  - `"follow"`: the row is empty, or carries exactly what the set carried
 *    BEFORE this edit — it was inheriting, so it keeps inheriting.
 *  - `"stay"`: anything else is an operator's override and is left alone.
 *
 * `next` is never empty here: a CLEAR never cascades (see schema.ts), so the
 * callers do not ask.
 */
export type TeamFollowVerdict = "unchanged" | "follow" | "stay";

export function teamFollowVerdict(
  current: ReadonlyArray<Id<"teams">> | undefined,
  previous: ReadonlyArray<Id<"teams">> | undefined,
  next: ReadonlyArray<Id<"teams">>,
): TeamFollowVerdict {
  if (sameTeamSet(current, next)) return "unchanged";
  if (!current || current.length === 0) return "follow";
  if (sameTeamSet(current, previous)) return "follow";
  return "stay";
}

/**
 * The verdict for one CARD, which has two more reasons to stay than a node:
 *
 *  - an operator said this card carries no team (`teamNoneConfirmedAt`) — that
 *    decision outranks every set-level default, always;
 *  - the card carries a typed or synced team NAME nobody has resolved yet
 *    (`pendingTeamNames`) — that is the card's own answer waiting on review,
 *    and writing ids beside it would make the row say its team twice (the
 *    same rule `updateCard` and `addCustomCard` keep by never storing both).
 *
 * Both are checked BEFORE the "already carries `next`" short-circuit on
 * purpose: a card that is confirmed teamless has empty `teamOnCardIds`, and
 * the empty-follows branch below would otherwise fill it in.
 */
export function cardTeamFollowVerdict(
  card: {
    teamOnCardIds?: ReadonlyArray<Id<"teams">>;
    teamNoneConfirmedAt?: number;
    pendingTeamNames?: ReadonlyArray<string>;
  },
  previous: ReadonlyArray<Id<"teams">> | undefined,
  next: ReadonlyArray<Id<"teams">>,
): TeamFollowVerdict {
  if (card.teamNoneConfirmedAt !== undefined) return "stay";
  if ((card.pendingTeamNames?.length ?? 0) > 0) return "stay";
  return teamFollowVerdict(card.teamOnCardIds, previous, next);
}

/**
 * The team a NEW card is born with: its own, if it arrived with one in any
 * form — real ids, or a typed/synced name still waiting on review — else the
 * leaf's set-level team, else nothing. Returns a COPY of the leaf's list for
 * the same reason `inheritedTeamIds` does.
 *
 * "Arrived with a name" counts as arrived with a team for the reason given on
 * `cardTeamFollowVerdict`: the name is the card's answer, and defaulting the
 * set's team underneath it would have the row claim two different things
 * until an operator resolves the name.
 */
export function defaultTeamOnCardIds(
  card: {
    teamOnCardIds?: ReadonlyArray<Id<"teams">>;
    pendingTeamNames?: ReadonlyArray<string>;
  },
  leaf: { teamIds?: ReadonlyArray<Id<"teams">> } | null | undefined,
): { ids: Array<Id<"teams">> | undefined; defaulted: boolean } {
  if ((card.teamOnCardIds?.length ?? 0) > 0) {
    return { ids: [...card.teamOnCardIds!], defaulted: false };
  }
  if ((card.pendingTeamNames?.length ?? 0) > 0) {
    return { ids: undefined, defaulted: false };
  }
  const inherited = inheritedTeamIds(leaf);
  return inherited
    ? { ids: inherited, defaulted: true }
    : { ids: undefined, defaulted: false };
}
