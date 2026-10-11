/**
 * NEO-339 — a checklist step end to end: fetch → Match Cards → re-sync guard →
 * `resolveChecklistEntities` → entity review → `commitCardChecklist` →
 * `discardCandidates` → the expected count asserted.
 *
 * The order and the calls are `CardChecklist`'s (`handleSync` →
 * `handlePairingConfirm` → `resolveAndCommit` → `runCommit`). The commit is ONE
 * call, as the UI makes it: the server chunks the write itself
 * (`MAX_CARDS_PER_COMMIT` is the per-call bound), and the tool never sends
 * `operatorDeleteIds` or `applyFields` — those only exist on the sync-review
 * path, which the tool refuses.
 *
 * Idempotent: a row that already holds the expected cards is skipped before a
 * single marketplace call. Resumable: a run that stopped at the review leaves
 * the review batch in place, and the next run's `resolveChecklistEntities`
 * resumes it with every decision already recorded.
 */

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { NbClient } from "../client/convex-client";
import type { OpenConflict, OpenDecisions, RowRef } from "../service";
import type { Checklist } from "../spec/schema";
import {
  assertNoSyncReview,
  ChecklistStepError,
  fetchCandidates,
  pairCandidates,
  type FetchedCandidates,
} from "./fetch-checklist";
import {
  readReviewRows,
  reviewTemplate,
  runReview,
  specNameKey,
  type ReviewApplied,
  type ReviewOpen,
} from "./review";

export interface ChecklistStepInput {
  /** The row whose checklist this is (the Base variant type, or an insert-level row). */
  rowId: Id<"selectorOptions">;
  /** The set's sport row (the chain's `sport` ancestor). */
  sportId: Id<"selectorOptions">;
  checklist: Checklist;
  /** Spec location of `checklist`, e.g. `steps[1].base.checklist`. */
  at: string;
  row: RowRef | null;
  /** Read-only: report what the step would do without fetching. */
  dryRun?: boolean;
}

/** An open entity review, by what `decide` / `reviewItems` need to reach it again. */
export interface ReviewSession {
  selectorOptionId: Id<"selectorOptions">;
  batchId: string;
  sportId: Id<"selectorOptions">;
  row: RowRef | null;
  at: string;
}

export type ChecklistStepResult =
  | { outcome: "skipped"; cards: number; detail: string }
  | {
      outcome: "committed";
      committed: number;
      cards: number;
      review: ReviewApplied & { alreadyDecided: number; staged: number };
      pairing: string;
      notes: string[];
    }
  | {
      outcome: "open";
      open: Pick<OpenDecisions, "conflicts"> & { review: ReviewOpen };
      /** The checklist in spec form with every open answer as a fill-in. */
      template: Record<string, unknown>;
      session?: ReviewSession;
      reason: string;
    };

/** How many cards a row holds now (read-only). */
export async function cardCount(client: NbClient, rowId: Id<"selectorOptions">): Promise<number> {
  const counts = await client.query(api.selectorOptions.getSlotCardCounts, { selectorOptionId: rowId });
  return counts.total;
}

/**
 * Is the step already done? A row holding exactly `expectCards` (or any cards,
 * when the spec does not say) is; a row holding a different number is refused
 * — the tool builds checklists, it does not re-sync them.
 */
export function checklistDone(cards: number, expectCards: number | undefined, at: string): boolean {
  if (cards === 0) return false;
  if (expectCards === undefined || cards === expectCards) return true;
  throw new ChecklistStepError(
    `${at}: the row already holds ${cards} cards and the spec expects ${expectCards}. ` +
      "The set-build tool builds checklists; it does not re-sync them.",
  );
}

const emptyReviewOpen = (): ReviewOpen => ({ players: [], teams: [], leagues: [] });

function templateOf(checklist: Checklist, extra: { conflicts?: Array<Record<string, unknown>>; review?: unknown }) {
  return {
    pairing: {
      ...checklist.pairing,
      ...(extra.conflicts ? { conflicts: extra.conflicts } : {}),
    },
    review: extra.review ?? checklist.review,
    ...(checklist.expectCards !== undefined ? { expectCards: checklist.expectCards } : {}),
  };
}

