/**
 * NEO-335 — how a NEW card's listing-title INPUTS are assembled, in one place.
 *
 * ## Why this exists
 *
 * `assessListingTitle` (generateListing.ts) is pure and has always been safe
 * for the browser. What was not shareable was the step BEFORE it: turning a
 * card plus its set into a `ListingCardInputs`. That lived inline in
 * `cardRowCreate.buildCardRowForInsert`, which drags in `sku.ts` and
 * `cardPlayerLinks.ts` and so can never reach the SPA bundle.
 *
 * NEO-335 asks the title question BEFORE save, on the wizard's "Card titles"
 * step, for cards that are not rows yet. A third hand-copied mapping is how
 * the title shown before save and the one written at insert drift apart, so
 * the mapping moved here and both sides call it:
 *
 *   - `buildCardRowForInsert` (server, at insert) — `mergeCardFeatures` +
 *     `listingInputsForCard`, then `titleAttentionItems` decides nothing at
 *     insert but reads the same assessment the row's flag is written from;
 *   - `components/SetSelector/card-titles.ts` (browser, before save) — the
 *     same two calls over a preview card and the set facts
 *     `resolveChecklistEntities` returns as `titleContext`;
 *   - `deriveCardAttention` (both) — `titleAttentionItems` over a STORED row.
 *
 * So "will this card be flagged after save?" and "is this card on the Card
 * titles step?" are one function of one assessment, and cannot disagree.
 *
 * ## Browser-safe, on purpose
 *
 * Imports only pure modules (`generateListing`, `deriveCardFeatures`,
 * `listingLimits`) and a TYPE from `cardAttention`. Keep it that way: the SPA
 * imports this file.
 */

import type { AttentionItem } from "./cardAttention";
import { deriveCardObservedFeatures } from "./deriveCardFeatures";
import {
  assessListingTitle,
  type ListingCardInputs,
  type ListingTitleAssessment,
} from "./generateListing";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "./listingLimits";

/**
 * The set-level facts a new card's title reads, resolved once per commit (or
 * once per resolve, for the pre-save step). Same shape the commit prelude
 * hands its chunks; `cardRowCreate.CardRowSetContext` extends it.
 */
export type ListingSetContext = {
  /** The sport row's value — the title's last filler token. */
  sportValue: string;
  /** The nearest `setName` ancestor's value. */
  setNameValue?: string;
  /** NEO-272 — the manufacturer's brand-unknown ROLE; absent = known. */
  manufacturerBrandUnknown?: boolean;
  /** The leaf row's complete `features` snapshot (NEO-71-74). */
  inheritedFeatures?: Record<string, string>;
};

/**
 * NEO-335 — what the wizard's pre-save "Card titles" step needs from the
 * server to title a card that is not a row yet: the set facts above, the
 * set-level team a teamless new card is born with (NEO-277), and the
 * CANONICAL name of every printed player/team spelling on the confirmed cards
 * that already resolves to an NB row. Returned by `resolveChecklistEntities`
 * as `titleContext` (built in `convex/listingTitleContext.ts`).
 *
 * A printed name that is NOT listed did not resolve before the wizard: it is
 * either a name the wizard asks about (its review row's decision says what
 * the card will carry) or one an operator ruled out earlier, which the card
 * will not carry at all. Never a guess from the printed spelling.
 */
export type TitleContext = ListingSetContext & {
  /** Full names of the leaf's set-level teams, in stored order. */
  setTeamNames: string[];
  /** Printed spelling (trimmed, verbatim) → the resolved player's name. */
  players: Array<{ printed: string; name: string }>;
  /** Printed spelling (trimmed, verbatim) → the resolved team's full name. */
  teams: Array<{ printed: string; name: string }>;
};

