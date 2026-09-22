import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { inheritedTeamIds } from "./lib/selectorTeams";
import { initialSlots } from "./platformSlots";
import {
  checkCustomSelectorValue,
  matchesBrandPrefix,
  selectorValueKey,
} from "./selectorSyncMatch";
import { unionChildren } from "./selectorSyncStore";

/**
 * NEO-237 (D13) — a set NeonBinder does not have yet, minted from what a
 * marketplace lists under a brand: one `setName` row and one `variantType`
 * child called "Base", in one transaction.
 *
 * ## Why the sync creates it, and why this module has no door of its own
 *
 * Jason, 2026-09-21: "If a set exists in a marketplace it should be saved
 * whether it is in SL or BSC or both." There is no review surface — the
 * Sync Sets SportLots phase in selectorOptions.ts calls
 * `insertSetWithBaseFromSl` for every root the fetch returned that no row
 * under the brand already holds by id. So this file exports plain helpers
 * only: no `query`/`mutation`, no `requireAdmin` (the caller's own gate
 * covers it), no `api` entry.
 *
 * ## The shape (the schema specialist's, step 0)
 *
 *  - The SET is NB's row: `platformData: {}`, no marketplace ids. Its
 *    `features` are the brand's plus the level's own derivation
 *    (`deriveOwnLevelFeatures("setName", name)`), its `teamIds` the brand's
 *    set-level team copied down (`inheritedTeamIds`), `children: []` until
 *    the Base exists, and `createdByUserId` from the caller's identity when
 *    there is one — never a client argument.
 *  - The BASE is the one row that carries the marketplace link, exactly
 *    where `BaseSetPicker` would put it, so the checklist fetch, the attach
 *    pane and the source chips all find it without a second concept. It gets
 *    its SportLots slot through `initialSlots` (slot key `s0`, label = the
 *    marketplace's label), `metadata.isBase: true` (the NB flag, derived once
 *    at creation — never re-read from the value "Base"), features from the
 *    set plus `deriveOwnLevelFeatures("variantType", "Base")`, and the same
 *    `teamIds`. **No** `platformFacets` (there is no BSC id to facet) and
 *    **no** `primaryPlatformId` (one slot; the lowest-numbered slot is
 *    primary by default).
 *  - Then the set's `children: [baseId]`, and the brand's `children` by
 *    set-union (`unionChildren`, never rebuilt).
 *
 * The marketplace's longer siblings of a root (its "members") are NOT
 * written here: the next sync classifies them as variants of the set that
 * now exists.
 *
 * ## Refusals are return values, not throws
 *
 * The sync walks many roots in one mutation and counts what it could not
 * file, so every refusal comes back as `{ ok: false, reason }` and leaves the
 * database untouched. Nothing is merged on a clash: an existing set that
 * folds to the same name may well be a different product that happens to
 * share it, and a set the marketplace files under this brand that NB already
 * has under another one is a re-home question — the prefix's job, not this
 * helper's.
 */

/**
 * What a set minted from a marketplace label is called, for one root under
 * one brand: the brand's `setNamePrefix` in front of the label, unless there
 * is no prefix or the label already leads with it (whole-word,
 * case-insensitive — the `matchesBrandPrefix` rule, the same word-boundary
 * rule the routing uses).
 *
 * A BSC-synced set under a brand keeps the brand in its name — Topps holds
 * "Topps Heritage", "Topps Chrome", "Topps Living" — while SportLots' label
 * is brand-STRIPPED ("Heritage"), so the two sides only fold together when
 * the prefix is put back. Under Unknown there is no prefix, so "Carddass"
 * stays "Carddass". The prefix comes off the brand row's `metadata`, never
 * off its display value (schema.ts `setNamePrefix`).
 *
 * `brandPrefix` is present ONLY when it was prepended, so
 * `brandPrefix !== undefined` ⇔ `defaultName !== label`.
 *
 * Pure and exported so a test can pin the rule without a database.
 */
export function candidateDefaultName(
  label: string,
  setNamePrefix: string | undefined,
): { defaultName: string; brandPrefix?: string } {
  const prefix = setNamePrefix?.trim() ?? "";
  if (!prefix || matchesBrandPrefix(label, prefix)) {
    return { defaultName: label };
  }
  return { defaultName: `${prefix} ${label.trim()}`, brandPrefix: prefix };
}

/**
 * Cap on cross-parent matches carried back. A name that legitimately appears
 * under twenty different brands is a data problem the caller needs to see the
 * shape of, not an exhaustive list of (the same ceiling
 * `findSelectorOptionElsewhere` applies).
 */
export const MAX_SET_ELSEWHERE_MATCHES = 20;

/** A set under a DIFFERENT brand of the same year that folds to the name. */
export type SetElsewhereMatch = {
  _id: Id<"selectorOptions">;
  value: string;
  /** The other brand's row id. */
  parentId: Id<"selectorOptions">;
  /** The other brand's display value, for the caller's report line. */
  brand: string;
};

export type InsertSetWithBaseRefusal =
  /** `brandId` is not a manufacturer row (gone under the caller's feet). */
  | { ok: false; reason: "brand_missing" }
  /** The name fails the per-level rule the "+ Custom" form applies. */
  | { ok: false; reason: "invalid_name"; detail: string }
  /**
   * A sibling under the same brand already folds to this name
   * (`selectorValueKey`, the fold every sync matcher uses).
   */
  | {
      ok: false;
      reason: "clash_at_target";
      existingId: Id<"selectorOptions">;
      value: string;
    }
  /** The name exists under a DIFFERENT brand of the same year. */
  | { ok: false; reason: "exists_elsewhere"; matches: SetElsewhereMatch[] };

