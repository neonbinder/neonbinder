/**
 * NEO-358 — the NB catalog, read by a collector.
 *
 * Every function here is a signed-in read (`requireSignedIn`, never admin):
 * the catalog is NB's shared reference data and every set is visible. Every
 * `returns` validator is built from `lib/catalogView.ts`, which lists NB
 * fields only, so no marketplace slot, label, facet, ref, `isCustom` or `sku`
 * can reach the collector's screen (`collectionCatalog.test.ts` pins it).
 *
 * Ids that arrive from the URL (`?set=`, `?variant=`, `?card=`, the drill's
 * parent) are taken as STRINGS and normalised here, so a stale or hand-typed
 * link reads as "not found" (null or empty) instead of throwing.
 *
 * Reads are bounded: per-variant card lists, never a whole-set card dump.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import { clampSearchQuery } from "./lib/searchQueryClamp";
import {
  CatalogReader,
  cardTotals,
  catalogCardValidator,
  catalogCardWithPathValidator,
  catalogLevelValidator,
  kindRank,
  pathNodeValidator,
  setRefValidator,
  variantKindValidator,
  variantRefValidator,
  type CatalogCardWithPath,
  type SetRef,
} from "./lib/catalogView";
import {
  isEmptyTitleQuery,
  parseTitleQuery,
  searchTextFor,
  titleMatches,
} from "./lib/titleQuery";
import { variantTypeKind } from "./variantRole";
import { cardPlayerLinkPage } from "./cardPlayerLinks";
import { playerAliasRowsByPrefix } from "./players";
import { findTeamsByAliasPrefix } from "./lib/teamRow";
import { normalizeEntityName } from "../lib/entities/normalize-name";
import { teamFullName } from "../lib/teams/team-name";

type Ctx = Pick<QueryCtx, "db">;
type Row = Doc<"selectorOptions">;
type CardRow = Doc<"cardChecklist">;

/** Children one drill step returns. Far above any real column. */
export const MAX_DRILL_ITEMS = 500;
/** Cards one variant returns. A 1,000-card base set fits with room. */
export const MAX_VARIANT_CARDS = 2000;
/** Rows a set summary lists (variant types + inserts + sub-variants). */
export const MAX_SET_VARIANTS = 1500;
/** Cards a query may count by hand when a row has no stored `cardCount`. */
export const COUNT_FALLBACK_BUDGET = 4000;
/** Ids `cards` hydrates in one call. */
export const MAX_CARDS_BY_ID = 200;
/** Suggestions per kind (players, teams, sets). */
export const SUGGEST_LIMIT = 6;
/** Search hits a free-text search reads before its own filter. */
export const SEARCH_SCAN = 256;
export const SEARCH_DEFAULT_LIMIT = 25;
export const SEARCH_MAX_LIMIT = 50;
/** Cards per page of a player's or team's cards. */
export const ENTITY_CARDS_DEFAULT_LIMIT = 50;
export const ENTITY_CARDS_MAX_LIMIT = 100;
/** Teams a franchise-wide read fans out over. */
export const MAX_FRANCHISE_TEAMS = 50;
/** Shortest typed text that suggests or searches. */
export const MIN_QUERY_CHARS = 2;

function selectorId(ctx: Ctx, raw: string | undefined): Id<"selectorOptions"> | null {
  if (!raw) return null;
  return ctx.db.normalizeId("selectorOptions", raw);
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function compareNames(a: Row, b: Row): number {
  return a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" });
}

function yearValue(row: Row): number {
  const n = Number.parseInt(row.value, 10);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/**
 * Display order for one column: years newest first; variant types Base, then
 * Insert, then Parallel, then the rest by name; everything else by name.
 */
function sortColumn(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (a.level === "year" && b.level === "year") {
      return yearValue(b) - yearValue(a) || compareNames(a, b);
    }
    if (a.level === "variantType" && b.level === "variantType") {
      return (
        kindRank(variantTypeKind(a)) - kindRank(variantTypeKind(b)) ||
        compareNames(a, b)
      );
    }
    return compareNames(a, b);
  });
}

const CARD_BEARING = new Set(["variantType", "insert", "parallel"]);

/**
 * NEO-358 (Jason, 2026-10-24) — whether any card sits on `row` or beneath it,
 * from its stored subtree count: true, false, or null when that count is
 * unknown (never counted yet). A row whose OWN count says it holds cards is
 * true whatever the subtree count says, so a drifted subtree count can never
 * hide a checklist that has cards.
 */
