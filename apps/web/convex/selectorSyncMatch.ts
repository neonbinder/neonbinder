/**
 * NEO-211 — the ONE matcher every selector-sync write path agrees on.
 *
 * Before this file, `storeSelectorOptions` and `storeReconciledOptions` each
 * built their own `existingByValue` map keyed on `value.toLowerCase().trim()`,
 * matched incoming marketplace rows against it, and **deleted every non-custom
 * existing row the marketplace did not name**. That made a rename a delete +
 * empty re-insert (the row's `_id`, its cards, its children and its
 * cross-listings all pointed at the row that was just removed), and made a
 * single marketplace outage look identical to "the marketplace dropped these
 * sets".
 *
 * The governing rule is now: **NeonBinder owns the set data; marketplace ids
 * exist only to route a marketplace's own update back to the row linked to
 * it.** So nothing here deletes, nothing here renames, and a row is matched by
 * IDENTITY (marketplace id → slot) before it is ever matched by name.
 *
 * Match tiers, in order:
 *
 *   0. `existingId` supplied by the client (the reconciliation modal knows
 *      which NB row a title belongs to). Resolved ONLY against the sibling
 *      snapshot the store already read — never `ctx.db.get`, so a client
 *      cannot steer the write at a row under a different parent or level.
 *   1. Marketplace id → the sibling holding it in a `platformData` slot.
 *      Exactly-one-or-withheld: NEO-137 makes M NB rows → 1 marketplace set
 *      legal, so an id held by two siblings is not evidence of which row the
 *      update belongs to.
 *   2. Normalised display value, against siblings that are FREE on the sides
 *      the item carries — no id at all on that side, an id upstream did not
 *      return this run (a re-slug: same set, new id), or a PLACEHOLDER id the
 *      caller names as such (NEO-237: a manufacturer row linked through
 *      SportLots' all-brands option before the brand's own id was known).
 *      Matching a stale row here is what heals a BSC re-slug through
 *      `setPrimarySlotId`, which reuses the slot KEY so every card on it keeps
 *      resolving; matching a placeholder row upgrades it to the real id
 *      through the same slot, and the outcome says so (`placeholderSides`).
 *   3. No candidate → insert. Ambiguous candidate → withheld and surfaced.
 *      Withholding writes nothing; it never deletes and never guesses.
 *
 * Everything in this module is PURE. It reads rows and returns a plan; the
 * stores do the writing. That is what lets the same rules be asserted in a
 * unit test and reused by the suggestions query without a second copy of the
 * matching logic drifting away from the one that writes.
 */

import {
  detachSlot,
  idForSlot,
  primarySlot,
  MAX_SLOT_LABEL_LENGTH,
  type PlatformDataShape,
  type PlatformFacetShape,
  type PlatformSide,
  type SlotBearingRow,
} from "./platformSlots";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { sportConfigDefaultsFor } from "./sportConfig";

export type { PlatformSide } from "./platformSlots";

export const PLATFORM_SIDES = ["bsc", "sportlots"] as const;

// NEO-85: structural deep-equal for the small plain-value objects/arrays we
// store on selectorOptions (platformData, children id arrays).
// Leaves are string | number | boolean | null; containers are arrays and plain
// objects. Used to skip no-op ctx.db.patch calls: in Convex, patching a row —
// even with byte-identical data — invalidates every query that read it, which
// re-renders and reflows the SetSelector columns under Maestro's coordinate
// taps (the weeks-long dropped-tap flake). Order-sensitive for arrays; our
// syncs write a deterministic order, so identical syncs compare equal.
export function valuesDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (
        !valuesDeepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// The one normaliser
// ───────────────────────────────────────────────────────────────────────────

/**
 * The single fold used by tier 2, by the sibling-clash check, by
 * `declinedUpstreamLabels`, and by the suggestions query's "does the
 * marketplace label differ from NB's name?" test.
 *
 * Deliberately `toLowerCase().trim()` — exactly what both stores have always
 * keyed on — and deliberately NOT `nameKey` from lib/cards/card-name.ts.
 * `nameKey` strips every non-alphanumeric character, which is right for player
 * names but would newly fold apart-by-design siblings like "Gold /50" and
 * "Gold 50" into one row here, silently merging two parallels.
 *
 * One fold, used everywhere, is the point: a name the matcher treats as equal
 * must be a name the clash check refuses and the suggestions query calls
 * unchanged, or the three disagree about what a rename even is.
 */
export function selectorValueKey(value: string): string {
  return value.toLowerCase().trim();
}

// ───────────────────────────────────────────────────────────────────────────
// The one validated write path for `selectorOptions.value`
// ───────────────────────────────────────────────────────────────────────────

/** Display values share the slot-label ceiling — both are operator-visible text. */
export const MAX_SELECTOR_VALUE_LENGTH = MAX_SLOT_LABEL_LENGTH;

export type SelectorValueCheck =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Validate a candidate display value WITHOUT throwing.
 *
 * Three callers write `value`: `renameSelectorOption` (operator typed it),
 * `applySelectorSyncSuggestions` (accepting a marketplace label), and the
 * store's tier-0 rename from the reconciliation modal. The marketplace label
 * is re-validated on the way out even though `assertValidSlotLabel` checked it
 * on the way in — a label stored by an older build, or by a path that predates
 * that check, must not become a row name unchecked.
 */
export function checkSelectorValue(raw: string): SelectorValueCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "Name cannot be empty" };
  if (trimmed.length > MAX_SELECTOR_VALUE_LENGTH) {
    return {
      ok: false,
      reason: `Name exceeds ${MAX_SELECTOR_VALUE_LENGTH} characters`,
    };
  }
  // Control characters and line breaks: a newline inside a display value
  // breaks every single-line renderer that shows it and is never intentional.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return {
      ok: false,
      reason: "Name cannot contain line breaks or control characters",
    };
  }
  // Zero-width and invisible characters are worse than control codes here,
  // because nothing renders them: a label carrying a ZWSP is VISUALLY
  // identical to one without, yet it is a different string, folds to a
  // different `selectorValueKey`, and so slips past the sibling-clash check to
  // produce two rows an operator cannot tell apart in any picker. They survive
  // `.trim()` too — none of them is Unicode White_Space. A marketplace label
  // or a copy-paste is all it takes.
  if (/[\u200B-\u200D\u2060\uFEFF]/.test(trimmed)) {
    return {
      ok: false,
      reason: "Name cannot contain zero-width or invisible characters",
    };
  }
  return { ok: true, value: trimmed };
}

/** Throwing wrapper for the paths whose contract is an error to the operator. */
export function assertSelectorValue(raw: string): string {
  const checked = checkSelectorValue(raw);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.value;
}

/**
 * NEO-219 — the ONE rule for a value an operator typed into "Add Custom
 * Entry", shared by the mutation that writes it and the form that offers it.
 *
 * `checkSelectorValue` above is the universal floor (non-empty after trim,
 * length ceiling, no control or zero-width characters). This adds the
 * per-LEVEL rule on top, because "" and "\u200b" are not the only ways to
 * name a row badly: `EntityColumn`'s custom field had no validation at all,
 * so `2o24` (letter o) went in as a `year` row, and every downstream consumer
 * that parses a year off a selector value — `deriveCardFeatures`, SKU
 * generation, the release-year resolution — silently got nothing back.
 *
 * PURE and dependency-free on purpose: `EntityColumn` imports it directly the
 * way the SetSelector components already import `platformSlots`, so the inline
 * error the operator reads and the `ConvexError` the mutation throws are the
 * same sentence produced by the same code. A second copy in the component is
 * how the two come to disagree.
 *
 * Year is STRICT four digits (Jason, 2026-09-04, decision 2). Season-shaped
 * values ("1972-73") are rejected even though `deriveCardFeatures` anticipates
 * them, because no season-shaped row or fixture exists anywhere in dev, prod
 * or `.maestro` — every `YEAR:` is four digits. Loosen the regex here, in one
 * place, if a real one ever appears.
 *
 * Note the ORDER: `checkSelectorValue` trims first, so " 2024 " is accepted
 * and stored as "2024". The regex never sees the surrounding whitespace.
 *
 * @param level the `selectorOptions.level` the value is being created at
 * @param raw   exactly what the operator typed, untrimmed
 */
export function checkCustomSelectorValue(
  level: string,
  raw: string,
): SelectorValueCheck {
  const base = checkSelectorValue(raw);
  if (!base.ok) return base;

  if (level === "year") {
    if (!/^\d{4}$/.test(base.value)) {
      return { ok: false, reason: "Year must be a four-digit number" };
    }
  }

  // NEO-237 — "All Brands" is the VIEW pinned at the top of the Manufacturers
  // column, not a row. See `ALL_BRANDS_VIEW_VALUE_KEY`.
  if (level === "manufacturer" && isAllBrandsViewName(base.value)) {
    return { ok: false, reason: ALL_BRANDS_VIEW_REFUSAL };
  }

  // Every other level: non-empty after trim, which `checkSelectorValue`
  // already guaranteed. There is deliberately no per-level character rule for
  // set/insert/parallel names — real ones carry slashes, parentheses, accents
  // and print-run numerals ("Gold /50", "Refractor (SP)").
  return base;
}

