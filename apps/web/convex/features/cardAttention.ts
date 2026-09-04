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
 * NEO-101 added the three listing-title/aspect kinds below. Keep this module
 * free of anything that would stop it running in the browser — its only import
 * is `listingLimits.ts`, which is itself nothing but exported numbers.
 */

import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "./listingLimits";

/**
 * One thing a card still needs from a human.
 *
 * Nothing here carries a message string: how an item is worded is a UI
 * decision, and duplicating it server-side is how the two drift. The wording
 * lives in `components/SetSelector/card-attention.ts` (`ATTENTION_LABELS`),
 * which is a `Record<AttentionKind, string>` — so adding a member here without
 * adding its label there does not typecheck, deliberately.
 *
 * The numeric payloads exist so a label or a fixer can state the actual
 * measurement without re-measuring the row it was derived from.
 */
export type AttentionItem =
  | { kind: "missingTeam" }
  // NEO-101: the stored title is longer than eBay will accept. eBay REJECTS
  // rather than truncating, so this one BLOCKS listing — the only way a row
  // reaches this state is an operator edit made before `updateCard` gained its
  // cap, since the generator cannot produce one.
  | { kind: "titleOverLimit"; length: number }
  // NEO-101: the auto-generated title's core was cut at a word boundary to fit
  // (see `cardChecklist.listingTitleTruncated`). Listable as-is; a human should
  // put the missing identifying words back.
  | { kind: "titleTruncated" }
  // NEO-101: an aspect-shaped field is longer than eBay's item-specific value
  // limit. WARN ONLY — nothing blocks the write, because no NB field is yet
  // proven to map verbatim onto an eBay aspect.
  | { kind: "aspectValueOverLimit"; field: "cardVariation"; length: number }
  // NEO-221: names on this card that the operator never ruled on in the review
  // wizard, so the card carries them as free text and links to no player/team.
  // The names are carried so the label and the fixer can say WHICH, without
  // re-reading the row.
  | { kind: "unreviewedName"; names: string[] };

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
  /**
   * NEO-221 — the player(s) this card is linked to. Read only for whether it
   * is empty: a card that already links to a player has its answer, whatever
   * extra spelling `pendingPlayerNames` still carries.
   */
  playerIds?: readonly string[];
  /**
   * Team names an operator typed that no `teams` row exists for yet; the next
   * sync's resolve pass turns them into `teamOnCardIds` (see schema.ts and
   * selectorOptions.ts). A non-empty list is an answer already given: the card
   * is UNRESOLVED, not unanswered, so it counts as having a team. Reading only
   * `teamOnCardIds` badged every hand-added card with a typed team and sent
   * the walker to ask the operator for something they had just supplied.
   *
   * NEO-208 note on where these come from. The quick-add form used to be the
   * main producer — it had a free-text "Team (optional)" box that wrote here —
   * and it now uses `TeamPicker` and sends real `teamOnCardIds`, so a card
   * added by hand today is born linked and never lands in this state. What
   * remains are rows written before that, and an old SPA bundle still sending
   * the legacy `addCustomCard.teams` name array. THE RULE IS UNCHANGED: a
   * pending name still counts as an answer, because those legacy rows are
   * exactly as answered as they ever were, and because the operator who typed
   * the name is not the person to re-ask. `updateCard` clears the names when a
   * real team is linked, so a row cannot end up counted twice.
   */
  pendingTeamNames?: readonly string[];
  /**
   * NEO-221 — player names this card carries that resolve to no `players` row.
   *
   * Two producers, one meaning. `addCustomCard` writes them when an operator
   * types a player the table does not have yet; `commitCardChecklist` writes
   * them when a synced card's name reached commit with no review decision.
   * Either way the card names a player it does not link to, and either way the
   * fix is the same — link it, or let the next sync's wizard resolve it. The
   * rule below deliberately does NOT try to tell the two apart: where a row
   * came from is not something NB behaviour is keyed on.
   */
  pendingPlayerNames?: readonly string[];
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
  /**
   * NEO-101 — the marketplace-agnostic listing title (see schema.ts). Measured,
   * never parsed: `titleOverLimit` is just its length against the eBay cap.
   */
  listingTitle?: string;
  /**
   * NEO-101 — the generator had to cut the title's core at creation time.
   *
   * A STORED flag rather than a recomputation, unlike every other input here,
   * and that asymmetry is deliberate: a row does not carry the player names or
   * set name its title was built from, so "did the core fit?" cannot be
   * re-derived from the row. `updateCard` clears it on any operator title
   * write, so the item goes away the moment a human authors the title — which
   * is the same self-clearing behaviour a recomputation would have given.
   */
  listingTitleTruncated?: boolean;
  /**
   * NEO-101/189 — NB's own per-card variation name. Read only for its length
   * against eBay's item-specific value cap.
   */
  cardVariation?: string;
};

