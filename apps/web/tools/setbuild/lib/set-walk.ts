/**
 * NEO-339 — the set's tree, read with bounded concurrency.
 *
 * Every read path that walks a whole set (`nb_attention`'s checklists, names
 * and notices, `nb_inspect`) used to await one `getSelectorOptions` per row,
 * one at a time. On a BSC-only sync of a big set (hundreds of insert rows)
 * that was hundreds of serial round trips per walk, and `nb_attention` walks
 * three times. This module reads the same rows, through the same query, with
 * at most `READ_CONCURRENCY` in flight, and hands them back in the order the
 * serial walk produced: variant types as the server lists them, each type's
 * rows as listed, each row's parallels as listed.
 */

import { variantTypeKind } from "../../../convex/variantRole";
import type { NbClient } from "../client/convex-client";
import { childrenOf, type RowId, type SelectorRow } from "../spec/resolve";

/**
 * How many reads run at once. These are Convex queries over one client
 * (websocket or HTTP), each a single indexed read; sixteen in flight keeps a
 * 230-row set's walk to about fifteen round trips without leaning on the
 * deployment.
 */
export const READ_CONCURRENCY = 16;

/** Run `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** One insert-level row and, when asked for, its parallels. */
export interface WalkedRow {
  row: SelectorRow;
  /** The row's `parallel` children; empty when the walk did not read them. */
  parallels: SelectorRow[];
}

/** One variant type of the set. */
export interface WalkedType {
  type: SelectorRow;
  /** True for the set's Base type, which holds its own cards and is not walked below. */
  isBase: boolean;
  /** The type's rows (empty for Base: nothing is read under it). */
  rows: WalkedRow[];
}

/**
 * The set's variant types, each non-Base type's rows, and (with
 * `parallels: true`) each row's parallels. One read for the types, then every
 * type's rows and every row's parallels at `READ_CONCURRENCY` overall.
 */
export async function walkSet(client: NbClient, setId: RowId, opts: { parallels: boolean }): Promise<WalkedType[]> {
  const types = await childrenOf(client, "variantType", setId);
  const isBase = types.map((t) => variantTypeKind(t) === "base");
  const rowsOf = await mapLimit(types, READ_CONCURRENCY, (t, i) =>
    isBase[i] ? Promise.resolve<SelectorRow[]>([]) : childrenOf(client, "insert", t._id),
  );
  const flat = rowsOf.flat();
  const parallelsOf = opts.parallels
    ? await mapLimit(flat, READ_CONCURRENCY, (r) => childrenOf(client, "parallel", r._id))
    : flat.map(() => [] as SelectorRow[]);
  let k = 0;
  return types.map((type, i) => ({
    type,
    isBase: isBase[i],
    rows: rowsOf[i].map((row) => ({ row, parallels: parallelsOf[k++] })),
  }));
}