// ───────────────────────────────────────────────────────────────────────────
// NEO-237 — the All Brands VIEW name is not a manufacturer name
// ───────────────────────────────────────────────────────────────────────────

/**
 * The Manufacturers column carries a pinned entry, "All Brands", that is a
 * VIEW ("show every set in this year, brand as a suffix") selected by a client
 * sentinel and never a document id. Before NEO-237 a `manufacturer` row of
 * that name was minted by the set sync to hold brand-unknown sets and stored
 * from SportLots' brand list, which offers "All Brands" as its no-filter
 * option; that row is now called "Unknown" (`ensureBrandUnknownRow`) and the
 * SportLots option is routed to it rather than stored (`fetchAggregatedOptions`
 * at the manufacturer level, `isSlAllBrandsBrandId`).
 *
 * So a manufacturer row of this name would be a second thing wearing the
 * view's label in the same column, and both doors that take an operator-typed
 * manufacturer name refuse it: `checkCustomSelectorValue` (the form and
 * `addCustomSelectorOption`) and `planValueRename` (every rename path). This
 * is NB's OWN view name being reserved in NB's own column — nothing here
 * compares a marketplace value. "Unknown" is deliberately NOT reserved:
 * typing it selects the existing row through the per-parent duplicate return.
 *
 * Folded through `selectorValueKey`, the same fold the sibling-clash check
 * uses, so "all brands" and "ALL BRANDS " are refused as the same word.
 */
export const ALL_BRANDS_VIEW_VALUE_KEY = selectorValueKey("All Brands");

/** The refusal both doors show. Fixed text; carries no operator value. */
export const ALL_BRANDS_VIEW_REFUSAL =
  "All Brands is the view at the top of this column, not a brand.";

export function isAllBrandsViewName(value: string): boolean {
  return selectorValueKey(value) === ALL_BRANDS_VIEW_VALUE_KEY;
}

// ───────────────────────────────────────────────────────────────────────────
// NEO-294 — the year's Unknown row does not rename
// ───────────────────────────────────────────────────────────────────────────

/**
 * Jason, 2026-09-22: "Unknown should not be renamable."
 *
 * Beside the All Brands refusal above because it is the same KIND of rule —
 * NB reserving a word in NB's own column — but the two are reserved from
 * opposite directions, and the difference is worth stating:
 *
 *   • "All Brands" is refused as a NAME, whatever row is asking for it, which
 *     is why it lives in `checkCustomSelectorValue` (the create door) as well
 *     as in `planValueRename` (every rename door).
 *   • "Unknown" is refused as a ROW: the name is deliberately NOT reserved
 *     (typing it in the custom-entry form selects the existing row through
 *     the per-parent duplicate return), and what may not change is the value
 *     of the row carrying `metadata.isBrandUnknown`. So the guard reads the
 *     row's NB ROLE FLAG, never its name — the same rule every other
 *     brand-unknown consumer follows (`brandView`, `brandRehome`,
 *     `findAncestorLabels`), and the reason a legacy row still named
 *     "All Brands" is caught by it too.
 *
 * WHY the row is frozen: every year's bucket is found by the flag and shown
 * under one word, so a year whose bucket says "Unknown" and a year whose
 * bucket says something an operator typed are the same bucket wearing two
 * names — and NEO-294's `ensureBrandRowForName` has to refuse a year whose
 * flagged row wears a known brand's name, which is a state only a rename
 * could produce.
 *
 * The ONE exception is `backfillBrandPrefixAndUnknownName`, which renames the
 * legacy "All Brands"-named flagged rows to "Unknown". That is NB tidying its
 * own word, not an operator door, so it passes `allowBrandUnknownRename`.
 */
export const BRAND_UNKNOWN_RENAME_REFUSAL =
  "Unknown is where sets with no known brand wait — it can't be renamed.";

/** True for the row that holds a year's sets whose brand NB has not identified. */
export function isBrandUnknownRow(
  metadata: { isBrandUnknown?: boolean } | null | undefined,
): boolean {
  return metadata?.isBrandUnknown === true;
}

// ───────────────────────────────────────────────────────────────────────────
// NEO-237 — the ONE brand-prefix matcher
// ───────────────────────────────────────────────────────────────────────────

/**
 * Does `label` start with `prefix` as a whole word?
 *
 * The single rule behind every "which brand does this set name belong to"
 * decision: the Sync Sets BSC phase (`routeBscSets`), the SportLots adapter's
 * all-brands narrowing (`fetchSetNames`), the SportLots-only classification
 * (`routeSlSets`), and the re-home of sets out of Unknown (`brandRehome.ts`).
 * One matcher, so the set a brand claims at sync time is the set the adapter
 * narrows to and the set the re-home moves — three copies would be three
 * answers.
 *
 * Both sides go through `selectorValueKey` (lowercase, trim), and the
 * character after the prefix must be ABSENT or NON-ALPHANUMERIC: "Choice
 * Biloxi" and "Choice-Biloxi" match "Choice", "Choices" does not, and
 * "Toppstown" does not match "Topps" — the same word-boundary rule
 * `stripBrandPrefixForLabel` learned the hard way ("Toppstown Retro" →
 * "town Retro"). Unicode letters and digits count as alphanumeric, so an
 * accented continuation is a longer word too, not a boundary.
 *
 * Widens the set sync's old `startsWith(brand + " ") || === brand`: any
 * non-alphanumeric boundary now counts ("Upper Deck-…"). No change for an
 * existing row, because id-first routing wins before a prefix is consulted.
 *
 * An empty prefix matches NOTHING. A manufacturer row with no
 * `setNamePrefix` buckets nothing and narrows nothing; it never falls back
 * to its display value (schema.ts `setNamePrefix`).
 */
export function matchesBrandPrefix(label: string, prefix: string): boolean {
  return foldedPrefixMatches(selectorValueKey(label), selectorValueKey(prefix));
}

/**
 * The rule on ALREADY-FOLDED strings, for the one caller that tests one label
 * against thousands of keys (`routeSlSets`) and cannot afford to re-fold both
 * sides per pair. Everything else goes through `matchesBrandPrefix`.
 */
function foldedPrefixMatches(foldedLabel: string, foldedPrefix: string): boolean {
  if (!foldedPrefix) return false;
  if (!foldedLabel.startsWith(foldedPrefix)) return false;
  const next = foldedLabel.charAt(foldedPrefix.length);
  return next === "" || !/[\p{L}\p{N}]/u.test(next);
}

/**
 * The label with its matched brand prefix removed — for the all-brands
 * narrowing, where the adapter returns "Carddass Dragon Ball" under a
 * "Bandai" row exactly as it returns "Series 1" under "Topps".
 *
 * Case-insensitive and whole-word (it is `matchesBrandPrefix` applied to the
 * ORIGINAL label, then the prefix's length sliced off), and never strips to
 * nothing: a set named exactly after its brand keeps its name rather than
 * becoming "" and being dropped by the caller's `if (setName)` guard — the
 * second correction `stripBrandPrefixForLabel` carries, for the same reason.
 * Returns the label unchanged when the prefix does not match.
 *
 * The boundary the matcher accepts is any non-alphanumeric character, so the
 * remainder may start with the separator that ended the brand: "Choice-
 * Biloxi" → "-Biloxi". A dash-like separator (hyphen, en/em dash, colon,
 * slash, pipe) is dropped along with the whitespace around it, because it
 * joined the brand to the name and means nothing on its own. Anything else
 * stays — a leading "#", "(" or quote may well be part of the set's name,
 * and guessing is what `stripBrandPrefixForLabel` declined to do. That
 * adapter strip keeps its whitespace-only trim (rows named by it before
 * NEO-237 must not churn a rename suggestion); this one names only rows a
 * via-All-Brands brand narrows, all of them born under this rule.
 */
export function stripMatchedBrandPrefix(label: string, prefix: string): string {
  if (!matchesBrandPrefix(label, prefix)) return label;
  const trimmedLabel = label.trim();
  const stripped = trimLeadingSeparators(trimmedLabel.slice(prefix.trim().length));
  return stripped.length > 0 ? stripped : trimmedLabel;
}

/**
 * What is left of a label after its brand prefix, with the joining
 * separator gone: whitespace and dash-like punctuation only. Shared by
 * `stripMatchedBrandPrefix` and `routeSlSets`' folded re-strip so the label
 * the adapter displays and the label the classifier judges are one string.
 */
function trimLeadingSeparators(rest: string): string {
  return rest.replace(/^[\s\-–—:/|]+/u, "").trim();
}

