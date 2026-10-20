/**
 * NEO-339 — Group Parallels' card-number check, from the modal: the shared
 * rule (lib/set-build/family-roots.ts, the same loop the set-building draft
 * runs) over the variant type's saved rows.
 *
 * Each row's cards come from the read-only `selectorOptions.previewCardChecklist`
 * by row (`selectorOptionId`): nothing is written, no batch is staged. A row
 * that already holds cards (`getSlotCardCounts`) is no evidence, as in the
 * draft. Only rows the check needs are read: each reported family root and
 * the parent it was suggested under, never the whole type.
 *
 * Cost, per check: one `getSlotCardCounts` query and at most one preview per
 * distinct row among those roots and parents. A preview is BSC 1 request plus
 * SportLots 1 per attached SportLots set (at most 10), no team lookups. Up to
 * `CHECK_CONCURRENCY` previews run at once. A successful preview is kept for
 * the tab's lifetime, keyed by the row and its version (`lastUpdated` and its
 * marketplace slots), so a second check of an unchanged row reads no
 * marketplace; a failure is never kept.
 */

import type { ConvexReactClient } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  cardsStandApart,
  groupWithFamilyRootEvidence,
  rowCardNumbers,
  type FamilyRootGrouping,
  type PreviewNumbers,
  type RowCardSource,
} from "../../lib/set-build/family-roots";
import type { InsertTree, RowId } from "../../lib/set-build/grouping";

/** Previews in flight at once. */
export const CHECK_CONCURRENCY = 4;
/** Kept previews, oldest dropped first past this. */
const CACHE_LIMIT = 200;

const previewCache = new Map<string, PreviewNumbers>();

/** Test seam: forget every kept preview. */
export function clearFamilyRootPreviewCache(): void {
  previewCache.clear();
}

export type EvidenceClient = Pick<ConvexReactClient, "query" | "action">;

/** A saved row as `getInsertTreeByVariantType` returns it: what the cache key reads. */
type SavedRow = { _id: RowId; lastUpdated?: unknown; platformData?: unknown };

export type FamilyRootCheck = FamilyRootGrouping & {
  /** Roots whose two rows could not both be read: they keep the name-based suggestion. */
  unknown: RowId[];
};

/**
 * Run the check over `tree` (the query's result: rows carry `lastUpdated` and
 * `platformData`). `onProgress(done, total)` counts rows read. Never throws:
 * a failed read is no evidence.
 */
export async function checkFamilyRoots(
  client: EvidenceClient,
  tree: InsertTree,
  familyRoots: ReadonlyMap<RowId, RowId>,
  onProgress?: (done: number, total: number) => void,
): Promise<FamilyRootCheck> {
  const versionOf = new Map<RowId, string>();
  for (const { insert, parallels } of tree) {
    for (const row of [insert, ...parallels] as SavedRow[]) {
      versionOf.set(row._id, JSON.stringify([row.lastUpdated ?? null, row.platformData ?? null]));
    }
  }
  const reads = new Map<RowId, Promise<string[] | undefined>>();
  let done = 0;
  const source: RowCardSource<RowId> = {
    cardsHeld: async (id) => {
      const counts = await client.query(api.selectorOptions.getSlotCardCounts, {
        selectorOptionId: id,
      });
      return counts.total;
    },
    preview: async (id) => {
      const key = `${id}|${versionOf.get(id) ?? ""}`;
      const kept = previewCache.get(key);
      if (kept) return kept;
      const got = await client.action(api.selectorOptions.previewCardChecklist, {
        selectorOptionId: id,
      });
      if (!got.success) return undefined;
      const numbers: PreviewNumbers = {
        matched: got.matched.map((m) => ({ card: { cardNumber: m.card.cardNumber } })),
        bscOnly: got.bscOnly.map((c) => ({ cardNumber: c.cardNumber })),
        slOnly: got.slOnly.map((c) => ({ cardNumber: c.cardNumber })),
      };
      if (previewCache.size >= CACHE_LIMIT) {
        const oldest = previewCache.keys().next().value;
        if (oldest !== undefined) previewCache.delete(oldest);
      }
      previewCache.set(key, numbers);
      return numbers;
    },
  };
  /** One row's numbers (the shared `rowCardNumbers`), read once per check whoever asks first. */
  const numbersOf = (id: RowId): Promise<string[] | undefined> => {
    let read = reads.get(id);
    if (!read) {
      read = rowCardNumbers(id, source)
        .catch(() => undefined)
        .finally(() => {
          done += 1;
          onProgress?.(done, reads.size);
        });
      reads.set(id, read);
      onProgress?.(done, reads.size);
    }
    return read;
  };

  // Read every row the first round needs, a few at a time; the loop below
  // then finds them read. A later round (a root inside a family the first
  // round held apart) reads its rows as it goes.
  const first = [...new Set([...familyRoots].flatMap(([root, parent]) => [parent, root]))];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CHECK_CONCURRENCY, first.length) }, async () => {
      while (next < first.length) await numbersOf(first[next++]);
    }),
  );

  const unknown: RowId[] = [];
  const grouping = await groupWithFamilyRootEvidence(tree, async (root, parent) => {
    const verdict = cardsStandApart(await numbersOf(parent), await numbersOf(root));
    if (verdict === undefined) unknown.push(root);
    return verdict;
  });
  return { ...grouping, unknown };
}
