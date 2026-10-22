/**
 * NEO-339 — the first half of a checklist step: fetch, Match Cards, and the
 * re-sync guard. The same public functions `CardChecklist.handleSync` calls, in
 * the same order, with the dialog's decisions read from the spec.
 *
 *   1. `fetchCardChecklist` — publishes the candidates and, before it returns,
 *      runs the BSC team lookup for every card that needs one (the #300 Julio
 *      Rodriguez / Mariners case), so by the time the action resolves the
 *      streamed rows carry their teams.
 *   2. `getReadyCandidates` — waited on until the batch the action wrote has
 *      reached us in full (`awaitStreamedBatch`'s rule: the batch id MOVED and
 *      `total === candidateCount`), then briefly for the team lookups to land.
 *   3. Pairing through `lib/set-build/pairing` — the dialog's reducer, seed and
 *      Confirm payload. One unpaused marketplace attached = the UI's
 *      no-dialog path: every card kept, exactly as `handleSync` does.
 *   4. `diffChecklistAgainstExisting` — when the incoming cards would need the
 *      sync-review dialog, the step refuses: this tool BUILDS sets, it does not
 *      re-sync them.
 *
 * Read-only on NB data except the candidate staging rows the fetch itself
 * writes (and the discard after a failed fetch), exactly like the UI.
 */

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { isChangedSyncCard, needsSyncReview } from "../../../lib/set-build/sync-review";
import {
  buildPairingResult,
  candidateKey,
  candidateToPairingCard,
  candidatesToPairingCards,
  openPairingConflicts,
  pairingReducer,
  seedPairingState,
  withConflicts,
  type PairingResult,
  type PairingState,
} from "../../../lib/set-build/pairing";
import { WaitTimeout, type NbClient } from "../client/convex-client";
import type { Checklist, CardConflict } from "../spec/schema";
import type { OpenConflict, RowRef } from "../service";
import { setBuilderLink } from "./set-builder-link";
import { StepCheckError } from "./step-check";

export type ReadyCandidates = FunctionReturnType<typeof api.checklistCandidates.getReadyCandidates>;
export type ReadyCandidate = ReadyCandidates["cards"][number];
export type FetchResult = FunctionReturnType<typeof api.selectorOptions.fetchCardChecklist>;
export type SyncDiff = FunctionReturnType<typeof api.selectorOptions.diffChecklistAgainstExisting>;
export type ServedSide = "bsc" | "sportlots";

/** A checklist step that cannot go on; the message is the operator's. A spec check (see `StepCheckError`). */
export class ChecklistStepError extends StepCheckError {
  /** Cards the step had already saved when the check failed (a count checked after the commit). */
  readonly committed?: number;
  constructor(message: string, opts: { progress?: string; committed?: number } = {}) {
    super(message, opts);
    this.name = "ChecklistStepError";
    if (opts.committed !== undefined) this.committed = opts.committed;
  }
}

/** How long the streamed batch may take to reach us after the action resolved. */
export const CANDIDATE_STREAM_TIMEOUT_MS = 60_000;
/**
 * After the batch is complete, how long to wait for the last team lookups.
 * The action awaited every lookup chunk before it returned; what can still be
 * in flight is NEO-294's one delayed retry for a >700-card batch (1s).
 */
export const TEAM_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Every card the fetch looks a team up for has had its answer. The server
 * looks up a card with a non-empty BSC ref and no teams; everything else never
 * waits. Since NEO-330 the server writes `status` per row (only a row awaiting
 * its own lookup starts `pending`, and a failed lookup chunk still flips its
 * rows), so `teamResolved` alone is the answer on a current server; the other
 * two legs keep an older server's never-flipped rows from holding the wait.
 */
export function teamLookupsSettled(cards: readonly ReadyCandidate[]): boolean {
  return cards.every((c) => c.teamResolved || (c.teams?.length ?? 0) > 0 || !c.platformData.bsc?.ref);
}

