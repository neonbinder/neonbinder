/**
 * NEO-24/71-74: auto-generate a card's marketplace-agnostic `listingTitle`
 * and `listingDescription` once, at card-creation time (write-once, same
 * model as every other default this session — the operator can freely edit
 * either field afterward; this module is never called again for an
 * existing row).
 *
 * Pure functions only — no DB access. Callers (commitCardChecklist's insert
 * branch, addCustomCard) resolve player names / ancestor values first and
 * pass them in as plain data, exactly like deriveCardFeatures.ts's contract.
 *
 * NEO-101 added `assessListingTitle`, which is the same generation reporting
 * what it had to give up. The cap itself now lives in `listingLimits.ts` with
 * its evidence; this module no longer keeps a private copy of the number.
 */

import { LISTING_TITLE_MAX } from "./listingLimits";

export type ListingCardInputs = {
  cardNumber: string;
  /** Resolved player display names, already looked up from playerIds. */
  playerNames?: string[];
  /** Mirrors the year node's value verbatim — same field `features.season` holds. */
  year?: string;
  manufacturer?: string;
  setName?: string;
  /** features.parallelName — "Base" for a plain base card, a real name otherwise. */
  parallelName?: string;
  isRookie?: boolean;
  isRelic?: boolean;
  /** features.autographed — "None" / "On Card" / "Sticker/Label". */
  autographed?: string;
  /** features.shortPrint — "None" / "SP" / "SSP". */
  shortPrint?: string;
  printRun?: number;
  /**
   * NEO-101/189 — `cardChecklist.cardVariation`, NB's OWN per-card variation
   * name ("Image Variation; Wearing sunglasses", "Nickname", "Sliding").
   *
   * Used VERBATIM. Deliberately not parsed: the `;`-separated shape some rows
   * carry is an artefact of how the string was first authored, not a schema,
   * and teaching this module to split on it would be re-introducing exactly
   * the marketplace vocabulary NEO-189 spent a ticket removing. A variation is
   * very often the reason a buyer searched, which is why it is a title token
   * at all rather than description-only.
   */
  cardVariation?: string;
};

/**
 * What `assessListingTitle` reports back: the title it built, and the two
 * facts a caller cannot recover from the string afterwards.
 */
export type ListingTitleAssessment = {
  /** The generated title. Always `<= LISTING_TITLE_MAX` characters. */
  title: string;
  /**
   * False when the CORE (year / manufacturer / set / players) had to be cut to
   * leave room for the card number. A stored row does not carry its player
   * names or set name, so this cannot be re-derived later from the row alone —
   * see `cardChecklist.listingTitleTruncated` in schema.ts.
   */
  coreFits: boolean;
  /**
   * The optional tokens that did not fit, in priority order. Purely
   * informational: nothing is stored from this, it exists so the operator can
   * see what the title gave up.
   */
  dropped: string[];
};

/**
 * A set node's `value` often already embeds its manufacturer's name as a
 * literal prefix word — either verbatim for a flagship base product
 * (manufacturer "Topps", setName "Topps" — see expectedFeatures.ts's note
 * that manufacturer sub-releases like Series 1/2 aren't separate sets), or
 * as part of a full product name (manufacturer "Topps", setName
 * "Topps Heritage"). Joining manufacturer and setName as independent tokens
 * in either case would duplicate the word ("Topps Topps" / "Topps Topps
 * Heritage"), so collapse them into a single token whenever setName already
 * starts with manufacturer as a whole word.
 */
function manufacturerAndSetTokens(inputs: ListingCardInputs): string[] {
  const manufacturer = inputs.manufacturer?.trim();
  const setName = inputs.setName?.trim();
  if (manufacturer && setName && startsWithWord(setName, manufacturer)) {
    return [setName];
  }
  return [manufacturer, setName].filter((value): value is string => Boolean(value));
}

