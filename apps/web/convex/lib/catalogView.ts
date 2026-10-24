/**
 * NEO-358 — the collector's view of the NB catalog: the validators and the
 * read helpers behind `convex/collectionCatalog.ts` and `convex/collection.ts`.
 *
 * ## NB data only, by construction
 *
 * Every shape here is built field by field from NB's own rows. Nothing copies
 * a document wholesale, so no `platformData`, `platformLabels`,
 * `platformFacets`, `primaryPlatformId`, `platformSlotSeq`, `isCustom`,
 * `bscTeamName`, `pendingTeamNames`, `pendingPlayerNames`, `sku`, raw
 * marketplace `attributes` or `autographType` can reach a collector. The
 * `returns` validators below list exactly what leaves, and Convex refuses a
 * return value carrying anything else, so a later edit that spreads a row in
 * here fails loudly rather than leaking quietly.
 *
 * ## Bounded
 *
 * Each helper caches by id within one call (`CatalogReader`), so a page of
 * cards reads each player, team and ancestor row once. The caller bounds how
 * many cards it hydrates.
 */

import { v } from "convex/values";
import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { variantTypeKind, type VariantTypeKind } from "../variantRole";

type Ctx = Pick<QueryCtx, "db">;
type Row = Doc<"selectorOptions">;
type CardRow = Doc<"cardChecklist">;

/** Hops the ancestor walk takes before giving up (a `parentId` cycle). */
const MAX_ANCESTOR_DEPTH = 16;

// ───────────────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────────────

export const catalogLevelValidator = v.union(
  v.literal("sport"),
  v.literal("year"),
  v.literal("manufacturer"),
  v.literal("setName"),
  v.literal("variantType"),
  v.literal("insert"),
  v.literal("parallel"),
);

export const variantKindValidator = v.union(
  v.literal("base"),
  v.literal("insert"),
  v.literal("parallel"),
  v.null(),
);

/** One row in a path: its id and its NB name. */
export const pathNodeValidator = v.object({
  _id: v.id("selectorOptions"),
  name: v.string(),
});

/**
 * A set and where it sits. `season` is what collectors call the year
 * ("1996-97"): the set's own `features.season`, else the year row's name.
 * An ancestor that cannot be found (an orphaned subtree) is `null`.
 */
export const setRefValidator = v.object({
  _id: v.id("selectorOptions"),
  name: v.string(),
  season: v.string(),
  sport: v.union(pathNodeValidator, v.null()),
  year: v.union(pathNodeValidator, v.null()),
  manufacturer: v.union(pathNodeValidator, v.null()),
});

/**
 * The card-bearing row a card hangs off (a variant type such as Base, an
 * insert, or a sub-variant) and the rows above it inside its set.
 *
 * `kind` is the variant TYPE's kind (NEO-334, read from its title): Base,
 * Insert(s) or Parallel(s), else null. `cardCount` is the stored count of
 * every card, `baseCardCount` of the regular (non-variation) ones; each is
 * null when it has never been counted.
 */
export const variantRefValidator = v.object({
  _id: v.id("selectorOptions"),
  level: catalogLevelValidator,
  name: v.string(),
  kind: variantKindValidator,
  variantType: v.union(pathNodeValidator, v.null()),
  insert: v.union(pathNodeValidator, v.null()),
  parallel: v.union(pathNodeValidator, v.null()),
  cardCount: v.union(v.number(), v.null()),
  /** The stored count of its regular (non-variation) cards; null when never counted. */
  baseCardCount: v.union(v.number(), v.null()),
});

export const cardFeatureValidator = v.union(
  v.literal("RC"),
  v.literal("AU"),
  v.literal("Relic"),
  v.literal("SP"),
);

export const cardPlayerValidator = v.object({
  _id: v.id("players"),
  name: v.string(),
  /** The name the card printed, when it differs from the player's name. */
  nameOnCard: v.optional(v.string()),
});

export const cardTeamValidator = v.object({
  _id: v.id("teams"),
  /** The nickname ("Padres"). */
  name: v.string(),
  /** Where the team is from: a city, a school, a sponsor. */
  location: v.optional(v.string()),
  primaryColor: v.optional(v.string()),
  secondaryColor: v.optional(v.string()),
});

