/**
 * NEO-237 — moving a set out of the year's Unknown row and under a brand.
 *
 * A PURE NB OPERATION. The set row keeps its `_id`, its subtree, its
 * marketplace slots and its cards; the writes are `parentId` on the row, its
 * `features.manufacturer` snapshot (below), and the `children` caches of the
 * two parents (filtered off the old one, unioned into the new one —
 * `unionChildren`, the precedent being `applyParallelGroupings`' reparenting).
 * Nothing here reads a marketplace value: the prefix comes from the brand
 * row's `metadata.setNamePrefix`, and the only name compared is the set row's
 * own NB display value.
 *
 * THE MANUFACTURER SNAPSHOT MOVES WITH THE ROW. `features` on a set row is a
 * copy of its parent's features taken at creation (`storeSelectorOptions`'
 * insert branch), and a row born under Unknown carries no `manufacturer` key
 * because Unknown has none (`ensureBrandUnknownRow`). Once the row is that
 * brand's set, a snapshot still pointing at Unknown's absence would be a lie
 * about its own parent, so `features.manufacturer` is set to the target
 * brand's — which makes the moved row indistinguishable from a sibling the
 * sync would have inserted under that brand. The row's other features are
 * kept; the key is removed when the brand carries none. ROW-LEVEL ONLY:
 * cards already committed under the row are not rewritten, the same rule the
 * Unknown rename applies (§2a).
 *
 * ONE DIRECTION ONLY FOR THE AUTOMATIC DOORS: Unknown → brand. NEO-294 adds
 * a fourth, OPERATOR-INITIATED door — the attributes panel's move control —
 * which may name any manufacturer of the year INCLUDING the Unknown row, and
 * says so explicitly with `allowBrandUnknownTarget`. The refusal stays the
 * default, so a sync cannot reach that destination by accident. The three
 * automatic doors are —
 *
 *   • `addCustomSelectorOption` at the manufacturer level (a new brand
 *     claims the sets whose names start with its prefix);
 *   • `setSelectorOptionSetNamePrefix` (an edited prefix claims likewise —
 *     "Choice" typed with prefix "Choice Biloxi" moves nothing, and fixing
 *     the prefix is how the operator moves it);
 *   • the Sync Sets BSC phase (`routeBscSets`' `moves`: a row that sits
 *     under Unknown holding a BSC id, and whose OWN NB name now matches a
 *     brand's prefix — never the marketplace's name for that set, which
 *     would let an upstream label move a row an operator has renamed).
 *
 * Never brand → brand, and never from a sync on a row already under a brand:
 * a placement is linkage, and the sync's job is to route a marketplace's
 * update to the row linked to it, not to second-guess where the row lives.
 *
 * SIBLING CLASH. Two rows under one parent must not fold to one name (the
 * NEO-219 rule every picker and drill util relies on), so a set whose name
 * already exists under the target brand STAYS under Unknown, counted and
 * logged, never renamed and never merged. The operator resolves it by hand —
 * which is the right outcome, because two same-named sets under one brand is
 * a question about which one is which, and a sync must not answer it. That
 * check is bounded by `MAX_YEAR_SET_ROWS` and FAILS CLOSED past it
 * (`rehomeTargetTooLargeRefusal`): a half-read sibling list would let the
 * move create the exact duplicate the check prevents.
 */

import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  matchesBrandPrefix,
  selectorValueKey,
  valuesDeepEqual,
} from "./selectorSyncMatch";
import { unionChildren } from "./selectorSyncStore";
import { MAX_YEAR_SET_ROWS } from "./setFromMarketplace";
import { resolvableSides, type ResolvableRow } from "./marketplaceResolvability";
import { pausedSides } from "./marketplacePause";
import { initialSlots } from "./platformSlots";
import { SL_ALL_BRANDS_BRAND_ID } from "./slBrandAxis";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { inheritedTeamIds } from "./lib/selectorTeams";