/** The facts a card itself contributes to its features and title. */
export type ListingCardFacts = {
  cardNumber: string;
  isRookie?: boolean;
  isRelic?: boolean;
  /** Observed only: folded into `features.autographed`. */
  autographType?: string;
  cardVariation?: string;
  attributes?: ReadonlyArray<string>;
  printRun?: number;
  /**
   * NEO-312 — the features map to merge onto INSTEAD of the set snapshot (a
   * parallel copy's). The commit and the pre-save step never pass it.
   */
  baseFeatures?: Record<string, string>;
  /**
   * NEO-321 — a parallel copy's own parallel name, applied last. The commit
   * and the pre-save step never pass it.
   */
  parallelName?: string;
};

/**
 * The card's `features` as a new row is born with them: the set snapshot (or
 * a copy's base), then what the card itself shows, then a copy's own
 * parallel name. Precedence is NEO-71-74's: inherited < observed.
 */
export function mergeCardFeatures(
  card: ListingCardFacts,
  set: ListingSetContext,
): Record<string, string> {
  const merged: Record<string, string> = {
    ...(card.baseFeatures ?? set.inheritedFeatures ?? {}),
    ...deriveCardObservedFeatures({
      isRookie: card.isRookie,
      isRelic: card.isRelic,
      autographType: card.autographType,
      cardVariation: card.cardVariation,
      attributes: card.attributes,
    }),
  };
  const ownParallelName = card.parallelName?.trim();
  if (ownParallelName) merged.parallelName = ownParallelName;
  return merged;
}

/**
 * The generator's inputs for a new card. `mergedFeatures` is
 * `mergeCardFeatures`' answer for the same card and set — passed in rather
 * than recomputed because the insert also stores it.
 *
 * `playerNames` / `teamNames` are CANONICAL names, in the card's stored order:
 * the title says "Dwight Gooden", not the "Doc Gooden" a card prints (NEO-254).
 */
export function listingInputsForCard(
  card: ListingCardFacts,
  set: ListingSetContext,
  names: { playerNames: string[]; teamNames?: string[] },
  mergedFeatures: Record<string, string> = mergeCardFeatures(card, set),
): ListingCardInputs {
  return {
    cardNumber: card.cardNumber,
    playerNames: names.playerNames,
    year: mergedFeatures.season,
    manufacturer: mergedFeatures.manufacturer,
    manufacturerBrandUnknown: set.manufacturerBrandUnknown,
    setName: set.setNameValue,
    parallelName: mergedFeatures.parallelName,
    isRookie: card.isRookie,
    isRelic: card.isRelic,
    autographed: mergedFeatures.autographed,
    printRun: card.printRun,
    shortPrint: mergedFeatures.shortPrint,
    cardVariation: card.cardVariation,
    teamNames: names.teamNames,
    sport: set.sportValue,
  };
}

/** The three title-shaped attention kinds, which this module owns. */
export type TitleAttentionItem = Extract<
  AttentionItem,
  { kind: "titleOverLimit" | "titleTruncated" | "aspectValueOverLimit" }
>;

/** The row fields the title kinds read — a stored row, or a row-to-be. */
export type TitleAttentionFields = {
  listingTitle?: string;
  /** NEO-101 — the generator cut the title's core at creation. */
  listingTitleTruncated?: boolean;
  cardVariation?: string;
};

/**
 * NEO-101 — what a card's title and variation still need from a human.
 *
 * Moved here from `deriveCardAttention` verbatim (it calls this) so the
 * pre-save step asks the same question of a card that is not a row yet.
 *
 * The two title rules are MUTUALLY EXCLUSIVE: a title that is both over the
 * cap and flagged truncated has one thing worth saying — it is too long — and
 * rewriting it clears both. The variation rule is independent and warn-only.
 */
export function titleAttentionItems(row: TitleAttentionFields): TitleAttentionItem[] {
  const items: TitleAttentionItem[] = [];
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
  return items;
}

/**
 * The row fields a NEW card is born with that `titleAttentionItems` reads,
 * from its assessment — exactly what `buildCardRowForInsert` writes when no
 * operator answer rides on the card.
 */
export function titleAttentionFieldsAtInsert(
  assessment: ListingTitleAssessment,
  cardVariation: string | undefined,
): TitleAttentionFields {
  return {
    listingTitle: assessment.title,
    ...(assessment.coreFits ? {} : { listingTitleTruncated: true }),
    cardVariation,
  };
}

