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
 *      the item carries — either no id at all on that side, or an id upstream
 *      did not return this run (a re-slug: same set, new id). Matching a stale
 *      row here is what heals a BSC re-slug through `setPrimarySlotId`, which
 *      reuses the slot KEY so every card on it keeps resolving.
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
  return { ok: true, value: trimmed };
}

/** Throwing wrapper for the paths whose contract is an error to the operator. */
export function assertSelectorValue(raw: string): string {
  const checked = checkSelectorValue(raw);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.value;
}

// ───────────────────────────────────────────────────────────────────────────
// variantType protection (NEO-211 F)
// ───────────────────────────────────────────────────────────────────────────

export const VARIANT_TYPE_RENAME_REFUSED = "VARIANT_TYPE_RENAME_REFUSED";
export const VARIANT_TYPE_RENAME_MESSAGE =
  "Variant type names come from the marketplace sync and cannot be renamed";

/**
 * A non-custom `variantType` row's DISPLAY VALUE is load-bearing, not
 * cosmetic: SetSelector derives terminal-column/Base-mapping behaviour from
 * it, `getBaseVariantBySet` looks Base up by name, and the BSC checklist fetch
 * derives its `variant` facet from the value (adapters/buysportscards.ts). So
 * every one of Base / Insert / Parallel / Promo is a protected string, not
 * only "Base".
 *
 * Custom variantType rows are NB's own invention with no marketplace meaning,
 * so they stay renameable (and `.maestro/rename-selector-option.yaml` renames
 * a custom row).
 *
 * Shared by all three value-writing paths so the refusal cannot be reached
 * around by whichever one a future feature happens to use.
 */
export function refusesValueRename(row: {
  level: string;
  isCustom?: boolean;
}): boolean {
  return row.level === "variantType" && row.isCustom !== true;
}

// ───────────────────────────────────────────────────────────────────────────
// Matching
// ───────────────────────────────────────────────────────────────────────────

export type MatchableRow<TId extends string = string> = SlotBearingRow & {
  _id: TId;
  value: string;
  isCustom?: boolean;
};

export type IncomingItem = {
  value: string;
  /** Marketplace ids on the wire — the client knows nothing about slots. */
  ids: Partial<Record<PlatformSide, string>>;
  /** Tier 0, reconciled items only. Verified against the sibling snapshot. */
  existingId?: string;
};

export type MatchOutcome<TId extends string = string> =
  | { kind: "matched"; existingId: TId; tier: 0 | 1 | 2 }
  | { kind: "insert" }
  | { kind: "withheld"; reason: string };

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
 * Which sides this run may unlink on.
 *
 * **Absent `coveredSides` means unlink NOTHING.** A Convex deploy is a hard
 * cutover with old SPA bundles live for minutes afterwards, and an old bundle
 * calling this store during a SportLots outage carries no way to say "SL was
 * not fetched". Defaulting to "infer it from the items" would make that bundle
 * strip SportLots linkage off every row it touched. Silence means silence.
 *
 * Coverage is then NARROWING-only: a side the caller claims to cover but that
 * carries no id anywhere in the batch is dropped, because a batch with no ids
 * on a side is not evidence that upstream stopped listing anything.
 */