/**
 * The "N sets moved out of Unknown" notice, one sentence for the two doors
 * that write it into `selectorSyncStatus` (`addCustomSelectorOption`, and
 * `setSelectorOptionSetNamePrefix` in brandView.ts). Counts only — a set name
 * is operator content and the status message is reactive state (NEO-47).
 */
export function rehomedNotice(count: number): string {
  return `${countNoun(count, "set")} moved out of Unknown`;
}

/**
 * NEO-294 (audit condition 2) — the refusal when the target brand holds more
 * sets than the sibling-clash read may cover. A `ConvexError` rather than an
 * `Error` so the sentence survives to whoever is looking (production redacts
 * a plain Error to "Server Error"); named and exported so the test and the
 * message cannot drift apart.
 */
export const rehomeTargetTooLargeRefusal = (brandName: string): string =>
  `${brandName} has more than ${MAX_YEAR_SET_ROWS} sets — too many to check ` +
  `a set's name against, so nothing was moved under it.`;

/**
 * "1 set" / "3 sets" / "0 brands" — the one pluraliser behind every count the
 * Sync Sets summary shows the operator. Never "(s)": the summary is read by a
 * collector, not a developer. `plural` defaults to `singular + "s"`.
 */
export function countNoun(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export type RehomeResult = {
  /** Rows whose `parentId` now names the brand. */
  rehomed: number;
  /** Rows left under their old parent because the brand already had that name. */
  clashes: number;
  /**
   * NEO-294 — rows left alone because an operator placed them
   * (`metadata.brandSetByOperator`). Always 0 on the operator's own move,
   * which passes `includeOperatorPlaced`.
   */
  operatorPlaced: number;
};

/** "Nothing to do" — the ordinary case on a fresh year, not an error. */
const EMPTY_REHOME: RehomeResult = { rehomed: 0, clashes: 0, operatorPlaced: 0 };

/**
 * The year's brand-unknown row, found by its NB ROLE and nothing else. `null`
 * when the year has none yet (nothing has been synced under it).
 *
 * One indexed read over the year's manufacturers. The first flagged row wins
 * if a year somehow carries two — `ensureBrandUnknownRow` never mints a
 * second, so that is a hand-edit, and the sync should still behave.
 */
export async function findBrandUnknownRow(
  ctx: { db: QueryCtx["db"] },
  yearId: Id<"selectorOptions">,
): Promise<Doc<"selectorOptions"> | null> {
  const manufacturers = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "manufacturer").eq("parentId", yearId),
    )
    .collect();
  return manufacturers.find((m) => m.metadata?.isBrandUnknown === true) ?? null;
}

/**
 * The moved row's `features` once it is `brandManufacturer`'s set: the row's
 * own features with `manufacturer` replaced by the brand's snapshot, or
 * removed when the brand has none. `undefined` when nothing would be left —
 * the caller removes the field rather than storing `{}`, matching how the
 * insert branch stores a row with no features.
 */