/**
 * NEO-102 — what this card still needs from a human.
 *
 * ## The `missingTeam` rule, and why it has three clauses
 *
 *   1. the card has no team on file — `teamOnCardIds` AND `pendingTeamNames`
 *      are both empty. A pending name is a team the operator typed that no
 *      `teams` row exists for yet, so the card is unresolved rather than
 *      unanswered; nothing else is a missing team.
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

  const hasTeam =
    (row.teamOnCardIds?.length ?? 0) > 0 || (row.pendingTeamNames?.length ?? 0) > 0;
  const awaitingBscLookup = !!row.platformData?.bsc?.ref && !row.teamCheckDoneAt;
  if (!hasTeam && !row.teamNoneConfirmedAt && !awaitingBscLookup) {
    items.push({ kind: "missingTeam" });
  }

  // NEO-101 — the two title rules are MUTUALLY EXCLUSIVE by construction, not
  // by coincidence. A row that is both over the limit and flagged truncated
  // (an operator pasted an over-long title onto a row whose generated title had
  // been cut, before `updateCard` gained its cap) has exactly one thing worth
  // saying to a human: it is too long. Reporting "was cut short" alongside
  // "is 94 characters" reads as a contradiction, and the over-limit fix
  // subsumes the other one anyway — rewriting the title clears both.
  const titleLength = row.listingTitle?.length ?? 0;
  if (titleLength > LISTING_TITLE_MAX) {
    items.push({ kind: "titleOverLimit", length: titleLength });
  } else if (row.listingTitleTruncated) {
    items.push({ kind: "titleTruncated" });
  }

  const variationLength = row.cardVariation?.length ?? 0;
  if (variationLength > ASPECT_VALUE_MAX) {
    items.push({
      kind: "aspectValueOverLimit",
      field: "cardVariation",
      length: variationLength,
    });
  }

  // ── NEO-221: a name on the card that links to nothing ────────────────────
  //
  // Fires per side, on the same shape of test: a pending NAME with no
  // corresponding LINK. `pendingPlayerNames` with an empty `playerIds`, or
  // `pendingTeamNames` with an empty `teamOnCardIds`. A card that already
  // links to a player or a team has its answer, and the leftover spelling is
  // a duplicate rather than a gap.
  //
  // ## No marketplace gate, deliberately
  //
  // An earlier draft badged only cards carrying a BSC or SportLots ref, on the
  // theory that a hand-added card's pending name is an answer awaiting the
  // next sync while a synced card's is a question never asked. That is the
  // "custom card" concept re-spelled, and NB behaviour is never keyed on
  // whether a row has marketplace ids (see the product invariant in the root
  // CLAUDE.md). It is also not true: both producers leave a card naming a
  // player it does not link to, and both are fixed the same way — link it in
  // the walker, or let the next sync's wizard resolve it.
  //
  // ## Exactly one badge, not two
  //
  // `hasTeam` above already counts a non-empty `pendingTeamNames` as having a
  // team, so a card with an unresolved team name gets THIS item and not
  // `missingTeam`. That split is the useful one: `missingTeam` means nobody
  // has said anything about the team, and this means somebody has, and it has
  // not landed yet. Two badges for one gap would just double the count the
  // operator is working through.
  const unreviewed = [
    ...((row.playerIds?.length ?? 0) === 0 ? (row.pendingPlayerNames ?? []) : []),
    ...((row.teamOnCardIds?.length ?? 0) === 0 ? (row.pendingTeamNames ?? []) : []),
  ];
  if (unreviewed.length > 0) {
    items.push({ kind: "unreviewedName", names: [...unreviewed] });
  }

  return items;
}

/** Convenience for a row badge or a filter predicate. */
export function needsAttention(row: AttentionCardRow): boolean {
  return deriveCardAttention(row).length > 0;
}

/**
 * NEO-102 — the hard cap on how many teams one card can carry.
 *
 * eBay's Team aspect is single-select, so a listing only ever sends one team
 * regardless of how many a card has on file; the multi-team case this feature
 * exists for is a League Leaders / rookie-combo card, where a handful of
 * players each contribute one team. 8 is a sanity bound on that, not a
 * marketplace rule — nothing requires exactly this number, it just keeps a
 * fat-fingered "select all" from writing an unbounded array. Enforced
 * server-side in `selectorOptions.updateCard`; `MissingTeamFixer.tsx` IMPORTS
 * this same constant (through the `components/SetSelector/card-attention`
 * seam) rather than keeping its own copy, so the picker and its cap message
 * cannot disagree with what the server will actually accept.
 */
export const MAX_CARD_TEAMS = 8;