/**
 * Everything one new card's title comes to, in one call: the merged features,
 * the generator's inputs, its assessment, and the attention items the row
 * would be born with. The pre-save step's single entry point.
 */
export function assessNewCardListing(
  card: ListingCardFacts,
  set: ListingSetContext,
  names: { playerNames: string[]; teamNames?: string[] },
): {
  mergedFeatures: Record<string, string>;
  inputs: ListingCardInputs;
  assessment: ListingTitleAssessment;
  items: TitleAttentionItem[];
} {
  const mergedFeatures = mergeCardFeatures(card, set);
  const inputs = listingInputsForCard(card, set, names, mergedFeatures);
  const assessment = assessListingTitle(inputs);
  return {
    mergedFeatures,
    inputs,
    assessment,
    items: titleAttentionItems(titleAttentionFieldsAtInsert(assessment, card.cardVariation)),
  };
}

/** Lowercased whitespace-delimited words, for "is this word in the title". */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * NEO-335 — what the title had to leave out, in the order the generator
 * would have spent characters on it: the identity words the core cut lost
 * (year, maker, set, each player), then the optional tokens it dropped.
 *
 * The generator reports the dropped OPTIONAL tokens itself; a core cut it
 * only reports as `coreFits: false`. The core is cut at a word boundary, so
 * what it lost is whichever of its words the title no longer carries — read
 * per segment, so "Mike Trout & Shohei Ohtani" cut after "Shohei" reports
 * "Ohtani" rather than a run of loose words. The maker is skipped when NB
 * does not know the brand (NEO-272): the generator never put it in.
 *
 * Display only. Nothing is stored from this.
 */
export function leftOutOfTitle(
  inputs: ListingCardInputs,
  assessment: ListingTitleAssessment,
): string[] {
  const present = new Set(wordsOf(assessment.title));
  const out: string[] = [];
  if (!assessment.coreFits) {
    const segments = [
      inputs.year,
      inputs.manufacturerBrandUnknown ? undefined : inputs.manufacturer,
      inputs.setName,
      ...(inputs.playerNames ?? []),
    ];
    for (const segment of segments) {
      const words = (segment ?? "").split(/\s+/).filter(Boolean);
      const missing = words.filter((w) => w !== "&" && !present.has(w.toLowerCase()));
      if (missing.length > 0) {
        const text = missing.join(" ");
        if (!out.includes(text)) out.push(text);
      }
    }
  }
  for (const token of assessment.dropped) {
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * NEO-335 — the operator's pre-save title answer, held to the same caps the
 * write paths hold (`updateCard` for the title; the aspect cap for the
 * variation the step asks to be trimmed). Returns the trimmed values, or
 * throws a message naming the card by NB's own card number.
 *
 * Shared by the commit action (refuses the whole commit before any phase
 * writes) and the chunk that writes the row (the writer caps, as the house
 * does for every internal arg that lands in a stored field).
 */
export function checkTitleAnswer(
  answer: { listingTitle?: string; cardVariation?: string; cardVariationAnswered?: boolean },
  where: string,
): { listingTitle?: string; cardVariation?: string } {
  const out: { listingTitle?: string; cardVariation?: string } = {};
  if (answer.listingTitle !== undefined) {
    const title = answer.listingTitle.trim();
    if (title.length > LISTING_TITLE_MAX) {
      throw new Error(
        `${where}: the title is ${title.length} characters; the limit is ${LISTING_TITLE_MAX}.`,
      );
    }
    if (title) out.listingTitle = title;
  }
  if (answer.cardVariationAnswered && answer.cardVariation !== undefined) {
    const variation = answer.cardVariation.trim();
    if (variation.length > ASPECT_VALUE_MAX) {
      throw new Error(
        `${where}: the variation is ${variation.length} characters; the limit is ${ASPECT_VALUE_MAX}.`,
      );
    }
    // Empty is no answer: clearing a variation is not what "trim it" asks.
    if (variation) out.cardVariation = variation;
  }
  return out;
}
