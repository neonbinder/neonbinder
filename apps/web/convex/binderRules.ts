/**
 * NEO-362 — smart binders: a binder the collector made, carrying a rule that
 * HELPS fill it (Jason, 2026-10-27). The rule never moves a card. It drives:
 *
 *   - "Find cards for this binder" (`findCards`): the collector's own copies
 *     that fit the rule and live anywhere else (another binder, Main, a box),
 *     each with its home, so they can be moved here. Never run on its own.
 *   - Declines (`decline`, `undecline`, `declined`): per binder, per CARD.
 *     Find cards leaves a declined card out; the Declined view lists them so
 *     one can be pulled back in.
 *   - The Checklists filter and "outside the rule" (`matchingCards`): which
 *     of some cards fit the rule.
 *   - Empty slots (`needs`): the catalog cards a binder is missing, for a
 *     smart binder every card its rule matches, for a binder sorted by
 *     checklist every card of the checklists it holds.
 *
 * Every function is signed-in and reads ONLY the caller's rows; a binder that
 * is not theirs reads like one that does not exist. The rule is evaluated by
 * `lib/collection/binder-rule.ts` over a card's NB facts (`FactReader`):
 * players, the teams printed on the card, the players' stints, the set,
 * brand, year and sport the card files under, its features, its print run.
 * NB data only, keyed on ids: no marketplace field is read here.
 */

import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import { cardPlayerLinkPage } from "./cardPlayerLinks";
import { cardIdsForTeam } from "./cardTeamLinks";
import { COLLECTION_ERRORS, MAX_LINES_PER_CARD, copyOut, copyValidator, refuse } from "./collection";
import { MAX_DRILL_ITEMS, MAX_VARIANT_CARDS, walkSetVariants } from "./collectionCatalog";
import { CatalogReader, cardFeatures, catalogCardWithPathValidator } from "./lib/catalogView";
import type { collectionRuleValidator } from "./schema";
import { teamFullName } from "../lib/teams/team-name";
import {
  MAX_RULE_IDS,
  MAX_SORTED_LINES,
  ruleIds,
  ruleMatches,
  ruleProblem,
  yearOfSeason,
  type CardFacts,
  type StoredRule,
  type StoredRuleLeaf,
} from "../lib/collection/binder-rule";

type Ctx = Pick<QueryCtx, "db">;
type CardRow = Doc<"cardChecklist">;
type ContainerRow = Doc<"collectionContainers">;
export type Rule = typeof collectionRuleValidator.type;

/** Declines one binder may hold. */
export const MAX_DECLINES = 2000;
/** Empty slots one read returns: a hundred pages of nine. */
export const MAX_NEEDS = 900;
/** Cards one `matchingCards` call checks. */
export const MAX_MATCH_CARDS = 200;
/** Copies one Find cards page reads. */
export const MAX_FIND_PAGE = 100;
export { MAX_SORTED_LINES };
/** Checklists a binder sorted by checklist draws empty slots for. */
export const MAX_NEED_CHECKLISTS = 30;
/** Catalog cards one empty-slot read may look at before it stops early. */
const MAX_CANDIDATES = 4000;
/** Lines of one card the Declined view lists. */
const DECLINED_LINES_PER_CARD = 10;

// ───────────────────────────────────────────────────────────────────────────
// A card's facts
// ───────────────────────────────────────────────────────────────────────────

/** Reads what a rule needs to know about cards, caching every row it touches. One per call. */
export class FactReader {
  readonly catalog: CatalogReader;
  private players = new Map<string, Doc<"players"> | null>();

  constructor(private readonly ctx: Ctx) {
    this.catalog = new CatalogReader(ctx);
  }

  private async player(id: Id<"players">): Promise<Doc<"players"> | null> {
    const key = id as string;
    if (!this.players.has(key)) this.players.set(key, await this.ctx.db.get(id));
    return this.players.get(key) ?? null;
  }