export function rowHasCards(
  row: Pick<Row, "cardCount" | "subtreeCardCount">,
): boolean | null {
  if (typeof row.cardCount === "number" && row.cardCount > 0) return true;
  if (typeof row.subtreeCardCount !== "number") return null;
  return row.subtreeCardCount > 0;
}

/**
 * Hidden from the collector: a row KNOWN to have no cards on it or beneath
 * it. An unknown count is shown, never hidden.
 */
export function hiddenAsEmpty(row: Pick<Row, "cardCount" | "subtreeCardCount">): boolean {
  return rowHasCards(row) === false;
}

// ───────────────────────────────────────────────────────────────────────────
// The drill (sport → year → brand → set → variant type → insert/parallel)
// ───────────────────────────────────────────────────────────────────────────

const drillItemValidator = v.object({
  _id: v.id("selectorOptions"),
  level: catalogLevelValidator,
  name: v.string(),
  /** A variant type's kind (Base, Insert, Parallel); null on every other row. */
  kind: variantKindValidator,
  /** Rows beneath this one. Zero means the drill ends here. */
  childCount: v.number(),
  /** Cards hanging off this row; null above the variant levels or when uncounted. */
  cardCount: v.union(v.number(), v.null()),
  /** The same, regular (non-variation) cards only: the default "of M". */
  baseCardCount: v.union(v.number(), v.null()),
  /**
   * Whether any card sits on this row or beneath it; null when not counted
   * yet. Never false in a drill reply: a row known to be empty is left out.
   */
  hasCards: v.union(v.boolean(), v.null()),
});

/**
 * One column of the catalog cascade: the children of `parentId` (the sports
 * when there is none). Pass `level` to read one level under the parent (a
 * Parallels type holds `insert`-level rows; an insert holds `parallel`-level
 * sub-variants); omit it to read every child.
 *
 * NEO-358 — a row KNOWN to have no cards on it or anywhere beneath it (its
 * stored `subtreeCardCount` is exactly 0) is left out, on every level: a
 * collector never drills into nothing. A row whose count is unknown is kept.
 * `truncated` is judged before that filter, on the rows read.
 */