// ───────────────────────────────────────────────────────────────────────────
// NEO-239 — the variantType rename refusal is GONE
//
// `refusesValueRename` (NEO-211 F) refused a rename on any variantType row a
// human had not typed. It existed because two places read that row's DISPLAY
// VALUE as if it were data: the BSC checklist fetch re-derived its `variant`
// facet from the value, and "which row is the base set" was detected by the
// literal string "base". Both are now read from the row instead — a
// `variant`-tagged BSC slot and `metadata.isBase` — so the name carries no
// meaning any process depends on, and every variantType row renames like every
// other level.
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// Matching
// ───────────────────────────────────────────────────────────────────────────

export type MatchableRow<TId extends string = string> = SlotBearingRow & {
  _id: TId;
  value: string;
};

export type IncomingItem = {
  value: string;
  /** Marketplace ids on the wire — the client knows nothing about slots. */
  ids: Partial<Record<PlatformSide, string>>;
  /** Tier 0, reconciled items only. Verified against the sibling snapshot. */
  existingId?: string;
};

export type MatchOutcome<TId extends string = string> =
  | {
      kind: "matched";
      existingId: TId;
      tier: 0 | 1 | 2;
      /**
       * NEO-237 — tier 2 only, and only when non-empty: the sides on which
       * the matched row's primary id is a PLACEHOLDER (`isPlaceholderId`)
       * that the item's real id now replaces. The store uses it to tell an
       * upgrade-from-placeholder apart from a re-slug: the slot key is
       * reused either way, but a placeholder never attributed anything, so
       * the swap is not a `relinked` rebinding.
       */
      placeholderSides?: PlatformSide[];
    }
  | { kind: "insert" }
  | {
      kind: "withheld";
      reason: string;
      /**
       * NEO-300 — set only on a withhold decided against the variant type's
       * subtree (two rows elsewhere hold the item's ids, or the modal's
       * `existingId` names a subtree row that does not carry the item's ids).
       * Which of the two it was, and the rows the item points at, so the
       * store can tell the operator rather than only logging it. Absent on
       * every sibling-level withhold, whose shape is unchanged.
       */
      elsewhere?: {
        reason: "heldByMany" | "idsDisagree";
        holderIds: TId[];
      };
    }
  /**
   * NEO-300 — the item names a row that already lives ELSEWHERE in this
   * variant type's subtree (an operator grouped it: an insert promoted to a
   * parallel, or a parallel demoted to an insert). No sibling holds it, so
   * without this the item landed as `insert` and re-created the row at its
   * old level. The store writes NOTHING for it — no insert, no reparent, no
   * level change, no rename, no platform refresh — and reports it.
   *
   * `tier` says what identified it: 0 = the modal's `existingId`, 1 = a
   * marketplace id held in one of the row's slots. Never a name.
   */
  | { kind: "heldElsewhere"; rowId: TId; tier: 0 | 1 };

/**
 * NEO-237 — "is this id on this side a placeholder link, not a live
 * marketplace id?" Answered by the CALLER, because the matcher is generic over
 * sides and levels and the answer is not: SportLots' all-brands option id
 * (`slBrandAxis.ts`) is a placeholder on a manufacturer row and would be a
 * bug anywhere else. Absent → nothing is a placeholder, today's rule exactly.
 */
export type PlaceholderIdPredicate = (side: PlatformSide, id: string) => boolean;

export type MatchAmbiguity = {
  /** The incoming item's display value — never a marketplace id or label. */
  item: string;
  reason: string;
};

export type SelectorSyncPlan<TId extends string = string> = {
  /** Parallel to the `items` array passed in. */
  outcomes: Array<MatchOutcome<TId>>;
  /** Sides this run is allowed to unlink on. Never inferred — see below. */
  coveredSides: PlatformSide[];
  /** Every marketplace id this run returned, per side. */
  returnedIds: Record<PlatformSide, Set<string>>;
  /** Withheld matches, for the log. Never returned to the client. */
  ambiguities: MatchAmbiguity[];
};

/**
 * What the FETCH returned, per side.
 *
 * NEO-211 F1: this is NOT the same thing as "the ids in the items", and on the
 * reconciler path the difference is the whole ballgame. `ReconciliationModal`
 * seeds every existing row into Ready, so the items are what the OPERATOR
 * confirmed, not what the marketplace listed. Deriving the unlink universe
 * from them gets both directions wrong:
 *
 *   • a set BSC genuinely delisted is still in the items (the modal restored
 *     it), so it would never be unlinked; and
 *   • a row the operator DISBANDED is absent from the items, so it would be
 *     unlinked and reported to that same operator as "no longer listed on
 *     BSC" — a statement about the marketplace that is simply false.
 *
 * So the caller passes the fetch's own id list when it has one. The items are
 * the fallback for callers that do not (the aggregator path, where items ARE
 * the fetch, and any old SPA bundle).
 */
export function resolveReturnedIds(
  items: readonly IncomingItem[],
  declared: { bsc?: readonly string[]; sportlots?: readonly string[] } | undefined,
): Record<PlatformSide, Set<string>> {
  const out: Record<PlatformSide, Set<string>> = {
    bsc: new Set<string>(),
    sportlots: new Set<string>(),
  };
  if (declared) {
    // Wholesale: a side the caller omitted gets an EMPTY universe, which by
    // the narrowing rule below means that side is not covered at all. Falling
    // back to the items for the omitted side would quietly re-introduce the
    // bug this argument exists to fix.
    for (const side of PLATFORM_SIDES) {
      for (const id of declared[side] ?? []) if (id) out[side].add(id);
    }
    return out;
  }
  for (const item of items) {
    for (const side of PLATFORM_SIDES) {
      const id = item.ids[side];
      if (id) out[side].add(id);
    }
  }
  return out;
}

/**
 * Which sides this run may unlink on.
 *
 * **Absent `coveredSides` means unlink NOTHING.** A Convex deploy is a hard
 * cutover with old SPA bundles live for minutes afterwards, and an old bundle
 * calling this store during a SportLots outage carries no way to say "SL was
 * not fetched". Defaulting to "infer it from the items" would make that bundle
 * strip SportLots linkage off every row it touched. Silence means silence.
 *
 * Coverage is then NARROWING-only: a side the caller claims to cover but whose
 * returned-id universe is empty is dropped, because "the fetch returned
 * nothing on this side" is not evidence that upstream dropped everything.
 */
export function effectiveCoveredSides(
  returnedIds: Record<PlatformSide, Set<string>>,
  declared: readonly PlatformSide[] | undefined,
): PlatformSide[] {
  if (!declared || declared.length === 0) return [];
  const out: PlatformSide[] = [];
  for (const side of PLATFORM_SIDES) {
    if (declared.includes(side) && returnedIds[side].size > 0) out.push(side);
  }
  return out;
}

/**
 * Is this row available to be matched BY NAME on `side`?
 *
 * Free means either "holds nothing on that side" or "holds an id upstream did
 * not return this run". The second case is the re-slug: BSC changed the slug
 * for a set it still lists, so the row's stored id is stale and the incoming
 * id belongs to it. Rebinding through `setPrimarySlotId` reuses the slot key,
 * so the cards on it keep resolving — which is the entire reason a stale row
 * is eligible rather than being left to accumulate a duplicate sibling.
 *
 * A row whose id on that side DID come back is not free: something else in
 * this batch legitimately owns it.
 *
 * NEO-237 — unless that id is a PLACEHOLDER (`isPlaceholderId`). A brand an
 * operator typed before Sync Manufacturers ran holds SportLots' all-brands
 * option id, and the fetch that finally lists the brand under its own id
 * ALSO returns the all-brands option — so by the rule above the row would
 * never be free, the real id would be withheld as "linked to a different
 * live id", and the only way out was the attributes-panel toggle. The
 * placeholder is not a live link to a set upstream lists under that id; it
 * is "no brand id yet", so the row is free and the real id lands in the
 * same slot. A row holding a REAL SportLots brand id keeps today's withhold.
 */
function isSideFreeForNameMatch(
  row: SlotBearingRow,
  side: PlatformSide,
  returnedIds: Set<string>,
  isPlaceholderId: PlaceholderIdPredicate | undefined,
): boolean {
  const slot = primarySlot(row, side);
  if (!slot) return true;
  const id = idForSlot(row, side, slot);
  if (id === undefined) return true;
  if (isPlaceholderId?.(side, id)) return true;
  return !returnedIds.has(id);
}

/** The sides on which `row`'s primary id is a placeholder the item replaces. */
function placeholderSidesFor(
  row: SlotBearingRow,
  sides: readonly PlatformSide[],
  isPlaceholderId: PlaceholderIdPredicate | undefined,
): PlatformSide[] {
  if (!isPlaceholderId) return [];
  return sides.filter((side) => {
    const slot = primarySlot(row, side);
    if (!slot) return false;
    const id = idForSlot(row, side, slot);
    return id !== undefined && isPlaceholderId(side, id);
  });
}

