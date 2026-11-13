/**
 * "Teams from your checklist: N of M cards" (NEO-478, NEO-496): one
 * definition for the fetch's line and the save's line, so the two can never
 * count differently.
 *
 * N counts the cards whose team answer came from the publisher's checklist:
 * `teamLookup: "checklist"`. That covers a team the row named, and the row's
 * "No Team" claim (NEO-489), and nothing else. These cards are not counted:
 *  - a card whose number is printed on two rows, which pairs with neither
 *    (D2) and is asked of the marketplace;
 *  - a pair whose teams disagree, which keeps the marketplace's teams until
 *    the operator picks a side;
 *  - a pair whose row names no team, which makes no claim and keeps its
 *    lookup.
 * M counts the cards.
 *
 * Which cards count as "the cards" depends on when the line is said:
 *  - At fetch time (`tallyFetchChecklistTeams`), the marketplaces' cards
 *    count (D2). A checklist-only row is not a card until the operator keeps
 *    it in Match Cards. With no marketplace card at all (a checklist-only
 *    fetch, where every row is kept), the rows are the cards.
 *  - At save time (`tallyChecklistTeams` over what Match Cards confirmed),
 *    the saved cards count: the marketplace cards that were kept, and the
 *    checklist-only rows the operator kept. A kept row that named a team (or
 *    said "No Team") counts in both N and M. A kept row that named none
 *    counts in M only. Rows that were not kept are dropped, so they count in
 *    neither. This is the fetch-time rule applied to the cards once the
 *    operator has said which rows are cards.
 */

/** N and M of "Teams from your checklist: N of M cards". */
export type ChecklistTeamsTally = { matched: number; total: number };

/** All the tally reads off a card. */
export type ChecklistTeamsCountable = { teamLookup?: string };

/** True when this card's team answer came from the checklist. */
export function teamFromChecklist(card: ChecklistTeamsCountable): boolean {
  return card.teamLookup === "checklist";
}

/** N and M over these cards: every one counts in M. */
export function tallyChecklistTeams(
  cards: readonly ChecklistTeamsCountable[],
): ChecklistTeamsTally {
  return {
    matched: cards.filter(teamFromChecklist).length,
    total: cards.length,
  };
}

/**
 * The fetch's line: the marketplace cards, or the checklist-only rows when no
 * marketplace card came back.
 */
export function tallyFetchChecklistTeams(
  marketplaceCards: readonly ChecklistTeamsCountable[],
  checklistOnlyCards: readonly ChecklistTeamsCountable[],
): ChecklistTeamsTally {
  return tallyChecklistTeams(
    marketplaceCards.length > 0 ? marketplaceCards : checklistOnlyCards,
  );
}
