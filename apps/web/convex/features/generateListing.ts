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
 */

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
};

const EBAY_TITLE_MAX = 80;

/**
 * eBay-style SEO title, target length ~80 chars (eBay's own hard cap). Core
 * identifying tokens (year/manufacturer/set/player/card#) always included;
 * optional high-value keywords (parallel, RC, AUTO, RELIC, SP/SSP, print
 * run) are appended one at a time, in priority order, only while they still
 * fit — so a long set/player name degrades gracefully instead of silently
 * overflowing eBay's limit.
 */
export function generateListingTitle(inputs: ListingCardInputs): string {
  const identityParts: string[] = [];
  if (inputs.year) identityParts.push(inputs.year);
  if (inputs.manufacturer) identityParts.push(inputs.manufacturer);
  if (inputs.setName) identityParts.push(inputs.setName);
  const playerPart =
    inputs.playerNames && inputs.playerNames.length > 0
      ? inputs.playerNames.join(" & ")
      : "";
  const corePrefix = [identityParts.join(" "), playerPart]
    .filter(Boolean)
    .join(" ");

  // The card number is the least negotiable token — a listing is ambiguous
  // without it — so it's always appended last and never truncated away.
  // Everything else (year/manufacturer/set/player) truncates from the end
  // instead if the combination is too long to fit.
  const reserved = ` #${inputs.cardNumber}`;
  const maxPrefixLen = EBAY_TITLE_MAX - reserved.length;
  const prefixFits = corePrefix.length <= maxPrefixLen;
  const prefix = prefixFits
    ? corePrefix
    : corePrefix.slice(0, Math.max(0, maxPrefixLen - 1)).trimEnd() + "…";

  let title = `${prefix}${reserved}`.trim();

  // Only attempt optional keyword embellishments when the core identity
  // wasn't already truncated — appending more text to an already-full
  // title would just get cut again, and the "…" already signals the cut.
  if (prefixFits) {
    const optional: string[] = [];
    const isParallel =
      inputs.parallelName && inputs.parallelName.toLowerCase() !== "base";
    if (isParallel) optional.push(inputs.parallelName!);
    if (inputs.isRookie) optional.push("RC");
    if (inputs.autographed && inputs.autographed !== "None") {
      optional.push("AUTO");
    }
    if (inputs.isRelic) optional.push("RELIC");
    if (inputs.shortPrint && inputs.shortPrint !== "None") {
      optional.push(inputs.shortPrint);
    }
    if (inputs.printRun) optional.push(`/${inputs.printRun}`);

    for (const token of optional) {
      const candidate = `${title} ${token}`;
      if (candidate.length > EBAY_TITLE_MAX) break;
      title = candidate;
    }
  }

  return title;
}

/**
 * Full prose description, assembled from whatever facts are present —
 * absent fields are skipped entirely rather than rendered as blanks.
 */
export function generateListingDescription(inputs: ListingCardInputs): string {
  const sentences: string[] = [];

  const setParts = [inputs.year, inputs.manufacturer, inputs.setName].filter(
    Boolean,
  );
  const isParallel =
    inputs.parallelName && inputs.parallelName.toLowerCase() !== "base";
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

  return sentences.join(" ");
}