export interface FetchedCandidates {
  fetch: FetchResult;
  /** null when the fetch published nothing (`candidateCount === 0`). */
  live: ReadyCandidates | null;
  /** Attached sides this run actually fetched (attached minus paused). */
  servedSides: ServedSide[];
}

/** Fetch a row's checklist and wait for the streamed candidates. */
export async function fetchCandidates(
  client: NbClient,
  rowId: Id<"selectorOptions">,
  opts: { streamTimeoutMs?: number; teamSettleTimeoutMs?: number } = {},
): Promise<FetchedCandidates> {
  const args = { selectorOptionId: rowId };
  // Captured BEFORE the call: the batch id must move (a previous run's
  // abandoned rows with a coincidentally equal count must never satisfy it).
  const before = await client.query(api.checklistCandidates.getReadyCandidates, args);
  const previousBatchId = before.batchId;

  const fetch = await client.action(api.selectorOptions.fetchCardChecklist, args);
  if (!fetch.success) {
    await client.mutation(api.checklistCandidates.discardCandidates, args);
    throw new ChecklistStepError(`The checklist fetch failed: ${fetch.message}`);
  }
  const paused = new Set<string>(fetch.pausedSides ?? []);
  const servedSides = fetch.attachedSides.filter((s) => !paused.has(s)) as ServedSide[];
  if (fetch.candidateCount === 0) return { fetch, live: null, servedSides };

  const n = fetch.candidateCount;
  let live = await client.waitFor(
    api.checklistCandidates.getReadyCandidates,
    args,
    (v) => v.batchId !== undefined && v.batchId !== previousBatchId && v.total === n && v.cards.length === n,
    { timeoutMs: opts.streamTimeoutMs ?? CANDIDATE_STREAM_TIMEOUT_MS, label: `the ${n} fetched cards to arrive` },
  );
  if (!teamLookupsSettled(live.cards)) {
    try {
      live = await client.waitFor(
        api.checklistCandidates.getReadyCandidates,
        args,
        (v) => v.batchId === live.batchId && v.cards.length === n && teamLookupsSettled(v.cards),
        { timeoutMs: opts.teamSettleTimeoutMs ?? TEAM_SETTLE_TIMEOUT_MS, label: "the BSC team lookups" },
      );
    } catch (err) {
      // Since NEO-333 the dialog holds Confirm on the fetch's team fence, but a
      // stream that never catches up unlocks it anyway; so here: a card whose
      // lookup never answered commits without one, as it would in the UI.
      if (!(err instanceof WaitTimeout)) throw err;
    }
  }
  return { fetch, live, servedSides };
}

// ---------------------------------------------------------------------------
// Match Cards
// ---------------------------------------------------------------------------

export type PairingSpec = Checklist["pairing"];

export type PairingOutcome =
  | {
      ok: true;
      result: PairingResult;
      /** "dialog" = the Match Cards answers were applied; "solo" = the UI's no-dialog keep-all. */
      mode: "dialog" | "solo";
      summary: { matched: number; keptBsc: number; keptSportlots: number; dropped: number };
      /**
       * `pairing.unlink` entries (by index) whose two cards are both in the
       * fetch and were not paired to each other: the operator's intent already
       * holds, so there was nothing to unlink. Absent when there are none.
       */
      alreadyApart?: number[];
    }
  | {
      ok: false;
      conflicts: OpenConflict[];
      /** The `pairing.conflicts` list in spec form: the given answers plus a fill-in per open pair. */
      template: Array<Record<string, unknown>>;
    };

/** Fill-in placeholder for a conflict's `choose`. */
export const CHOOSE_PLACEHOLDER = '<"bsc" | "sportlots">';

/** The other answer to a card conflict, as an open decision's detail says it. */
export const UNLINK_HINT = "if these are two different cards, unlink them (pairing.unlink) instead";

