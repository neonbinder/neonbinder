/**
 * The listing title of a STORED card: what the generator would write for it
 * today, and the rebuild that keeps a still-generated title (and listing
 * description) in step with its card after a server-side fact change.
 *
 * ## Why this module exists
 *
 * `selectorOptions.previewListingTitle` (the Regenerate button and the
 * TitleFixer chips) was the only place that rebuilt a stored card's title, and
 * its ancestor walk (`findAncestorLabels`) lived inside `selectorOptions.ts`.
 * The autograph-format cascade (`cardChecklist.applyBscAttributeFill`, reached
 * from `autographFormat.ts`, the BSC per-card lookup and the armed backfill)
 * must rebuild the same title the same way, and `cardChecklist.ts` cannot
 * import `selectorOptions.ts` (that module imports it). So the walk and the
 * stored-row mapping live here, and both callers import them: Regenerate and
 * the cascade read one builder, the insert branch's own
 * (`listingInputsForCard` + `assessListingTitle`).
 *
 * ## Which titles (and descriptions) are "still as generated"
 *
 * NB stores no provenance on `listingTitle`: creation writes the generated
 * title (or the operator's pre-save answer, NEO-335), and `updateCard` writes
 * an operator's edit, and neither records which it was. The one reliable
 * signal is the title itself: a title that EQUALS what the generator produces
 * from the card's facts as they stand just BEFORE the change is one nobody has
 * edited (or one an operator kept word for word). Anything else is the
 * operator's own and is never rewritten. A card whose set or player was
 * renamed since it was born fails the comparison and is left alone too: that
 * is the conservative miss, and Regenerate still offers the new title.
 *
 * `listingDescription` is held to the same rule against
 * `generateListingDescription`, creation's builder, fed the same inputs
 * (there is no Regenerate for it).
 */

import type { Doc, Id } from "./_generated/dataModel";
import {
  assessListingTitle,
  generateListingDescription,
  type ListingCardInputs,
  type ListingTitleAssessment,
} from "./features/generateListing";
import { listingInputsForCard } from "./features/listingInputs";
import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "./features/cardAttention";
import { titleChainFacts, type TitleChainFacts } from "./listingShortName";
import { teamFullName } from "../lib/teams/team-name";

type DbReader = { db: { get: (id: any) => Promise<any> } };

/** Everything listing generation needs from above a card. */
export type StoredCardTitleChain = {
  setName?: string;
  sport?: string;
  manufacturerBrandUnknown?: boolean;
} & TitleChainFacts;

/**
 * Walk a selectorOptions node's parent chain ONCE, collecting everything
 * listing generation needs from above the card: the setName display value
 * ("Chrome"), the sport display value ("Baseball"), and — NEO-272 — whether NB
 * has identified the brand of the set at all (a ROLE off
 * `metadata.isBrandUnknown` on the manufacturer in between, never its name).
 *
 * NEO-101 widened this from `findSetNameValue`, which returned early at the
 * setName level. The sport node sits ABOVE setName, so a second helper would
 * have meant a second walk over the same chain for every card previewed or
 * hand-added — the walk is the cost here, not the comparison, so both values
 * come out of one pass.
 *
 * Still deliberately narrow rather than a general ancestor-chain utility:
 * every other consumer of the chain already had its own reason to walk it
 * (commitCardChecklist resolves both in the prelude, once per commit, and
 * hands them to the chunks). Depth-bounded like
 * `findSportForSelectorOption`, so a cyclic or corrupted `parentId` cannot
 * spin a query.
 */