export const drill = query({
  args: {
    level: v.optional(catalogLevelValidator),
    parentId: v.optional(v.string()),
  },
  returns: v.object({
    items: v.array(drillItemValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    let rows: Row[];
    if (args.parentId === undefined) {
      rows = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", args.level ?? "sport").eq("parentId", undefined),
        )
        .take(MAX_DRILL_ITEMS + 1);
    } else {
      const parentId = selectorId(ctx, args.parentId);
      if (!parentId) return { items: [], truncated: false };
      rows = args.level
        ? await ctx.db
            .query("selectorOptions")
            .withIndex("by_level_and_parent", (q) =>
              q.eq("level", args.level!).eq("parentId", parentId),
            )
            .take(MAX_DRILL_ITEMS + 1)
        : await ctx.db
            .query("selectorOptions")
            .withIndex("by_parent", (q) => q.eq("parentId", parentId))
            .take(MAX_DRILL_ITEMS + 1);
    }
    const truncated = rows.length > MAX_DRILL_ITEMS;
    const budget = { left: COUNT_FALLBACK_BUDGET };
    const items = [];
    for (const row of sortColumn(rows.slice(0, MAX_DRILL_ITEMS))) {
      if (hiddenAsEmpty(row)) continue;
      const totals = CARD_BEARING.has(row.level)
        ? await cardTotals(ctx, row, budget)
        : { all: null, base: null };
      items.push({
        _id: row._id,
        level: row.level,
        name: row.value,
        kind: row.level === "variantType" ? (variantTypeKind(row) ?? null) : null,
        childCount: row.children?.length ?? 0,
        cardCount: totals.all,
        baseCardCount: totals.base,
        hasCards: rowHasCards(row),
      });
    }
    return { items, truncated };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// A set
// ───────────────────────────────────────────────────────────────────────────

/** Where a set sits. Null when the id is not a set row. */
export const setPath = query({
  args: { setId: v.string() },
  returns: v.union(setRefValidator, v.null()),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const id = selectorId(ctx, args.setId);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row || row.level !== "setName") return null;
    return await new CatalogReader(ctx).setRef(id);
  },
});

const setVariantValidator = v.object({
  _id: v.id("selectorOptions"),
  level: catalogLevelValidator,
  name: v.string(),
  kind: variantKindValidator,
  variantType: v.union(pathNodeValidator, v.null()),
  insert: v.union(pathNodeValidator, v.null()),
  parallel: v.union(pathNodeValidator, v.null()),
  /** The row above it inside the set (the set itself for a variant type). */
  parentId: v.id("selectorOptions"),
  childCount: v.number(),
  /** Every card hanging off this row; null when never counted and too many to count here. */
  cardCount: v.union(v.number(), v.null()),
  /** Its regular (non-variation) cards: the default "N of M". Null as above. */
  baseCardCount: v.union(v.number(), v.null()),
});

/**
 * A set and every row inside it that can carry cards, in checklist order:
 * each variant type (Base first), then its inserts by name, each followed by
 * its sub-variants. Container rows (an "Inserts" type with no cards of its
 * own) are listed with their count so the caller decides what to show.
 *
 * NEO-358 — a row KNOWN to have no cards on it or beneath it (stored
 * `subtreeCardCount` exactly 0) is left out; an unknown one is kept, and so
 * is a container whose children hold cards. Its rows beneath are still read,
 * each judged on its own count.
 *
 * `totalCards` / `totalBaseCards`: the set's stored subtree counts when it
 * has them; otherwise the sum of every row's `cardCount` / `baseCardCount`
 * (null when any is unknown).
 */
export const setSummary = query({
  args: { setId: v.string() },
  returns: v.union(
    v.object({
      set: setRefValidator,
      variants: v.array(setVariantValidator),
      totalCards: v.union(v.number(), v.null()),
      totalBaseCards: v.union(v.number(), v.null()),
      truncated: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const setId = selectorId(ctx, args.setId);
    if (!setId) return null;
    const setRow = await ctx.db.get(setId);
    if (!setRow || setRow.level !== "setName") return null;
    const reader = new CatalogReader(ctx);
    const set = await reader.setRef(setId);
    if (!set) return null;

    const budget = { left: COUNT_FALLBACK_BUDGET };
    const variants: Array<typeof setVariantValidator.type> = [];
    let truncated = false;
    let total: number | null = 0;
    let totalBase: number | null = 0;

    const push = async (
      row: Row,
      parentId: Id<"selectorOptions">,
      variantType: Row,
      insert: Row | null,
    ) => {
      if (hiddenAsEmpty(row)) return true;
      if (variants.length >= MAX_SET_VARIANTS) {
        truncated = true;
        return false;
      }
      const totals = await cardTotals(ctx, row, budget);
      total = total === null || totals.all === null ? null : total + totals.all;
      totalBase =
        totalBase === null || totals.base === null ? null : totalBase + totals.base;
      variants.push({
        _id: row._id,
        level: row.level,
        name: row.value,
        kind: variantTypeKind(variantType) ?? null,
        variantType: { _id: variantType._id, name: variantType.value },
        insert: insert ? { _id: insert._id, name: insert.value } : null,
        parallel:
          row.level === "parallel" ? { _id: row._id, name: row.value } : null,
        parentId,
        childCount: row.children?.length ?? 0,
        cardCount: totals.all,
        baseCardCount: totals.base,
      });
      return true;
    };

    const types = sortColumn(
      await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", setId),
        )
        .take(MAX_DRILL_ITEMS),
    );
    outer: for (const type of types) {
      if (!(await push(type, setId, type, null))) break;
      const inserts = sortColumn(
        await ctx.db
          .query("selectorOptions")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", "insert").eq("parentId", type._id),
          )
          .take(MAX_DRILL_ITEMS),
      );
      for (const insert of inserts) {
        if (!(await push(insert, type._id, type, insert))) break outer;
        const subs = sortColumn(
          await ctx.db
            .query("selectorOptions")
            .withIndex("by_level_and_parent", (q) =>
              q.eq("level", "parallel").eq("parentId", insert._id),
            )
            .take(MAX_DRILL_ITEMS),
        );
        for (const sub of subs) {
          if (!(await push(sub, insert._id, type, insert))) break outer;
        }
      }
    }
    // The set's own subtree counts are every card in it, read once; the sum
    // above is the fallback for a set not counted yet.
    if (
      typeof setRow.subtreeCardCount === "number" &&
      typeof setRow.subtreeNonVariationCardCount === "number"
    ) {
      total = setRow.subtreeCardCount;
      totalBase = setRow.subtreeNonVariationCardCount;
    }
    return { set, variants, totalCards: total, totalBaseCards: totalBase, truncated };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Cards
// ───────────────────────────────────────────────────────────────────────────

/**
 * One variant's checklist, in `sortOrder`. Home rows only (a cross-listed
 * guest card is listed under its own set). Null when the id is not a
 * card-bearing row.
 */
export const variantCards = query({
  args: { variantId: v.string() },
  returns: v.union(
    v.object({
      set: v.union(setRefValidator, v.null()),
      variant: variantRefValidator,
      cards: v.array(catalogCardValidator),
      truncated: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const variantId = selectorId(ctx, args.variantId);
    if (!variantId) return null;
    const reader = new CatalogReader(ctx);
    const variant = await reader.variantRef(variantId);
    if (!variant) return null;
    const rows = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantId))
      .take(MAX_VARIANT_CARDS + 1);
    const truncated = rows.length > MAX_VARIANT_CARDS;
    const ordered = rows
      .slice(0, MAX_VARIANT_CARDS)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const cards = [];
    for (const row of ordered) cards.push(await reader.card(row));
    return { set: await reader.setRef(variantId), variant, cards, truncated };
  },
});

/** One card with its set and variant. Null when it is gone or the id is bad. */
export const card = query({
  args: { cardId: v.string() },
  returns: v.union(catalogCardWithPathValidator, v.null()),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const id = ctx.db.normalizeId("cardChecklist", args.cardId);
    if (!id) return null;
    const row = await ctx.db.get(id);
    if (!row) return null;
    return await new CatalogReader(ctx).cardWithPath(row);
  },
});

/**
 * Several cards, aligned with `cardIds`: a gone card (or a bad id) is null in
 * its place, so a collector's copy of a card that left the catalog still has
 * a slot to say so. At most `MAX_CARDS_BY_ID` ids.
 */
export const cards = query({
  args: { cardIds: v.array(v.string()) },
  returns: v.array(v.union(catalogCardWithPathValidator, v.null())),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    if (args.cardIds.length > MAX_CARDS_BY_ID) {
      throw new Error(`At most ${MAX_CARDS_BY_ID} cards per call`);
    }
    const reader = new CatalogReader(ctx);
    const out: Array<CatalogCardWithPath | null> = [];
    for (const raw of args.cardIds) {
      const id = ctx.db.normalizeId("cardChecklist", raw);
      const row = id ? await ctx.db.get(id) : null;
      out.push(row ? await reader.cardWithPath(row) : null);
    }
    return out;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Suggestions: players (with aliases), teams, sets
// ───────────────────────────────────────────────────────────────────────────

const playerSuggestionValidator = v.object({
  _id: v.id("players"),
  name: v.string(),
  sport: v.union(pathNodeValidator, v.null()),
  /** The alias the text matched ("Doc Gooden" for Dwight Gooden), if any. */
  matchedAlias: v.optional(v.string()),
});

const teamSuggestionValidator = v.object({
  _id: v.id("teams"),
  /** "San Diego Padres". */
  fullName: v.string(),
  /** "Padres". */
  name: v.string(),
  location: v.optional(v.string()),
  sport: v.union(pathNodeValidator, v.null()),
  primaryColor: v.optional(v.string()),
  secondaryColor: v.optional(v.string()),
  /** Its franchise, when it has one: offered as "include the whole franchise". */
  franchise: v.union(
    v.object({ _id: v.id("franchises"), name: v.string() }),
    v.null(),
  ),
});

/** A year typed as part of a set name: "2024", "1996-97", "2023-2024". */
const YEAR_TOKEN = /^\d{4}(-\d{2}|-\d{4})?$/;

async function suggestPlayers(ctx: Ctx, text: string, reader: CatalogReader) {
  const out: Array<typeof playerSuggestionValidator.type> = [];
  const seen = new Set<string>();
  const key = normalizeEntityName(text);
  if (key) {
    const aliasRows = await playerAliasRowsByPrefix(ctx, key, SUGGEST_LIMIT * 2);
    // Exact alias hits first, then prefix ones.
    aliasRows.sort(
      (a, b) =>
        Number(b.aliasNormalized === key) - Number(a.aliasNormalized === key),
    );
    for (const row of aliasRows) {
      if (out.length >= SUGGEST_LIMIT) break;
      if (seen.has(row.playerId as string)) continue;
      const player = await ctx.db.get(row.playerId);
      if (!player) continue;
      seen.add(player._id as string);
      const alias = (player.aliases ?? []).find(
        (a) => normalizeEntityName(a) === row.aliasNormalized,
      );
      const sport = await reader.row(player.sportId);
      out.push({
        _id: player._id,
        name: player.name,
        sport: sport ? { _id: sport._id, name: sport.value } : null,
        ...(alias ? { matchedAlias: alias } : {}),
      });
    }
  }
  if (out.length < SUGGEST_LIMIT) {
    const hits = await ctx.db
      .query("players")
      .withSearchIndex("search_name", (q) => q.search("name", text))
      .take(SUGGEST_LIMIT * 2);
    for (const player of hits) {
      if (out.length >= SUGGEST_LIMIT) break;
      if (seen.has(player._id as string)) continue;
      seen.add(player._id as string);
      const sport = await reader.row(player.sportId);
      out.push({
        _id: player._id,
        name: player.name,
        sport: sport ? { _id: sport._id, name: sport.value } : null,
      });
    }
  }
  return out;
}

async function suggestTeams(ctx: Ctx, text: string, reader: CatalogReader) {
  const out: Array<typeof teamSuggestionValidator.type> = [];
  const key = normalizeEntityName(text);
  if (!key) return out;
  const found: Array<Doc<"teams">> = [];
  const seen = new Set<string>();
  for (const team of await findTeamsByAliasPrefix(ctx, text, SUGGEST_LIMIT)) {
    if (seen.has(team._id as string)) continue;
    seen.add(team._id as string);
    found.push(team);
  }
  const hits = await ctx.db
    .query("teams")
    .withSearchIndex("search_name", (q) => q.search("nameNormalized", key))
    .take(SUGGEST_LIMIT * 2);
  for (const team of hits) {
    if (seen.has(team._id as string)) continue;
    seen.add(team._id as string);
    found.push(team);
  }
  const franchises = new Map<string, Doc<"franchises"> | null>();
  for (const team of found.slice(0, SUGGEST_LIMIT)) {
    let franchise: Doc<"franchises"> | null = null;
    if (team.franchiseId) {
      const fk = team.franchiseId as string;
      if (!franchises.has(fk)) franchises.set(fk, await ctx.db.get(team.franchiseId));
      franchise = franchises.get(fk) ?? null;
    }
    const sport = await reader.row(team.sportId);
    out.push({
      _id: team._id,
      fullName: teamFullName(team),
      name: team.name,
      ...(team.location ? { location: team.location } : {}),
      sport: sport ? { _id: sport._id, name: sport.value } : null,
      ...(team.colors?.primary ? { primaryColor: team.colors.primary } : {}),
      ...(team.colors?.secondary ? { secondaryColor: team.colors.secondary } : {}),
      franchise: franchise ? { _id: franchise._id, name: franchise.name } : null,
    });
  }
  return out;
}

async function suggestSets(ctx: Ctx, text: string, reader: CatalogReader) {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const years = tokens.filter((t) => YEAR_TOKEN.test(t));
  const words = tokens.filter((t) => !YEAR_TOKEN.test(t));
  if (words.length === 0) return [];
  const hits = await ctx.db
    .query("selectorOptions")
    .withSearchIndex("search_value", (q) =>
      q.search("value", words.join(" ")).eq("level", "setName"),
    )
    .take(50);
  const out: SetRef[] = [];
  for (const row of hits) {
    if (out.length >= SUGGEST_LIMIT) break;
    // NEO-358 — a set known to hold no cards is never offered.
    if (hiddenAsEmpty(row)) continue;
    const ref = await reader.setRef(row._id);
    if (!ref) continue;
    const haystack = [ref.manufacturer?.name ?? "", ref.name, ref.sport?.name ?? ""]
      .join(" ")
      .toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    const season = ref.season.toLowerCase();
    const yearName = ref.year?.name.toLowerCase() ?? "";
    if (
      !years.every(
        (y) => y === yearName || y === season || season.startsWith(y),
      )
    ) {
      continue;
    }
    out.push(ref);
  }
  return out;
}

/**
 * What the typed text could name, before any card search: players (by name or
 * alias, so "Doc Gooden" offers Dwight Gooden), teams (by name or alias), and
 * sets ("2024 Topps Chrome"; NEO-358: never a set known to hold no cards).
 * Empty under `MIN_QUERY_CHARS`.
 */
export const suggest = query({
  args: { q: v.string() },
  returns: v.object({
    players: v.array(playerSuggestionValidator),
    teams: v.array(teamSuggestionValidator),
    sets: v.array(setRefValidator),
  }),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const text = clampSearchQuery(args.q).replace(/["“”]/g, " ").trim();
    if (text.length < MIN_QUERY_CHARS) return { players: [], teams: [], sets: [] };
    const reader = new CatalogReader(ctx);
    return {
      players: await suggestPlayers(ctx, text, reader),
      teams: await suggestTeams(ctx, text, reader),
      sets: await suggestSets(ctx, text, reader),
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Free-text card search
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cards whose listing title holds every unquoted word (anywhere, any order)
 * and every quoted phrase (verbatim, case-insensitive). The index is searched
 * on the words; the rule is applied to the top `SEARCH_SCAN` hits.
 * `truncated` says more may exist than were returned.
 */
export const search = query({
  args: {
    q: v.string(),
    sportId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    cards: v.array(catalogCardWithPathValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const raw = clampSearchQuery(args.q);
    const parsed = parseTitleQuery(raw);
    if (isEmptyTitleQuery(parsed) || raw.trim().length < MIN_QUERY_CHARS) {
      return { cards: [], truncated: false };
    }
    const limit = clampInt(args.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
    const sportId = selectorId(ctx, args.sportId);
    if (args.sportId && !sportId) return { cards: [], truncated: false };
    const text = searchTextFor(parsed);
    const hits = await ctx.db
      .query("cardChecklist")
      .withSearchIndex("search_listing_title", (q) => {
        const s = q.search("listingTitle", text);
        return sportId ? s.eq("sportId", sportId) : s;
      })
      .take(SEARCH_SCAN);
    const matches = hits.filter((c) => titleMatches(c.listingTitle, parsed));
    const reader = new CatalogReader(ctx);
    const cards = [];
    for (const row of matches.slice(0, limit)) cards.push(await reader.cardWithPath(row));
    return {
      cards,
      truncated: matches.length > limit || hits.length >= SEARCH_SCAN,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// A player's cards, a team's cards
// ───────────────────────────────────────────────────────────────────────────

const entityCardsValidator = v.object({
  cards: v.array(catalogCardWithPathValidator),
  /** Pass back as `cursor` for the next page; null when there is no more. */
  continueCursor: v.union(v.string(), v.null()),
});

type PlayerCursor = { s: string; t: number };
type TeamCursor = { i: number; t: number };

function parseCursor<T>(raw: string | null | undefined, ok: (x: unknown) => x is T): T | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return ok(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlayerCursor(x: unknown): x is PlayerCursor {
  return (
    typeof x === "object" && x !== null &&
    typeof (x as PlayerCursor).s === "string" &&
    Number.isFinite((x as PlayerCursor).t)
  );
}

function isTeamCursor(x: unknown): x is TeamCursor {
  return (
    typeof x === "object" && x !== null &&
    Number.isInteger((x as TeamCursor).i) &&
    typeof (x as TeamCursor).t === "number"
  );
}

/**
 * A team cursor is caller-supplied: it is honoured only when it points INSIDE
 * this query's team list (`0 <= i < teamCount`) and carries a real creation
 * time (finite, not negative; `JSON.parse("1e999")` is Infinity). Anything
 * else starts from the first page, as a missing cursor does, rather than
 * reading `teamIds[-1]` (undefined) or skipping the list entirely.
 */
export function teamCursorInRange(
  cursor: TeamCursor | null,
  teamCount: number,
): TeamCursor | null {
  if (!cursor) return null;
  if (cursor.i < 0 || cursor.i >= teamCount) return null;
  if (!Number.isFinite(cursor.t) || cursor.t < 0) return null;
  return cursor;
}

async function hydrateLinked(
  ctx: Ctx,
  cardIds: Array<Id<"cardChecklist">>,
): Promise<CatalogCardWithPath[]> {
  const reader = new CatalogReader(ctx);
  const seen = new Set<string>();
  const out: CatalogCardWithPath[] = [];
  for (const id of cardIds) {
    if (seen.has(id as string)) continue;
    seen.add(id as string);
    const row: CardRow | null = await ctx.db.get(id);
    if (row) out.push(await reader.cardWithPath(row));
  }
  return out;
}

/**
 * Every card a player appears on (`cardPlayerLinks`), a page at a time, in
 * link order (by the card's sport, then when the link was made).
 */
export const cardsByPlayer = query({
  args: {
    playerId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: entityCardsValidator,
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const playerId = ctx.db.normalizeId("players", args.playerId);
    if (!playerId) return { cards: [], continueCursor: null };
    const limit = clampInt(args.limit, ENTITY_CARDS_DEFAULT_LIMIT, ENTITY_CARDS_MAX_LIMIT);
    const cursor = parseCursor(args.cursor, isPlayerCursor);
    const cursorSport = cursor ? selectorId(ctx, cursor.s) : null;
    const links = await cardPlayerLinkPage(
      ctx,
      playerId,
      cursor && cursorSport ? { sportId: cursorSport, creationTime: cursor.t } : null,
      limit + 1,
    );
    const page = links.slice(0, limit);
    const last = page[page.length - 1];
    return {
      cards: await hydrateLinked(ctx, page.map((l) => l.cardChecklistId)),
      continueCursor:
        links.length > limit && last
          ? JSON.stringify({ s: last.sportId, t: last._creationTime })
          : null,
    };
  },
});

/**
 * Every card carrying a team on its face (`cardTeamLinks`), a page at a time.
 * By default just that team; `includeFranchise` widens it to every team in the
 * team's franchise. `franchise` names the franchise the option would use
 * (null when the team has none), so the caller can offer it.
 */
export const cardsByTeam = query({
  args: {
    teamId: v.string(),
    includeFranchise: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    cards: v.array(catalogCardWithPathValidator),
    continueCursor: v.union(v.string(), v.null()),
    franchise: v.union(
      v.object({ _id: v.id("franchises"), name: v.string() }),
      v.null(),
    ),
  }),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const teamId = ctx.db.normalizeId("teams", args.teamId);
    const team = teamId ? await ctx.db.get(teamId) : null;
    if (!team) return { cards: [], continueCursor: null, franchise: null };
    const franchiseRow = team.franchiseId ? await ctx.db.get(team.franchiseId) : null;
    const franchise = franchiseRow
      ? { _id: franchiseRow._id, name: franchiseRow.name }
      : null;

    let teamIds: Array<Id<"teams">> = [team._id];
    if (args.includeFranchise && franchiseRow) {
      const members = await ctx.db
        .query("teams")
        .withIndex("by_franchise_id", (q) => q.eq("franchiseId", franchiseRow._id))
        .take(MAX_FRANCHISE_TEAMS);
      teamIds = members
        .map((m) => m._id)
        .sort((a, b) => (a as string).localeCompare(b as string));
      if (!teamIds.includes(team._id)) teamIds.unshift(team._id);
    }

    const limit = clampInt(args.limit, ENTITY_CARDS_DEFAULT_LIMIT, ENTITY_CARDS_MAX_LIMIT);
    const cursor = teamCursorInRange(parseCursor(args.cursor, isTeamCursor), teamIds.length);
    let index = cursor ? cursor.i : 0;
    let after = cursor ? cursor.t : null;
    const links: Array<Doc<"cardTeamLinks"> & { at: number }> = [];
    while (index < teamIds.length && links.length <= limit) {
      const id = teamIds[index];
      const since = after;
      const rows = await ctx.db
        .query("cardTeamLinks")
        .withIndex("by_team", (q) =>
          since === null ? q.eq("teamId", id) : q.eq("teamId", id).gt("_creationTime", since),
        )
        .take(limit + 1 - links.length);
      for (const row of rows) links.push({ ...row, at: index });
      if (links.length <= limit) {
        index += 1;
        after = null;
      }
    }
    const page = links.slice(0, limit);
    const last = page[page.length - 1];
    return {
      cards: await hydrateLinked(ctx, page.map((l) => l.cardChecklistId)),
      continueCursor:
        links.length > limit && last
          ? JSON.stringify({ i: last.at, t: last._creationTime })
          : null,
      franchise,
    };
  },
});
