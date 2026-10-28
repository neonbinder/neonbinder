import { useState } from "react";
import type { Copy, CopyId } from "./data/types";

/**
 * The prefix of the id a store gives a line it has drawn ahead of the server
 * (a split, an add): the real collection swaps it for the server's id when the
 * write lands. The demo never uses it.
 */
export const OPTIMISTIC_ID_PREFIX = "optimistic:";

export function isOptimisticId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_ID_PREFIX);
}

/** What a line is, apart from its id and how many it holds: the server's fold rule, as the client sees it. */
export function lineSignature(copy: Copy): string {
  return JSON.stringify([
    copy.cardId,
    copy.homeId,
    copy.slot ?? null,
    copy.upForTrade,
    copy.condition ?? null,
    copy.graded?.grader ?? null,
    copy.graded?.grade ?? null,
    copy.graded?.cert ?? null,
    copy.serialNumber ?? null,
    copy.costBasis ?? null,
    copy.minPrice ?? null,
    copy.acquiredAt,
    copy.location ?? null,
    copy.notes,
  ]);
}

/** The keys a list drew with, and the lines it drew them for. */
export interface LineKeys {
  lines: readonly Copy[];
  keys: ReadonlyMap<CopyId, string>;
}

export const NO_LINE_KEYS: LineKeys = { lines: [], keys: new Map() };

/**
 * Each line's React key in `next`, carried on from `prev`.
 *
 * A line keeps the key it had. A line the store drew ahead of the server
 * (an `optimistic:` id) that has gone hands its key to the server's line that
 * replaced it: the new id with the same signature, or, when exactly one of
 * each is left over (the server filled in a field, say the date), that one.
 * So an open panel on the line, and the row itself, live through the id swap
 * instead of closing and remounting under the collector's pointer. Anything
 * else is keyed by its own id.
 */
export function carryLineKeys(prev: LineKeys, next: readonly Copy[]): Map<CopyId, string> {
  const nextIds = new Set(next.map((c) => c.id));
  const prevIds = new Set(prev.lines.map((c) => c.id));
  const gone = prev.lines.filter((c) => isOptimisticId(c.id) && !nextIds.has(c.id));
  const fresh = next.filter((c) => !prevIds.has(c.id) && !isOptimisticId(c.id));
  const carried = new Map<CopyId, string>();
  if (gone.length > 0 && fresh.length > 0) {
    const left = [...gone];
    const unmatched: Copy[] = [];
    for (const line of fresh) {
      const signature = lineSignature(line);
      const i = left.findIndex((g) => lineSignature(g) === signature);
      if (i < 0) {
        unmatched.push(line);
        continue;
      }
      carried.set(line.id, prev.keys.get(left[i].id) ?? left[i].id);
      left.splice(i, 1);
    }
    if (left.length === 1 && unmatched.length === 1) {
      carried.set(unmatched[0].id, prev.keys.get(left[0].id) ?? left[0].id);
    }
  }
  const keys = new Map<CopyId, string>();
  for (const line of next) keys.set(line.id, carried.get(line.id) ?? prev.keys.get(line.id) ?? line.id);
  return keys;
}

/**
 * A stable React key per line across the optimistic→real id swap (see
 * `carryLineKeys`). Recomputed only when a line's id or signature changes, so
 * a store that hands a new array every render costs nothing.
 */
export function useLineKeys(lines: readonly Copy[]): (copy: Copy) => string {
  const shape = lines.map((c) => `${c.id}\u0000${lineSignature(c)}`).join("\n");
  const [drawn, setDrawn] = useState(() => ({ shape, lines, keys: carryLineKeys(NO_LINE_KEYS, lines) }));
  let current = drawn;
  if (drawn.shape !== shape) {
    current = { shape, lines, keys: carryLineKeys(drawn, lines) };
    setDrawn(current);
  }
  const { keys } = current;
  return (copy) => keys.get(copy.id) ?? copy.id;
}
