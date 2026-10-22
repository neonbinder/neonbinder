import type { AttentionCardRow, AttentionKind } from "./card-attention";

/**
 * NEO-339 — the attention walker's pure rules and MissingTeamFixer's words,
 * in one React-free module.
 *
 * They used to live in `cardAttentionRegistry.ts` and `MissingTeamFixer.tsx`,
 * which import the fixers and the pickers (React, `convex/react`, `@/` paths).
 * The set-build tool (`tools/setbuild/lib/attention.ts`) lists the same cards
 * in the same order with the same sentences, so the rules moved here and both
 * sides import them: the registry and the fixer re-export what they used to
 * define, and the tool imports this file by relative path, as it already does
 * `card-attention.ts` and `drill-url.ts`. One copy, nothing to drift.
 *
 * Keep it pure: type imports and plain functions only.
 */

/**
 * NEO-335 — the order the walker asks its questions in: every card missing a
 * player first (NEO-339), then every card missing a team, then names not yet
 * linked, then titles. Within a group, by card number.
 *
 * A card is ranked by the question the walker will actually PUT to it — the
 * item `pickAttentionFixer` chose — not by the earliest kind it happens to
 * carry. Ranking on anything else would file a card under one heading and
 * then show it under another. (A card with an over-long title AND an unlinked
 * name presents its title, because `deriveCardAttention` lists the name last,
 * so it walks with the titles.)
 *
 * A `Record` over every kind, so adding a kind to `AttentionItem` without
 * deciding where it walks is a type error rather than a silent "last".
 * The three title kinds share a rank: they are one fixer and one question.
 *
 * NEO-339: cards with no player walk FIRST, ahead of the teams. A linked
 * player is what the team question's chips come from (`suggestedTeamsForCard`
 * reads the card's players' careers), so a card missing both is asked for its
 * player first and, answered, comes to its team with the career's set-year
 * team already picked — rather than asking for a team blind and then for the
 * player who would have named it.
 */
export const WALK_RANK: Record<AttentionKind, number> = {
  missingPlayer: 0,
  missingTeam: 1,
  unreviewedName: 2,
  titleOverLimit: 3,
  titleTruncated: 3,
  aspectValueOverLimit: 3,
};

/** After every ranked kind: a card whose kinds this bundle has no fixer for. */
export const WALK_UNRANKED = 4;

/** The walk rank of the question a card is asked (its chosen item's kind). */
export function walkRankOfKind(kind: string): number {
  return WALK_RANK[kind as AttentionKind] ?? WALK_UNRANKED;
}

/**
 * NEO-335 — a card still waiting on the automatic BSC team lookup: linked to
 * BSC, no team on it, nobody has said it has none, and the lookup has not
 * stamped `teamCheckDoneAt` (it failed at fetch and is queued for a retry).
 *
 * These are exactly the cards `deriveCardAttention` holds back from
 * `missingTeam` while they wait (its clause 3), so they are not in the walk.
 * The walker counts them only to say, once the walk is done, that more may
 * yet arrive. Never a reason to badge or ask: the lookup answers most of them.
 *
 * Reads only the presence of the BSC ref, the same as the rule it mirrors.
 */
export function isAwaitingTeamLookup(row: AttentionCardRow): boolean {
  return (
    !!row.platformData?.bsc?.ref &&
    !row.teamCheckDoneAt &&
    !row.teamNoneConfirmedAt &&
    (row.teamOnCardIds?.length ?? 0) === 0 &&
    (row.pendingTeamNames?.length ?? 0) === 0
  );
}

/**
 * "Jimmie Foxx played here" / "Johnny Bench & Pete Rose played here" /
 * "A, B & C played here" — the provenance a chip carries. Full names, never a
 * derived surname: "Ken Griffey Jr." has no safe one.
 */
export function playedHere(playerNames: readonly string[]): string {
  const names =
    playerNames.length <= 2
      ? playerNames.join(" & ")
      : `${playerNames.slice(0, -1).join(", ")} & ${playerNames[playerNames.length - 1]}`;
  return `${names} played here`;
}

/**
 * The line over the listing's chips. Never names the marketplace (Jason,
 * 2026-10-11) — "the listing".
 *
 *   agreed   — a set-year stint is one of the listing's rows, so it is
 *              preselected and focus is on Save
 *   several  — the name is held in several eras: pick the one on the card
 *   one      — one row: offered, not assumed (the background lookup already
 *              links a lone row whose era fits, so reaching here means it
 *              did not)
 */
export function marketplaceHeading(listingName: string, rowCount: number, agreed: boolean): string {
  if (agreed) return `The listing names “${listingName}” and the career agrees — Enter accepts it.`;
  if (rowCount > 1) {
    return `The listing names “${listingName}” — ${rowCount} teams share that name. Pick the one on the card.`;
  }
  return `The listing names “${listingName}” — pick it if it matches the card.`;
}

/**
 * The line over the career chips.
 *
 * `uncoveredSetYear` is the set's year when the server fell back to the whole
 * career because no stint covers it; undefined when the set has no year.
 */
export function careerHeading(
  inSetYear: boolean,
  listingDisagrees: boolean,
  uncoveredSetYear?: number,
): string {
  if (!inSetYear) {
    return uncoveredSetYear !== undefined
      ? `No ${uncoveredSetYear} team on file — here’s the whole career. Pick the one on the card.`
      : "No year on this set — here’s the whole career. Pick the one on the card.";
  }
  if (listingDisagrees) {
    return "From the career — the listing names a different team, so pick the one on the card.";
  }
  return "Suggested from career history — Enter accepts these.";
}
