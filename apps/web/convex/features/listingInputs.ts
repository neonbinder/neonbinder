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
 * `listingLimits`, `../listingShortName`) and a TYPE from `cardAttention`.
 * Keep it that way: the SPA imports this file.
 */

import type { AttentionItem } from "./cardAttention";
import {
  autographedFromFormat,
  deriveCardObservedFeatures,
} from "./deriveCardFeatures";
import {
  assessListingTitle,
  isFillerToken,
  rookieAsRc,
  type ListingCardInputs,
  type ListingTitleAssessment,
} from "./generateListing";
import { ASPECT_VALUE_MAX, LISTING_TITLE_MAX } from "./listingLimits";
import {
  MAX_LISTING_SHORT_NAME_LENGTH,
  normalizeListingShortName,
} from "../listingShortName";

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
  /**
   * NEO-335 — the chain's insert-level row's value ("Dugout Collection").
   * Carried with `insertIsRole`; it reaches the title only when that is true.
   */
  insertNameValue?: string;
  /**
   * NEO-335 — the insert-level row's NB role: an insert of an Insert type,
   * the kind read from its variant type's title (NEO-334, `variantRole.ts`,
   * via `titleChainFacts`). The insert name enters the title core on this
   * role, never on the insert row's own level or name.
   */
  insertIsRole?: boolean;
  /**
   * NEO-335 — a directly-synced parallel LEAF's own value, set only when the
   * leaf is a parallel by role (a sub-variant, or an insert-level row under a
   * Parallel type: `derivedVariantFlags`, NEO-334). Used as the parallel token
   * when the features snapshot names no parallel.
   */
  parallelLeafValue?: string;
  /**
   * NEO-335 — the chain's resolved `listingShortName` (nearest self-or-ancestor
   * up to the setName row), or the operator's draft on the Card titles step.
   */
  listingShortName?: string;
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
  // NEO-345 — the leaf's autograph FORMAT (`set.inheritedFeatures
  // .autographFormat`: the operator's answer stored on the leaf, or the
  // wizard's draft answer before save). A card carrying AU is born
  // `autographed` with it. Fill-empty, the rule `applyBscAttributeFill` uses
  // on a stored row: an `autographed` the card already has (a parallel
  // copy's insert-card fact, an operator's set-level value) is kept.
  const formatted = autographedFromFormat(
    card.attributes,
    set.inheritedFeatures?.autographFormat,
  );
  if (formatted && (merged.autographed ?? "None") === "None") {
    merged.autographed = formatted;
  }
  // The format is a fact about the LEAF, not about any one card.
  delete merged.autographFormat;
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
  // NEO-335 — the insert's name joins the core on the insert row's NB ROLE,
  // never on its level or its name (product invariant 4).
  const insertName =
    set.insertIsRole === true ? set.insertNameValue?.trim() || undefined : undefined;
  // NEO-335 — a parallel leaf synced straight from a marketplace has no
  // `features.parallelName`; its own value (set only for the NB parallel
  // role) is the parallel token then. A named parallel in the features wins.
  const parallelName =
    mergedFeatures.parallelName?.trim()
      ? mergedFeatures.parallelName
      : set.parallelLeafValue?.trim() || undefined;
  const setShortName = set.listingShortName?.trim() || undefined;
  // NEO-335 — the leaf's parallel ROLE earns the parallel its "Parallel"
  // label. `parallelLeafValue` is set by `titleChainFacts` only on that role
  // (`derivedVariantFlags`), so its presence is the role, never its wording.
  const parallelIsRole = !!set.parallelLeafValue?.trim();
  return {
    cardNumber: card.cardNumber,
    playerNames: names.playerNames,
    year: mergedFeatures.season,
    manufacturer: mergedFeatures.manufacturer,
    manufacturerBrandUnknown: set.manufacturerBrandUnknown,
    setName: set.setNameValue,
    ...(insertName ? { insertName } : {}),
    ...(setShortName ? { setShortName } : {}),
    parallelName,
    ...(parallelIsRole ? { parallelIsRole: true } : {}),
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
  // Measured TRIMMED (NEO-335 adversarial pass): a variation that fits once
  // its stray whitespace is gone is not too long, and a new row stores it
  // trimmed (`storedCardVariation`). Measuring the padding put a card on the
  // pre-save step with nothing the operator could fix.
  const variationLength = row.cardVariation?.trim().length ?? 0;
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
 * NEO-335 — the `cardVariation` a NEW row stores: the printed one, trimmed;
 * blank is none. `buildCardRowForInsert` writes this, and the pre-save step
 * measures the same value, so the two agree on who is over the aspect cap.
 */
export function storedCardVariation(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
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
    cardVariation: storedCardVariation(cardVariation),
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
 * NEO-335 — is this dropped token one of the generator's FILLER words: the
 * sport, "Rookie" (the second spelling, appended only beside "RC"), or the
 * "Insert" / "Parallel" labels?
 * Lives in generateListing.ts now (the short-name rule reads it there);
 * re-exported so existing importers keep working.
 */
export { isFillerToken };

/**
 * NEO-335 — what the title had to leave out, in the order the generator
 * would have spent characters on it: the identity words the core cut lost
 * (year, maker, set, each player), then the optional tokens it dropped.
 *
 * The generator reports the dropped OPTIONAL tokens itself; a core cut it
 * only reports as `coreFits: false`. The core is cut at a word boundary, so
 * what it lost is read per segment. Year, maker and set report whichever of
 * their words the title no longer carries. A PLAYER is reported whole when
 * the title no longer carries the whole name: "Mike Trout & Shohei Ohtani"
 * cut after "Shohei" reports "Shohei Ohtani", and a dropped "Ken Griffey Sr."
 * is reported as that, never as a bare "Sr." because "Ken Griffey" survives
 * in his son's name beside it. The maker is skipped when NB does not know the
 * brand (NEO-272): the generator never put it in.
 *
 * FILLER is not listed (collector review, NEO-335): the sport word, the
 * second spelling of rookie ("Rookie" beside "RC") and the "Insert" /
 * "Parallel" labels are the generator's
 * deliberate fill tail — they exist to spend characters that would otherwise
 * go unused — so they are not a loss an operator should be shown, let alone
 * first. Only the dropped TOKENS are filtered; a set or player word that
 * happens to read "Baseball" is still reported.
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
    // NEO-335 — the insert's name is core identity now, so its words are
    // reported like the set's. A title built with the short name reads the
    // short name in their place: the full names were left out on purpose.
    const maker = inputs.manufacturerBrandUnknown ? undefined : inputs.manufacturer;
    // A title that shortened "Rookie" to "RC" in the insert's name reads
    // the shortened name: "Rookie" was not lost, it was abbreviated.
    const insertName =
      assessment.rookieAsRcUsed && inputs.insertName
        ? rookieAsRc(inputs.insertName)
        : inputs.insertName;
    const segments = assessment.shortNameUsed
      ? [inputs.year, maker, inputs.setShortName]
      : [inputs.year, maker, inputs.setName, insertName];
    for (const segment of segments) {
      const words = (segment ?? "").split(/\s+/).filter(Boolean);
      const missing = words.filter((w) => w !== "&" && !present.has(w.toLowerCase()));
      if (missing.length > 0) {
        const text = missing.join(" ");
        if (!out.includes(text)) out.push(text);
      }
    }
    // Then the players, whole — the core's own order.
    const titleLower = assessment.title.toLowerCase();
    for (const raw of inputs.playerNames ?? []) {
      const name = raw.trim().split(/\s+/).filter(Boolean).join(" ");
      if (name && !titleLower.includes(name.toLowerCase()) && !out.includes(name)) {
        out.push(name);
      }
    }
  }
  for (const token of assessment.dropped) {
    if (isFillerToken(token, inputs)) continue;
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
  answer: {
    listingTitle?: string;
    listingTitleKept?: string;
    cardVariation?: string;
    cardVariationAnswered?: boolean;
  },
  where: string,
): { listingTitle?: string; listingTitleKept?: string; cardVariation?: string } {
  const out: { listingTitle?: string; listingTitleKept?: string; cardVariation?: string } = {};
  // Both title fields are held to the same cap: the kept one is the title
  // the step SHOWED, which the generator never makes longer than this.
  for (const field of ["listingTitle", "listingTitleKept"] as const) {
    const raw = answer[field];
    if (raw === undefined) continue;
    const title = raw.trim();
    if (title.length > LISTING_TITLE_MAX) {
      throw new Error(
        `${where}: the title is ${title.length} characters; the limit is ${LISTING_TITLE_MAX}.`,
      );
    }
    if (title) out[field] = title;
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

/**
 * NEO-335 — a shorter set name to OFFER on the Card titles step: the maker
 * (unless NB has not identified the brand, NEO-272), then the first word of
 * the insert's name — or, with no insert, the first word of the set's name
 * that is not the maker's. 1990 Upper Deck Collector's Choice, Hologram
 * insert → "Upper Deck Hologram".
 *
 * Reads NB row values only: the maker from the set's features snapshot, the
 * insert name only when the insert row carries the NB insert role. Only ever
 * shown as a suggestion; nothing stores it unless the operator accepts it.
 * Undefined when there is nothing shorter to offer.
 */
export function suggestShortSetName(set: ListingSetContext): string | undefined {
  const maker = set.manufacturerBrandUnknown
    ? undefined
    : set.inheritedFeatures?.manufacturer?.trim() || undefined;
  const makerWords = maker ? maker.split(/\s+/) : [];
  const insert = set.insertIsRole === true ? set.insertNameValue?.trim() : undefined;
  const firstWord = (text: string | undefined, skip: readonly string[]): string | undefined => {
    const words = (text ?? "").split(/\s+/).filter(Boolean);
    // Skip the maker's words only where the name LEADS with them ("Upper
    // Deck Collector's Choice"), never a matching word later on.
    let at = 0;
    while (
      at < skip.length &&
      at < words.length &&
      words[at].toLowerCase() === skip[at].toLowerCase()
    ) {
      at += 1;
    }
    if (at > 0 && at < skip.length) at = 0;
    return words[at];
  };
  const word = firstWord(insert, makerWords) ?? firstWord(set.setNameValue, makerWords);
  if (!word) return undefined;
  const suggestion = [maker, word].filter(Boolean).join(" ");
  // Nothing shorter to offer: the suggestion says what the set name already does.
  const full = [maker, set.setNameValue?.trim(), insert].filter(Boolean).join(" ");
  if (suggestion.length >= full.length) return undefined;
  return suggestion;
}

/**
 * NEO-335 — a short name as the operator typed it, checked BEFORE it is sent:
 * the same rule both write paths apply (`normalizeListingShortName`, the
 * attributes panel's mutation and the commit's batch-level arg), read without
 * throwing so the Card titles step can say what is wrong in place.
 *
 * `value` is the trimmed short name to send (undefined when blank: nothing is
 * sent); `error` is the server's own sentence when it would be refused.
 */
export function checkShortNameAnswer(
  raw: string | undefined,
): { value?: string; error?: string } {
  if (raw === undefined) return {};
  try {
    const value = normalizeListingShortName(raw);
    return value === undefined ? {} : { value };
  } catch (e) {
    const data = (e as { data?: unknown }).data;
    return {
      error:
        typeof data === "string"
          ? data
          : `A short name is at most ${MAX_LISTING_SHORT_NAME_LENGTH} characters.`,
    };
  }
}
