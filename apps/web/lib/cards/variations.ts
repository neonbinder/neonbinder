/**
 * Card VARIATIONS — the NeonBinder domain model (NEO-189).
 *
 * A variation is the same checklist slot printed a second way: a different
 * photo, a nickname on the nameplate, team-colour treatment, or an outright
 * printing error. It is NOT a parallel — a parallel is a whole alternate
 * printing of a set, already modelled as its own `selectorOptions` row with its
 * own checklist. A variation lives inside one set's checklist, hanging off one
 * specific card.
 *
 * ## Why this module is not in an adapter
 *
 * Both marketplaces we sync carry variations, and they express them
 * differently. Neither expression is the domain:
 *
 *                 BSC                              SportLots
 *   identity      suffixed cardNo (`11b`, `11c`)   SAME cardNo as the parent
 *   marker        `VAR` attribute token, and/or    ` [ VAR <name> ]` appended
 *                 a `VAR:` description prefix      to the card description
 *   name          `Action`, `Team Color`           `Action Image`,
 *                                                  `Team Name Color Swap`
 *
 * NeonBinder owns the card data. BSC and SL are things we LINK to for listing,
 * never the shape we store — the same rule `selectorOptions.sportConfig` states
 * for sport codes: marketplace wire formats are resolved at the adapter
 * boundary and must never be persisted onto a domain entity.
 *
 * So each adapter answers two domain questions about a row — "is this a
 * variation?" and "what is it called?" — and everything downstream of that
 * lives here, marketplace-agnostic.
 *
 * ## Why parents are resolved by ROW, not by card number
 *
 * The obvious API returns `Map<variationCardNumber, parentCardNumber>`. That is
 * a BSC-shaped API and it makes SportLots **unrepresentable**: SL gives every
 * variation of #13 the card number `13`, so five variations and their parent
 * all collide on one key. Indices are the only identity every source has.
 */

/** One row as the domain sees it, after an adapter has normalised it. */
export interface VariationCandidate {
  /** The card number as printed. May be shared with the parent (SportLots) or
   *  carry a distinguishing suffix (BSC). */
  cardNumber: string;
  /** Whether the source marked this row as a variation of some other card. */
  isVariation: boolean;
  /** The marketplace's RAW label for this variation, e.g. "Action Image".
   *  Untranslated on purpose: which NeonBinder name it maps to is the admin's
   *  decision, stored in `variationTypeAliases` (see convex/variationTypes.ts).
   *  Absent when the source marked a variation but named it nothing. */
  variationLabel?: string;
}

export interface ResolvedVariations {
  /** index of a variation row → index of its parent row. */
  parentByIndex: Map<number, number>;
  /** Card-number stems where a variation exists but no single parent could be
   *  identified. Reported so a caller can surface them for review rather than
   *  guessing — never silently dropped. */
  unresolvedStems: string[];
}

/**
 * Split a card number into the STEM it groups on.
 *
 * `"11"` → `11`. `"11b"` → `11`. `"1a"` → `1`. A number with no numeric prefix
 * (`"CC-JA"`, `"MIR-AJ"`) is its own stem and groups only with an exact match.
 *
 * Case-insensitive: 2022 Topps Heritage carries a single uppercase suffix among
 * 297 otherwise-lowercase ones.
 */
export function cardNumberStem(cardNumber: string): string {
  const m = cardNumber.trim().match(/^(\d+)([a-z]+)$/i);
  return m ? m[1] : cardNumber.trim();
}

/**
 * Decide which row each variation is a variation OF.
 *
 * ## The rule, and why it is not the obvious one
 *
 * "A bare number is the parent, an alpha suffix means child" is wrong, and
 * measurably so. Scored against seven live payloads (2026-08-27), counting
 * groups that contain a variation:
 *
 *   set                                 bare-is-parent   this rule
 *   2021 Topps Heritage base                 77/77         77/77
 *   2022 Topps Heritage base               144/144       144/144
 *   2021 Topps base                          2/152       152/152   <—
 *   2021 Donruss football base               50/50         50/50
 *   2021 Panini Prizm basketball base        36/36         36/36
 *
 * 2021 Topps is the counter-example: its base cards are themselves suffixed.
 * There is no card #1 — the set ships `1a` "Rounding Base" (Fernando Tatis
 * Jr.), `1b` "Sliding" (SP), `1c` "In Dugout" (SSP). 150 of its 660 stems have
 * no bare-numbered row at all.
 *
 * What holds across all 459 variation groups: **group by stem, and exactly one
 * row in the group is not a variation. That row is the parent** — whatever its
 * number looks like. It also happens to be the only rule that works for
 * SportLots, where the parent's number is identical to its variations'.
 *
 * ## Ambiguity is reported, never guessed
 *
 * A stem with zero non-variation rows, or more than one, is returned in
 * `unresolvedStems`. Real examples from 2021 Topps Heritage inserts: #251 and
 * #378 are checklist print variations (Large/Small Print, Star/Asterisk before
 * copyright) where BOTH rows are variations and no parent row exists.
 *
 * ## Scope the input to ONE marketplace set
 *
 * Grouping is on the stem alone, so this is only sound when `rows` covers a
 * single set. Run it over a payload spanning several and unrelated cards
 * collide: across all 2021 Heritage inserts at once, Bill Bonham's #29
 * variation lands in the same stem as Deivi Garcia's #29 and links to it. That
 * is structurally identical to the legitimate different-player case below —
 * only the scoping tells them apart. NEO-137's N:M mapping must therefore group
 * per source set, not across a merged fan-out.
 *
 * ## Do NOT add a "same player" guard
 *
 * It looks like an easy safety net and it is wrong. Under the hobby's "Legend"
 * short-print convention a variation routinely features a COMPLETELY DIFFERENT
 * player from its parent: 2021 Topps #52 is Archie Bradley, while `52b`/`52c`/
 * `52d` are Mickey Mantle; #4 David Bote → `4b` Ernie Banks; 2022 Heritage #201
 * is a team-highlight card whose five variations are all Aaron Judge.
 * Requiring player overlap drops 63 of 213 legitimate links in 2021 Topps
 * alone.
 */