export function rehomedFeatures(
  rowFeatures: Record<string, string> | undefined,
  brandManufacturer: string | undefined,
): Record<string, string> | undefined {
  const next: Record<string, string> = { ...(rowFeatures ?? {}) };
  if (brandManufacturer !== undefined) next.manufacturer = brandManufacturer;
  else delete next.manufacturer;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Move specific setName rows under `brandId`. The shared core: the two
 * name-driven doors above filter Unknown's sets by prefix and hand the
 * survivors here; the sync hands over the rows `routeBscSets` named by id.
 *
 * `rows` must be `setName` rows; anything else is skipped and counted as
 * nothing. A row already under the brand is a no-op, not a clash.
 *
 * TWO NEO-294 OPTIONS, both default-false so every existing caller keeps the
 * behaviour it was written against:
 *
 *   allowBrandUnknownTarget — the target may be the year's flagged Unknown
 *     row. Only the operator's move passes it: "move this set back to
 *     Unknown" is a legitimate destination for a person and never for a
 *     sync, which would be undoing its own work.
 *   includeOperatorPlaced — rows carrying `metadata.brandSetByOperator` are
 *     moved rather than skipped. Only the operator's move passes it: a
 *     second decision by the same hand is still theirs, while an automatic
 *     path must never take a row back off the brand a person chose.
 */
export async function rehomeSetRowsToBrand(
  ctx: MutationCtx,
  args: {
    rows: readonly Doc<"selectorOptions">[];
    brandId: Id<"selectorOptions">;
    /** NEO-294 — the operator's move may name the flagged Unknown row. */
    allowBrandUnknownTarget?: boolean;
    /** NEO-294 — the operator's move may re-place a row they placed before. */
    includeOperatorPlaced?: boolean;
  },
): Promise<RehomeResult> {
  const brand = await ctx.db.get(args.brandId);
  if (!brand || brand.level !== "manufacturer") {
    throw new Error("rehomeSetRowsToBrand: target is not a manufacturer row");
  }
  if (
    brand.metadata?.isBrandUnknown === true &&
    args.allowBrandUnknownTarget !== true
  ) {
    throw new Error("rehomeSetRowsToBrand: target is the brand-unknown row");
  }

  // The target's IN-TRANSACTION name set, grown as rows land, so two Unknown
  // rows that fold to one name cannot both move.
  //
  // BOUNDED, AND FAILS CLOSED (NEO-294 audit, condition 2): the year's
  // Unknown row is a legal target for the operator's move and is the biggest
  // bucket there is, so this read carries `MAX_YEAR_SET_ROWS` like every
  // other year-scoped set read. A truncated sibling list cannot answer "is
  // this name taken?", and re-homing against a half-read answer would put
  // two fold-equal names under one parent — the NEO-219 rule this function
  // upholds. Refuse instead; nothing is written.
  const targetSiblings = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "setName").eq("parentId", args.brandId),
    )
    .take(MAX_YEAR_SET_ROWS + 1);
  if (targetSiblings.length > MAX_YEAR_SET_ROWS) {
    throw new ConvexError(rehomeTargetTooLargeRefusal(brand.value));
  }
  const takenKeys = new Set(targetSiblings.map((r) => selectorValueKey(r.value)));

  const now = Date.now();
  const movedIds: Id<"selectorOptions">[] = [];
  const removedFrom = new Map<Id<"selectorOptions">, Set<Id<"selectorOptions">>>();
  let clashes = 0;
  let operatorPlaced = 0;

  for (const row of args.rows) {
    if (row.level !== "setName") continue;
    if (row.parentId === args.brandId) continue;
    // NEO-294 — the operator's placement outranks every automatic caller.
    // Counted, not silent: the sync's summary and the backfill's report both
    // say how many rows they left alone.
    if (
      row.metadata?.brandSetByOperator === true &&
      args.includeOperatorPlaced !== true
    ) {
      operatorPlaced++;
      continue;
    }
    const key = selectorValueKey(row.value);
    if (takenKeys.has(key)) {
      clashes++;
      continue;
    }
    takenKeys.add(key);
    // NEO-85: write-if-changed on `features` — a row that already carries the
    // brand's manufacturer (a hand-edited snapshot) is not rewritten.
    const nextFeatures = rehomedFeatures(row.features, brand.features?.manufacturer);
    const featuresChanged = !valuesDeepEqual(row.features ?? {}, nextFeatures ?? {});
    await ctx.db.patch(row._id, {
      parentId: args.brandId,
      lastUpdated: now,
      // `undefined` removes the field: a row with no features left is stored
      // the way the insert branch stores one, with no `features` key at all.
      ...(featuresChanged ? { features: nextFeatures } : {}),
    });
    movedIds.push(row._id);
    if (row.parentId) {
      const set = removedFrom.get(row.parentId) ?? new Set<Id<"selectorOptions">>();
      set.add(row._id);
      removedFrom.set(row.parentId, set);
    }
  }

  if (movedIds.length > 0) {
    // NEO-85: write-if-changed on every `children` cache, as everywhere else
    // in this tree — a byte-identical patch still reflows every column
    // watching the parent.
    for (const [fromId, ids] of removedFrom) {
      const from = await ctx.db.get(fromId);
      if (!from) continue;
      const next = (from.children ?? []).filter((id) => !ids.has(id));
      if (!valuesDeepEqual(from.children ?? [], next)) {
        await ctx.db.patch(fromId, { children: next, lastUpdated: now });
      }
    }
    const nextChildren = unionChildren(brand.children, movedIds);
    if (!valuesDeepEqual(brand.children ?? [], nextChildren)) {
      await ctx.db.patch(args.brandId, { children: nextChildren, lastUpdated: now });
    }
  }

  if (clashes > 0) {
    // Counts only — a set name is operator content and the log is not the
    // place for it (NEO-47's rule, applied to logs).
    console.warn(
      `[brandRehome] ${clashes} set(s) stayed under their old parent: the ` +
        `target brand already has a set of that name.`,
    );
  }
  return { rehomed: movedIds.length, clashes, operatorPlaced };
}