export async function findAncestorLabels(
  ctx: DbReader,
  node: any,
): Promise<StoredCardTitleChain> {
  const labels: {
    setName?: string;
    sport?: string;
    manufacturerBrandUnknown?: boolean;
  } = {};
  if (!node) return labels;
  // NEO-335 — the rows from `node` up to and including the setName row, LEAF
  // FIRST, for `titleChainFacts` (the insert role, a parallel leaf, the
  // nearest short name). Collected on the way past: this walk already passes
  // every one of them before it can stop.
  const titleChain: any[] = [];
  let current = node;
  let depth = 0;
  while (current && depth < 16) {
    if (labels.setName === undefined) titleChain.push(current);
    if (current.level === "setName" && labels.setName === undefined) {
      labels.setName = current.value;
    }
    // NEO-272 — the manufacturer ROLE, not its name. Picked up on the way past
    // rather than by a walk of its own: the chain is
    // sport › year › manufacturer › setName › …, so walking UP from a card's
    // parent reaches the manufacturer AFTER setName and BEFORE sport, and the
    // break below waits for sport. Every chain that has a manufacturer level
    // therefore passes through it before this loop can stop.
    if (
      current.level === "manufacturer" &&
      labels.manufacturerBrandUnknown === undefined
    ) {
      labels.manufacturerBrandUnknown =
        current.metadata?.isBrandUnknown === true;
    }
    if (current.level === "sport" && labels.sport === undefined) {
      labels.sport = current.value;
    }
    // Deliberately NOT extended with `manufacturerBrandUnknown`. A chain with
    // no manufacturer level at all — a setName hung straight off a sport, which
    // is what most fixtures and some hand-built trees look like — would then
    // never satisfy the condition and would walk to the depth cap, paying extra
    // reads on every card previewed or hand-added to buy nothing. The value is
    // already collected above by the time sport is reached, so stopping here
    // loses nothing; leaving it absent is the same "no manufacturer role" answer
    // as `false`, which is exactly how the generator reads it.
    if (labels.setName !== undefined && labels.sport !== undefined) break;
    const parentId: Id<"selectorOptions"> | undefined = current.parentId;
    if (!parentId) break;
    current = await ctx.db.get(parentId);
    depth += 1;
  }
  return { ...labels, ...titleChainFacts(titleChain) };
}

/**
 * Names already read in this transaction, by id (`null` = a dangling id).
 * One per page of a walk, so a player on many cards is read once.
 */
export type TitleNameCache = {
  players: Map<string, string | null>;
  teams: Map<string, string | null>;
};

export function newTitleNameCache(): TitleNameCache {
  return { players: new Map(), teams: new Map() };
}

/** The card fields the title reads. A stored row, or a row about to be patched. */
export type StoredCardTitleFields = Pick<
  Doc<"cardChecklist">,
  | "cardNumber"
  | "isRookie"
  | "isRelic"
  | "printRun"
  | "cardVariation"
  | "features"
  | "playerIds"
  | "teamOnCardIds"
  | "pendingPlayerNames"
  | "pendingTeamNames"
>;

/**
 * A stored card's canonical player and team names, in stored order, the way
 * `previewListingTitle` has always resolved them.
 *
 * Deduped and BOUNDED before any read (`MAX_CARD_PLAYERS` / `MAX_CARD_TEAMS`,
 * the same numbers the write path enforces, so a row written through the
 * supported path is never truncated by them). A dangling id is skipped, not a
 * failure. A hand-added card that carries only the names an operator typed
 * (`pendingPlayerNames` / `pendingTeamNames`) uses those: both are the
 * operator's answer.
 */
export async function storedCardTitleNames(
  ctx: DbReader,
  card: StoredCardTitleFields,
  cache: TitleNameCache = newTitleNameCache(),
): Promise<{ playerNames: string[]; teamNames: string[] }> {
  const playerIds = [...new Set(card.playerIds ?? [])].slice(0, MAX_CARD_PLAYERS);
  const resolvedPlayerNames: string[] = [];
  for (const playerId of playerIds) {
    if (!cache.players.has(playerId)) {
      const player = await ctx.db.get(playerId);
      cache.players.set(playerId, player ? player.name : null);
    }
    const name = cache.players.get(playerId);
    if (name) resolvedPlayerNames.push(name);
  }
  const playerNames =
    resolvedPlayerNames.length > 0
      ? resolvedPlayerNames
      : (card.pendingPlayerNames ?? []);

  const teamIds = [...new Set(card.teamOnCardIds ?? [])].slice(0, MAX_CARD_TEAMS);
  const resolvedTeamNames: string[] = [];
  for (const teamId of teamIds) {
    if (!cache.teams.has(teamId)) {
      const team = await ctx.db.get(teamId);
      // NEO-236: full name, matching what the commit path stores on the card.
      cache.teams.set(teamId, team ? teamFullName(team) : null);
    }
    const name = cache.teams.get(teamId);
    if (name) resolvedTeamNames.push(name);
  }
  const teamNames =
    resolvedTeamNames.length > 0
      ? resolvedTeamNames
      : (card.pendingTeamNames ?? []).slice(0, MAX_CARD_TEAMS);

  return { playerNames, teamNames };
}

/**
 * NEO-335 — the insert branch's own mapping (`listingInputsForCard`), fed the
 * STORED row's `features` as the merged snapshot, rather than a hand-kept
 * mirror of it: year/manufacturer/parallel/autograph/short print off
 * `features`, the card's own RC/relic/print run/verbatim variation, the set
 * name, the NEO-272 brand ROLE and the sport, plus the chain's insert role,
 * parallel leaf and short name. Pure.
 */