  async facts(card: CardRow): Promise<CardFacts> {
    const playerIds = new Set<string>();
    for (const id of card.playerIds ?? []) playerIds.add(id as string);
    for (const link of card.playerLinks ?? []) playerIds.add(link.playerId as string);
    const playedForIds = new Set<string>();
    let hallOfFame = false;
    for (const id of playerIds) {
      const player = await this.player(id as Id<"players">);
      if (!player) continue;
      if (player.isHallOfFame) hallOfFame = true;
      for (const stint of player.teamYears ?? []) playedForIds.add(stint.teamId as string);
    }
    const chain = await this.catalog.chain(card.selectorOptionId);
    const set = chain?.get("setName");
    const yearRow = chain?.get("year");
    const season = set?.features?.season ?? yearRow?.value;
    return {
      playerIds,
      teamIds: new Set((card.teamOnCardIds ?? []).map((id) => id as string)),
      playedForIds,
      hallOfFame,
      sportId: (chain?.get("sport")?._id as string | undefined) ?? null,
      brandId: (chain?.get("manufacturer")?._id as string | undefined) ?? null,
      setId: (set?._id as string | undefined) ?? null,
      year: yearOfSeason(season),
      features: new Set(cardFeatures(card)),
      printRun: typeof card.printRun === "number" && card.printRun > 0 ? card.printRun : null,
    };
  }