export function effectiveCoveredSides(
  items: readonly IncomingItem[],
  declared: readonly PlatformSide[] | undefined,
): PlatformSide[] {
  if (!declared || declared.length === 0) return [];
  const present = new Set<PlatformSide>();
  for (const item of items) {
    for (const side of PLATFORM_SIDES) {
      if (item.ids[side]) present.add(side);
    }
  }
  const out: PlatformSide[] = [];
  for (const side of PLATFORM_SIDES) {
    if (declared.includes(side) && present.has(side)) out.push(side);
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
 */
function isSideFreeForNameMatch(
  row: SlotBearingRow,
  side: PlatformSide,
  returnedIds: Set<string>,
): boolean {
  const slot = primarySlot(row, side);
  if (!slot) return true;
  const id = idForSlot(row, side, slot);
  if (id === undefined) return true;
  return !returnedIds.has(id);
}

export function planSelectorSync<TId extends string>(args: {
  existing: readonly MatchableRow<TId>[];
  items: readonly IncomingItem[];
  coveredSides?: readonly PlatformSide[];
}): SelectorSyncPlan<TId> {
  const { existing, items } = args;

  const returnedIds: Record<PlatformSide, Set<string>> = {
    bsc: new Set<string>(),
    sportlots: new Set<string>(),
  };
  for (const item of items) {
    for (const side of PLATFORM_SIDES) {
      const id = item.ids[side];
      if (id) returnedIds[side].add(id);
    }
  }

  const coveredSides = effectiveCoveredSides(items, args.coveredSides);
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

  /** A row already claimed by an earlier item in this same batch. */
  const claimed = new Set<TId>();
  const outcomes: Array<MatchOutcome<TId>> = [];

  for (const item of items) {
    const key = selectorValueKey(item.value);
    let withheld: string | undefined;

    // ── Tier 0 — client-supplied existingId, sibling-scoped ────────────────
    if (item.existingId) {
      const row = byRowId.get(item.existingId);
      if (row) {
        if (claimed.has(row._id)) {
          // Two modal rows pointing at one NB row. The second is a new set as
          // far as we can tell; inserting it is additive and reversible,
          // folding it into the first would silently merge two titles.
          ambiguities.push({
            item: item.value,
            reason: "existingId already claimed by an earlier item",
          });
          outcomes.push({ kind: "insert" });
          continue;
        }
        claimed.add(row._id);
        outcomes.push({ kind: "matched", existingId: row._id, tier: 0 });
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

    // ── Tier 1 — marketplace id → the sibling holding it ───────────────────
    const tier1 = new Set<MatchableRow<TId>>();
    for (const side of PLATFORM_SIDES) {
      const id = item.ids[side];
      if (!id) continue;
      const holders = bySideId[side].get(id);
      if (!holders || holders.length === 0) continue;
      if (holders.length > 1) {
        // NEO-137 M:1 is legal, so this is not corruption — it just is not
        // evidence of which row the update belongs to.
        withheld = `${side} id is held by ${holders.length} sibling rows`;
        continue;
      }
      tier1.add(holders[0]);
    }
    if (tier1.size === 1) {
      const row = [...tier1][0];
      if (claimed.has(row._id)) {
        ambiguities.push({
          item: item.value,
          reason: "two incoming items resolve to one row by marketplace id",
        });
        outcomes.push({
          kind: "withheld",
          reason: "row already claimed in this batch",
        });
        continue;
      }
      claimed.add(row._id);
      outcomes.push({ kind: "matched", existingId: row._id, tier: 1 });
      continue;
    }
    if (tier1.size > 1) {
      // BSC says row A, SportLots says row B. Upstream believes these are one
      // set; NB has them as two. Merging rows is not something a sync gets to
      // decide, and picking a side would silently move a marketplace link.
      withheld = "bsc and sportlots ids resolve to different rows";
    }

    // ── Tier 2 — normalised display value against FREE siblings ────────────
    const sameName = byKey.get(key) ?? [];
    if (sameName.length > 1) {
      // Two siblings already fold to one name. Nothing here can say which of
      // them upstream means, and picking would attach a marketplace id to a
      // coin-flip.
      withheld = `${sameName.length} sibling rows share this name`;
    } else if (sameName.length === 1) {
      const row = sameName[0];
      const sidesCarried = PLATFORM_SIDES.filter((s) => item.ids[s]);
      const free = sidesCarried.every((side) =>
        isSideFreeForNameMatch(row, side, returnedIds[side]),
      );
      if (!free) {
        // The name matches but the row is currently, legitimately bound to a
        // different id upstream still lists. Inserting a same-named sibling
        // would break the one-name-per-parent rule every picker relies on.
        withheld = "name matches a row already linked to a different live id";
      } else if (claimed.has(row._id)) {
        ambiguities.push({
          item: item.value,
          reason: "two incoming items fold to one existing row",
        });
        outcomes.push({
          kind: "withheld",
          reason: "row already claimed in this batch",
        });
        continue;
      } else {
        claimed.add(row._id);
        outcomes.push({ kind: "matched", existingId: row._id, tier: 2 });
        continue;
      }
    }

    if (withheld) {
      ambiguities.push({ item: item.value, reason: withheld });
      outcomes.push({ kind: "withheld", reason: withheld });
      continue;
    }

    outcomes.push({ kind: "insert" });
  }

  return { outcomes, coveredSides, returnedIds, ambiguities };
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
  | { ok: false; reason: "refused" | "invalid" | "clash"; message: string }
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
 * check and the feature re-derivation, and none of them had the variantType
 * refusal. A guard that lives on one of three doors is not a guard.
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
    isCustom?: boolean;
    features?: Record<string, string>;
    sportConfig?: unknown;
  };
  nextValue: string;
  siblings: ReadonlyArray<{ _id: string; value: string }>;
}): RenamePlan {
  const { row, siblings } = args;

  if (refusesValueRename(row)) {
    return {
      ok: false,
      reason: "refused",
      message: VARIANT_TYPE_RENAME_MESSAGE,
    };
  }

  const checked = checkSelectorValue(args.nextValue);
  if (!checked.ok) {
    return { ok: false, reason: "invalid", message: checked.reason };
  }
  const trimmed = checked.value;

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
