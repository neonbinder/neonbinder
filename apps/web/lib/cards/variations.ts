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
  /** The variation's canonical name, e.g. "Action". Absent when the source
   *  marked a variation but gave it no name. */
  variationName?: string;
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
 * Canonical NeonBinder names for the variation types both marketplaces carry,
 * with each marketplace's own spelling as an alias.
 *
 * Established by comparing BSC and SportLots for the SAME set (2021 Topps
 * Heritage) card by card on 2026-08-27. Where a card had n variations on both
 * sides, the labels lined up in order across 11 cards:
 *
 *   BSC "Action"        ↔ SL "Action Image"            (7 cards)
 *   BSC "Alternate"     ↔ SL "Throwback Alternate"     (3 cards)
 *   BSC "Team Color"    ↔ SL "Team Name Color Swap"    (8 cards)
 *   BSC "Missing Stars" ↔ SL "Missing Stars"           (4 cards)
 *   BSC "Nickname"      ↔ SL "Nickname"                (5 cards)
 *   BSC "Error"         ↔ SL "Error"                   (1 card)
 *
 * Two of the six differ in wording entirely, which is the whole argument for
 * owning a canonical name rather than storing whichever marketplace synced
 * last.
 *
 * Keys are lowercased for lookup. Anything unrecognised passes through
 * unchanged rather than being forced into this list — sets invent new variation
 * types every year, and a name we have not seen is data, not an error.
 */
const VARIATION_NAME_ALIASES: Record<string, string> = {
  // Action
  action: "Action",
  "action image": "Action",
  // Throwback Alternate
  alternate: "Throwback Alternate",
  "throwback alternate": "Throwback Alternate",
  // Team Color Swap
  "team color": "Team Color Swap",
  "team name color swap": "Team Color Swap",
  "team & name color swap variation": "Team Color Swap",
  // Same on both sides — listed so the canonical casing is pinned.
  "missing stars": "Missing Stars",
  nickname: "Nickname",
  error: "Error",
};

/**
 * Map a marketplace's variation label onto the NeonBinder name.
 *
 * Unknown labels are trimmed and returned as-is: this normalises what we have
 * evidence for and refuses to invent mappings for what we do not.
 */
export function canonicalVariationName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed) return trimmed;
  return VARIATION_NAME_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}
