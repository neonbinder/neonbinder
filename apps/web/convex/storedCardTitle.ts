/**
 * NEO-358 — what the generator WOULD title a STORED card today.
 *
 * The body of `selectorOptions.previewListingTitle`, extracted unchanged so
 * the armed `backfillCardSearchFields` fills a missing `listingTitle` with
 * exactly the title Regenerate would offer the operator. One implementation:
 * a backfilled title and a regenerated one cannot disagree.
 *
 * Read-only. Players and teams are deduped and bounded before any read
 * (`MAX_CARD_PLAYERS` / `MAX_CARD_TEAMS`, what the write paths enforce); a
 * dangling id is skipped rather than failing; a hand-added card's still
 * pending names are the fallback, as `addCustomCard` uses them.
 */

import type { QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  assessListingTitle,
  type ListingCardInputs,
  type ListingTitleAssessment,
} from "./features/generateListing";
import { listingInputsForCard } from "./features/listingInputs";
import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "./features/cardAttention";
import { teamFullName } from "../lib/teams/team-name";
// Called inside the function only; selectorOptions.ts imports this module back.
import { findAncestorLabels } from "./selectorOptions";

export type StoredCardTitle = ListingTitleAssessment & {
  inputs: ListingCardInputs & { playerNames: string[]; teamNames: string[] };
};

export async function titleForStoredCard(
  ctx: { db: QueryCtx["db"] },
  card: Doc<"cardChecklist">,
): Promise<StoredCardTitle> {
  // Deduped and BOUNDED before any read, exactly as `teamOnCardIds` is
  // below. NEO-101 originally bounded this with a LOCAL constant of its own
  // (12) because `updateCard.playerIds` was written unvalidated and this
  // query was the only thing standing between one card id and an unbounded
  // sequential `ctx.db.get` walk. NEO-246 routed that write through
  // `resolvePlayerIdsForWrite`, so the stopgap is gone and the bound here is
  // `MAX_CARD_PLAYERS` — the same number the write path enforces. A row that
  // went through the supported path can therefore never be truncated by it;
  // the cap remains for rows written before that validation landed, or by a
  // future caller that skips it. Deduping still earns its keep for the same
  // rows: a repeat must not be read twice, or printed twice.
  const previewPlayerIds = [...new Set(card.playerIds ?? [])].slice(
    0,
    MAX_CARD_PLAYERS,
  );
  const resolvedPlayerNames: string[] = [];
  for (const playerId of previewPlayerIds) {
    const player = await ctx.db.get(playerId);
    // A dangling id is a data problem, not a reason to fail a preview —
    // skip it and let the chips show what actually resolved.
    if (player) resolvedPlayerNames.push(player.name);
  }
  const playerNames =
    resolvedPlayerNames.length > 0
      ? resolvedPlayerNames
      : (card.pendingPlayerNames ?? []);

  // Teams get the same treatment as players — deduped and BOUNDED before any
  // read. The bound here is `MAX_CARD_TEAMS`, which is what `updateCard`
  // already enforces on the write path, so a row that went through the
  // supported path can never be truncated by it; the cap exists for rows
  // written before that validation landed, or by a future caller that skips
  // it.
  const previewTeamIds = [...new Set(card.teamOnCardIds ?? [])].slice(
    0,
    MAX_CARD_TEAMS,
  );
  const resolvedTeamNames: string[] = [];
  for (const teamId of previewTeamIds) {
    const team = await ctx.db.get(teamId);
    // NEO-236: full name, matching what the commit path stores on the card.
    if (team) resolvedTeamNames.push(teamFullName(team));
  }
  // Same fallback as `playerNames`: a hand-added card carries the names the
  // operator typed until a sync resolves them into `teams` rows, and those
  // are the operator's answer.
  const teamNames =
    resolvedTeamNames.length > 0
      ? resolvedTeamNames
      : (card.pendingTeamNames ?? []).slice(0, MAX_CARD_TEAMS);

  const features: Record<string, string> = card.features ?? {};
  const parentNode = await ctx.db.get(card.selectorOptionId);
  const {
    setName: setNameValue,
    sport: sportValue,
    manufacturerBrandUnknown,
    ...chainFacts
  } = await findAncestorLabels(ctx, parentNode);

  // NEO-335 — the insert branch's own mapping (`listingInputsForCard`), fed
  // the STORED row's `features` as the merged snapshot, rather than a
  // hand-kept mirror of it. Same fields as before — year/manufacturer/
  // parallel/autograph/short print off `features`, the card's own RC/relic/
  // print run/verbatim variation, the set name, the NEO-272 brand ROLE and
  // the sport — plus the chain's insert role, parallel leaf and short name,
  // so Regenerate and the TitleFixer read the short name an operator set.
  const inputs: ListingCardInputs = listingInputsForCard(
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
    { playerNames, teamNames },
    features,
  );

  const { title, coreFits, dropped } = assessListingTitle(inputs);
  return {
    title,
    coreFits,
    dropped,
    inputs: { ...inputs, playerNames, teamNames },
  };
}
