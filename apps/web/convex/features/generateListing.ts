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
 *
 * ## The formula, and why the title PACKS rather than stays short
 *
 *   core:      <year> <manufacturer/set> <insert> <players> #<cardNumber>
 *              (a core too long to fit gives up its insert, set and maker
 *              words, from the end, before any player's: `cutCore`)
 *   then, while each still fits, in this order:
 *              AUTO, RELIC, <parallel>, /<printRun>, <cardVariation>,
 *              RC, SP|SSP, <each team name>, "Rookie", <sport>
 *   then, last (NEO-335, the old title builder's labels), each placed right
 *   after the name it labels:
 *              "Parallel" after the parallel, "Insert" after the insert
 *   and, only when the title does not fit otherwise, "Rookie" → "RC" inside
 *   the insert's name, before the set's short name is tried.
 *
 * A listing title is the only text eBay's search actually matches on, so an
 * unused character is a search term thrown away. Jason's research
 * (2026-09-02), two samples of SOLD listings — 119 Topps Chrome baseball and
 * 120 Panini Prizm football — says what real sellers put in that space:
 *
 *   - two-thirds of titles run 70-80 characters; the mean is 70
 *   - 70% lead with the year
 *   - 82-93% carry the card number
 *   - ~50% name the TEAM
 *   - ~50% say RC or Rookie, and a THIRD of those use both words
 *
 * NeonBinder's own titles averaged 34. That is not concision, it is half the
 * listing's searchable surface left blank — so the token list below is
 * deliberately long, and the loop keeps trying tokens until the budget is
 * genuinely spent. eBay's own seller guidance orders a title year, brand /
 * edition, player, special features, grading, which is exactly the core here.
 *
 * The tail of the list is FILLER, and ordered as such. `"Rookie"` is appended
 * late and only alongside `RC` — the two words are not redundant to a search
 * engine (a third of sold rookie listings carry both), but `RC` is the one
 * that must survive if only one can. `sport` is last: it is the weakest search
 * term on the card (a buyer browsing baseball cards is already in baseball),
 * so it exists purely to spend characters that would otherwise go unused.
 */

import { LISTING_TITLE_MAX } from "./listingLimits";

export type ListingCardInputs = {
  cardNumber: string;
  /** Resolved player display names, already looked up from playerIds. */
  playerNames?: string[];
  /** Mirrors the year node's value verbatim — same field `features.season` holds. */
  year?: string;
  manufacturer?: string;
  /**
   * NEO-272 — `selectorOptions.metadata.isBrandUnknown` on the ancestor
   * `manufacturer` row: NB has not identified the brand of this set. The row
   * above it is the marketplace's all-brands FILTER OPTION ("show all cards
   * from all brands"), carried as a manufacturer row, so the "brand" here names
   * no brand at all.
   *
   * When true the `manufacturer` above is dropped from both the title and the
   * description — see `manufacturerAndSetTokens`. Passed as a FLAG rather than
   * letting this module compare the name, because that name is a marketplace
   * filter label NB does not own and an operator can rename besides — keying
   * behaviour on it is the forward dependency product invariant 4 forbids.
   */
  manufacturerBrandUnknown?: boolean;
  setName?: string;
  /**
   * NEO-335 — the insert's own name ("Dugout Collection"), already gated on
   * the insert row's NB role by `listingInputsForCard`. Set identity: it
   * joins the CORE after the set name and is never dropped, only shortened.
   */
  insertName?: string;
  /**
   * NEO-335 — the set's shorter name for titles. When the generator uses it,
   * it REPLACES the set-name and insert-name words in the core; the maker is
   * kept unless the short name already starts with it.
   */
  setShortName?: string;
  /** features.parallelName — "Base" for a plain base card, a real name otherwise. */
  parallelName?: string;
  /**
   * NEO-335 — the card's leaf is a parallel by NB ROLE (a sub-variant, or an
   * insert-level row under a Parallel type: `derivedVariantFlags`, NEO-334),
   * set by `listingInputsForCard` from the chain's `parallelLeafValue`. It is
   * what earns the parallel token its "Parallel" label (`labelTokens`); never
   * read off the parallel's name. The insert's label needs no such flag:
   * `insertName` is itself present only on the insert role.
   */
  parallelIsRole?: boolean;
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
  /**
   * NEO-101 — the stored `teams.name` values for this card's `teamOnCardIds`,
   * in stored order.
   *
   * VERBATIM, like `cardVariation`: "Seattle Mariners", "Oregon Ducks
   * baseball", "Tigres del Licey". Never parsed into city/nickname, never
   * abbreviated to "SEA". A team name is a search term a buyer types the way
   * it is printed, and roughly half of sold listings carry one — abbreviating
   * it would be inventing marketplace vocabulary for no gain.
   */
  teamNames?: string[];
  /**
   * NEO-101 — the ancestor sport node's value, e.g. "Baseball".
   *
   * The weakest token in the list and deliberately last: it is a filler word
   * that spends leftover characters. Frequently swallowed by the word-level
   * de-duplication below, because a team name like "Oregon Ducks baseball"
   * already contains it.
   */
  sport?: string;
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
  /**
   * NEO-335 — present (and true) only when the title was built with the set's
   * short name (`setShortName`) in place of its set and insert names. Absent
   * otherwise, so an assessment without a short name is unchanged.
   */
  shortNameUsed?: true;
  /**
   * NEO-335 — present (and true) only when the title was built with "Rookie"
   * shortened to "RC" in the insert's name (`rookieAsRc`), because the title
   * did not fit otherwise. Absent otherwise.
   */
  rookieAsRcUsed?: true;
};

/**
 * NEO-335 — when a set's short name replaces its full name in a title.
 *
 *   - "A": build with the full names; when the core was cut OR any optional
 *     token that is not filler (the sport, the second "Rookie") was dropped,
 *     rebuild with the short name and use that.
 *   - "B": only when the core was cut.
 *   - "C": always, whenever the set has a short name.
 *
 * One switch, read by every caller through `assessListingTitle`'s default, so
 * the title shown before save, the title written at insert and the title the
 * Regenerate button rebuilds cannot disagree.
 */
export type ShortNameRule = "A" | "B" | "C";
export const SHORT_NAME_RULE: ShortNameRule = "A";

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
 *
 * ## NEO-272 — a set whose brand NB has not identified has no manufacturer token
 *
 * `syncSetsAcrossManufacturers` files a BSC set whose name prefix-matches no
 * real brand under the marketplace's all-brands FILTER OPTION, carried as a
 * `manufacturer` row. "All Brands" is not a brand: it means "show all cards
 * from all brands", so it says nothing whatever about the card in hand.
 * Composing it into a title is therefore not merely wasteful, it is
 * meaningless text in a buyer-facing field — and it costs real characters out
 * of the 80 a title gets ("All Brands " alone is eleven of them), which is
 * routinely the difference between a title that fits and one the Cards Needing
 * Attention walker flags as cut short.
 *
 * The test is the caller's NB flag, never the row's name. Keying it on the
 * literal "All Brands" is the same defect NEO-239 removed when it stopped
 * detecting the base variant by the literal "Base", and here it is the clearer
 * case: the name is a MARKETPLACE FILTER LABEL that NB does not own, so a
 * string comparison would be NB behaviour keyed on a marketplace value —
 * exactly the forward dependency product invariant 4 (CLAUDE.md) forbids. It
 * would miss a renamed row into the bargain.
 *
 * Dropping it here, rather than in each caller, is what makes the title and
 * the DESCRIPTION agree: `generateListingDescription` builds its set label
 * from this same helper, so one change covers both.
 *
 * A flagged manufacturer produces no token at all — not an empty one — so the
 * `filter(Boolean).join` below emits no leftover separator and no double
 * space, and the `startsWithWord` collapse branch is unreachable (it needs a
 * truthy `manufacturer`), which is right: there is nothing to collapse into.
 */
function manufacturerAndSetTokens(inputs: ListingCardInputs): string[] {
  const manufacturer = inputs.manufacturerBrandUnknown
    ? undefined
    : inputs.manufacturer?.trim();
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

/**
 * NEO-335 — the set-identity words of the core: maker and set (collapsed as
 * above), then the insert's name; or, with `useShortName`, the short name in
 * place of the set and insert names.
 *
 * The insert name is set identity, the way the old title builder treated it:
 * a 1996 Score "Dugout Collection" card is not a Score base card, and a title
 * that says so is wrong, not merely short. It is only ever SHORTENED (by the
 * short name), never dropped.
 *
 * An insert named after its set ("Topps Chrome Refractor" under "Topps
 * Chrome") collapses into the set word for word, like a set named after its
 * maker; an insert whose every word the set already says adds nothing.
 *
 * With the short name, the maker is kept unless the short name already starts
 * with it — the same rule as a set name that starts with its brand — and is
 * never kept for a brand NB has not identified (NEO-272).
 */
function setIdentityTokens(inputs: ListingCardInputs, useShortName: boolean): string[] {
  const shortName = inputs.setShortName?.trim();
  if (useShortName && shortName) {
    const manufacturer = inputs.manufacturerBrandUnknown
      ? undefined
      : inputs.manufacturer?.trim();
    if (manufacturer && !startsWithWord(shortName, manufacturer)) {
      return [manufacturer, shortName];
    }
    return [shortName];
  }
  const tokens = manufacturerAndSetTokens(inputs);
  const insert = inputs.insertName?.trim();
  if (!insert) return tokens;
  if (tokens.length === 0) return [insert];
  if (startsWithWord(insert, tokens.join(" "))) return [insert];
  const last = tokens[tokens.length - 1];
  if (startsWithWord(insert, last)) return [...tokens.slice(0, -1), insert];
  if (alreadySaid(tokens.join(" "), insert)) return tokens;
  return [...tokens, insert];
}

/**
 * NEO-335 — the label words the old title builder (`getTitles`) put after an
 * insert's and a parallel's names: "1996 Score Dugout Collection Insert …",
 * "… Gold Parallel". Jason, 2026-10-13: "yes include them and they are the
 * first to drop if too long".
 */
export const INSERT_LABEL = "Insert";
export const PARALLEL_LABEL = "Parallel";

/**
 * Does `name` already end with `label` as a word, singular or plural ("Gold
 * Insert", "Prizm Parallels")? Then the label would only repeat it. The old
 * builder appended regardless ("Gold Insert Insert"); this does not.
 */
function endsWithLabel(name: string, label: string): boolean {
  const words = name.trim().toLowerCase().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  const word = label.toLowerCase();
  return last === word || last === `${word}s`;
}

/**
 * NEO-335 — "Rookie" shortened to "RC" in an insert's name ("Rookie Debut" →
 * "RC Debut"), applied only when the title does not fit otherwise. Exactly the
 * old builder's replacement (`card.insert.replace('Rookie', 'RC')`): the FIRST
 * occurrence, case-sensitive, no word boundary — so "Rookies" reads "RCs" and
 * a lowercase "rookie" is left alone.
 */
export function rookieAsRc(name: string): string {
  return name.replace("Rookie", "RC");
}

/**
 * NEO-335 — is this dropped optional token one of the generator's FILLER
 * words: the sport, "Rookie" (the second spelling, appended only beside
 * "RC"), or the "Insert" / "Parallel" labels (appended only on those roles)?
 * A filler drop is not a loss: those words exist to spend characters that
 * would otherwise go unused, so none of them alone switches a title to the
 * short name (rule A) or is listed as left out.
 */
export function isFillerToken(token: string, inputs: ListingCardInputs): boolean {
  const sport = inputs.sport?.trim();
  if (sport && token === sport) return true;
  if (token === INSERT_LABEL && !!inputs.insertName?.trim()) return true;
  if (token === PARALLEL_LABEL && inputs.parallelIsRole === true) return true;
  return inputs.isRookie === true && token === "Rookie";
}

function isRealParallel(inputs: ListingCardInputs): boolean {
  const name = inputs.parallelName?.trim();
  return !!name && name.toLowerCase() !== "base";
}

/** The parallel's title token, when there is a real one. */
function parallelToken(inputs: ListingCardInputs): string | undefined {
  return isRealParallel(inputs) ? inputs.parallelName!.trim() : undefined;
}

/**
 * NEO-335 — should the parallel token carry the "Parallel" label? Only on the
 * parallel ROLE, only when the token does not already end with the word, and
 * not when the token is the card's own variation text: NEO-189 copies
 * `cardVariation` into `features.parallelName`, so on a parallel card with a
 * variation the "parallel" token is really "Image Variation", and labelling it
 * a parallel would say something untrue. (Same comparison the description
 * makes before stating the variation a second time.)
 */
function parallelWantsLabel(inputs: ListingCardInputs): boolean {
  const token = parallelToken(inputs);
  if (!token || inputs.parallelIsRole !== true) return false;
  if (endsWithLabel(token, PARALLEL_LABEL)) return false;
  return token.toLowerCase() !== inputs.cardVariation?.trim().toLowerCase();
}

/**
 * NEO-335 — should the insert's name carry the "Insert" label? Whenever the
 * name is in the core (its presence IS the insert role, `listingInputsForCard`)
 * and does not already end with the word.
 */
function insertWantsLabel(inputs: ListingCardInputs): boolean {
  const insert = inputs.insertName?.trim();
  return !!insert && !endsWithLabel(insert, INSERT_LABEL);
}

/**
 * The optional keyword tokens, most valuable first.
 *
 * Order settled by Jason 2026-09-02 (collector consult plus the sold-listing
 * research summarised in this module's header), and it is NOT the order this
 * generator used before:
 *
 *   AUTO → RELIC → parallel → /printRun → cardVariation → RC → SP/SSP
 *        → each team name → "Rookie" → sport
 *
 * AUTO and RELIC lead because they drive price and are eBay's own filter
 * facets; parallel plus print run are how scarcity reads at a glance;
 * the variation text is frequently the literal search term; RC and SP/SSP
 * trail because both are obvious the moment the buyer opens the listing.
 * Teams, the second "Rookie" spelling and the sport are the fill tail — real
 * search terms, but the ones to lose first when the budget runs out.
 *
 * Returned RAW and in full. Nothing is filtered here: whether a token is
 * redundant depends on the title as it stands when the token is reached, so
 * that judgement belongs in the append loop, not in this list.
 */
function optionalTokens(inputs: ListingCardInputs): string[] {
  const tokens: string[] = [];
  if (inputs.autographed && inputs.autographed !== "None") tokens.push("AUTO");
  if (inputs.isRelic) tokens.push("RELIC");
  if (isRealParallel(inputs)) tokens.push(parallelToken(inputs)!);
  if (inputs.printRun) tokens.push(`/${inputs.printRun}`);
  const variation = inputs.cardVariation?.trim();
  if (variation) tokens.push(variation);
  if (inputs.isRookie) tokens.push("RC");
  if (inputs.shortPrint && inputs.shortPrint !== "None") {
    tokens.push(inputs.shortPrint);
  }
  for (const team of inputs.teamNames ?? []) {
    const trimmed = team.trim();
    if (trimmed) tokens.push(trimmed);
  }
  // The second spelling of "rookie". Not redundant with `RC` to a search
  // engine — a third of sold rookie listings carry both words — but it is the
  // one to lose if only one fits, hence its position behind everything else
  // that identifies the card.
  if (inputs.isRookie) tokens.push("Rookie");
  const sport = inputs.sport?.trim();
  if (sport) tokens.push(sport);
  return tokens;
}

/** Lowercased whitespace-delimited words of a string, for the de-dup test. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Is every word of `token` already a word of the title built so far?
 *
 * ## Why word-level, and why against the WHOLE title
 *
 * The narrow version of this rule compared `parallelName` against
 * `cardVariation`, because `deriveCardObservedFeatures` copies a card's
 * `cardVariation` into `features.parallelName` (NEO-189) and both insert call
 * sites therefore hand the generator the same string twice — titling a 2024
 * Topps Chrome variation as `... #300b Image Variation Image Variation`.
 *
 * Lengthening the token list turned that one collision into a family of them:
 *
 *   - a team named "Oregon Ducks baseball" followed by the sport "Baseball";
 *   - a manufacturer "Topps" already inside a set name "Topps Chrome", or a
 *     parallel that repeats the product word;
 *   - the same team resolved twice onto one card.
 *
 * All of them are the same defect — a word the buyer already read, spending
 * characters twice — so all of them are answered by one rule: skip a token
 * whose every word is already present as a word of the title. Comparing WORDS
 * rather than whole strings is what catches "Oregon Ducks baseball" ⊃
 * "Baseball"; comparing against the whole title rather than the token list is
 * what catches repeats of a word from the core.
 *
 * It deliberately does NOT collapse `RC` and `Rookie`: different words, and
 * carrying both is what real sold listings do.
 *
 * Approximate by construction — a token could in principle have every word
 * scattered across unrelated parts of the title ("New York Yankees" after a
 * "New York" team and a player surnamed Yankees). The failure mode is a
 * dropped filler word on a card that will never exist, which is the right side
 * to be wrong on.
 */
function alreadySaid(title: string, token: string): boolean {
  const present = new Set(wordsOf(title));
  const tokenWords = wordsOf(token);
  return tokenWords.length > 0 && tokenWords.every((w) => present.has(w));
}

/**
 * Strip a trailing "&" left dangling by a word-boundary cut.
 *
 * `playerNames` join with " & ", so a cut that keeps the connector but loses
 * the player it was joining to yields "Aaron Judge &" — a title reading
 * "... Aaron Judge & #17" that promises a second player and never delivers one.
 * `&` sits between two spaces, so it is a perfectly good WORD as far as the
 * boundary rule is concerned; nothing but this check stops the cut landing
 * there.
 *
 * LOOPS deliberately: stripping one connector can expose another ("A & & B"),
 * and a degenerate core built entirely of connectors must terminate at the
 * empty string rather than spin. Each pass removes at least one character, so
 * it does.
 */
function dropDanglingConnector(text: string): string {
  let result = text.trimEnd();
  while (/(^|\s)&$/.test(result)) {
    result = result.slice(0, -1).trimEnd();
  }
  return result;
}

/**
 * NEO-335 — a generational name suffix: Jr., Sr., II, III, IV, with or
 * without the period (and a trailing comma tolerated). Case-insensitive.
 */
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv)\.?,?$/i;

/** Is `name`'s last word a generational suffix ("Ken Griffey Jr.")? */
export function endsWithNameSuffix(name: string): boolean {
  const words = name.trim().split(/\s+/);
  return words.length > 1 && NAME_SUFFIX.test(words[words.length - 1]);
}

/**
 * Cut `text` to at most `maxLength` characters at the last WHOLE-WORD boundary
 * that fits.
 *
 * NEO-335 — `forbidden` lists space positions the cut may not land on: the
 * spaces INSIDE a player name that ends in a generational suffix. "Ken Griffey
 * Jr." and "Ken Griffey Sr." on one card are told apart by nothing else, so a
 * cut that keeps "Ken Griffey" and drops the suffix titles both cards as the
 * same man. Such a name is kept whole or dropped whole; the cut moves to an
 * earlier boundary, and the title stays flagged (`coreFits: false`). When no
 * allowed boundary fits, the plain last boundary is used, as before.
 *
 * No ellipsis, ever. An `…` in a live eBay title reads to a buyer as a broken
 * listing rather than as a deliberate abbreviation (collector consult,
 * 2026-09-02), and it also costs a character that a real word could have used.
 * A hard mid-word slice is the fallback only when there is no whitespace to cut
 * at — a single unbroken token longer than the budget — because returning
 * nothing at all would be worse.
 */
function cutAtWordBoundary(
  text: string,
  maxLength: number,
  forbidden: ReadonlySet<number> = new Set(),
): string {
  if (maxLength <= 0) return "";
  if (text.length <= maxLength) return text;
  const window = text.slice(0, maxLength);
  let lastSpace = window.lastIndexOf(" ");
  while (lastSpace > 0 && forbidden.has(lastSpace)) {
    lastSpace = window.lastIndexOf(" ", lastSpace - 1);
  }
  if (lastSpace <= 0) lastSpace = window.lastIndexOf(" ");
  if (lastSpace > 0) return dropDanglingConnector(window.slice(0, lastSpace).trimEnd());
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
 * The leading whole words of `text` that fit in `room` characters; empty when
 * not even the first word fits. Never a mid-word slice and never a trailing
 * " &" ("Black & White Mini" cut after "&").
 */
function leadingWordsThatFit(text: string, room: number): string {
  if (text.length <= room) return text;
  if (room <= 0) return "";
  const at = text.lastIndexOf(" ", room);
  return at > 0 ? dropDanglingConnector(text.slice(0, at)) : "";
}

/**
 * The core's prefix (everything before ` #<cardNumber>`) when it does not fit
 * whole in `maxPrefixLen` characters.
 *
 * ## The players outrank the set words
 *
 * A title is found by the player's name first: "Vladimir Guerrero Jr.
 * Authentics Relic" is a search, "Topps Chrome Authentics Relics Orange
 * Refractor" with no name in it is not, and nobody can tell from it which of
 * the checklist's cards is for sale. The cut used to run from the END of the
 * core, which is where the players sit, so on a long insert the whole name
 * went and every set word stayed (NEO-339: thirteen 2023 Topps Chrome insert
 * titles rewritten by hand).
 *
 * So the words are given up in this order:
 *
 *   1. set identity, from its end: the insert's words first (on a flat insert
 *      such as "Authentics Relics Orange Refractor" that is its parallel
 *      words, then its own), then the set's, then the maker's. The year leads
 *      the identity, so it is the last of them to go.
 *   2. only when the players do not fit even beside nothing but the card
 *      number: the players, cut at a whole word after the year. A name ending
 *      in Jr./Sr./II/III/IV is kept whole or dropped whole when an earlier
 *      boundary exists (`cutAtWordBoundary`'s `forbidden`): Ken Griffey Jr.
 *      and Sr. share a card.
 *
 * With no players the identity is cut at a whole word, as it always was
 * (including the hard-slice fallback for a single unbroken word).
 *
 * Either way the core was cut, so the assessment reports `coreFits: false`
 * and the row is born `listingTitleTruncated`: identity words a buyer might
 * search on are gone, and `leftOutOfTitle` names them.
 */
function cutCore(
  identity: string,
  playerPart: string,
  inputs: ListingCardInputs,
  maxPrefixLen: number,
): string {
  if (!playerPart) return cutAtWordBoundary(identity, maxPrefixLen);
  if (playerPart.length <= maxPrefixLen) {
    // The space between the identity and the players costs one character.
    const kept = leadingWordsThatFit(identity, maxPrefixLen - playerPart.length - 1);
    return [kept, playerPart].filter(Boolean).join(" ");
  }
  const year = inputs.year?.trim() ?? "";
  const text = [year, playerPart].filter(Boolean).join(" ");
  // NEO-335 — the spaces inside a player name ending in Jr./Sr./II/III/IV,
  // where the cut may not land: the suffix is who the player is.
  const suffixedNameSpaces = new Set<number>();
  let start = year ? year.length + 1 : 0;
  for (const name of inputs.playerNames ?? []) {
    if (endsWithNameSuffix(name)) {
      for (let i = 0; i < name.length; i += 1) {
        if (name[i] === " ") suffixedNameSpaces.add(start + i);
      }
    }
    start += name.length + " & ".length;
  }
  return cutAtWordBoundary(text, maxPrefixLen, suffixedNameSpaces);
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
 *      cut; the descriptive prefix truncates instead, set words before
 *      players (`cutCore`).
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
  options: { shortNameRule?: ShortNameRule } = {},
): ListingTitleAssessment {
  // "Does not fit" means the core was cut or a token that is not filler was
  // dropped. Losing only filler (the sport, the second "Rookie", the "Insert"
  // and "Parallel" labels) is the generator spending spare room, not a loss.
  const lost = (a: ListingTitleAssessment) =>
    a.dropped.filter((token) => !isFillerToken(token, inputs)).length;
  const fitsWhole = (a: ListingTitleAssessment) => a.coreFits && lost(a) === 0;

  let best = buildTitle(inputs, false);
  // NEO-335 — "Rookie" → "RC" in the insert's name, only when the title does
  // not fit otherwise (Jason, 2026-10-13: "Rookie->RC should shorten only when
  // needed"). The old builder's position: after the optional words are lost,
  // BEFORE any shorter set or insert name is tried.
  //
  // "Needed" is held to its word: the shortened name is taken when the core
  // was cut (four characters back for the card's own identity), or when it
  // keeps a real token the full name lost. When it buys nothing — the same
  // tokens are lost either way — the insert keeps its printed name. (The old
  // builder kept it regardless, but it never re-tried a lost token after.)
  const insert = inputs.insertName?.trim();
  if (!fitsWhole(best) && insert && rookieAsRc(insert) !== insert) {
    const rc = buildTitle({ ...inputs, insertName: rookieAsRc(insert) }, false);
    if (!best.coreFits || lost(rc) < lost(best)) {
      best = { ...rc, rookieAsRcUsed: true };
    }
  }
  if (!inputs.setShortName?.trim()) return best;
  // NEO-335 — the short name, behind one rule (see `SHORT_NAME_RULE`).
  const rule = options.shortNameRule ?? SHORT_NAME_RULE;
  const useShortName =
    rule === "C" || !best.coreFits || (rule === "A" && !fitsWhole(best));
  if (!useShortName) return best;
  return { ...buildTitle(inputs, true), shortNameUsed: true };
}

/**
 * NEO-339 — the words that tell this parallel apart from its parent: the
 * parallel's name less the leading words its parent already says. "1988 Topps
 * Baseball Autographs Red" under the insert "1988 Topps Baseball Autographs"
 * is "Red"; "SuperFractor" is itself. The parent is the insert when there is
 * one, else the set. Undefined when there is no real parallel, when the
 * parallel token is really the card's variation text (NEO-189 copies it into
 * `parallelName`), or when nothing is left.
 *
 * Leading words only, so the phrase keeps its order ("Orange Refractor" stays
 * "Orange Refractor"). Compared case-insensitively, by word.
 */
export function parallelDistinguishingWords(inputs: ListingCardInputs): string | undefined {
  const token = parallelToken(inputs);
  if (!token) return undefined;
  if (token.toLowerCase() === inputs.cardVariation?.trim().toLowerCase()) return undefined;
  const parent = inputs.insertName?.trim() || inputs.setName?.trim() || "";
  const parentWords = new Set(wordsOf(parent));
  const words = token.split(/\s+/).filter(Boolean);
  let at = 0;
  while (at < words.length && parentWords.has(words[at].toLowerCase())) at += 1;
  const rest = words.slice(at).join(" ");
  return rest || undefined;
}

/**
 * One title build: full set names, or the short name in their place.
 *
 * ## NEO-339 — a parallel's own words outlive its insert's and its set's
 *
 * The 2023 Topps Chrome "1988 Topps Baseball Autographs Red" card titled as
 * "… 1988 Topps Baseball Autographs Vladimir Guerrero Jr. #88BA-VG": the
 * parallel's whole name could not fit after the core, so it was dropped, and
 * the title read exactly like the base and SuperFractor versions. "Red" is
 * what identifies the card.
 *
 * So the plain build runs first, and when it lost the parallel's
 * distinguishing words (`parallelDistinguishingWords`) the title is rebuilt
 * with them right after the card number, as part of the core: year,
 * player(s), number, those words. Room for them comes out of the identity
 * words, insert first, then set, then maker (`cutCore`). A title that already
 * carries them is returned unchanged. The rebuild is flagged as cut
 * (`coreFits: false`) only when identity words were actually given up.
 */
function buildTitle(
  inputs: ListingCardInputs,
  useShortName: boolean,
): ListingTitleAssessment {
  const plain = buildTitleWith(inputs, useShortName, undefined);
  const key = parallelDistinguishingWords(inputs);
  if (!key || alreadySaid(plain.title, key)) return plain;
  // A key that cannot fit beside the card number cannot be kept at all.
  if (` #${inputs.cardNumber} ${key}`.length > LISTING_TITLE_MAX) return plain;
  return buildTitleWith(inputs, useShortName, key);
}

function buildTitleWith(
  inputs: ListingCardInputs,
  useShortName: boolean,
  parallelKey: string | undefined,
): ListingTitleAssessment {
  const identityParts: string[] = [];
  if (inputs.year) identityParts.push(inputs.year);
  identityParts.push(...setIdentityTokens(inputs, useShortName));
  const playerPart =
    inputs.playerNames && inputs.playerNames.length > 0
      ? inputs.playerNames.join(" & ")
      : "";
  const identity = identityParts.join(" ");
  const corePrefix = [identity, playerPart].filter(Boolean).join(" ");

  // The parallel's own words ride with the number when a plain build lost
  // them (see `buildTitle`).
  const reserved = parallelKey
    ? ` #${inputs.cardNumber} ${parallelKey}`
    : ` #${inputs.cardNumber}`;
  const maxPrefixLen = LISTING_TITLE_MAX - reserved.length;
  const coreFits = corePrefix.length <= maxPrefixLen;
  const prefix = coreFits
    ? corePrefix
    : cutCore(identity, playerPart, inputs, maxPrefixLen);

  let title = `${prefix}${reserved}`.trim();

  // Optional tokens are attempted even when the core had to be cut. A
  // word-boundary cut can leave several characters of real slack (the word it
  // dropped may have been long), and AUTO / RELIC are worth more to a buyer
  // than that slack is — the operator is being asked to rewrite this title
  // anyway, via `coreFits: false`.
  const dropped: string[] = [];
  const parallel = parallelToken(inputs);
  // Where the parallel token ends in the title, once it is in. Later tokens
  // only ever append, so the index stays true.
  let parallelEnd: number | undefined = parallelKey ? title.length : undefined;
  for (const token of optionalTokens(inputs)) {
    // Already in the core, by its distinguishing words; its full name would
    // only repeat the parent's.
    if (parallelKey && token === parallel) continue;
    // A token the buyer has already read is not reported as dropped — it IS
    // in the title, just not a second time.
    if (alreadySaid(title, token)) continue;
    const candidate = `${title} ${token}`;
    if (candidate.length > LISTING_TITLE_MAX) {
      dropped.push(token);
      continue;
    }
    title = candidate;
    if (token === parallel && parallelEnd === undefined) parallelEnd = title.length;
  }

  // NEO-335 — the "Parallel" and "Insert" labels, tried LAST so they are the
  // first words lost when room runs out ("Insert" first, then "Parallel", the
  // old builder's order), but each placed right after the name it labels.
  // Skip, don't stop, as above.
  //
  // "Parallel" only when the parallel token itself made it in. "Insert" only
  // on a full-name build whose core was not cut: with the short name the
  // insert's name is not in the title to label, and a cut core is already
  // short of its own identity words.
  const labels: Array<{ word: string; at: number }> = [];
  if (parallelEnd !== undefined && parallelWantsLabel(inputs)) {
    labels.push({ word: PARALLEL_LABEL, at: parallelEnd });
  }
  if (!useShortName && coreFits && insertWantsLabel(inputs)) {
    labels.push({ word: INSERT_LABEL, at: identity.length });
  }
  for (const { word, at } of labels) {
    const candidate = `${title.slice(0, at)} ${word}${title.slice(at)}`;
    if (candidate.length > LISTING_TITLE_MAX) {
      dropped.push(word);
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

  // NEO-335: the insert's name is part of what the card is, so the
  // description's set label carries it too. Never the short name: the
  // description has no cap, so nothing here needs shortening.
  const setParts = [inputs.year, ...setIdentityTokens(inputs, false)].filter(
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

  // NEO-101: named in full, once, however many teams the card carries — the
  // description has no cap, so unlike the title nothing here competes for room.
  const teamNames = (inputs.teamNames ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  if (teamNames.length > 0) {
    sentences.push(`Team: ${teamNames.join(", ")}.`);
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
