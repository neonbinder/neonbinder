/**
 * NEO-339 — a checklist step end to end: fetch → Match Cards → re-sync guard →
 * `resolveChecklistEntities` → entity review → `commitCardChecklist` →
 * `discardCandidates` → the expected count asserted.
 *
 * The order and the calls are `CardChecklist`'s (`handleSync` →
 * `handlePairingConfirm` → `resolveAndCommit` → `runCommit`), with the spec's
 * `autographFormat` as the wizard's "Autographed cards" answer. The commit is ONE
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
import { countCheck, pausedNames, skipSuffix, specExpects, type CountCheck } from "./expected-count";
import type { PausedContext } from "./sync-column";
import {
  readReviewRows,
  reviewTemplate,
  runReview,
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
  /**
   * The run's paused marketplaces. With one paused, `expectCardsWhenPaused`
   * is asserted instead of `expectCards`, or no count at all (see
   * `lib/expected-count.ts`). Absent = nothing paused.
   */
  paused?: PausedContext;
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
 * Is the step already done? A row holding exactly the expected count (or any
 * cards, when the spec does not say, or when a paused run asserts no count) is;
 * a row holding a different number is refused — the tool builds checklists,
 * it does not re-sync them. `expect` is the live `expectCards`, or the run's
 * `CountCheck` for it (`checklistCount`).
 */
export function checklistDone(cards: number, expect: number | undefined | CountCheck, at: string): boolean {
  if (cards === 0) return false;
  const check: CountCheck =
    typeof expect === "object" ? expect : countCheck("expectCards", expect, undefined, []);
  if (check.kind !== "assert" || cards === check.want) return true;
  throw new ChecklistStepError(
    `${at}: the row already holds ${cards} cards and ${specExpects(check)}. ` +
      "The set-build tool builds checklists; it does not re-sync them.",
  );
}

/**
 * A checklist's count check in this run: `expectCards`, or with a marketplace
 * paused `expectCardsWhenPaused` or nothing (`lib/expected-count.ts`). Pure.
 */
export function checklistCount(
  checklist: Pick<Checklist, "expectCards" | "expectCardsWhenPaused">,
  paused: PausedContext | undefined,
  reportedSides: readonly string[] = [],
): CountCheck {
  return countCheck("expectCards", checklist.expectCards, checklist.expectCardsWhenPaused, pausedNames(paused, reportedSides));
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
    ...(checklist.expectCardsWhenPaused !== undefined ? { expectCardsWhenPaused: checklist.expectCardsWhenPaused } : {}),
    ...(checklist.autographFormat !== undefined ? { autographFormat: checklist.autographFormat } : {}),
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
  const pre = checklistCount(checklist, input.paused);
  if (checklistDone(before, pre, at)) {
    return { outcome: "skipped", cards: before, detail: `already holds ${before} cards${skipSuffix(pre)}` };
  }

  const fetched = await fetchCandidates(client, rowId);
  hooks.onFetched?.(fetched);
  // The run's declared pause, plus any side this fetch itself skipped as paused.
  const count = checklistCount(checklist, input.paused, fetched.fetch.pausedSides ?? []);

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
    const apart = paired.alreadyApart?.length ?? 0;
    const unlinked = (checklist.pairing.unlink?.length ?? 0) - apart;
    const unlinkNote = [unlinked ? `${unlinked} unlinked` : "", apart ? `${apart} already apart` : ""].filter(Boolean).join(", ");
    pairingNote =
      paired.mode === "solo"
        ? `one marketplace attached: kept all ${cards.length}`
        : `${s.matched} matched${unlinkNote ? ` (${unlinkNote})` : ""}, ${s.keptBsc} BSC-only kept, ${s.keptSportlots} SportLots-only kept, ${s.dropped} dropped`;
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
  /** Spec answers for names the review did not ask about: no-ops (see `matchReview`). */
  let mootAnswers = 0;
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
    mootAnswers = outcome.moot.length;
  } else if (checklist.review !== "none-expected") {
    // No review opened, yet the spec answers names: every name is known by
    // now (an earlier checklist, or another writer, created it), so each
    // answer is moot, a reported no-op (NEO-339; `matchReview`).
    mootAnswers = checklist.review.players.length + checklist.review.teams.length + checklist.review.leagues.length;
  }

  const result = await client.action(api.selectorOptions.commitCardChecklist, {
    selectorOptionId: rowId,
    sportId,
    cards,
    ...(resolved.batchId ? { batchId: resolved.batchId } : {}),
    // NEO-345 — the wizard's "Autographed cards" answer, when the spec gives it.
    ...(checklist.autographFormat ? { autographFormat: checklist.autographFormat } : {}),
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
  if (mootAnswers) notes.push(`${mootAnswers} review answer${mootAnswers === 1 ? "" : "s"} had nothing to answer (the name is known or not staged)`);
  if (count.kind === "skip") notes.push(count.note);

  const after = await cardCount(client, rowId);
  if (count.kind === "assert" && after !== count.want) {
    throw new ChecklistStepError(
      `${at}: saved ${result.count} cards; the row now holds ${after}, ${specExpects(count)}.`,
      { committed: result.count, progress: pairingNote },
    );
  }
  return { outcome: "committed", committed: result.count, cards: after, review, pairing: pairingNote, notes };
}