/** The other answer, as a conflict's fill-in says it: the exact entry to add. */
function unlinkFill(card: { platformData: { bsc?: { ref: string }; sportlots?: { ref: string } } }): string {
  const entry = JSON.stringify({ bsc: card.platformData.bsc?.ref, sportlots: card.platformData.sportlots?.ref });
  return `two different cards? Remove its conflicts entries and add ${entry} to pairing.unlink`;
}

const refOf = (c: { platformData: { bsc?: { ref: string }; sportlots?: { ref: string } } }, side: ServedSide) =>
  side === "bsc" ? c.platformData.bsc?.ref : c.platformData.sportlots?.ref;

/**
 * Apply the spec's Match Cards answers to the streamed candidates, through the
 * dialog's own reducer. Pure.
 *
 * - One unpaused side attached and every row a single → the UI never shows
 *   the dialog and keeps everything (`handleSync`'s NEO-255 path); the spec's
 *   pairing answers are not consulted, exactly as no operator is.
 * - Otherwise: each `unlink` entry is the dialog's UNLINK of one matched pair,
 *   by both card refs. When both cards are in the fetch but not paired to each
 *   other, the entry is already met ("already apart"); when either card is not
 *   in the fetch, or several pairs fit, it fails the step. Each `pairs` entry is a LINK of one unmatched BSC card
 *   with one unmatched SportLots card, by marketplace ref (never by number);
 *   every name/players disagreement on a pair still matched needs exactly one
 *   `conflicts` answer (or an `unlink`), or it is an open decision; then
 *   "Keep all" per side.
 */