/** A card as a collector sees it, without its path. */
export const catalogCardFields = {
  _id: v.id("cardChecklist"),
  /** A string ("13b" exists), and never unique, even inside one set. */
  cardNumber: v.string(),
  cardName: v.string(),
  sortOrder: v.number(),
  /** The card-bearing row it hangs off (`cardChecklist.selectorOptionId`). */
  variantId: v.id("selectorOptions"),
  printRun: v.optional(v.number()),
  /** Image or photo variation name ("Sliding"). */
  cardVariation: v.optional(v.string()),
  /** Set on a variation: the regular card it is a variation of. */
  variationOfCardId: v.optional(v.id("cardChecklist")),
  features: v.array(cardFeatureValidator),
  /** NEO-363 — required on every card, never blank. */
  listingTitle: v.string(),
  players: v.array(cardPlayerValidator),
  teams: v.array(cardTeamValidator),
};
export const catalogCardValidator = v.object(catalogCardFields);

/** A card with its set and variant, for a list that mixes sets. */
export const catalogCardWithPathValidator = v.object({
  ...catalogCardFields,
  set: v.union(setRefValidator, v.null()),
  variant: v.union(variantRefValidator, v.null()),
});

export type PathNode = Infer<typeof pathNodeValidator>;
export type SetRef = Infer<typeof setRefValidator>;
export type VariantRef = Infer<typeof variantRefValidator>;
export type CatalogCard = Infer<typeof catalogCardValidator>;
export type CatalogCardWithPath = Infer<typeof catalogCardWithPathValidator>;
export type CardFeature = Infer<typeof cardFeatureValidator>;

// ───────────────────────────────────────────────────────────────────────────
// Pure pieces
// ───────────────────────────────────────────────────────────────────────────

/** The card's traits, from NB's own derived fields. */
export function cardFeatures(card: CardRow): CardFeature[] {
  const f = card.features ?? {};
  const out: CardFeature[] = [];
  if (card.isRookie === true || f.isRookie === "true") out.push("RC");
  if (f.autographed && f.autographed !== "None") out.push("AU");
  if (card.isRelic === true || f.isRelic === "true") out.push("Relic");
  if (f.shortPrint === "SP" || f.shortPrint === "SSP") out.push("SP");
  return out;
}

/** Order for a variant type's kind: Base, then Insert, then Parallel, then none. */
export function kindRank(kind: VariantTypeKind | undefined): number {
  if (kind === "base") return 0;
  if (kind === "insert") return 1;
  if (kind === "parallel") return 2;
  return 3;
}

function node(row: Row | undefined): PathNode | null {
  return row ? { _id: row._id, name: row.value } : null;
}

// ───────────────────────────────────────────────────────────────────────────
// The reader
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per-call cache over the rows a card list touches. One instance per query or
 * mutation; never shared across calls.
 */
export class CatalogReader {
  private rows = new Map<string, Row | null>();
  private players = new Map<string, Doc<"players"> | null>();
  private teams = new Map<string, Doc<"teams"> | null>();
  private chains = new Map<string, Map<string, Row> | null>();

  constructor(private readonly ctx: Ctx) {}

  async row(id: Id<"selectorOptions">): Promise<Row | null> {
    const key = id as string;
    if (!this.rows.has(key)) this.rows.set(key, await this.ctx.db.get(id));
    return this.rows.get(key) ?? null;
  }

  /**
   * The row and its ancestors keyed by level, nearest first wins. Null when
   * the row itself is gone.
   */
  async chain(id: Id<"selectorOptions">): Promise<Map<string, Row> | null> {
    const key = id as string;
    if (this.chains.has(key)) return this.chains.get(key) ?? null;
    const start = await this.row(id);
    if (!start) {
      this.chains.set(key, null);
      return null;
    }
    const byLevel = new Map<string, Row>();
    let cursor: Row | null = start;
    let depth = 0;
    while (cursor && depth < MAX_ANCESTOR_DEPTH) {
      if (!byLevel.has(cursor.level)) byLevel.set(cursor.level, cursor);
      if (cursor.level === "sport" || !cursor.parentId) break;
      cursor = await this.row(cursor.parentId);
      depth += 1;
    }
    this.chains.set(key, byLevel);
    return byLevel;
  }

  /** The set a row sits under (itself when it is one), as a `SetRef`. */
  async setRef(id: Id<"selectorOptions">): Promise<SetRef | null> {
    const chain = await this.chain(id);
    const set = chain?.get("setName");
    if (!chain || !set) return null;
    const year = chain.get("year");
    return {
      _id: set._id,
      name: set.value,
      season: set.features?.season ?? year?.value ?? "",
      sport: node(chain.get("sport")),
      year: node(year),
      manufacturer: node(chain.get("manufacturer")),
    };
  }