export type InsertSetWithBaseResult =
  | { ok: true; setId: Id<"selectorOptions">; baseId: Id<"selectorOptions"> }
  | InsertSetWithBaseRefusal;

/**
 * Sets under every OTHER manufacturer of the brand's year that fold to
 * `key`. The setName-level case of `findElsewhereMatches` in
 * selectorOptions.ts, kept here so this module has no import into the sync
 * module that imports it, and no admin gate on the read.
 */
async function setNameMatchesElsewhere(
  ctx: MutationCtx,
  brand: Doc<"selectorOptions">,
  key: string,
): Promise<SetElsewhereMatch[]> {
  const yearId = brand.parentId;
  if (!yearId) return [];
  const manufacturers = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "manufacturer").eq("parentId", yearId),
    )
    .collect();

  const matches: SetElsewhereMatch[] = [];
  for (const other of manufacturers) {
    if (other._id === brand._id) continue;
    const rows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", other._id),
      )
      .collect();
    for (const row of rows) {
      if (selectorValueKey(row.value) !== key) continue;
      matches.push({
        _id: row._id,
        value: row.value,
        parentId: other._id,
        brand: other.value,
      });
      if (matches.length >= MAX_SET_ELSEWHERE_MATCHES) return matches;
    }
  }
  return matches;
}

/**
 * D13 — a set and its Base from one SportLots entry, in one transaction.
 * See the module comment for the shape and the refusals.
 *
 * `name` is the FINAL name (the caller derives it — `candidateDefaultName`
 * puts the brand's prefix back); nothing is prepended here. `sl` is the
 * SportLots id and label the Base's slot carries. `createdByUserId` is the
 * caller's identity when it has one.
 *
 * Every refusal returns before the first write, so a refused call leaves
 * the database exactly as it found it.
 */
export async function insertSetWithBaseFromSl(
  ctx: MutationCtx,
  args: {
    brandId: Id<"selectorOptions">;
    name: string;
    sl: { id: string; label: string };
    createdByUserId?: string;
  },
): Promise<InsertSetWithBaseResult> {
  const brand = await ctx.db.get(args.brandId);
  if (!brand || brand.level !== "manufacturer") {
    return { ok: false, reason: "brand_missing" };
  }

  const checked = checkCustomSelectorValue("setName", args.name);
  if (!checked.ok) {
    return { ok: false, reason: "invalid_name", detail: checked.reason };
  }
  const value = checked.value;
  const key = selectorValueKey(value);

  // Sibling clash under the target brand — the fold every matcher uses.
  const siblings = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "setName").eq("parentId", brand._id),
    )
    .collect();
  const clash = siblings.find((s) => selectorValueKey(s.value) === key);
  if (clash) {
    return {
      ok: false,
      reason: "clash_at_target",
      existingId: clash._id,
      value: clash.value,
    };
  }

  // Cross-parent duplicate — the same scope `addCustomSelectorOption`'s
  // confirm offers from, so the two doors cannot disagree about what counts.
  const matches = await setNameMatchesElsewhere(ctx, brand, key);
  if (matches.length > 0) {
    return { ok: false, reason: "exists_elsewhere", matches };
  }

  const now = Date.now();
  const brandTeamIds = inheritedTeamIds(brand);
  const audit = args.createdByUserId
    ? { createdByUserId: args.createdByUserId }
    : {};

  // 1. The set: NB's row, no marketplace ids.
  const setFeatures = {
    ...(brand.features ?? {}),
    ...deriveOwnLevelFeatures("setName", value),
  };
  const setId = await ctx.db.insert("selectorOptions", {
    level: "setName",
    value,
    platformData: {},
    parentId: brand._id,
    children: [],
    ...audit,
    ...(Object.keys(setFeatures).length > 0 ? { features: setFeatures } : {}),
    ...(brandTeamIds ? { teamIds: brandTeamIds } : {}),
    lastUpdated: now,
  });

  // 2. The Base: the one row that carries the SportLots link.
  const slots = initialSlots({
    sportlots: [{ id: args.sl.id, label: args.sl.label }],
  });
  const baseFeatures = {
    ...setFeatures,
    ...deriveOwnLevelFeatures("variantType", "Base"),
  };
  const baseId = await ctx.db.insert("selectorOptions", {
    level: "variantType",
    value: "Base",
    platformData: slots.platformData,
    platformLabels: slots.platformLabels,
    platformSlotSeq: slots.platformSlotSeq,
    parentId: setId,
    children: [],
    ...audit,
    metadata: { isBase: true },
    ...(Object.keys(baseFeatures).length > 0 ? { features: baseFeatures } : {}),
    ...(brandTeamIds ? { teamIds: [...brandTeamIds] } : {}),
    lastUpdated: now,
  });

  // 3. Parents' children caches.
  await ctx.db.patch(setId, { children: [baseId] });
  await ctx.db.patch(brand._id, {
    children: unionChildren(brand.children, [setId]),
  });

  return { ok: true, setId, baseId };
}