export function resolveVariationParents(
  rows: VariationCandidate[],
): ResolvedVariations {
  const byStem = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const stem = cardNumberStem(row.cardNumber);
    const bucket = byStem.get(stem);
    if (bucket) bucket.push(i);
    else byStem.set(stem, [i]);
  });

  const parentByIndex = new Map<number, number>();
  const unresolvedStems: string[] = [];

  for (const [stem, indices] of byStem) {
    const variations = indices.filter((i) => rows[i].isVariation);
    if (variations.length === 0) continue;

    const parents = indices.filter((i) => !rows[i].isVariation);
    if (parents.length !== 1) {
      unresolvedStems.push(stem);
      continue;
    }
    for (const i of variations) parentByIndex.set(i, parents[0]);
  }

  return { parentByIndex, unresolvedStems };
}

/**
 * BOOTSTRAP SEED ONLY — **not** the authority on what a variation is called.
 *
 * ## Why this is not a lookup table
 *
 * BSC and SportLots name the same variation differently, and the user's
 * position (2026-08-27) is that this is *very common*: **the admin building the
 * set decides the NeonBinder canonical name, through a reconciliation step.**
 * A hard-coded map is a guess frozen into code, and every set we have not
 * looked at yet will contain names that are not in it.
 *
 * This repo already learned that lesson once. `SPORT_SKU_CODE` and friends were
 * display-name-keyed maps consulted at runtime; two call sites passed different
 * casing, the lookup silently missed, and one set produced two different
 * marketplace-facing SKU prefixes (see `sku.ts` and NEO-96). The fix was to
 * move the authority onto the row and keep the map only as a **bootstrap
 * default applied at creation time, never as a runtime lookup**. Same shape
 * here: the stored `variationTypes` vocabulary is the authority; this seeds it.
 *
 * ## Evidence behind the seed
 *
 * Comparing BSC and SportLots card-by-card for the same set (2021 Topps
 * Heritage) on 2026-08-27, where a card had n variations on both sides the
 * labels lined up in order across 11 cards:
 *
 *   BSC "Action"        ↔ SL "Action Image"            (7 cards)
 *   BSC "Alternate"     ↔ SL "Throwback Alternate"     (3 cards)
 *   BSC "Team Color"    ↔ SL "Team Name Color Swap"    (8 cards)
 *   BSC "Missing Stars" ↔ SL "Missing Stars"           (4 cards)
 *   BSC "Nickname"      ↔ SL "Nickname"                (5 cards)
 *   BSC "Error"         ↔ SL "Error"                   (1 card)
 *
 * Two of the six are worded completely differently. The canonical spellings
 * below are a STARTING PROPOSAL for the admin to accept or override — they are
 * not a product decision that has been made.
 */
export const BOOTSTRAP_VARIATION_ALIASES: ReadonlyArray<{
  canonical: string;
  bsc: string[];
  sportlots: string[];
}> = [
  { canonical: "Action", bsc: ["Action"], sportlots: ["Action Image"] },
  { canonical: "Throwback Alternate", bsc: ["Alternate"], sportlots: ["Throwback Alternate"] },
  { canonical: "Team Color Swap", bsc: ["Team Color"], sportlots: ["Team Name Color Swap"] },
  { canonical: "Missing Stars", bsc: ["Missing Stars"], sportlots: ["Missing Stars"] },
  { canonical: "Nickname", bsc: ["Nickname"], sportlots: ["Nickname"] },
  { canonical: "Error", bsc: ["Error"], sportlots: ["Error"] },
];

/**
 * Normalise a marketplace's variation label for LOOKUP — casing and internal
 * whitespace only.
 *
 * This is deliberately not a rename: it is the key an alias is stored and found
 * under, so `"Action Image"`, `"action image"` and `"Action  Image"` all reach
 * the same stored decision. Choosing what a label *means* is the admin's, via
 * reconciliation; this only makes the lookup stable.
 */
export function variationLabelKey(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Tidy a raw marketplace label for DISPLAY in the reconciliation step.
 *
 * Whitespace-normalised and otherwise untouched — an unreviewed label must
 * reach the admin exactly as the marketplace spelled it, or they cannot judge
 * what it maps to.
 */
export function displayVariationLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}