/**
 * Re-home every set under the year's Unknown row whose NB name starts with
 * `prefix` (whole word, `matchesBrandPrefix`) to `brandId`.
 *
 * The name compared is the SET ROW'S OWN VALUE — NB data — against a prefix
 * that is NB data on the brand row. An empty prefix moves nothing, and a year
 * with no Unknown row has nothing to move; both return zeros rather than
 * throwing, because "nothing to do" is the ordinary case on a fresh year.
 */
export async function rehomeSetsFromBrandUnknown(
  ctx: MutationCtx,
  args: {
    yearId: Id<"selectorOptions">;
    brandId: Id<"selectorOptions">;
    prefix: string;
  },
): Promise<RehomeResult> {
  const prefix = args.prefix.trim();
  if (!prefix) return EMPTY_REHOME;

  const unknown = await findBrandUnknownRow(ctx, args.yearId);
  if (!unknown || unknown._id === args.brandId) return EMPTY_REHOME;

  const sets = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "setName").eq("parentId", unknown._id),
    )
    .collect();
  const matching = sets.filter((row) => matchesBrandPrefix(row.value, prefix));
  if (matching.length === 0) return EMPTY_REHOME;

  return await rehomeSetRowsToBrand(ctx, { rows: matching, brandId: args.brandId });
}

// ───────────────────────────────────────────────────────────────────────────
// NEO-294 — minting a brand row for a name from the known list
// ───────────────────────────────────────────────────────────────────────────

export type EnsureBrandRowResult = {
  /**
   * The brand row to file sets under, or `null` when the year already has a
   * manufacturer of that name that is NOT a usable brand — today that is
   * only the flagged Unknown row, wearing an operator's rename. Nothing is
   * created in that case and the caller leaves those sets in Unknown, which
   * is where the row in question puts them anyway.
   */
  id: Id<"selectorOptions"> | null;
  /** `true` only when this call inserted the row. */
  created: boolean;
  /**
   * The row's ACTUAL `metadata.setNamePrefix`, minted or adopted. A caller
   * that re-routes with this row in hand must use this rather than assume
   * the brand name: an adopted row written before NEO-237 may carry none,
   * and a row with no prefix buckets nothing (schema.ts).
   */
  setNamePrefix?: string;
};

/**
 * The ancestor chain a MUTATION needs to judge resolvability — the same walk
 * `getAncestorChain` does, with only the fields the rule reads. A third copy
 * of this loop, after `selectorOptions.ts` and `setReconciliation.ts`, for
 * the same reason both of those have one: a mutation cannot call the query,
 * which carries its own `requireAdmin`.
 */
async function loadChain(
  ctx: { db: QueryCtx["db"] },
  leafId: Id<"selectorOptions"> | undefined,
): Promise<ResolvableRow[]> {
  const chain: ResolvableRow[] = [];
  let currentId: Id<"selectorOptions"> | undefined = leafId;
  while (currentId) {
    const row: Doc<"selectorOptions"> | null = await ctx.db.get(currentId);
    if (!row) break;
    chain.unshift({
      level: row.level,
      value: row.value,
      platformData: row.platformData ?? {},
      platformFacets: row.platformFacets,
    });
    currentId = row.parentId;
  }
  return chain;
}