/** side → marketplace id → the rows holding it in ANY slot. */
function indexBySideId<TId extends string>(
  rows: readonly MatchableRow<TId>[],
): Record<PlatformSide, Map<string, Array<MatchableRow<TId>>>> {
  const out: Record<PlatformSide, Map<string, Array<MatchableRow<TId>>>> = {
    bsc: new Map(),
    sportlots: new Map(),
  };
  for (const row of rows) {
    for (const side of PLATFORM_SIDES) {
      const map = row.platformData?.[side];
      if (!map) continue;
      for (const id of Object.values(map)) {
        const holders = out[side].get(id);
        if (!holders) out[side].set(id, [row]);
        else if (!holders.includes(row)) holders.push(row);
      }
    }
  }
  return out;
}

/** Does `row` hold `id` in any slot on `side`? */
function rowHoldsId(row: SlotBearingRow, side: PlatformSide, id: string): boolean {
  return Object.values(row.platformData?.[side] ?? {}).includes(id);
}

/**
 * NEO-300 — does this item name a row that lives elsewhere in the variant
 * type's subtree? `undefined` = no, carry on to the name tier.
 *
 * Tier 0 first (the modal's own NB row id), then every marketplace id the
 * item carries. One distinct holder is `heldElsewhere`. Several is a
 * WITHHOLD, not an insert: the id is already in the subtree, so a new row
 * would be the duplicate this rule exists to stop, and picking one holder
 * would be a coin-flip about which grouping the operator meant.
 *
 * Tier 0 needs the ids to agree. The `existingId` is the CLIENT's claim; the
 * row it names must hold every id the item carries (on each side it carries
 * one). An item carrying an id the row does not hold is not "the same row,
 * already grouped" — it is a modal line pointing at one set with another
 * set's id — so it is withheld and reported, never quietly accepted. An item
 * carrying no ids at all has nothing to contradict the claim.
 */
function heldElsewhereOutcome<TId extends string>(
  item: IncomingItem,
  byId: ReadonlyMap<string, MatchableRow<TId>>,
  bySideId: Record<PlatformSide, Map<string, Array<MatchableRow<TId>>>>,
): MatchOutcome<TId> | undefined {
  if (item.existingId) {
    const row = byId.get(item.existingId);
    if (row) {
      const contradicted = PLATFORM_SIDES.filter((side) => {
        const id = item.ids[side];
        return id !== undefined && !rowHoldsId(row, side, id);
      });
      if (contradicted.length === 0) {
        return { kind: "heldElsewhere", rowId: row._id, tier: 0 };
      }
      return {
        kind: "withheld",
        reason:
          `existingId names a row elsewhere in this variant type that does ` +
          `not hold the item's ${contradicted.join(" and ")} id`,
        elsewhere: { reason: "idsDisagree", holderIds: [row._id] },
      };
    }
  }
  const holders = new Set<MatchableRow<TId>>();
  for (const side of PLATFORM_SIDES) {
    const id = item.ids[side];
    if (!id) continue;
    for (const row of bySideId[side].get(id) ?? []) holders.add(row);
  }
  if (holders.size === 0) return undefined;
  if (holders.size > 1) {
    return {
      kind: "withheld",
      reason: `marketplace ids are held by ${holders.size} rows elsewhere in this variant type`,
      elsewhere: {
        reason: "heldByMany",
        holderIds: [...holders].map((row) => row._id),
      },
    };
  }
  return { kind: "heldElsewhere", rowId: [...holders][0]._id, tier: 1 };
}

/**
 * NEO-300 — does any item name something no sibling holds?
 *
 * The stores use it to skip the subtree read on the common path: a re-sync
 * whose every id (and every `existingId`) is already on a sibling cannot
 * produce a `heldElsewhere`, so the per-insert reads would buy nothing.
 */
export function itemsReachPastSiblings(
  existing: readonly MatchableRow[],
  items: readonly IncomingItem[],
): boolean {
  const ids = new Set<string>();
  const held: Record<PlatformSide, Set<string>> = {
    bsc: new Set(),
    sportlots: new Set(),
  };
  for (const row of existing) {
    ids.add(row._id);
    for (const side of PLATFORM_SIDES) {
      for (const id of Object.values(row.platformData?.[side] ?? {})) {
        held[side].add(id);
      }
    }
  }
  return items.some(
    (item) =>
      (item.existingId !== undefined && !ids.has(item.existingId)) ||
      PLATFORM_SIDES.some((side) => {
        const id = item.ids[side];
        return id !== undefined && !held[side].has(id);
      }),
  );
}

/**
 * NEO-300 — are two rows the SAME marketplace set as far as their links can
 * tell? The grouping guard's test for "this row is already a parallel of that
 * insert".
 *
 * True only when the rows are linked on at least one common side AND, on
 * every side BOTH are linked on, they share an id (in any slot). One shared
 * id is not enough: NEO-137 made M:1 legal — one SportLots set can cover two
 * NB rows that BSC splits — so two rows holding the same SL id but different
 * BSC ids are two sets, and grouping one beside the other is a real operator
 * decision. A side only one row is linked on says nothing either way.
 *
 * Ids only: two rows with the same NAME under one insert are two NB rows as
 * far as this is concerned, and a card number is never consulted.
 */
export function indistinguishableByMarketplaceIds(
  a: SlotBearingRow,
  b: SlotBearingRow,
): boolean {
  let commonSides = 0;
  for (const side of PLATFORM_SIDES) {
    const ours = Object.values(a.platformData?.[side] ?? {});
    const theirs = new Set(Object.values(b.platformData?.[side] ?? {}));
    if (ours.length === 0 || theirs.size === 0) continue;
    commonSides++;
    if (!ours.some((id) => theirs.has(id))) return false;
  }
  return commonSides > 0;
}

