/**
 * NEO-339 — `nb_fix`'s `detach: [{ row, side, id }]`: the Set Builder's
 * detach of one marketplace link from one row, made the way the row's
 * Sources panel makes it (`components/SetSelector/MultiSourcePanel.tsx`).
 *
 * The panel's × on a slot chip shows "Detach SportLots "X"? N cards were
 * fetched from it…", and its confirm sends
 * `selectorOptions.detachPlatformId { selectorOptionId, side, slot,
 * confirmPrimary: chip.isPrimary, acknowledgedCards: N }`, N from
 * `selectorOptions.getSlotCardCounts`. This module sends the same call:
 *
 *  - the row is named the way every fix answer names one
 *    (`resolveAttentionRow`: omitted = the Base; `type`, `name`, `parallel`),
 *    and resolved, with every other answer of the call, before any write;
 *  - the marketplace id is resolved to its slot on the row by id
 *    (`slotForId`), never by label. An id the row does not carry is a
 *    reported no-op (`moot`): it is not attached, so nothing is detached;
 *  - the card count is read at fix time and sent as `acknowledgedCards`, so a
 *    checklist commit landing in between is refused by the server
 *    (`DETACH_COUNT_CHANGED`) rather than orphaning a number nobody read; the
 *    result says so and nothing is written for that answer;
 *  - the reconciler's primary slot is detached with `confirmPrimary`, as the
 *    panel's confirm does: the confirm phrase over these answers is the
 *    operator's confirmation. A later sync of the row could re-add it.
 *
 * What the detach does NOT do, exactly as in the UI: it removes no card.
 * Cards fetched from the set keep their marketplace ref, now attributed to
 * no slot; deleting the ones that do not belong is the Set Builder's (each
 * card's Delete, or a re-sync's review). The result counts them.
 */

import { api } from "../../../convex/_generated/api";
import { primarySlot, slotForId, type SlotBearingRow } from "../../../convex/platformSlots";
import type { NbClient } from "../client/convex-client";
import { attentionSetOf, resolveAttentionRow, type AttentionRowNode, type AttentionSetTarget, type CardRowRef } from "./attention";
import { CardAnswerError } from "./attention-answers";
import { errorCode } from "./sync-column";

/** Detach answers per call: each is one link an operator reads in the confirm digest. */
export const MAX_FIX_DETACH = 10;

export type DetachSide = "bsc" | "sportlots";

export interface DetachFixAnswer {
  /** The row; omitted = the set's Base. */
  row?: CardRowRef;
  side: DetachSide;
  /** The marketplace set id attached to the row (as `nb_inspect` lists it). */
  id: string;
}

export interface DetachFixResult {
  /** `detach[i]`. */
  at: string;
  row: CardRowRef;
  rowLabel: string;
  rowId: string;
  side: DetachSide;
  id: string;
  /** applied: detached; moot: the row does not carry the id; refused: the card count changed since it was read. */
  outcome: "applied" | "moot" | "refused";
  detail: string;
  /** Cards fetched from the detached set: still on the row, their ref now unattributed. */
  orphanedCards?: number;
  /** The reconciler's primary on that side was detached (a later sync of the row could re-add it). */
  primary?: boolean;
}

export interface ResolvedDetachAnswer {
  at: string;
  node: AttentionRowNode;
  answer: DetachFixAnswer;
}

const SIDE_NAME: Record<DetachSide, string> = { bsc: "BSC", sportlots: "SportLots" };

/** Every answer's row, exactly-one (reads only). The same link named twice is refused. */
export async function resolveDetachAnswers(
  client: NbClient,
  target: AttentionSetTarget,
  answers: readonly DetachFixAnswer[],
): Promise<ResolvedDetachAnswer[]> {
  const set = attentionSetOf(target);
  const out: ResolvedDetachAnswer[] = [];
  const seen = new Map<string, string>();
  for (const [i, answer] of answers.entries()) {
    const at = `detach[${i}]`;
    const node = await resolveAttentionRow(client, set, answer.row, at);
    const key = `${String(node.rowId)}|${answer.side}|${answer.id}`;
    const first = seen.get(key);
    if (first !== undefined) {
      throw new CardAnswerError(at, `${SIDE_NAME[answer.side]} ${answer.id} on ${node.label} is detached at ${first} too. Name each link once.`);
    }
    seen.set(key, at);
    out.push({ at, node, answer });
  }
  return out;
}

/** "3 cards were fetched from it" — the panel's clause, as a count. */
function cardsClause(n: number): string {
  if (n === 0) return "No card was fetched from it.";
  const subject = n === 1 ? "1 card was" : `${n} cards were`;
  return `${subject} fetched from it and ${n === 1 ? "stays" : "stay"} on the row; delete any that do not belong in the Set Builder.`;
}

/** Detach each link, in answer order, through the panel's own mutation. */
export async function applyDetachAnswers(client: NbClient, resolved: readonly ResolvedDetachAnswer[]): Promise<DetachFixResult[]> {
  const results: DetachFixResult[] = [];
  for (const { at, node, answer } of resolved) {
    const base = { at, row: node.ref, rowLabel: node.label, rowId: String(node.rowId), side: answer.side, id: answer.id };
    const row = (await client.query(api.selectorOptions.getSelectorOptionById, { id: node.rowId })) as SlotBearingRow | null;
    const slot = row ? slotForId(row, answer.side, answer.id) : undefined;
    if (!row || slot === undefined) {
      results.push({ ...base, outcome: "moot", detail: `${node.label} does not carry ${SIDE_NAME[answer.side]} ${answer.id}; nothing to detach.` });
      continue;
    }
    const counts = await client.query(api.selectorOptions.getSlotCardCounts, { selectorOptionId: node.rowId });
    const cards = counts[answer.side][slot] ?? 0;
    const primary = slot === primarySlot(row, answer.side);
    try {
      const r = await client.mutation(api.selectorOptions.detachPlatformId, {
        selectorOptionId: node.rowId,
        side: answer.side,
        slot,
        ...(primary ? { confirmPrimary: true } : {}),
        acknowledgedCards: cards,
      });
      results.push({
        ...base,
        outcome: "applied",
        detail:
          `Detached ${SIDE_NAME[answer.side]} ${answer.id} from ${node.label}. ${cardsClause(r.orphanedCards)}` +
          (primary ? " A later sync of this row could re-add it." : ""),
        orphanedCards: r.orphanedCards,
        ...(primary ? { primary: true } : {}),
      });
    } catch (err) {
      if (errorCode(err) !== "DETACH_COUNT_CHANGED") throw new DetachFixAborted(results, err);
      const now = ((err as { data?: { cards?: unknown } }).data ?? {}).cards;
      results.push({
        ...base,
        outcome: "refused",
        detail: `Not detached: ${typeof now === "number" ? now : "a different number of"} card(s) now come from ${SIDE_NAME[answer.side]} ${answer.id}, not the ${cards} read a moment ago. Check the row and answer again.`,
      });
    }
  }
  return results;
}

/** A failure that is not a refusal, part-way: the links detached so far, with the cause. */
export class DetachFixAborted extends Error {
  readonly results: readonly DetachFixResult[];
  constructor(results: readonly DetachFixResult[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DetachFixAborted";
    this.results = results;
    this.cause = cause;
  }
}