export function storedCardListingInputs(
  card: StoredCardTitleFields,
  chain: StoredCardTitleChain,
  names: { playerNames: string[]; teamNames: string[] },
): ListingCardInputs {
  const {
    setName: setNameValue,
    sport: sportValue,
    manufacturerBrandUnknown,
    ...chainFacts
  } = chain;
  return listingInputsForCard(
    {
      cardNumber: card.cardNumber,
      isRookie: card.isRookie,
      isRelic: card.isRelic,
      printRun: card.printRun,
      cardVariation: card.cardVariation,
    },
    {
      sportValue: sportValue ?? "",
      setNameValue,
      manufacturerBrandUnknown,
      ...chainFacts,
    },
    names,
    card.features ?? {},
  );
}

/** What a stored card's title would be today. */
export async function assessStoredCardTitle(
  ctx: DbReader,
  card: StoredCardTitleFields,
  chain: StoredCardTitleChain,
  cache?: TitleNameCache,
): Promise<ListingTitleAssessment> {
  const names = await storedCardTitleNames(ctx, card, cache);
  return assessListingTitle(storedCardListingInputs(card, chain, names));
}

/**
 * The listing fields to patch when a server-side change to a card (`before` →
 * `after`) should carry through to its title and description, each decided on
 * its own; `undefined` when nothing changes.
 *
 * Only text still AS GENERATED is rebuilt (see the module header): the stored
 * `listingTitle` must equal the generator's title for `before`, and the stored
 * `listingDescription` must equal `generateListingDescription` for `before` —
 * the insert branch's own builder, fed the same inputs as the title. Then the
 * new text is the generator's for `after`. An operator's title or description
 * is never touched, and one being hand-written does not stop the other from
 * being rebuilt.
 *
 * `listingTitleTruncated` follows creation's rule (NEO-101 / NEO-335) when the
 * title is rebuilt:
 *
 *   - the new core fits → the flag is cleared;
 *   - the new core is cut and the old one was not → the flag is set (a cut
 *     nobody has seen, exactly what creation flags);
 *   - both cut → the flag stays as it is: the cut was already flagged, or
 *     already answered before save (`listingTitleKept`), and the change did
 *     not touch the core.
 *
 * Names are read once with `cache` and used for both halves, before and after.
 */
export async function rebuiltGeneratedListing(
  ctx: DbReader,
  before: StoredCardTitleFields &
    Pick<
      Doc<"cardChecklist">,
      "listingTitle" | "listingTitleTruncated" | "listingDescription"
    >,
  after: StoredCardTitleFields,
  chain: StoredCardTitleChain,
  cache: TitleNameCache = newTitleNameCache(),
): Promise<
  | {
      patch: {
        listingTitle?: string;
        listingTitleTruncated?: true | undefined;
        listingDescription?: string;
      };
      retitled: boolean;
      redescribed: boolean;
    }
  | undefined
> {
  const isText = (v: string | undefined): v is string =>
    typeof v === "string" && v.trim() !== "";
  const storedTitle = before.listingTitle;
  const storedDescription = before.listingDescription;
  if (!isText(storedTitle) && !isText(storedDescription)) return undefined;

  const wasInputs = storedCardListingInputs(
    before,
    chain,
    await storedCardTitleNames(ctx, before, cache),
  );
  const nowInputs = storedCardListingInputs(
    after,
    chain,
    await storedCardTitleNames(ctx, after, cache),
  );
  const patch: {
    listingTitle?: string;
    listingTitleTruncated?: true | undefined;
    listingDescription?: string;
  } = {};
  let retitled = false;
  let redescribed = false;

  if (isText(storedTitle)) {
    const was = assessListingTitle(wasInputs);
    if (was.title === storedTitle) {
      const now = assessListingTitle(nowInputs);
      const storedFlag: true | undefined =
        before.listingTitleTruncated === true ? true : undefined;
      const flag: true | undefined = now.coreFits
        ? undefined
        : was.coreFits
          ? true
          : storedFlag;
      if (now.title !== storedTitle || flag !== storedFlag) {
        patch.listingTitle = now.title;
        // Present even when undefined: the patch then removes the field.
        patch.listingTitleTruncated = flag;
        retitled = true;
      }
    }
  }

  if (isText(storedDescription)) {
    if (generateListingDescription(wasInputs) === storedDescription) {
      const now = generateListingDescription(nowInputs);
      if (now !== storedDescription) {
        patch.listingDescription = now;
        redescribed = true;
      }
    }
  }

  return retitled || redescribed ? { patch, retitled, redescribed } : undefined;
}