/** Run one checklist step. Writes; the caller has already checked the confirm phrase. */
export async function runChecklistStep(
  client: NbClient,
  input: ChecklistStepInput,
  hooks: { onFetched?: (f: FetchedCandidates) => void } = {},
): Promise<ChecklistStepResult> {
  const { rowId, sportId, checklist, at, row } = input;
  const before = await cardCount(client, rowId);
  if (checklistDone(before, checklist.expectCards, at)) {
    return { outcome: "skipped", cards: before, detail: `already holds ${before} cards` };
  }

  const fetched = await fetchCandidates(client, rowId);
  hooks.onFetched?.(fetched);

  // Match Cards. Nothing fetched = the UI's "nothing to pair" path: straight to
  // entity resolution with no cards.
  let cards: Parameters<typeof assertNoSyncReview>[2]["cards"] = [];
  let conflictsByIndex = {};
  let pairingNote = "nothing fetched";
  if (fetched.live) {
    const paired = pairCandidates(fetched.live, checklist.pairing, {
      servedSides: fetched.servedSides,
      attachedSides: fetched.fetch.attachedSides,
      at,
      row,
    });
    if (!paired.ok) {
      return {
        outcome: "open",
        reason: `${paired.conflicts.length} card disagreement(s) need an answer`,
        open: { conflicts: paired.conflicts as OpenConflict[], review: emptyReviewOpen() },
        template: templateOf(checklist, { conflicts: paired.template }),
      };
    }
    cards = paired.result.cards;
    conflictsByIndex = paired.result.conflictsByIndex;
    const s = paired.summary;
    pairingNote =
      paired.mode === "solo"
        ? `one marketplace attached: kept all ${cards.length}`
        : `${s.matched} matched, ${s.keptBsc} BSC-only kept, ${s.keptSportlots} SportLots-only kept, ${s.dropped} dropped`;
  }
  await assertNoSyncReview(client, rowId, { cards, conflictsByIndex }, at);

  // Entity resolution on the CONFIRMED cards, then the review.
  const resolved = await client.action(api.selectorOptions.resolveChecklistEntities, {
    selectorOptionId: rowId,
    sportId,
    cards,
  });
  let review: ReviewApplied & { alreadyDecided: number; staged: number } = {
    players: 0,
    teams: 0,
    leagues: 0,
    alreadyDecided: 0,
    staged: 0,
  };
  if (resolved.batchId) {
    const session: ReviewSession = { selectorOptionId: rowId, batchId: resolved.batchId, sportId, row, at: `${at}.review` };
    const outcome = await runReview(client, { selectorOptionId: rowId, batchId: resolved.batchId, at: `${at}.review`, row }, checklist.review);
    if (outcome.status === "open") {
      const rows = await readReviewRows(client, session);
      return {
        outcome: "open",
        reason: "the entity review has rows the spec does not answer",
        open: { conflicts: [], review: outcome.open },
        template: templateOf(checklist, { review: reviewTemplate(rows, checklist.review) }),
        session,
      };
    }
    review = { ...outcome.applied, alreadyDecided: outcome.alreadyDecided, staged: outcome.staged };
  } else if (checklist.review !== "none-expected") {
    // No review opened, yet the spec answers names: each answer matches no row.
    const open = emptyReviewOpen();
    for (const k of ["players", "teams", "leagues"] as const) {
      checklist.review[k].forEach((e, i) =>
        open[k].push({
          at: `${at}.review.${k}[${i}]`,
          row,
          name: e.name,
          reason: "unmatched",
          candidates: [],
          detail: `no review opened for this checklist, so nothing is named "${specNameKey(e.name)}"`,
        }),
      );
    }
    if (open.players.length + open.teams.length + open.leagues.length > 0) {
      return {
        outcome: "open",
        reason: "the spec answers a review that did not open",
        open: { conflicts: [], review: open },
        template: templateOf(checklist, { review: "none-expected" }),
      };
    }
  }

  const result = await client.action(api.selectorOptions.commitCardChecklist, {
    selectorOptionId: rowId,
    sportId,
    cards,
    ...(resolved.batchId ? { batchId: resolved.batchId } : {}),
  });
  const notes: string[] = [];
  try {
    await client.mutation(api.checklistCandidates.discardCandidates, { selectorOptionId: rowId });
  } catch {
    notes.push("could not clear the staged candidates (the next fetch sweeps them)");
  }
  if (result.conflicts.length) notes.push(`${result.conflicts.length} linked to two cards — not saved`);
  if (result.collisionInserts) notes.push(`${result.collisionInserts} saved as new rows`);
  if (result.unmatchedExistingCount) notes.push(`${result.unmatchedExistingCount} no longer listed upstream (kept)`);
  if (result.unreviewedNameCount) notes.push(`${result.unreviewedNameCount} names were not reviewed`);
  if (result.staleDecisions) notes.push(`${result.staleDecisions} changed under review — not applied`);

  const after = await cardCount(client, rowId);
  if (checklist.expectCards !== undefined && after !== checklist.expectCards) {
    throw new ChecklistStepError(
      `${at}: saved ${result.count} cards; the row now holds ${after}, the spec expects ${checklist.expectCards}.`,
    );
  }
  return { outcome: "committed", committed: result.count, cards: after, review, pairing: pairingNote, notes };
}