function startsWithWord(value: string, prefix: string): boolean {
  if (!value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const boundaryChar = value[prefix.length];
  return boundaryChar === undefined || /\s/.test(boundaryChar);
}

function isRealParallel(inputs: ListingCardInputs): boolean {
  const name = inputs.parallelName?.trim();
  return !!name && name.toLowerCase() !== "base";
}

/**
 * The optional keyword tokens, most valuable first.
 *
 * Order settled by Jason 2026-09-02 (collector consult, decisions log in
 * `todos/neo-101-plan.md`), and it is NOT the order this generator used
 * before:
 *
 *   AUTO → RELIC → parallel → /printRun → cardVariation → RC → SP/SSP
 *
 * AUTO and RELIC lead because they drive price and are eBay's own filter
 * facets; parallel plus print run are how scarcity reads at a glance;
 * the variation text is frequently the literal search term; RC and SP/SSP
 * trail because both are obvious the moment the buyer opens the listing.
 *
 * ## Why the de-duplication is not paranoia
 *
 * `parallelName` and `cardVariation` are routinely THE SAME STRING, by design:
 * `deriveCardObservedFeatures` copies a card's `cardVariation` into
 * `features.parallelName` (NEO-189), because a variation is what fills eBay's
 * Parallel/Variety aspect on a card that has no parallel. Passing both — which
 * both insert call sites do, since both fields are genuinely on the row —
 * titled a 2024 Topps Chrome variation as `... #300b Image Variation Image
 * Variation`. Higher priority wins the slot; the duplicate is simply not a
 * second token, and is NOT reported as dropped (it is in the title).
 */
function optionalTokens(inputs: ListingCardInputs): string[] {
  const raw: string[] = [];
  if (inputs.autographed && inputs.autographed !== "None") raw.push("AUTO");
  if (inputs.isRelic) raw.push("RELIC");
  if (isRealParallel(inputs)) raw.push(inputs.parallelName!.trim());
  if (inputs.printRun) raw.push(`/${inputs.printRun}`);
  const variation = inputs.cardVariation?.trim();
  if (variation) raw.push(variation);
  if (inputs.isRookie) raw.push("RC");
  if (inputs.shortPrint && inputs.shortPrint !== "None") {
    raw.push(inputs.shortPrint);
  }

  const seen = new Set<string>();
  return raw.filter((token) => {
    const key = token.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Cut `text` to at most `maxLength` characters at the last WHOLE-WORD boundary
 * that fits.
 *
 * No ellipsis, ever. An `…` in a live eBay title reads to a buyer as a broken
 * listing rather than as a deliberate abbreviation (collector consult,
 * 2026-09-02), and it also costs a character that a real word could have used.
 * A hard mid-word slice is the fallback only when there is no whitespace to cut
 * at — a single unbroken token longer than the budget — because returning
 * nothing at all would be worse.
 */
function cutAtWordBoundary(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  const window = text.slice(0, maxLength);
  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace > 0) return window.slice(0, lastSpace).trimEnd();
  // The fallback cuts at a UTF-16 code unit, which can land BETWEEN the two
  // halves of a surrogate pair — an emoji, or any astral character — leaving an
  // orphaned high surrogate on the end. That is not a character: it renders as
  // a replacement glyph and is not encodable as valid UTF-8 once a marketplace
  // adapter serialises the title. Drop it.
  //
  // Only this branch needs the check. The word-boundary branch above cuts at a
  // space, and a space is never half of anything.
  const hardCut = /[\uD800-\uDBFF]$/.test(window) ? window.slice(0, -1) : window;
  return hardCut.trimEnd();
}

/**
 * NEO-101 — eBay-style SEO title, plus what it had to give up building it.
 *
 * ## The shape
 *
 * Core identifying tokens (year / manufacturer / set / players) then the card
 * number, then optional high-value keywords appended one at a time while they
 * still fit. `generateListingTitle` is a thin wrapper over this that returns
 * only `.title`.
 *
 * ## Two guarantees, for ANY inputs
 *
 *   1. `title.length <= LISTING_TITLE_MAX`. eBay REJECTS an over-length title
 *      rather than shortening it (see listingLimits.ts), so a title that does
 *      not fit is a listing that never publishes.
 *   2. the title ends with `#<cardNumber>`, or with `#<cardNumber>` followed by
 *      optional tokens. The card number is the least negotiable token — a
 *      listing is ambiguous without it — so it is never the thing that gets
 *      cut; the descriptive prefix truncates instead.
 *
 * (Guarantee 1 assumes the card number itself fits: `#<cardNumber>` shorter
 * than the cap. A card number pushing 80 characters is not a card number, and
 * the alternative — truncating it — would break guarantee 2, which matters
 * more.)
 *
 * ## Skip, don't stop
 *
 * A token that does not fit is SKIPPED and later tokens are still tried. The
 * old loop `break`ed on the first miss, which meant one long parallel or
 * variation name silently swallowed the three-character `RC` sitting behind it
 * even though `RC` fit perfectly well. Priority order says which token wins a
 * contested character, not which tokens are allowed to be considered.
 */
export function assessListingTitle(
  inputs: ListingCardInputs,
): ListingTitleAssessment {
  const identityParts: string[] = [];
  if (inputs.year) identityParts.push(inputs.year);
  identityParts.push(...manufacturerAndSetTokens(inputs));
  const playerPart =
    inputs.playerNames && inputs.playerNames.length > 0
      ? inputs.playerNames.join(" & ")
      : "";
  const corePrefix = [identityParts.join(" "), playerPart]
    .filter(Boolean)
    .join(" ");

  const reserved = ` #${inputs.cardNumber}`;
  const maxPrefixLen = LISTING_TITLE_MAX - reserved.length;
  const coreFits = corePrefix.length <= maxPrefixLen;
  const prefix = coreFits
    ? corePrefix
    : cutAtWordBoundary(corePrefix, maxPrefixLen);

  let title = `${prefix}${reserved}`.trim();

  // Optional tokens are attempted even when the core had to be cut. A
  // word-boundary cut can leave several characters of real slack (the word it
  // dropped may have been long), and AUTO / RELIC are worth more to a buyer
  // than that slack is — the operator is being asked to rewrite this title
  // anyway, via `coreFits: false`.
  const dropped: string[] = [];
  for (const token of optionalTokens(inputs)) {
    const candidate = `${title} ${token}`;
    if (candidate.length > LISTING_TITLE_MAX) {
      dropped.push(token);
      continue;
    }
    title = candidate;
  }

  return { title, coreFits, dropped };
}

/**
 * The title alone. Kept as its own export with its original signature because
 * both insert call sites and a pile of tests call it; anything that also needs
 * to know what was cut calls `assessListingTitle` directly.
 */
export function generateListingTitle(inputs: ListingCardInputs): string {
  return assessListingTitle(inputs).title;
}

/**
 * Full prose description, assembled from whatever facts are present —
 * absent fields are skipped entirely rather than rendered as blanks. Each
 * fact renders as its own line (the field is a multi-line textarea) rather
 * than one run-on paragraph.
 *
 * No cap applies here: eBay's description field takes ~500k of HTML, and the
 * longest description this generator has ever produced on real data is 132
 * characters. So unlike the title, nothing is dropped — a `cardVariation` too
 * long to earn a place in the title still states itself in full here.
 */
export function generateListingDescription(inputs: ListingCardInputs): string {
  const sentences: string[] = [];

  const setParts = [inputs.year, ...manufacturerAndSetTokens(inputs)].filter(
    Boolean,
  );
  const isParallel = isRealParallel(inputs);
  const setLabel = setParts.length > 0 ? setParts.join(" ") : null;

  if (setLabel && inputs.playerNames?.length) {
    const who = inputs.playerNames.join(" & ");
    const variant = isParallel ? ` ${inputs.parallelName}` : "";
    sentences.push(`${setLabel}${variant} card of ${who}, #${inputs.cardNumber}.`);
  } else if (setLabel) {
    const variant = isParallel ? ` ${inputs.parallelName}` : "";
    sentences.push(`${setLabel}${variant} card #${inputs.cardNumber}.`);
  } else if (inputs.playerNames?.length) {
    sentences.push(
      `Card #${inputs.cardNumber} of ${inputs.playerNames.join(" & ")}.`,
    );
  } else {
    sentences.push(`Card #${inputs.cardNumber}.`);
  }

  // NEO-101: stated right after the identity sentence, because WHICH printing
  // this is belongs with what the card is, not with its extras. Verbatim, and
  // a string that already ends in a full stop does not get a second one.
  //
  // Skipped when the parallel name the sentence above already rendered IS this
  // string — which is the common case, not an edge one: NEO-189 copies a card's
  // `cardVariation` into `features.parallelName`, so both arrive here. Same
  // de-duplication the title's token list does, for the same reason.
  const variation = inputs.cardVariation?.trim();
  const alreadyStated =
    isParallel &&
    inputs.parallelName!.trim().toLowerCase() === variation?.toLowerCase();
  if (variation && !alreadyStated) {
    sentences.push(
      variation.endsWith(".") ? `Variation: ${variation}` : `Variation: ${variation}.`,
    );
  }

  if (inputs.isRookie) sentences.push("This is a Rookie Card.");

  if (inputs.autographed && inputs.autographed !== "None") {
    sentences.push(`Autographed (${inputs.autographed}).`);
  }

  if (inputs.isRelic) sentences.push("Includes a memorabilia relic piece.");

  if (inputs.shortPrint && inputs.shortPrint !== "None") {
    const label = inputs.shortPrint === "SSP" ? "Super Short Print" : "Short Print";
    sentences.push(`${label} (${inputs.shortPrint}).`);
  }

  if (inputs.printRun) {
    sentences.push(`Serial numbered to ${inputs.printRun}.`);
  }

  return sentences.join("\n");
}