  async matches(rule: Rule, card: CardRow): Promise<boolean> {
    return ruleMatches(rule as StoredRule, await this.facts(card));
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Checking and naming a rule
// ───────────────────────────────────────────────────────────────────────────

const LEVEL_OF: Partial<Record<StoredRuleLeaf["kind"], string>> = {
  sport: "sport",
  brand: "manufacturer",
  set: "setName",
};

function dedupe<T extends string>(ids: readonly T[]): T[] {
  return [...new Set(ids)];
}

/**
 * The rule as stored: checked (`ruleProblem`), every id the right kind of
 * row and still there, id lists without repeats. Refuses with the words to
 * show.
 */
export async function cleanRule(ctx: Ctx, raw: Rule): Promise<Rule> {
  const terms = raw.terms.map((term) => {
    const test = term.test;
    const out =
      test.kind === "player"
        ? { ...test, playerIds: dedupe(test.playerIds) }
        : test.kind === "team" || test.kind === "playedFor"
          ? { ...test, teamIds: dedupe(test.teamIds) }
          : test.kind === "sport"
            ? { ...test, sportIds: dedupe(test.sportIds) }
            : test.kind === "brand"
              ? { ...test, brandIds: dedupe(test.brandIds) }
              : test.kind === "set"
                ? { ...test, setIds: dedupe(test.setIds) }
                : test;
    return { ...(term.negate ? { negate: true as const } : {}), test: out };
  });
  const rule: Rule = { version: 1, match: raw.match, terms };
  const problem = ruleProblem(rule as StoredRule);
  if (problem) refuse(COLLECTION_ERRORS.invalid, problem);
  for (const { test } of rule.terms) {
    if (test.kind === "player") {
      for (const id of test.playerIds) {
        if (!(await ctx.db.get(id))) refuse(COLLECTION_ERRORS.invalid, "One of the rule's players isn't in NB anymore. Pick them again.");
      }
    }
    if (test.kind === "team" || test.kind === "playedFor") {
      for (const id of test.teamIds) {
        if (!(await ctx.db.get(id))) refuse(COLLECTION_ERRORS.invalid, "One of the rule's teams isn't in NB anymore. Pick it again.");
      }
    }
    const level = LEVEL_OF[test.kind];
    if (level) {
      const ids =
        test.kind === "sport" ? test.sportIds : test.kind === "brand" ? test.brandIds : test.kind === "set" ? test.setIds : [];
      for (const id of ids) {
        const row = await ctx.db.get(id);
        if (!row || row.level !== level) {
          refuse(COLLECTION_ERRORS.invalid, `One of the rule's ${test.kind}s isn't in NB anymore. Pick it again.`);
        }
      }
    }
  }
  return rule;
}

export const ruleNameValidator = v.object({ id: v.string(), name: v.string() });

/**
 * What each id a rule names reads as, for the rule in words: a player's
 * name, a team's full name, a set as "2024 Topps Chrome", a brand or sport
 * row's value. An id that no longer resolves is left out (the words say
 * "a player that's gone").
 */
export async function ruleNames(ctx: Ctx, rule: Rule): Promise<Array<typeof ruleNameValidator.type>> {
  const ids = ruleIds(rule as StoredRule);
  const reader = new CatalogReader(ctx);
  const out: Array<typeof ruleNameValidator.type> = [];
  for (const raw of ids.players) {
    const id = ctx.db.normalizeId("players", raw);
    const row = id ? await ctx.db.get(id) : null;
    if (row) out.push({ id: raw, name: row.name });
  }
  for (const raw of ids.teams) {
    const id = ctx.db.normalizeId("teams", raw);
    const row = id ? await ctx.db.get(id) : null;
    if (row) out.push({ id: raw, name: teamFullName(row) });
  }
  for (const raw of ids.options) {
    const id = ctx.db.normalizeId("selectorOptions", raw);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) continue;
    if (row.level === "setName") {
      const set = await reader.setRef(row._id);
      out.push({ id: raw, name: set ? `${set.season} ${set.manufacturer?.name ?? ""} ${set.name}`.replace(/\s+/g, " ").trim() : row.value });
    } else {
      out.push({ id: raw, name: row.value });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// The catalog side: which cards a rule could match
// ───────────────────────────────────────────────────────────────────────────

/** A leaf the catalog can be walked from without reading every card. */
function walkable(leaf: StoredRuleLeaf): boolean {
  return leaf.kind === "player" || leaf.kind === "team" || leaf.kind === "set" || leaf.kind === "brand";
}

const WALK_PREFERENCE: Array<StoredRuleLeaf["kind"]> = ["set", "player", "team", "brand"];

async function cardsUnderSet(
  ctx: Ctx,
  setId: Id<"selectorOptions">,
  add: (id: Id<"cardChecklist">) => boolean,
): Promise<void> {
  await walkSetVariants(ctx, setId, async (row) => {
    const cards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", row._id))
      .take(MAX_VARIANT_CARDS);
    for (const card of cards) if (!add(card._id)) return false;
    return true;
  });
}

/** Cards a walkable leaf names, through `add` (false stops the walk). */
async function leafCards(
  ctx: Ctx,
  leaf: StoredRuleLeaf,
  add: (id: Id<"cardChecklist">) => boolean,
): Promise<void> {
  if (leaf.kind === "player") {
    for (const raw of leaf.playerIds) {
      const id = ctx.db.normalizeId("players", raw);
      if (!id) continue;
      const links = await cardPlayerLinkPage(ctx, id, null, MAX_CANDIDATES);
      for (const link of links) if (!add(link.cardChecklistId)) return;
    }
  } else if (leaf.kind === "team") {
    for (const raw of leaf.teamIds) {
      const id = ctx.db.normalizeId("teams", raw);
      if (!id) continue;
      for (const cardId of await cardIdsForTeam(ctx, id, MAX_CANDIDATES)) if (!add(cardId)) return;
    }
  } else if (leaf.kind === "set") {
    for (const raw of leaf.setIds) {
      const id = ctx.db.normalizeId("selectorOptions", raw);
      if (id) await cardsUnderSet(ctx, id, add);
    }
  } else if (leaf.kind === "brand") {
    for (const raw of leaf.brandIds) {
      const id = ctx.db.normalizeId("selectorOptions", raw);
      if (!id) continue;
      const sets = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) => q.eq("level", "setName").eq("parentId", id))
        .take(MAX_DRILL_ITEMS);
      for (const set of sets) await cardsUnderSet(ctx, set._id, add);
    }
  }
}

/**
 * The catalog cards worth testing against a rule: one walkable leaf's cards
 * for an all-of rule, every leaf's for an any-of rule. `supported: false`
 * when the rule has no such way in (only years, a sport, features, a print
 * run, Hall of Fame or "played for"): the catalog is too big to test card by
 * card, so those rules show no empty slots. `complete: false` when the walk
 * stopped at `MAX_CANDIDATES`.
 */
export async function catalogCandidates(
  ctx: Ctx,
  rule: Rule,
): Promise<{ cardIds: Array<Id<"cardChecklist">>; supported: boolean; complete: boolean }> {
  const positive = rule.terms.filter((t) => !t.negate).map((t) => t.test as StoredRuleLeaf);
  let leaves: StoredRuleLeaf[] = [];
  if (rule.match === "all") {
    for (const kind of WALK_PREFERENCE) {
      const leaf = positive.find((l) => l.kind === kind);
      if (leaf) {
        leaves = [leaf];
        break;
      }
    }
  } else if (rule.terms.every((t) => !t.negate && walkable(t.test as StoredRuleLeaf))) {
    leaves = positive;
  }
  if (leaves.length === 0) return { cardIds: [], supported: false, complete: true };
  const seen = new Set<string>();
  const cardIds: Array<Id<"cardChecklist">> = [];
  let complete = true;
  const add = (id: Id<"cardChecklist">) => {
    if (seen.has(id as string)) return true;
    if (cardIds.length >= MAX_CANDIDATES) {
      complete = false;
      return false;
    }
    seen.add(id as string);
    cardIds.push(id);
    return true;
  };
  for (const leaf of leaves) {
    if (!complete) break;
    await leafCards(ctx, leaf, add);
  }
  return { cardIds, supported: true, complete };
}

// ───────────────────────────────────────────────────────────────────────────
// Reads
// ───────────────────────────────────────────────────────────────────────────

/** The caller's own binder (never Main, a box or a shelf), or null. */
async function ownBinder(ctx: Ctx, ownerId: string, raw: string): Promise<ContainerRow | null> {
  const id = ctx.db.normalizeId("collectionContainers", raw);
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.ownerId !== ownerId || row.kind !== "binder") return null;
  if (row.system === "want" || row.system === "trade") return null;
  return row;
}

async function declinedIds(ctx: Ctx, ownerId: string, binderId: Id<"collectionContainers">): Promise<Set<string>> {
  const rows = await ctx.db
    .query("collectionBinderDeclines")
    .withIndex("by_owner_binder_card", (q) => q.eq("ownerId", ownerId).eq("binderId", binderId))
    .take(MAX_DECLINES);
  return new Set(rows.map((r) => r.cardId as string));
}

/**
 * Which of `cardIds` fit the binder's rule, in the order asked. A binder
 * without a rule (or not the caller's) fits nothing; a bad id or a private
 * card never fits. At most `MAX_MATCH_CARDS` ids.
 */
export const matchingCards = query({
  args: { containerId: v.string(), cardIds: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    if (args.cardIds.length > MAX_MATCH_CARDS) {
      refuse(COLLECTION_ERRORS.invalid, `At most ${MAX_MATCH_CARDS} cards per call.`);
    }
    const binder = await ownBinder(ctx, ownerId, args.containerId);
    if (!binder?.rule) return [];
    const facts = new FactReader(ctx);
    const out: string[] = [];
    for (const raw of args.cardIds) {
      const id = ctx.db.normalizeId("cardChecklist", raw);
      const card = id ? await ctx.db.get(id) : null;
      if (card && (await facts.matches(binder.rule, card))) out.push(raw);
    }
    return out;
  },
});

const needValidator = v.object({
  card: catalogCardWithPathValidator,
  /** The collector has a copy of it in a binder somewhere (not this one). */
  held: v.boolean(),
});

export const needsResultValidator = v.object({
  needs: v.array(needValidator),
  /** False when the rule has no way into the catalog (see `catalogCandidates`). */
  supported: v.boolean(),
  /** True when there are more than were returned (`MAX_NEEDS`, or a walk cut short). */
  truncated: v.boolean(),
});

/**
 * The catalog cards a binder's empty slots stand for, every one NOT in the
 * binder: for a smart binder, the cards its rule matches; otherwise (a
 * binder sorted by checklist) the non-variation cards of each checklist it
 * holds a card from, at most `MAX_NEED_CHECKLISTS` of them. `held` says the
 * collector has the card in another binder (`ownerHeld`: null on a public
 * read, which never learns it).
 */
export async function binderNeeds(
  ctx: Ctx,
  binder: ContainerRow,
  ownerHeld: ((cardId: Id<"cardChecklist">) => Promise<boolean>) | null,
): Promise<typeof needsResultValidator.type> {
  const lines = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", binder.ownerId).eq("homeId", binder._id))
    .take(MAX_SORTED_LINES + 1);
  const here = new Set(lines.map((l) => l.cardId as string));
  const facts = new FactReader(ctx);
  const needs: Array<typeof needValidator.type> = [];
  let truncated = false;
  const take = async (card: CardRow): Promise<boolean> => {
    if (here.has(card._id as string)) return true;
    if (needs.length >= MAX_NEEDS) {
      truncated = true;
      return false;
    }
    needs.push({
      card: await facts.catalog.cardWithPath(card),
      held: ownerHeld ? await ownerHeld(card._id) : false,
    });
    return true;
  };
  if (binder.rule) {
    const candidates = await catalogCandidates(ctx, binder.rule);
    if (!candidates.supported) return { needs: [], supported: false, truncated: false };
    if (!candidates.complete) truncated = true;
    for (const id of candidates.cardIds) {
      const card = await ctx.db.get(id);
      if (!card || !(await facts.matches(binder.rule, card))) continue;
      if (!(await take(card))) break;
    }
    return { needs, supported: true, truncated };
  }
  const variants: Array<Id<"selectorOptions">> = [];
  for (const line of lines) {
    if (line.variantId && !variants.includes(line.variantId)) variants.push(line.variantId);
  }
  if (variants.length > MAX_NEED_CHECKLISTS) truncated = true;
  outer: for (const variantId of variants.slice(0, MAX_NEED_CHECKLISTS)) {
    const cards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", variantId))
      .take(MAX_VARIANT_CARDS);
    for (const card of cards) {
      if (card.variationOfCardId) continue;
      if (!(await take(card))) break outer;
    }
  }
  return { needs, supported: true, truncated };
}

/** Does the owner hold `cardId` in a binder (any but `except`)? Cached per call. */
function heldInBinders(ctx: Ctx, ownerId: string, except: Id<"collectionContainers">) {
  const kinds = new Map<string, ContainerRow | null>();
  return async (cardId: Id<"cardChecklist">) => {
    const lines = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
      .take(MAX_LINES_PER_CARD);
    for (const line of lines) {
      if (line.homeId === except || line.quantity < 1) continue;
      const key = line.homeId as string;
      if (!kinds.has(key)) kinds.set(key, await ctx.db.get(line.homeId));
      if (kinds.get(key)?.kind === "binder") return true;
    }
    return false;
  };
}

/** The caller's binder's empty slots (see `binderNeeds`). Empty for anything else. */
export const needs = query({
  args: { containerId: v.string() },
  returns: needsResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const binder = await ownBinder(ctx, ownerId, args.containerId);
    if (!binder) return { needs: [], supported: true, truncated: false };
    return await binderNeeds(ctx, binder, heldInBinders(ctx, ownerId, binder._id));
  },
});

