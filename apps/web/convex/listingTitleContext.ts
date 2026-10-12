/**
 * NEO-335 — the server half of the wizard's pre-save "Card titles" step.
 *
 * The step titles cards that are not rows yet, in the browser, with the same
 * pure code the insert uses (`features/listingInputs.ts`). What the browser
 * cannot work out for itself is the set's facts and the CANONICAL names behind
 * the printed ones — the title says "Dwight Gooden", not the "Doc Gooden" a
 * card prints. This module assembles that `TitleContext`, once, and
 * `resolveChecklistEntities` hands it back beside the unknown names, so the
 * wizard opens with everything it needs and makes no second round trip.
 *
 * ## The set facts mirror the commit prelude, not `findAncestorLabels`
 *
 * `commitCardChecklistPrelude` is what the insert's titles are actually built
 * from: the leaf's own `features` snapshot, the NEAREST `setName` ancestor's
 * value, that set's parent manufacturer ROLE (NEO-272), the sport row's value,
 * the chain's insert role, parallel leaf and short name (NEO-335,
 * `listingShortName.titleChainFacts`), and (NEO-277, in the chunk) the leaf's
 * set-level teams. `titleSetFacts`
 * reads exactly those, the same way, so a title shown before save is the
 * title written at insert.
 *
 * ## The names come from the resolve gate itself
 *
 * `resolveUnknownsAndStartBatch` already asks, for every printed name, "does
 * this resolve to one NB row?" — it is the gate that decides which names reach
 * the wizard at all. It records the ids it resolved, and this module turns
 * them into names. No second resolution, so the context can never claim a
 * name resolved that the gate sent to the wizard, or the reverse.
 */

import { internalQuery, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { inheritedTeamIds } from "./lib/selectorTeams";
import { teamFullName } from "../lib/teams/team-name";
import type { TitleContext } from "./features/listingInputs";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import { titleChainFacts, titleChainFactsFields } from "./listingShortName";

/** Player ids read per `playerNamesByIds` call: one transaction's budget. */
export const TITLE_CONTEXT_PLAYER_PAGE = 200;

/** Depth cap on the ancestor walk, as the prelude's sibling walks have. */
const MAX_ANCESTOR_DEPTH = 16;

const nameMapValidator = v.array(v.object({ printed: v.string(), name: v.string() }));

/** The wire shape of `TitleContext`. */
export const titleContextValidator = v.object({
  sportValue: v.string(),
  setNameValue: v.optional(v.string()),
  manufacturerBrandUnknown: v.optional(v.boolean()),
  inheritedFeatures: v.optional(v.record(v.string(), v.string())),
  // NEO-335 — the insert role, a parallel leaf, the nearest short name.
  ...titleChainFactsFields,
  setTeamNames: v.array(v.string()),
  players: nameMapValidator,
  teams: nameMapValidator,
});

const setFactsValidator = v.object({
  sportValue: v.string(),
  setNameValue: v.optional(v.string()),
  manufacturerBrandUnknown: v.optional(v.boolean()),
  inheritedFeatures: v.optional(v.record(v.string(), v.string())),
  ...titleChainFactsFields,
  setTeamNames: v.array(v.string()),
});

/**
 * The set-level facts a new card's title reads — see the module note for why
 * these mirror `commitCardChecklistPrelude` line for line.
 *
 * Internal: it trusts its arguments. `resolveChecklistEntities` calls it after
 * `requireAdmin` and after proving `sportId` is the leaf's own sport.
 */
export const titleSetFacts = internalQuery({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    sportId: v.id("selectorOptions"),
  },
  returns: setFactsValidator,
  handler: async (ctx, args) => {
    const leaf = await ctx.db.get(args.selectorOptionId);
    const inheritedFeatures =
      leaf?.features && Object.keys(leaf.features).length > 0 ? leaf.features : undefined;

    let setNameNode: Doc<"selectorOptions"> | null =
      leaf?.level === "setName" ? leaf : null;
    // NEO-335 — the rows walked, leaf first up to the setName row, for the
    // title's chain facts; the prelude reads the same rows the same way.
    const titleChain: Array<Doc<"selectorOptions"> | null> = [leaf];
    let cursorId: Id<"selectorOptions"> | undefined = setNameNode ? undefined : leaf?.parentId;
    let depth = 0;
    while (!setNameNode && cursorId && depth < MAX_ANCESTOR_DEPTH) {
      const node: Doc<"selectorOptions"> | null = await ctx.db.get(cursorId);
      if (!node) break;
      titleChain.push(node);
      if (node.level === "setName") setNameNode = node;
      cursorId = node.parentId;
      depth += 1;
    }
    const manufacturerNode = setNameNode?.parentId
      ? await ctx.db.get(setNameNode.parentId)
      : null;
    const manufacturerBrandUnknown =
      manufacturerNode?.level === "manufacturer"
        ? manufacturerNode.metadata?.isBrandUnknown === true
        : undefined;

    const sportRow = await ctx.db.get(args.sportId);

    // NEO-277 — a new card with no team of its own is born with these.
    const setTeamNames: string[] = [];
    // Not sliced: the chunk reads the whole list, and this must match it.
    for (const teamId of inheritedTeamIds(leaf) ?? []) {
      const team = await ctx.db.get(teamId);
      if (team) setTeamNames.push(teamFullName(team));
    }

    return {
      sportValue: sportRow?.value ?? "",
      ...(setNameNode?.value !== undefined ? { setNameValue: setNameNode.value } : {}),
      ...(manufacturerBrandUnknown !== undefined ? { manufacturerBrandUnknown } : {}),
      ...(inheritedFeatures ? { inheritedFeatures } : {}),
      ...titleChainFacts(titleChain),
      setTeamNames,
    };
  },
});

