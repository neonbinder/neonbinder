/**
 * NEO-102 — "this stored card still needs a human", derived rather than queued.
 *
 * ## Why a derivation and not a review-queue row
 *
 * The first design for reconciling teamless cards added a third
 * `entityReviewQueue` kind and rode the commit wire: rows created during the
 * fetch, decided in the wizard, applied by the commit. That works only for
 * cards a sync is about to touch. The cards that actually need attention are
 * the ones ALREADY COMMITTED — dev's 2026 Topps base has ten teamless League
 * Leaders cards sitting in `cardChecklist` today, every one of them stamped
 * `teamCheckDoneAt` by the background queue and therefore invisible forever.
 * A pure derivation over stored rows covers those with zero migration, needs
 * no per-batch state, and cannot be raced by a commit.
 *
 * So this module is deliberately PURE: no ctx, no database, no async. It reads
 * the fields a card already carries and answers what a human still owes it.
 * That is what lets the SPA call it directly on a `getCardChecklist` row (the
 * same way it already imports `expectedFeatures`) and lets a Convex query call
 * it server-side, with no chance of the two disagreeing.
 *
 * NEO-101 will add title/name kinds to `AttentionItem`. Keep this module free
 * of anything that would stop it running in the browser.
 */

/**
 * One thing a card still needs from a human.
 *
 * A discriminated union of ONE member today, which is intentional — NEO-101's
 * title kinds land here, and a consumer written against `item.kind` keeps
 * working when they do. Nothing here carries a message string: how an item is
 * worded is a UI decision, and duplicating it server-side is how the two drift.
 */
export type AttentionItem = { kind: "missingTeam" };

/** The discriminant alone, for keying label maps and fixer registries. */
export type AttentionKind = AttentionItem["kind"];

/**
 * Exactly the fields `deriveCardAttention` reads, typed STRUCTURALLY rather
 * than as `Doc<"cardChecklist">`.
 *
 * Two reasons. The SPA passes a `getCardChecklist` row, which is a doc plus
 * cross-listing annotations and is not the doc type; and a caller that only
 * has a projection (a test fixture, a future narrowed query) should be able to
 * use this without inventing an `_id`. `readonly string[]` accepts
 * `Id<"teams">[]` because a Convex id is a branded string.
 */
export type AttentionCardRow = {
  /** The team(s) printed on the card. Absent and `[]` are the same statement. */
  teamOnCardIds?: readonly string[];
  /** Operator confirmed this card carries no team — see schema.ts. */
  teamNoneConfirmedAt?: number;
  /** The BSC per-card team lookup has RUN, whatever it found — see schema.ts. */
  teamCheckDoneAt?: number;
  /**
   * Only `bsc.ref`'s presence is read: it is what makes a card eligible for
   * the BSC per-card team lookup at all. `sportlots` is declared so a caller
   * can hand over a whole stored row without a cast, and is deliberately NOT
   * consulted — SportLots' checklist scrape never attempts team extraction
   * (see the note in adapters/sportlots.ts), so an SL ref is not something to
   * wait on.
   */
  platformData?: {
    bsc?: { ref: string };
    sportlots?: { ref: string };
  };
};

/**
 * NEO-102 — what this card still needs from a human.
 *
 * ## The `missingTeam` rule, and why it has three clauses
 *
 *   1. `teamOnCardIds` is empty — nothing else is a missing team.
 *   2. `teamNoneConfirmedAt` is unset. An operator who said "this card carries
 *      no team" has answered; re-asking is the bug this field exists to stop.
 *   3. the card is not still WAITING on the automatic answer.
 *
 * Clause 3 is the one worth explaining. A card with a `platformData.bsc.ref`
 * has an automatic source for its team: `processBscTeamEnrichmentQueue` walks
 * the cards a commit just wrote, one BSC detail request every 300ms, and fills
 * `teamOnCardIds` where BSC has an answer. Right after a 900-card sync, that
 * queue is minutes from finishing — badging every BSC card "missing team"
 * during the drain would flood the checklist with items that resolve
 * themselves, and would train the operator to ignore the badge. So a
 * BSC-linked card is only badged once `teamCheckDoneAt` says the lookup has
 * been and gone. A card with no BSC ref (a custom card, a SportLots-only card
 * — SportLots deliberately never scrapes team, see adapters/sportlots.ts) has
 * no automatic source to wait for, so it is badged immediately.
 *
 * Note clause 3 does NOT read whether the queue SUCCEEDED. `teamCheckDoneAt`
 * means "asked, regardless of outcome", and a BSC card that came back with no
 * team on file is precisely the case a human has to settle.
 */
export function deriveCardAttention(row: AttentionCardRow): AttentionItem[] {
  const items: AttentionItem[] = [];

  const hasTeam = (row.teamOnCardIds?.length ?? 0) > 0;
  const awaitingBscLookup = !!row.platformData?.bsc?.ref && !row.teamCheckDoneAt;
  if (!hasTeam && !row.teamNoneConfirmedAt && !awaitingBscLookup) {
    items.push({ kind: "missingTeam" });
  }

  return items;
}

/** Convenience for a row badge or a filter predicate. */
export function needsAttention(row: AttentionCardRow): boolean {
  return deriveCardAttention(row).length > 0;
}