/**
 * "Find cards for this binder": the caller's copies that fit the rule and
 * live anywhere but this binder (Main, another binder, a box), a page of
 * their collection at a time in card order. A page reads up to
 * `MAX_FIND_PAGE` copies and returns the ones that fit, so a page may hold
 * none while more remain: keep loading until `isDone`. A declined card is
 * left out; a private card (NEO-361) never fits. Empty for a binder without
 * a rule.
 */
export const findCards = query({
  args: { containerId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(copyValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const binder = await ownBinder(ctx, ownerId, args.containerId);
    if (!binder?.rule) return { page: [], isDone: true, continueCursor: "" };
    const rule = binder.rule;
    const declined = await declinedIds(ctx, ownerId, binder._id);
    const result = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.max(1, Math.min(Math.floor(args.paginationOpts.numItems), MAX_FIND_PAGE)),
      });
    const facts = new FactReader(ctx);
    const verdicts = new Map<string, boolean>();
    const homes = new Map<string, ContainerRow | null>();
    const page: Array<typeof copyValidator.type> = [];
    for (const line of result.page) {
      if (line.homeId === binder._id || line.quantity < 1) continue;
      const cardKey = line.cardId as string;
      if (declined.has(cardKey)) continue;
      const homeKey = line.homeId as string;
      if (!homes.has(homeKey)) homes.set(homeKey, await ctx.db.get(line.homeId));
      const home = homes.get(homeKey);
      if (!home || home.system === "want" || home.system === "trade") continue;
      if (!verdicts.has(cardKey)) {
        const id = ctx.db.normalizeId("cardChecklist", cardKey);
        const card = id ? await ctx.db.get(id) : null;
        verdicts.set(cardKey, !!card && (await facts.matches(rule, card)));
      }
      if (verdicts.get(cardKey)) page.push(copyOut(line));
    }
    return { ...result, page };
  },
});