/**
 * Canonical names for player ids the resolve gate resolved. Bounded per call;
 * the caller pages. A dangling id is skipped — the card will not carry it.
 */
export const playerNamesByIds = internalQuery({
  args: { ids: v.array(v.id("players")) },
  returns: v.array(v.object({ id: v.id("players"), name: v.string() })),
  handler: async (ctx, args) => {
    if (args.ids.length > TITLE_CONTEXT_PLAYER_PAGE) {
      throw new Error(
        `playerNamesByIds: ${args.ids.length} ids exceeds the ${TITLE_CONTEXT_PLAYER_PAGE}-id page`,
      );
    }
    const out: Array<{ id: Id<"players">; name: string }> = [];
    for (const id of args.ids) {
      const player = await ctx.db.get(id);
      if (player) out.push({ id, name: player.name });
    }
    return out;
  },
});

/**
 * What the resolve gate learned about each printed name, keyed by the SAME
 * normalisation it looked them up under (`normalizePlayerName` /
 * `normalizeTeamName`). Filled by `resolveUnknownsAndStartBatch`.
 */
export type ResolvedNames = {
  playerIdByNorm: Map<string, Id<"players">>;
  teamNameByNorm: Map<string, string>;
};

export function emptyResolvedNames(): ResolvedNames {
  return { playerIdByNorm: new Map(), teamNameByNorm: new Map() };
}

/**
 * Assemble the `TitleContext` for the confirmed cards: the set facts, then
 * every printed player/team spelling on the cards that the gate resolved,
 * with its canonical name. Spellings are listed verbatim (trimmed) so the
 * browser looks a card's own string up without re-implementing the
 * normaliser.
 */
export async function buildTitleContext(
  ctx: ActionCtx,
  args: {
    selectorOptionId: Id<"selectorOptions">;
    sportId: Id<"selectorOptions">;
    cards: ReadonlyArray<{ players?: string[]; teams?: string[]; team?: string }>;
    resolved: ResolvedNames;
  },
): Promise<TitleContext> {
  type SetFacts = Omit<TitleContext, "players" | "teams">;
  const facts: SetFacts = await ctx.runQuery(internal.listingTitleContext.titleSetFacts, {
    selectorOptionId: args.selectorOptionId,
    sportId: args.sportId,
  });

  const ids = Array.from(new Set(args.resolved.playerIdByNorm.values()));
  const nameById = new Map<string, string>();
  for (let i = 0; i < ids.length; i += TITLE_CONTEXT_PLAYER_PAGE) {
    const page: Array<{ id: Id<"players">; name: string }> = await ctx.runQuery(
      internal.listingTitleContext.playerNamesByIds,
      {
        ids: ids.slice(i, i + TITLE_CONTEXT_PLAYER_PAGE),
      },
    );
    for (const { id, name } of page) nameById.set(id, name);
  }

  const players = new Map<string, string>();
  const teams = new Map<string, string>();
  for (const card of args.cards) {
    for (const raw of card.players ?? []) {
      const printed = raw.trim();
      if (!printed || players.has(printed)) continue;
      const id = args.resolved.playerIdByNorm.get(normalizePlayerName(printed));
      const name = id ? nameById.get(id) : undefined;
      if (name) players.set(printed, name);
    }
    const printedTeams = (card.teams ?? []).map((t) => t.trim()).filter(Boolean);
    if (printedTeams.length === 0 && card.team?.trim()) printedTeams.push(card.team.trim());
    for (const printed of printedTeams) {
      if (teams.has(printed)) continue;
      const name = args.resolved.teamNameByNorm.get(normalizeTeamName(printed));
      if (name) teams.set(printed, name);
    }
  }

  return {
    ...facts,
    players: Array.from(players, ([printed, name]) => ({ printed, name })),
    teams: Array.from(teams, ([printed, name]) => ({ printed, name })),
  };
}
