import type { MutationCtx, QueryCtx } from "./_generated/server";
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
 *
 * ## The read budget
 *
 * The two duplicate checks (sibling under the brand, same name under another
 * brand of the year) need every `setName` row of the year. Read per root that
 * is ~2,700 documents × 200 roots on a full baseball year — Convex refuses a
 * transaction long before that. So a batch caller builds the folded-name
 * index ONCE (`buildSetNameIndex`, one pass over the year, bounded by
 * `MAX_YEAR_SET_ROWS`) and hands it in; the helper then reads nothing but the
 * brand row and advances the index with every set it writes, so a later root
 * in the same batch that folds to the same name is the clash a re-read would
 * have found. A caller that passes no index gets the self-reading path — the
 * same decisions, one row at a time — and the tests pin the two agree.
 * A truncated index cannot answer "exists elsewhere", so the helper refuses
 * every root against it (`index_truncated`) rather than guess; the caller
 * reports it. And one transaction writes at most `MAX_SL_SETS_PER_MUTATION`
 * roots (each is two inserts and two patches); a longer list is chunked by
 * the action, one index build per chunk, so a chunk always sees what the
 * chunk before it wrote.
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

/**
 * NEO-237 — the read budget for a year-wide set index (`buildSetNameIndex`
 * here, `listYearSetRows` in selectorOptions.ts). A full baseball year is a
 * few hundred BSC sets plus whatever SportLots-only sets operators created;
 * this is well above that and well inside one function's document budget.
 * Truncation is REPORTED, never papered over: an index missing rows would
 * let a sync insert a copy of a set another manufacturer already holds.
 */
export const MAX_YEAR_SET_ROWS = 3000;

/**
 * NEO-237 — roots one `createSetsFromSlRoots` transaction writes. Each root
 * is two inserts and two patches plus the brand-row re-read, and every
 * transaction rebuilds the year index (≤ `MAX_YEAR_SET_ROWS` reads), so 40
 * keeps a chunk far inside Convex's per-transaction limits while a 200-root
 * sync (`MAX_SL_SETS_PER_SYNC`) is five chunks, not two hundred index reads.
 */
export const MAX_SL_SETS_PER_MUTATION = 40;

/** `items` in order, in slices of at most `size`; `[]` for no items. */
export function chunkSlRoots<T>(
  items: ReadonlyArray<T>,
  size: number,
): Array<Array<T>> {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunkSlRoots: size must be a positive integer, got ${size}`);
  }
  const out: Array<Array<T>> = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * The year's `setName` rows folded by `selectorValueKey`, from the target
 * brand's point of view: its own siblings, and every other manufacturer's
 * sets. Built once per batch by `buildSetNameIndex`; advanced by
 * `insertSetWithBaseFromSl` with each set it writes.
 */
export type SetNameIndex = {
  /** Folded name → the set under the target brand that holds it. */
  siblingKeys: Map<string, { _id: Id<"selectorOptions">; value: string }>;
  /**
   * Folded name → sets under OTHER brands of the year that hold it, at most
   * `MAX_SET_ELSEWHERE_MATCHES` per name (the same ceiling the self-reading
   * path applies).
   */
  elsewhereKeys: Map<string, SetElsewhereMatch[]>;
  /** The read hit `MAX_YEAR_SET_ROWS` before the year was covered. */
  truncated: boolean;
};

/**
 * One pass over the year: the brand's own `setName` children, then every
 * other manufacturer's, through `by_level_and_parent`, bounded by
 * `MAX_YEAR_SET_ROWS` rows in total. Reads `1 + manufacturers` queries
 * regardless of how many roots the caller then files against it. Rows of
 * another year are never read (the walk starts at the brand's parent).
 */
export async function buildSetNameIndex(
  ctx: Pick<QueryCtx, "db">,
  brand: Doc<"selectorOptions">,
): Promise<SetNameIndex> {
  const siblingKeys: SetNameIndex["siblingKeys"] = new Map();
  const elsewhereKeys: SetNameIndex["elsewhereKeys"] = new Map();
  let read = 0;
  let truncated = false;

  const setsUnder = async (parentId: Id<"selectorOptions">) => {
    const remaining = MAX_YEAR_SET_ROWS - read;
    if (remaining <= 0) {
      truncated = true;
      return [];
    }
    const rows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", parentId),
      )
      .take(remaining + 1);
    if (rows.length > remaining) truncated = true;
    const kept = rows.slice(0, remaining);
    read += kept.length;
    return kept;
  };

  for (const row of await setsUnder(brand._id)) {
    const key = selectorValueKey(row.value);
    // First sibling wins, as `Array.find` did on the self-reading path.
    if (!siblingKeys.has(key)) {
      siblingKeys.set(key, { _id: row._id, value: row.value });
    }
  }

  if (brand.parentId) {
    const manufacturers = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "manufacturer").eq("parentId", brand.parentId),
      )
      .collect();
    for (const other of manufacturers) {
      if (other._id === brand._id) continue;
      if (truncated) break;
      for (const row of await setsUnder(other._id)) {
        const key = selectorValueKey(row.value);
        const matches = elsewhereKeys.get(key) ?? [];
        if (matches.length >= MAX_SET_ELSEWHERE_MATCHES) continue;
        matches.push({
          _id: row._id,
          value: row.value,
          parentId: other._id,
          brand: other.value,
        });
        elsewhereKeys.set(key, matches);
      }
    }
  }

  return { siblingKeys, elsewhereKeys, truncated };
}

export type InsertSetWithBaseRefusal =
  /** `brandId` is not a manufacturer row (gone under the caller's feet). */
  | { ok: false; reason: "brand_missing" }
  /**
   * The caller's pre-read index hit `MAX_YEAR_SET_ROWS`: "exists elsewhere"
   * cannot be answered, so nothing is written against it.
   */
  | { ok: false; reason: "index_truncated" }
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
 * `index` is the batch caller's pre-read `buildSetNameIndex` for this brand.
 * With it the duplicate checks read nothing — the only read is the brand row
 * — and the set written is added to `index.siblingKeys` so the next root of
 * the batch sees it. Without it the checks read the year themselves (one
 * sibling query, one query per other manufacturer); the decisions are the
 * same either way.
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
  index?: SetNameIndex,
): Promise<InsertSetWithBaseResult> {
  const brand = await ctx.db.get(args.brandId);
  if (!brand || brand.level !== "manufacturer") {
    return { ok: false, reason: "brand_missing" };
  }
  if (index?.truncated) {
    return { ok: false, reason: "index_truncated" };
  }

  const checked = checkCustomSelectorValue("setName", args.name);
  if (!checked.ok) {
    return { ok: false, reason: "invalid_name", detail: checked.reason };
  }
  const value = checked.value;
  const key = selectorValueKey(value);

  // Sibling clash under the target brand — the fold every matcher uses.
  let clash: { _id: Id<"selectorOptions">; value: string } | undefined;
  if (index) {
    clash = index.siblingKeys.get(key);
  } else {
    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", brand._id),
      )
      .collect();
    clash = siblings.find((s) => selectorValueKey(s.value) === key);
  }
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
  const matches = index
    ? (index.elsewhereKeys.get(key) ?? [])
    : await setNameMatchesElsewhere(ctx, brand, key);
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

  // The next root of the batch sees this set exactly as a re-read would.
  index?.siblingKeys.set(key, { _id: setId, value });

  return { ok: true, setId, baseId };
}