  /** A card-bearing row as a `VariantRef`. Null above the variant levels. */
  async variantRef(id: Id<"selectorOptions">): Promise<VariantRef | null> {
    const chain = await this.chain(id);
    const self = await this.row(id);
    if (!chain || !self) return null;
    if (
      self.level !== "variantType" &&
      self.level !== "insert" &&
      self.level !== "parallel"
    ) {
      return null;
    }
    const variantType = chain.get("variantType");
    return {
      _id: self._id,
      level: self.level,
      name: self.value,
      kind: variantTypeKind(variantType) ?? null,
      variantType: node(variantType),
      insert: node(chain.get("insert")),
      parallel: node(chain.get("parallel")),
      cardCount: self.cardCount ?? null,
      baseCardCount: self.nonVariationCardCount ?? null,
    };
  }

  private async player(id: Id<"players">): Promise<Doc<"players"> | null> {
    const key = id as string;
    if (!this.players.has(key)) this.players.set(key, await this.ctx.db.get(id));
    return this.players.get(key) ?? null;
  }

  private async team(id: Id<"teams">): Promise<Doc<"teams"> | null> {
    const key = id as string;
    if (!this.teams.has(key)) this.teams.set(key, await this.ctx.db.get(id));
    return this.teams.get(key) ?? null;
  }

  /** A card row as a collector sees it. A vanished player or team is skipped. */
  async card(card: CardRow): Promise<CatalogCard> {
    const links =
      card.playerLinks ??
      (card.playerIds ?? []).map((playerId) => ({ playerId, nameOnCard: "" }));
    const seenPlayers = new Set<string>();
    const players: CatalogCard["players"] = [];
    for (const link of links) {
      if (seenPlayers.has(link.playerId as string)) continue;
      seenPlayers.add(link.playerId as string);
      const p = await this.player(link.playerId);
      if (!p) continue;
      const printed = link.nameOnCard.trim();
      players.push({
        _id: p._id,
        name: p.name,
        ...(printed && printed !== p.name ? { nameOnCard: printed } : {}),
      });
    }
    const seenTeams = new Set<string>();
    const teams: CatalogCard["teams"] = [];
    for (const teamId of card.teamOnCardIds ?? []) {
      if (seenTeams.has(teamId as string)) continue;
      seenTeams.add(teamId as string);
      const t = await this.team(teamId);
      if (!t) continue;
      teams.push({
        _id: t._id,
        name: t.name,
        ...(t.location ? { location: t.location } : {}),
        ...(t.colors?.primary ? { primaryColor: t.colors.primary } : {}),
        ...(t.colors?.secondary ? { secondaryColor: t.colors.secondary } : {}),
      });
    }
    return {
      _id: card._id,
      cardNumber: card.cardNumber,
      cardName: card.cardName,
      sortOrder: card.sortOrder,
      variantId: card.selectorOptionId,
      ...(card.printRun !== undefined ? { printRun: card.printRun } : {}),
      ...(card.cardVariation ? { cardVariation: card.cardVariation } : {}),
      ...(card.variationOfCardId
        ? { variationOfCardId: card.variationOfCardId }
        : {}),
      features: cardFeatures(card),
      listingTitle: card.listingTitle,
      players,
      teams,
    };
  }

  /** A card with its set and variant. */
  async cardWithPath(card: CardRow): Promise<CatalogCardWithPath> {
    return {
      ...(await this.card(card)),
      set: await this.setRef(card.selectorOptionId),
      variant: await this.variantRef(card.selectorOptionId),
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Counts
// ───────────────────────────────────────────────────────────────────────────

/** A row's two counts: every card, and the regular (non-variation) cards. */
export type CardTotals = { all: number | null; base: number | null };

/**
 * How many cards hang off a row, both ways: `all` is every card row
 * (`cardCount`), `base` the ones with no `variationOfCardId`
 * (`nonVariationCardCount`). A stored value wins; an absent one is counted by
 * hand on `by_selector_option` while `budget.left` allows, else null.
 *
 * The fallback exists for rows written before NEO-358's ledger and not yet
 * reached by `backfillVariantCardCounts`. It is never written back from a
 * query.
 */
export async function cardTotals(
  ctx: Ctx,
  row: Row,
  budget: { left: number },
): Promise<CardTotals> {
  const storedAll = typeof row.cardCount === "number" ? row.cardCount : null;
  const storedBase =
    typeof row.nonVariationCardCount === "number"
      ? row.nonVariationCardCount
      : null;
  if (storedAll !== null && storedBase !== null) {
    return { all: storedAll, base: storedBase };
  }
  if (budget.left <= 0) return { all: storedAll, base: storedBase };
  const cap = budget.left;
  const rows = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", row._id))
    .take(cap + 1);
  budget.left -= Math.min(rows.length, cap);
  if (rows.length > cap) return { all: storedAll, base: storedBase };
  return {
    all: storedAll ?? rows.length,
    base: storedBase ?? rows.filter((r) => !r.variationOfCardId).length,
  };
}