/**
 * NEO-294 — find or mint the manufacturer row called `name` under `yearId`,
 * born EXACTLY as a hand-created brand is (`addCustomSelectorOption` at the
 * manufacturer level):
 *
 *   • `metadata.setNamePrefix` = the name, the one default every creation
 *     path writes;
 *   • the SportLots ALL-BRANDS sentinel in its SportLots slot when the chain
 *     can scope SportLots (`resolvableSides` at the manufacturer level, the
 *     pause included) — unconditional otherwise, exactly as Jason asked on
 *     the NEO-237 preview. A year with no SportLots ids gets a brand with no
 *     SportLots slot, which is an ordinary row, not an error (invariant 6),
 *     and writing a link that can never be fetched would break invariant 5;
 *   • features copied down from the year plus the level's own, `teamIds`
 *     inherited, `children: []`, and the row unioned into the year's
 *     `children` cache.
 *
 * IDEMPOTENT by folded name, the same per-parent rule
 * `addCustomSelectorOption` returns on: a second call with the same name
 * returns the row the first one made and writes nothing. That is what makes
 * "sync again" and "run the backfill twice" free.
 *
 * NEVER on a flagged row: `setNamePrefix` on the row that holds the sets
 * whose brand NB has not identified is a contradiction (schema.ts), so a
 * flagged row wearing this name is reported as `id: null` rather than
 * adopted or renamed. `name` is an NB constant from `knownBrands.ts`; no
 * marketplace value reaches this function.
 */
export async function ensureBrandRowForName(
  ctx: MutationCtx,
  args: { yearId: Id<"selectorOptions">; name: string },
): Promise<EnsureBrandRowResult> {
  const name = args.name.trim();
  if (!name) throw new Error("ensureBrandRowForName: empty brand name");
  const year = await ctx.db.get(args.yearId);
  if (!year || year.level !== "year") {
    throw new Error("ensureBrandRowForName: parent is not a year row");
  }

  const siblings = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "manufacturer").eq("parentId", args.yearId),
    )
    .collect();
  const key = selectorValueKey(name);
  const existing = siblings.find((m) => selectorValueKey(m.value) === key);
  if (existing) {
    if (existing.metadata?.isBrandUnknown === true) {
      return { id: null, created: false };
    }
    return {
      id: existing._id,
      created: false,
      ...(existing.metadata?.setNamePrefix !== undefined
        ? { setNamePrefix: existing.metadata.setNamePrefix }
        : {}),
    };
  }

  const chain = await loadChain(ctx, args.yearId);
  const resolution = resolvableSides(chain, {
    level: "manufacturer",
    paused: pausedSides(),
  });
  const alloc = resolution.sportlots.resolvable
    ? initialSlots({ sportlots: [{ id: SL_ALL_BRANDS_BRAND_ID, label: name }] })
    : undefined;

  const features = {
    ...(year.features ?? {}),
    ...deriveOwnLevelFeatures("manufacturer", name),
  };
  const parentTeamIds = inheritedTeamIds(year);
  const now = Date.now();
  const id = await ctx.db.insert("selectorOptions", {
    level: "manufacturer",
    value: name,
    platformData: alloc?.platformData ?? {},
    ...(alloc ? { platformLabels: alloc.platformLabels } : {}),
    ...(alloc ? { platformSlotSeq: alloc.platformSlotSeq } : {}),
    parentId: args.yearId,
    children: [],
    metadata: { setNamePrefix: name },
    ...(Object.keys(features).length > 0 ? { features } : {}),
    ...(parentTeamIds ? { teamIds: parentTeamIds } : {}),
    lastUpdated: now,
  });
  const nextChildren = unionChildren(year.children, [id]);
  if (!valuesDeepEqual(year.children ?? [], nextChildren)) {
    await ctx.db.patch(args.yearId, { children: nextChildren, lastUpdated: now });
  }
  return { id, created: true, setNamePrefix: name };
}