export function planSelectorSync<TId extends string>(args: {
  existing: readonly MatchableRow<TId>[];
  items: readonly IncomingItem[];
  coveredSides?: readonly PlatformSide[];
  /** What the FETCH returned. Falls back to the items when absent — see above. */
  returnedIds?: { bsc?: readonly string[]; sportlots?: readonly string[] };
  /**
   * NEO-237 — which ids are placeholder links (see `PlaceholderIdPredicate`).
   * Consulted by tier 2 only. Tier 1 is untouched: a placeholder id never
   * arrives as an item (`fetchAggregatedOptions` routes it out first), and if
   * an old bundle ever sent it, the M:1 withhold is the right answer.
   */
  isPlaceholderId?: PlaceholderIdPredicate;
  /**
   * NEO-300 — rows in the same variant type's subtree that are NOT siblings
   * of this sync (see `loadVariantTypeSubtreeElsewhere`). Consulted only
   * AFTER the sibling tiers 0 and 1 miss outright, and only by NB row id
   * (tier 0) or marketplace id held in a slot (tier 1) — never by name, and
   * never by card number. A hit is `heldElsewhere`. Absent or empty → today's
   * rule exactly. A row that is also in `existing` is ignored here: a sibling
   * always wins.
   */
  elsewhereInSubtree?: readonly MatchableRow<TId>[];
}): SelectorSyncPlan<TId> {
  const { existing, items, isPlaceholderId } = args;

  const returnedIds = resolveReturnedIds(items, args.returnedIds);
  const coveredSides = effectiveCoveredSides(returnedIds, args.coveredSides);
  const ambiguities: MatchAmbiguity[] = [];

  // Sibling indexes.
  const byRowId = new Map<string, MatchableRow<TId>>();
  const byKey = new Map<string, Array<MatchableRow<TId>>>();
  const bySideId: Record<PlatformSide, Map<string, Array<MatchableRow<TId>>>> = {
    bsc: new Map(),
    sportlots: new Map(),
  };
  for (const row of existing) {
    byRowId.set(row._id, row);
    const key = selectorValueKey(row.value);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
    for (const side of PLATFORM_SIDES) {
      const map = row.platformData?.[side];
      if (!map) continue;
      for (const id of Object.values(map)) {
        const rows = bySideId[side].get(id);
        if (rows) {
          if (!rows.includes(row)) rows.push(row);
        } else {
          bySideId[side].set(id, [row]);
        }
      }
    }
  }

  // NEO-300 — the same two identity indexes over the rest of the variant
  // type's subtree. No name index, deliberately: a same-named row under a
  // different parent is a different set as far as NB knows.
  const elsewhereById = new Map<string, MatchableRow<TId>>();
  const elsewhereBySideId = indexBySideId(
    (args.elsewhereInSubtree ?? []).filter((row) => {
      if (byRowId.has(row._id) || elsewhereById.has(row._id)) return false;
      elsewhereById.set(row._id, row);
      return true;
    }),
  );

  /** A row already claimed by another item in this same batch. */
  const claimed = new Set<TId>();
  const outcomes: Array<MatchOutcome<TId> | undefined> = items.map(
    () => undefined,
  );
  /** A tier-1 problem that must still withhold the item if tier 2 finds nothing. */
  const carriedReason: Array<string | undefined> = items.map(() => undefined);

  // ── Pass 1 — identity: tier 0, then tier 1 ─────────────────────────────
  //
  // NEO-211 F5: identity claims are resolved for the WHOLE batch before any
  // name match is attempted. Interleaving them made the result depend on item
  // ORDER — a name match earlier in the list could claim the very row that a
  // later item's marketplace id identified, and the id is the stronger signal
  // by construction.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.existingId) {
      const row = byRowId.get(item.existingId);
      if (row) {
        if (claimed.has(row._id)) {
          // NEO-211 F2: withhold, do NOT insert. An insert here creates a
          // second sibling with this row's name, and from then on tier 2 at
          // this parent withholds forever — one bad batch permanently
          // disables name matching for that set.
          const reason = "existingId already claimed in this batch";
          ambiguities.push({ item: item.value, reason });
          outcomes[i] = { kind: "withheld", reason };
        } else {
          claimed.add(row._id);
          outcomes[i] = { kind: "matched", existingId: row._id, tier: 0 };
        }
        continue;
      }
      // Not a sibling at this (level, parentId) — a stale id, a deleted row,
      // or a client aiming somewhere it has no business aiming. Fall through
      // to the tiers that derive identity from data we own.
      ambiguities.push({
        item: item.value,
        reason: "existingId is not a sibling at this level/parent",
      });
    }

    const tier1 = new Set<MatchableRow<TId>>();
    for (const side of PLATFORM_SIDES) {
      const id = item.ids[side];
      if (!id) continue;
      const holders = bySideId[side].get(id);
      if (!holders || holders.length === 0) continue;
      if (holders.length > 1) {
        // NEO-137 M:1 is legal, so this is not corruption — it just is not
        // evidence of which row the update belongs to. NEO-211 F7: reported
        // whether or not the OTHER side goes on to resolve cleanly, because
        // an id sitting on two rows is worth knowing about either way.
        const reason = `${side} id is held by ${holders.length} sibling rows`;
        ambiguities.push({ item: item.value, reason });
        carriedReason[i] = reason;
        continue;
      }
      tier1.add(holders[0]);
    }

    if (tier1.size === 1) {
      const row = [...tier1][0];
      if (claimed.has(row._id)) {
        const reason = "two incoming items resolve to one row by marketplace id";
        ambiguities.push({ item: item.value, reason });
        outcomes[i] = { kind: "withheld", reason };
      } else {
        claimed.add(row._id);
        outcomes[i] = { kind: "matched", existingId: row._id, tier: 1 };
      }
      continue;
    }
    if (tier1.size > 1) {
      // BSC says row A, SportLots says row B. Upstream believes these are one
      // set; NB has them as two. Merging rows is not something a sync gets to
      // decide, and picking a side would silently move a marketplace link.
      const reason = "bsc and sportlots ids resolve to different rows";
      ambiguities.push({ item: item.value, reason });
      carriedReason[i] = reason;
    }

    // NEO-300 — no sibling holds anything this item names. Before it can
    // become an insert, ask whether the row already lives elsewhere in the
    // variant type's subtree. Only on a CLEAN sibling miss: a sibling-level
    // ambiguity is already a withhold, and a sibling hit always wins.
    if (tier1.size === 0 && carriedReason[i] === undefined) {
      const elsewhere = heldElsewhereOutcome(
        item,
        elsewhereById,
        elsewhereBySideId,
      );
      if (elsewhere) {
        if (elsewhere.kind === "withheld") {
          ambiguities.push({ item: item.value, reason: elsewhere.reason });
        }
        outcomes[i] = elsewhere;
      }
    }
  }

  // ── Pass 2 — name, over whatever pass 1 left unclaimed ─────────────────
  for (let i = 0; i < items.length; i++) {
    if (outcomes[i]) continue;
    const item = items[i];
    let withheld = carriedReason[i];

    const sameName = byKey.get(selectorValueKey(item.value)) ?? [];
    const sidesCarried = PLATFORM_SIDES.filter((s) => item.ids[s]);

    if (sameName.length > 1) {
      // Two siblings already fold to one name. Nothing here can say which of
      // them upstream means, and picking would attach a marketplace id to a
      // coin-flip.
      withheld = `${sameName.length} sibling rows share this name`;
      ambiguities.push({ item: item.value, reason: withheld });
    } else if (sameName.length === 1) {
      const row = sameName[0];
      if (sidesCarried.length === 0) {
        // NEO-211 F6: an item with no marketplace id at all has nothing to
        // attach, so a name match would be a pure no-op that nonetheless
        // CLAIMS the row — hiding it from a later item that does carry its id,
        // and (on the reconciler path) letting a stray modal line silently
        // adopt an existing set. The only legitimately id-less rows are custom
        // ones, and those arrive through addCustomSelectorOption, not here.
        withheld = "item carries no marketplace id to attach";
        ambiguities.push({ item: item.value, reason: withheld });
      } else if (
        !sidesCarried.every((side) =>
          isSideFreeForNameMatch(row, side, returnedIds[side], isPlaceholderId),
        )
      ) {
        // The name matches but the row is currently, legitimately bound to a
        // different id upstream still lists. Inserting a same-named sibling
        // would break the one-name-per-parent rule every picker relies on.
        withheld = "name matches a row already linked to a different live id";
        ambiguities.push({ item: item.value, reason: withheld });
      } else if (claimed.has(row._id)) {
        withheld = "row already claimed in this batch";
        ambiguities.push({
          item: item.value,
          reason: "two incoming items fold to one existing row",
        });
      } else {
        claimed.add(row._id);
        // NEO-237 — say which sides were placeholders, so the store can
        // count the upgrade instead of reporting a re-slug. Only when there
        // is one: the outcome shape for every other match is unchanged.
        const placeholderSides = placeholderSidesFor(
          row,
          sidesCarried,
          isPlaceholderId,
        );
        outcomes[i] = {
          kind: "matched",
          existingId: row._id,
          tier: 2,
          ...(placeholderSides.length > 0 ? { placeholderSides } : {}),
        };
        continue;
      }
    }

    outcomes[i] = withheld ? { kind: "withheld", reason: withheld } : { kind: "insert" };
  }

  return {
    outcomes: outcomes as Array<MatchOutcome<TId>>,
    coveredSides,
    returnedIds,
    ambiguities,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Unlink (NEO-211 D)
// ───────────────────────────────────────────────────────────────────────────

export type UnlinkResult = {
  /** The marketplace id that was detached. */
  id: string;
  slot: string;
  platformData: PlatformDataShape;
  platformLabels: {
    bsc?: Record<string, string>;
    sportlots?: Record<string, string>;
  };
  platformFacets: PlatformFacetShape;
  primaryPlatformId: { bsc?: string; sportlots?: string } | undefined;
};

/**
 * Detach the PRIMARY slot on `side` when the id it holds did not come back.
 *
 * Primary ONLY. Operator extras are ids a human deliberately attached, often
 * from a different BSC facet than the one this level's fetch queries (NEO-189
 * files a `setName` slug on a variantType row on purpose), so "this fetch did
 * not mention it" is not evidence upstream dropped it. Their `platformFacets`
 * entries stay with them.
 *
 * Returns `undefined` when there is nothing to do — which is what keeps the
 * NEO-85 write-if-changed guard honest: an unchanged re-sync produces no
 * unlink, so no patch, so no `lastUpdated` bump.
 */
export function unlinkStalePrimary(
  row: SlotBearingRow,
  side: PlatformSide,
  returnedIds: Set<string>,
): UnlinkResult | undefined {
  const slot = primarySlot(row, side);
  if (!slot) return undefined;
  const id = idForSlot(row, side, slot);
  if (id === undefined) return undefined;
  if (returnedIds.has(id)) return undefined;

  const detached = detachSlot(row, side, slot);
  const nextPrimary: { bsc?: string; sportlots?: string } = {
    ...(row.primaryPlatformId ?? {}),
  };
  delete nextPrimary[side];

  return {
    id,
    slot,
    platformData: detached.platformData,
    platformLabels: detached.platformLabels,
    platformFacets: detached.platformFacets,
    primaryPlatformId:
      Object.keys(nextPrimary).length > 0 ? nextPrimary : undefined,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Declined upstream labels (NEO-211 C)
// ───────────────────────────────────────────────────────────────────────────

export type DeclinedUpstreamLabels = { bsc?: string; sportlots?: string };

/**
 * A decline is a decision about ONE label, so it has to be forgotten the
 * moment the marketplace says something new. Stored normalised (and compared
 * normalised) so a re-cased "TOPPS" does not re-open a decision the operator
 * already made about "Topps".
 *
 * Returns the next value, or `undefined` when nothing changes.
 */
export function clearDeclinedIfLabelChanged(
  current: DeclinedUpstreamLabels | undefined,
  side: PlatformSide,
  newLabel: string | undefined,
): { changed: boolean; next: DeclinedUpstreamLabels | undefined } {
  const declined = current?.[side];
  if (declined === undefined) return { changed: false, next: current };
  if (newLabel !== undefined && selectorValueKey(newLabel) === declined) {
    return { changed: false, next: current };
  }
  const next: DeclinedUpstreamLabels = { ...(current ?? {}) };
  delete next[side];
  return {
    changed: true,
    next: Object.keys(next).length > 0 ? next : undefined,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The one validated rename (NEO-211 C/E/F)
// ───────────────────────────────────────────────────────────────────────────

export type RenamePlan =
  | { ok: false; reason: "invalid" | "clash"; message: string }
  | { ok: true; unchanged: true }
  | {
      ok: true;
      unchanged: false;
      value: string;
      features?: Record<string, string>;
      sportConfig?: ReturnType<typeof sportConfigDefaultsFor>;
    };

/**
 * Everything that has to be true before `selectorOptions.value` is written,
 * in one place.
 *
 * Three call sites write a display value — `renameSelectorOption` (an operator
 * typed it), `applySelectorSyncSuggestions` accept (a marketplace label the
 * operator approved), and the reconciliation modal's tier-0 RENAME (a title
 * edited in the modal). Before NEO-211 only the first had the sibling-clash
 * check and the feature re-derivation. A guard that lives on one of three
 * doors is not a guard.
 *
 * `siblings` must be the caller's IN-TRANSACTION working set, not a stale
 * read: two accepted suggestions in one call that fold to the same name have
 * to see each other, or the first write makes the second one legal.
 *
 * Pure — it decides, the caller patches.
 */
export function planValueRename(args: {
  row: {
    _id: string;
    level: string;
    value: string;
    features?: Record<string, string>;
    sportConfig?: unknown;
    /**
     * NEO-294 — REQUIRED, and required on purpose. The brand-unknown refusal
     * below can only fire if the caller hands over the row's NB role flags,
     * and an optional field is how a fourth call site would come to bypass a
     * guard that three of them honour. `undefined` is a legitimate answer for
     * a row that carries no metadata; forgetting to ask is not.
     */
    metadata: { isBrandUnknown?: boolean } | null | undefined;
  };
  nextValue: string;
  siblings: ReadonlyArray<{ _id: string; value: string }>;
  /**
   * NEO-294 — the internal escape hatch for the ONE rename that must still
   * land on a flagged row: `backfillBrandPrefixAndUnknownName` renaming the
   * legacy "All Brands"-named bucket to "Unknown". Never set from a path an
   * operator or a marketplace label can reach.
   */
  allowBrandUnknownRename?: boolean;
}): RenamePlan {
  const { row, siblings } = args;

  const checked = checkSelectorValue(args.nextValue);
  if (!checked.ok) {
    return { ok: false, reason: "invalid", message: checked.reason };
  }
  const trimmed = checked.value;

  // NEO-237 — the third door. A rename is how a row would come to wear the
  // view's name after the create path refused it, and a marketplace label
  // accepted through `applySelectorSyncSuggestions` is a rename too.
  if (row.level === "manufacturer" && isAllBrandsViewName(trimmed)) {
    return { ok: false, reason: "invalid", message: ALL_BRANDS_VIEW_REFUSAL };
  }

  // NEO-294 — the year's Unknown row is frozen, whatever it is being renamed
  // TO. Checked before the no-op branch below so "rename Unknown to Unknown"
  // is refused rather than quietly reported as unchanged: the answer to
  // "can I rename this row" must not depend on what was typed.
  if (isBrandUnknownRow(row.metadata) && args.allowBrandUnknownRename !== true) {
    return {
      ok: false,
      reason: "invalid",
      message: BRAND_UNKNOWN_RENAME_REFUSAL,
    };
  }

  const key = selectorValueKey(trimmed);
  if (key === selectorValueKey(row.value)) {
    // A no-op rename (or a case-only change to the same word) should not churn
    // `lastUpdated` — NEO-85: a redundant patch invalidates every query
    // watching this row and reflows the SetSelector columns for nothing.
    if (trimmed === row.value) return { ok: true, unchanged: true };
  } else {
    // Two rows under one parent must not share a display value, or the drill
    // utils and the pickers cannot tell them apart.
    const clash = siblings.find(
      (o) => o._id !== row._id && selectorValueKey(o.value) === key,
    );
    if (clash) {
      return {
        ok: false,
        reason: "clash",
        message: `Another ${row.level} here is already called "${clash.value}"`,
      };
    }
  }

  // `features` are derived FROM the value at insert, so a rename has to
  // recompute them or the row keeps features derived from a name it no longer
  // has. Existing explicitly-set keys win, matching insert-time precedence
  // (parent features < own-level derived).
  const rederived = deriveOwnLevelFeatures(
    row.level as Parameters<typeof deriveOwnLevelFeatures>[0],
    trimmed,
  );
  const features = { ...(row.features ?? {}), ...rederived };

  // A sport's config is seeded from its display value at creation. Backfill on
  // rename ONLY when the row has none — never overwrite, so an operator's
  // edits survive, and never clear, so renaming "Baseball" to "MLB Baseball"
  // keeps the SKU code and QIDs it already had.
  const sportConfig =
    row.level === "sport" && !row.sportConfig
      ? sportConfigDefaultsFor(trimmed)
      : undefined;

  return {
    ok: true,
    unchanged: false,
    value: trimmed,
    ...(Object.keys(features).length > 0 ? { features } : {}),
    ...(sportConfig ? { sportConfig } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// NEO-237 — Sync Sets routing, BSC phase (D8)
// ───────────────────────────────────────────────────────────────────────────

/** A marketplace set as the adapter returns it: display label + its id. */
export type MarketplaceSetEntry = { value: string; platformValue: string };

/**
 * What the router needs to know about one manufacturer row under the year.
 * Read off `metadata`, never off `value`: a row lacking `setNamePrefix`
 * claims nothing by prefix (schema.ts), and a flagged row is never a prefix
 * candidate — it is where the sets that match no brand go.
 */
export type BrandRouteManufacturer<TId extends string = string> = {
  _id: TId;
  setNamePrefix?: string;
  isBrandUnknown?: boolean;
};

/** A setName row under some manufacturer of the year that holds a BSC id. */
export type BscSetHolder<TId extends string = string> = {
  rowId: TId;
  parentId: TId;
  /**
   * The row's OWN NB display value — the only name allowed to decide where
   * this row goes (product invariants 3 and 4). Required, not optional: a
   * holder without it would silently fall back to the marketplace's name,
   * which is the bug this field exists to close. See `routeBscSets`.
   */
  value: string;
  /**
   * NEO-294 — `metadata.brandSetByOperator`: an operator put this row where
   * it is. Read only to REFUSE a move; nothing else about the row changes.
   */
  setByOperator?: boolean;
};

/**
 * NEO-294 — a brand from the known list that this year does not have yet,
 * and the sets that asked for it.
 *
 * DATA, not an action: `routeBscSets` is pure and cannot create a row, so it
 * reports the brand NAME it wants and the caller mints it (`ensureBrandRow`)
 * before routing runs again with that row in hand. The name is an NB
 * constant from `knownBrands.ts`, never a marketplace value.
 */
export type KnownBrandRequest = {
  /** The entry from `KNOWN_BRANDS`, exactly as spelled there. */
  brand: string;
  /** The BSC sets that matched it — reported so the caller can say how many. */
  sets: MarketplaceSetEntry[];
};

export type BscSetRoutePlan<TId extends string = string> = {
  /** Sets to store under each BRAND (id-first; see below). */
  buckets: Map<TId, MarketplaceSetEntry[]>;
  /** Sets that matched no brand: the Unknown bucket, whether or not a row for it exists yet. */
  unknown: MarketplaceSetEntry[];
  /**
   * Rows to re-home Unknown → brand BEFORE the buckets are stored, so the
   * brand's per-bucket store finds them as siblings and matches by id rather
   * than inserting a second copy. Only ever Unknown → brand.
   */
  moves: Array<{ rowId: TId; fromId: TId; toId: TId }>;
  /**
   * NEO-294 — the known brands this year would need for the sets that
   * otherwise land in Unknown, deduped and in first-seen order. Empty unless
   * a `matchKnownBrand` was passed in. The sets counted here are ALSO in
   * `unknown`: until the brand row exists there is nowhere else to put them,
   * and the caller re-routes once it does.
   */
  knownBrandRequests: KnownBrandRequest[];
};

/**
 * File one flat BSC set list under the year's manufacturers.
 *
 * ID FIRST, PREFIX SECOND, UNKNOWN THIRD — and a move only ever goes Unknown
 * → brand:
 *
 *   1. a setName row ANYWHERE under the year already holds the set's BSC id
 *      (`holdersByBscId`, built from every manufacturer's sets, not one
 *      parent's) →
 *        • under a brand: that brand's bucket, whatever the prefix says. An
 *          operator's placement, or a prior sync's, is the linkage; the name
 *          is not consulted. Several holders under brands (NEO-137 M:1) →
 *          the first brand holder's bucket, and nothing moves.
 *        • under Unknown, and THE ROW'S OWN NB NAME prefix-matches a brand →
 *          that row is re-homed to the brand (`moves`) and the set goes in
 *          the brand's bucket. Under Unknown with no matching brand →
 *          Unknown, in place.
 *   2. no holder → the LONGEST matching prefix wins ("Upper Deck" before
 *      "Upper"), else Unknown.
 *
 * Before NEO-237 tier 1 matched only within one parent, so a set an operator
 * had filed under a brand — or that a brand's creation had re-homed — was
 * re-inserted under whichever bucket the prefix chose. This is the fix.
 *
 * WHOSE NAME DECIDES — the rule that keeps rung 1 legal (NEO-294 audit,
 * condition 1). `set.value` is the MARKETPLACE's name for the set;
 * `holder.value` is the NB row's own. They are used for two different jobs
 * and must never be swapped:
 *
 *   • A SET NB ALREADY HAS A ROW FOR (rung 1) is routed by the HOLDER's
 *     value — every `brandByPrefix` and `matchKnownBrand` on that rung reads
 *     `holder.value`. NB owns the row; a marketplace value may not move it
 *     after creation (product invariants 3 and 4). The door this closes:
 *     an operator renames a set under Unknown from "Choice Biloxi Shuckers"
 *     to "Biloxi Shuckers Team Set" (ordinary set rows are renameable —
 *     NEO-211), the marketplace keeps returning its old name, and routing on
 *     `set.value` would mint "Choice" and re-parent the operator's row on
 *     the strength of a name NB no longer uses. Upstream renames are
 *     operator-reviewed suggestions, never silent writes.
 *   • A SET NB HAS NO ROW FOR (rung 2) is routed by `set.value`, because
 *     there is no NB name yet: this is creation-time derivation from
 *     marketplace data, which invariant 2(a) allows and which is the whole
 *     point of the known-brands list.
 *
 *   Each Unknown holder is judged on ITS OWN name, so a second row holding
 *   the same BSC id is never moved on a sibling's name either. Do NOT
 *   "simplify" rung 1 back to `set.value` — it type-checks, the tests that
 *   name a renamed row are the only thing that catches it, and the failure
 *   is silent data movement.
 *
 *   KNOWN, AND DELIBERATE: with SEVERAL Unknown holders of one BSC id whose
 *   names match DIFFERENT brands, each holder is re-homed to the brand its
 *   own name matched, but the SET is bucketed under `target` — the FIRST
 *   holder's brand. So the set is stored beside one of them while a sibling
 *   row has moved to another brand. The alternative is worse: one BSC set
 *   list entry is one set, and bucketing it under several brands would store
 *   a copy of it under each. Every row keeps its id, its cards and its
 *   linkage either way; what is arbitrary is only which brand's bucket the
 *   incoming id/label lands in. Do not "fix" this by changing behaviour
 *   without asking — an M:1 fan-out across brands is a data shape an
 *   operator has to see, not one a router should quietly pick a winner for.
 *
 * NEO-294 adds two more rules AROUND that ladder, both on the Unknown rung:
 *
 *   • AN OPERATOR'S PLACEMENT IS FINAL. A holder carrying `setByOperator`
 *     never moves and its set is bucketed where the row already is — under
 *     Unknown, in place. It is checked BEFORE the prefix, so the operator
 *     outranks a brand's prefix and the known list alike. Bucketing it
 *     anywhere else would insert a second copy beside the row it named.
 *   • THE KNOWN LIST IS THE LAST WORD BEFORE UNKNOWN. A set no NB brand
 *     claims is offered to `matchKnownBrand` — by the holder's name on rung
 *     1 and by the marketplace's on rung 2, per "whose name decides" above.
 *     A hit is reported in `knownBrandRequests` and the set ALSO stays in
 *     `unknown` for this pass, because the brand row does not exist yet.
 *     The caller mints the requested brands and calls this function again
 *     with them in `manufacturers`, where rung 2 files the sets and the
 *     Unknown holders become ordinary prefix moves. One function decides
 *     placement, once.
 *
 * Pure: it reads rows and returns a plan; the action re-homes and stores.
 * `matchKnownBrand` is injected rather than imported so this module stays
 * free of `knownBrands.ts` (which imports the matcher from here) and so a
 * test can route against a list of its own.
 */
export function routeBscSets<TId extends string>(args: {
  sets: readonly MarketplaceSetEntry[];
  manufacturers: readonly BrandRouteManufacturer<TId>[];
  holdersByBscId: ReadonlyMap<string, readonly BscSetHolder<TId>[]>;
  /** NEO-294 — `knownBrands.matchKnownBrand`; absent means "no known list". */
  matchKnownBrand?: (setName: string) => string | undefined;
}): BscSetRoutePlan<TId> {
  const unknownIds = new Set<TId>();
  // Prefix candidates, longest folded prefix first, so the first match is the
  // most specific one. Flagged rows and rows without a prefix never appear.
  const candidates: Array<{ _id: TId; prefix: string }> = [];
  for (const mfr of args.manufacturers) {
    if (mfr.isBrandUnknown === true) {
      unknownIds.add(mfr._id);
      continue;
    }
    const prefix = mfr.setNamePrefix?.trim();
    if (prefix) candidates.push({ _id: mfr._id, prefix });
  }
  candidates.sort(
    (a, b) => selectorValueKey(b.prefix).length - selectorValueKey(a.prefix).length,
  );
  const brandByPrefix = (label: string): TId | undefined =>
    candidates.find((c) => matchesBrandPrefix(label, c.prefix))?._id;

  const buckets = new Map<TId, MarketplaceSetEntry[]>();
  const unknown: MarketplaceSetEntry[] = [];
  const moves: BscSetRoutePlan<TId>["moves"] = [];
  const moved = new Set<TId>();
  const bucket = (id: TId, set: MarketplaceSetEntry) => {
    const list = buckets.get(id);
    if (list) list.push(set);
    else buckets.set(id, [set]);
  };

  // NEO-294 — requested known brands, deduped on the folded name so two
  // spellings of one entry could never ask for two rows. First-seen order.
  const requests = new Map<string, KnownBrandRequest>();
  const requestKnownBrand = (brand: string, set: MarketplaceSetEntry) => {
    const key = selectorValueKey(brand);
    const existing = requests.get(key);
    if (existing) existing.sets.push(set);
    else requests.set(key, { brand, sets: [set] });
  };

  for (const set of args.sets) {
    const holders = args.holdersByBscId.get(set.platformValue) ?? [];
    const brandHolder = holders.find((h) => !unknownIds.has(h.parentId));
    if (brandHolder) {
      bucket(brandHolder.parentId, set);
      continue;
    }
    if (holders.length > 0) {
      // Every holder sits under Unknown.
      //
      // NEO-294 — unless an operator put one of them there, in which case
      // this set is theirs and neither the prefix nor the known list gets a
      // vote. The row stays; the set is bucketed nowhere but Unknown.
      if (holders.some((h) => h.setByOperator === true)) {
        unknown.push(set);
        continue;
      }
      // NEO-294 condition 1 — NB already has a row for this set, so the name
      // that decides where the row goes is the ROW'S, not the marketplace's
      // (see "whose name decides" above). Each holder is judged on its own
      // value; the set is bucketed under the first brand any of them names.
      let target: TId | undefined;
      for (const h of holders) {
        const to = brandByPrefix(h.value);
        if (to === undefined) continue;
        if (target === undefined) target = to;
        if (moved.has(h.rowId)) continue;
        moved.add(h.rowId);
        moves.push({ rowId: h.rowId, fromId: h.parentId, toId: to });
      }
      if (target === undefined) {
        // No holder's own name matches an existing brand; the known list is
        // asked the same question with the same NB names.
        for (const h of holders) {
          const known = args.matchKnownBrand?.(h.value);
          if (known !== undefined) requestKnownBrand(known, set);
        }
        unknown.push(set);
        continue;
      }
      bucket(target, set);
      continue;
    }
    const target = brandByPrefix(set.value);
    if (target !== undefined) {
      bucket(target, set);
      continue;
    }
    const known = args.matchKnownBrand?.(set.value);
    if (known !== undefined) requestKnownBrand(known, set);
    unknown.push(set);
  }

  return { buckets, unknown, moves, knownBrandRequests: [...requests.values()] };
}
// ───────────────────────────────────────────────────────────────────────────
// NEO-237 — Sync Sets classification, SportLots phase (D11)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Bound on what one Sync Sets offers from SportLots for one brand scope.
 *
 * NEO-306 — every SportLots-only name the classifier keeps becomes an ENTRY
 * in that brand's review (`slSetReviews`, `convex/slSetReview.ts`), where the
 * operator files it as its own set or under one of the brand's sets' variant
 * types. So this caps ENTRIES, not roots: a SportLots year lists ~2,500 sets,
 * and a brand with more than 200 new names in one sync is a data-quality
 * problem to look at, not a 200+-row dialog. The rest are counted and are
 * the first thing the next sync reaches once these are covered.
 */
export const MAX_SL_SETS_PER_SYNC = 200;

/**
 * NEO-306 — a SportLots set id is a short slug; anything longer is not one.
 * `routeSlSets` drops (and counts) an entry whose id is empty or longer, so
 * the review's own assert (`replaceScope`) stays a backstop and one bad id
 * can never abort a whole Sync Sets.
 */
export const MAX_SL_ID_LENGTH = 64;

export type SlSetEntry = { id: string; label: string };

export type SlSetRoutePlan = {
  /** Entries whose id is already attached somewhere under the brand. */
  covered: number;
  /** Entries hidden as a variant of a set NB already has (year-wide). */
  variants: number;
  /**
   * The SportLots-only names for the brand's review, one entry each, sorted
   * by folded label (so "All-America" sits right above "All-America Game
   * Autos"), capped at `MAX_SL_SETS_PER_SYNC`.
   */
  entries: SlSetEntry[];
  /** Entries past `MAX_SL_SETS_PER_SYNC`, dropped after the sort. */
  truncated: number;
  /** Entries dropped because their label exceeds `MAX_SLOT_LABEL_LENGTH`. */
  unnameable: number;
  /**
   * NEO-306 — entries dropped because their SportLots id is empty or longer
   * than `MAX_SL_ID_LENGTH`: not an id NB could store or list against.
   */
  badIds: number;
};

/**
 * The folded name keys a year's setName rows answer to, for the "variant of
 * a known set" test. BOTH forms per row: its `value`, and its brand's
 * `setNamePrefix + " " + value`. NB files a BSC-synced set as "Topps Chrome"
 * under Topps and a hand-built one as "Chrome"; a SportLots label that lands
 * under Unknown's full-year list reads "Topps Chrome Sepia Refractor", and
 * either key has to hide it.
 */
export function knownSetNameKeys(
  rows: ReadonlyArray<{ value: string; brandPrefix?: string }>,
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = selectorValueKey(row.value);
    if (!key) continue;
    keys.add(key);
    const prefix = row.brandPrefix?.trim();
    if (prefix) keys.add(selectorValueKey(`${prefix} ${row.value}`));
  }
  return keys;
}

/**
 * Classify one brand scope's SportLots set list.
 *
 *   covered  — the entry's SL id is attached on any row under the brand's
 *              sets (the caller walks setName → variantType → insert →
 *              parallel). Wins over everything: a set NB already links needs
 *              no offer, however it is named.
 *   variant  — a set NB already has, year-wide, EQUALS or word-boundary-
 *              PREFIXES the entry's label (`knownSetNameKeys`), so the entry
 *              is that set's variant, not a new set. Not surfaced — the
 *              Inserts sync under that set finds it. Two tests:
 *
 *              EQUALS is tested on the label as the adapter returned it AND
 *              re-prefixed with the scope's own prefix: under a real brand
 *              the adapter strips "Topps " off "Topps Chrome", and NB's set
 *              may be called either "Chrome" or "Topps Chrome".
 *
 *              PREFIXES is tested with the SCOPE PREFIX STRIPPED FROM BOTH
 *              SIDES: the entry's label minus the prefix (a no-op when the
 *              adapter already stripped it) against each known name minus the
 *              same prefix. A known set contributes a prefix-hider only from
 *              what remains after the brand prefix, and a known set that IS
 *              the brand prefix (a flagship filed under its brand's own name:
 *              "Topps" under Topps, "Bowman" under Bowman) leaves nothing —
 *              it hides an exact match and nothing by prefix. Without this
 *              the flagship hid the whole brand: "Topps" prefixed the
 *              re-prefixed form of every entry ("Topps Heritage", "Topps
 *              Finest", …) the moment the Topps row existed.
 *   entry    — everything else: a SportLots-only name, ONE review entry each
 *              (NEO-306). Nothing is written here or by the caller's sync:
 *              the operator decides in the brand's review whether "Bowman
 *              Gold" is its own set or a parallel of Bowman. That replaced
 *              NEO-305's flagship absorb, which counted such names as the
 *              flagship's parallels and wrote them nowhere, and NEO-237's
 *              roots-become-sets, which wrote every one of them as a set.
 *              Entries are sorted by folded label BEFORE the cap, so two
 *              syncs over the same list keep the same window: what was cut
 *              off last time is exactly what the next sync (with last time's
 *              entries now covered) reaches first.
 *
 * Pure. `entries` are the adapter's (already prefix-stripped) labels: the
 * whole-word, case-insensitive strip of `stripMatchedBrandPrefix` for a
 * via-All-Brands scope, `stripBrandPrefixForLabel`'s case-sensitive one for a
 * real brand's own list, and no strip at all for Unknown (no `scopePrefix`).
 * The strip repeated here is the folded form of the first, so a label that
 * arrives stripped is unchanged and one the case-sensitive strip missed is
 * still judged on what follows the brand.
 */
export function routeSlSets(args: {
  entries: readonly SlSetEntry[];
  coveredSlIds: ReadonlySet<string>;
  knownSetNameKeys: ReadonlySet<string>;
  /** The scope's `setNamePrefix`; absent for Unknown (no re-prefixed form). */
  scopePrefix?: string;
}): SlSetRoutePlan {
  const prefix = args.scopePrefix?.trim();
  const foldedPrefix = prefix ? selectorValueKey(prefix) : "";
  // The folded key minus the scope prefix as a whole word; "" when the key
  // IS the prefix. Unlike `stripMatchedBrandPrefix` this DOES strip to
  // nothing, because "nothing remains" is the signal the prefix test needs.
  const stripScopePrefix = (foldedKey: string): string => {
    if (!foldedPrefixMatches(foldedKey, foldedPrefix)) return foldedKey;
    return trimLeadingSeparators(foldedKey.slice(foldedPrefix.length));
  };
  // Keys come folded from `knownSetNameKeys`; folded again here so a caller
  // that built the set by hand cannot make the pairwise test case-sensitive.
  const known = [...args.knownSetNameKeys].map(selectorValueKey).filter(Boolean);
  const knownSet = new Set(known);
  // The prefix-hiders: what remains of each known name after the scope
  // prefix. The flagship named after its brand contributes nothing here.
  const knownHiders = [...new Set(known.map(stripScopePrefix))].filter(Boolean);
  const isVariantOfKnown = (label: string): boolean => {
    const key = selectorValueKey(label);
    if (knownSet.has(key)) return true;
    if (prefix && knownSet.has(selectorValueKey(`${prefix} ${label}`))) return true;
    // A label that IS the brand name (kept whole by the adapter's strip) has
    // nothing after the prefix to test; it is only ever an exact match.
    const stripped = stripScopePrefix(key);
    if (!stripped) return false;
    for (const hider of knownHiders) {
      if (foldedPrefixMatches(stripped, hider)) return true;
    }
    return false;
  };

  let covered = 0;
  let variants = 0;
  let unnameable = 0;
  let badIds = 0;
  const fresh: Array<{ id: string; label: string; key: string }> = [];
  const seenIds = new Set<string>();
  for (const entry of args.entries) {
    // Beside the label cap: an id no slot can carry is dropped and counted
    // here, before anything downstream asserts on it.
    if (!entry.id || entry.id.length > MAX_SL_ID_LENGTH) {
      badIds++;
      continue;
    }
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    if (args.coveredSlIds.has(entry.id)) {
      covered++;
      continue;
    }
    const label = entry.label.trim();
    if (!label) continue;
    if (label.length > MAX_SLOT_LABEL_LENGTH) {
      unnameable++;
      continue;
    }
    if (isVariantOfKnown(label)) {
      variants++;
      continue;
    }
    fresh.push({ id: entry.id, label, key: selectorValueKey(label) });
  }

  // Folded label, then id: a stable total order, so the capped window is the
  // same across syncs and a name sits directly above its longer siblings.
  fresh.sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const kept = fresh.slice(0, MAX_SL_SETS_PER_SYNC);
  return {
    covered,
    variants,
    entries: kept.map(({ id, label }) => ({ id, label })),
    truncated: fresh.length - kept.length,
    unnameable,
    badIds,
  };
}