/**
 * The cards declined for this binder, newest decline first, each with the
 * caller's copies of it (up to ten lines, wherever they live) so one can be
 * pulled back in.
 */
export const declined = query({
  args: { containerId: v.string() },
  returns: v.array(v.object({ cardId: v.id("cardChecklist"), copies: v.array(copyValidator) })),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const binder = await ownBinder(ctx, ownerId, args.containerId);
    if (!binder) return [];
    const rows = await ctx.db
      .query("collectionBinderDeclines")
      .withIndex("by_owner_binder_card", (q) => q.eq("ownerId", ownerId).eq("binderId", binder._id))
      .take(MAX_DECLINES);
    rows.sort((a, b) => b.declinedAt - a.declinedAt);
    const out = [];
    for (const row of rows) {
      // A card that left the catalog is no choice to make (the wipe leaves the row).
      if (!(await ctx.db.get(row.cardId))) continue;
      const lines = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", row.cardId))
        .take(DECLINED_LINES_PER_CARD);
      out.push({ cardId: row.cardId, copies: lines.map(copyOut) });
    }
    return out;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Writes
// ───────────────────────────────────────────────────────────────────────────

async function ownSmartBinder(ctx: MutationCtx, ownerId: string, containerId: Id<"collectionContainers">) {
  const row = await ctx.db.get(containerId);
  if (!row || row.ownerId !== ownerId) {
    refuse(COLLECTION_ERRORS.notFound, "That binder isn't in your collection.");
  }
  if (!row.rule) refuse(COLLECTION_ERRORS.invalid, `${row.name} has no rule, so there's nothing to decline.`);
  return row;
}

/** Leave a card out of this binder's Find cards. Idempotent. */
export const decline = mutation({
  args: { containerId: v.id("collectionContainers"), cardId: v.id("cardChecklist") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const binder = await ownSmartBinder(ctx, ownerId, args.containerId);
    const existing = await ctx.db
      .query("collectionBinderDeclines")
      .withIndex("by_owner_binder_card", (q) =>
        q.eq("ownerId", ownerId).eq("binderId", binder._id).eq("cardId", args.cardId),
      )
      .first();
    if (existing) return null;
    const count = await ctx.db
      .query("collectionBinderDeclines")
      .withIndex("by_owner_binder_card", (q) => q.eq("ownerId", ownerId).eq("binderId", binder._id))
      .take(MAX_DECLINES);
    if (count.length >= MAX_DECLINES) {
      refuse(COLLECTION_ERRORS.limit, `${binder.name} has ${MAX_DECLINES} declined cards already. Pull some back in first.`);
    }
    await ctx.db.insert("collectionBinderDeclines", {
      ownerId,
      binderId: binder._id,
      cardId: args.cardId,
      declinedAt: Date.now(),
    });
    return null;
  },
});

/** Pull a declined card back into this binder's Find cards. Idempotent. */
export const undecline = mutation({
  args: { containerId: v.id("collectionContainers"), cardId: v.id("cardChecklist") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const rows = await ctx.db
      .query("collectionBinderDeclines")
      .withIndex("by_owner_binder_card", (q) =>
        q.eq("ownerId", ownerId).eq("binderId", args.containerId).eq("cardId", args.cardId),
      )
      .take(2);
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

/** Every decline of a binder, gone (its rule was taken off, or it was deleted). */
export async function forgetDeclines(
  ctx: MutationCtx,
  ownerId: string,
  binderId: Id<"collectionContainers">,
): Promise<void> {
  const rows = await ctx.db
    .query("collectionBinderDeclines")
    .withIndex("by_owner_binder_card", (q) => q.eq("ownerId", ownerId).eq("binderId", binderId))
    .take(MAX_DECLINES);
  for (const row of rows) await ctx.db.delete(row._id);
}

/** Years one brand lookup walks, and brands it reads under each. */
const MAX_BRAND_YEARS = 200;
const MAX_BRANDS_PER_YEAR = 100;

/**
 * A sport's brands for the rule builder: NB keeps a brand row per year
 * ("Topps" under 1986, "Topps" under 2024), so a brand line names every
 * year's row of the brand. Grouped by the row's own NB name, folded for
 * case; the rule then stores the ids, never the name.
 */
export const brandsOfSport = query({
  args: { sportId: v.id("selectorOptions") },
  returns: v.array(v.object({ name: v.string(), ids: v.array(v.id("selectorOptions")) })),
  handler: async (ctx, { sportId }) => {
    await requireSignedIn(ctx);
    const sport = await ctx.db.get(sportId);
    if (!sport || sport.level !== "sport") return [];
    const years = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) => q.eq("level", "year").eq("parentId", sportId))
      .take(MAX_BRAND_YEARS);
    const byName = new Map<string, { name: string; ids: Id<"selectorOptions">[] }>();
    for (const year of years) {
      const brands = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) => q.eq("level", "manufacturer").eq("parentId", year._id))
        .take(MAX_BRANDS_PER_YEAR);
      for (const brand of brands) {
        const key = brand.value.trim().toLowerCase();
        const group = byName.get(key);
        if (group) group.ids.push(brand._id);
        else byName.set(key, { name: brand.value.trim(), ids: [brand._id] });
      }
    }
    return [...byName.values()]
      .map((g) => ({ name: g.name, ids: g.ids.slice(0, MAX_RULE_IDS) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