export function pairCandidates(
  live: ReadyCandidates,
  pairing: PairingSpec,
  ctx: { servedSides: readonly ServedSide[]; attachedSides: readonly string[]; at: string; row: RowRef | null },
): PairingOutcome {
  const needsOperator = live.cards.some(
    (c) => c.bucket === "matched" || c.nameConflict || c.playersConflict,
  );
  if (ctx.servedSides.length === 1 && !needsOperator) {
    const cards = candidatesToPairingCards(live.cards);
    return {
      ok: true,
      mode: "solo",
      result: { cards, conflictsByIndex: {} },
      summary: {
        matched: 0,
        keptBsc: ctx.servedSides[0] === "bsc" ? cards.length : 0,
        keptSportlots: ctx.servedSides[0] === "sportlots" ? cards.length : 0,
        dropped: 0,
      },
    };
  }

  let state: PairingState = seedPairingState({
    autoMatched: live.cards
      .filter((c) => c.bucket === "matched")
      .map((c) => ({ card: candidateToPairingCard(c), confidence: c.confidence ?? 1 })),
    unmatchedBsc: live.cards.filter((c) => c.bucket === "bscOnly").map(candidateToPairingCard),
    unmatchedSl: live.cards.filter((c) => c.bucket === "slOnly").map(candidateToPairingCard),
  });

  const fail = (message: string): never => {
    throw new ChecklistStepError(`${ctx.at}: ${message}`);
  };

  // The dialog's Unlink, first: a pair the server matched (on the number) that
  // is two different cards. Both halves go back to their unmatched columns,
  // keep their own names and rosters (the reducer's NEO-189/251 split), and
  // follow "Keep all" below; the pair's disagreements are no longer asked.
  const alreadyApart: number[] = [];
  const inFetch = (side: ServedSide, ref: string) => live.cards.some((c) => refOf(c, side) === ref);
  (pairing.unlink ?? []).forEach((pair, i) => {
    const hits = state.matched
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => refOf(m.card, "bsc") === pair.bsc && refOf(m.card, "sportlots") === pair.sportlots);
    if (hits.length === 1) {
      state = pairingReducer(state, { type: "UNLINK", index: hits[0].index });
      return;
    }
    if (hits.length > 1) {
      fail(
        `pairing.unlink[${i}]: no single matched pair is BSC card "${pair.bsc}" with SportLots card "${pair.sportlots}" ` +
          `(${hits.length} found).`,
      );
    }
    // Not paired to each other. If both cards were fetched, they are already
    // apart, which is what the entry asks for. A card the fetch does not hold
    // is a wrong ref, never a guess.
    const bscThere = inFetch("bsc", pair.bsc);
    const slThere = inFetch("sportlots", pair.sportlots);
    if (bscThere && slThere) {
      alreadyApart.push(i);
      return;
    }
    const missing =
      !bscThere && !slThere
        ? "neither card is in this fetch"
        : !bscThere
          ? "the BSC card is not in this fetch"
          : "the SportLots card is not in this fetch";
    fail(`pairing.unlink[${i}]: BSC card "${pair.bsc}" and SportLots card "${pair.sportlots}" cannot be unlinked: ${missing}.`);
  });

  (pairing.pairs ?? []).forEach((pair, i) => {
    const bsc = state.unmatchedBsc.filter((c) => c.platformData.bsc?.ref === pair.bsc);
    const sl = state.unmatchedSl.filter((c) => c.platformData.sportlots?.ref === pair.sportlots);
    if (bsc.length !== 1) {
      fail(`pairing.pairs[${i}]: BSC card ref "${pair.bsc}" matches ${bsc.length} unmatched BSC cards (needs exactly one).`);
    }
    if (sl.length !== 1) {
      fail(`pairing.pairs[${i}]: SportLots card ref "${pair.sportlots}" matches ${sl.length} unmatched SportLots cards (needs exactly one).`);
    }
    state = pairingReducer(state, { type: "LINK", bscKey: candidateKey(bsc[0]), slKey: candidateKey(sl[0]) });
  });

  // Every disagreement on a matched pair, answered exactly once.
  const answers = pairing.conflicts ?? [];
  const used = new Set<number>();
  const open: OpenConflict[] = [];
  const fillIns: Array<Record<string, unknown>> = [];
  const answersFor = (field: CardConflict["field"], card: { platformData: { bsc?: { ref: string }; sportlots?: { ref: string } } }) =>
    answers
      .map((a, i) => ({ a, i }))
      .filter(
        ({ a }) =>
          a.field === field &&
          (a.bsc === undefined || a.bsc === refOf(card, "bsc")) &&
          (a.sportlots === undefined || a.sportlots === refOf(card, "sportlots")),
      );
  const pairs = state.matched.map((m) => ({ key: candidateKey(m.card), m }));
  for (const { key, m } of pairs) {
    for (const field of ["name", "players"] as const) {
      const conflict = field === "name" ? m.nameConflict : m.playersConflict;
      if (!conflict) continue;
      const hits = answersFor(field, m.card);
      const detail =
        field === "name"
          ? `name: BSC "${m.nameConflict!.bsc}" vs SportLots "${m.nameConflict!.sportlots}"`
          : `players: BSC [${m.playersConflict!.bsc.join(", ")}] vs SportLots [${m.playersConflict!.sportlots.join(", ")}]`;
      const refs = `(bsc ${refOf(m.card, "bsc") ?? "-"}, sportlots ${refOf(m.card, "sportlots") ?? "-"})`;
      if (hits.length !== 1) {
        open.push({
          at: `${ctx.at}.pairing.conflicts`,
          row: ctx.row,
          cardNumber: m.card.cardNumber,
          detail: `${hits.length === 0 ? "unanswered" : `${hits.length} answers match`} — ${detail} ${refs}; ${UNLINK_HINT}`,
        });
        if (hits.length === 0) {
          fillIns.push({
            field,
            ...(refOf(m.card, "bsc") ? { bsc: refOf(m.card, "bsc") } : {}),
            ...(refOf(m.card, "sportlots") ? { sportlots: refOf(m.card, "sportlots") } : {}),
            // The hint rides inside the placeholder: the spec is strict, so a
            // separate hint key would have to be deleted by hand after filling.
            choose: `${CHOOSE_PLACEHOLDER} — #${m.card.cardNumber} ${detail}; ${unlinkFill(m.card)}`,
          });
        }
        continue;
      }
      used.add(hits[0].i);
      // Indexes move as the reducer re-orders; find the pair by key each time.
      const index = state.matched.findIndex((p) => candidateKey(p.card) === key);
      state = pairingReducer(state, {
        type: field === "name" ? "CHOOSE_NAME" : "CHOOSE_PLAYERS",
        index,
        side: hits[0].a.choose,
      });
    }
  }
  answers.forEach((a, i) => {
    if (used.has(i)) return;
    open.push({
      at: `${ctx.at}.pairing.conflicts[${i}]`,
      row: ctx.row,
      cardNumber: "",
      detail: `This ${a.field} answer (bsc ${a.bsc ?? "-"}, sportlots ${a.sportlots ?? "-"}) names no disagreeing pair.`,
    });
  });
  // NEO-339 — the dialog's own Confirm gate, on the state as it now stands:
  // every disagreement answered. The loop above answers each one it finds,
  // so this only fires if an answer failed to reach the reducer — which would
  // otherwise commit BSC's side over it, the defect the gate exists for.
  for (const c of open.length === 0 ? openPairingConflicts(state) : []) {
    open.push({
      at: `${ctx.at}.pairing.conflicts`,
      row: ctx.row,
      cardNumber: c.cardNumber,
      detail: `the ${c.field} conflict on #${c.cardNumber} is still unanswered; ${UNLINK_HINT}`,
    });
  }
  if (open.length > 0) {
    return { ok: false, conflicts: open, template: [...answers.map((a) => ({ ...a })), ...fillIns] };
  }

  const keepBsc = pairing.unmatchedBsc === "keep";
  const keepSl = pairing.unmatchedSportlots === "keep";
  const result = buildPairingResult(state, { keepUnmatchedBsc: keepBsc, keepUnmatchedSl: keepSl });
  return {
    ok: true,
    mode: "dialog",
    result,
    summary: {
      matched: state.matched.length,
      keptBsc: state.keptBsc.length + (keepBsc ? state.unmatchedBsc.length : 0),
      keptSportlots: state.keptSl.length + (keepSl ? state.unmatchedSl.length : 0),
      dropped: (keepBsc ? 0 : state.unmatchedBsc.length) + (keepSl ? 0 : state.unmatchedSl.length),
    },
    ...(alreadyApart.length > 0 ? { alreadyApart } : {}),
  };
}

// ---------------------------------------------------------------------------
// The re-sync guard
// ---------------------------------------------------------------------------

/**
 * The sync-review dialog's own rule (`lib/set-build/sync-review.ts`, which
 * `components/SetSelector/sync-review-modal.tsx` calls too). Re-exported under
 * its old name for the tool's callers.
 */
export { needsSyncReview };

/**
 * Refuse a checklist the sync-review dialog would have to settle. The diff is
 * the UI's own (the cards with their unsettled disagreements); a build onto an
 * empty row never needs it.
 */
export async function assertNoSyncReview(
  client: NbClient,
  rowId: Id<"selectorOptions">,
  result: PairingResult,
  at: string,
): Promise<void> {
  if (result.cards.length === 0) return;
  const diff = await client.query(api.selectorOptions.diffChecklistAgainstExisting, {
    selectorOptionId: rowId,
    cards: withConflicts(result.cards, result.conflictsByIndex),
  });
  if (needsSyncReview(diff)) {
    const changed = diff.cards.filter(isChangedSyncCard).length;
    const link = await setBuilderLink(client, rowId);
    throw new ChecklistStepError(
      `${at}: this checklist already holds cards that differ from the fetch (${changed} changed, ` +
        `${diff.removedUpstream.fullyOrphaned.length} no longer listed, ${diff.conflicts.length} conflicts). ` +
        `The set-build tool builds checklists; it does not re-sync them. Review it in the Set Builder: ${link}`,
    );
  }
}
