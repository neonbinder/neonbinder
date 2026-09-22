/**
 * ── NEO-296: the bound on a "resolve these ids to rows" query ────────────────
 *
 * `teams.getManyByIds` and `players.getManyByIds` are the two batch id → row
 * reads every operator surface leans on, and both were `v.array(v.id(...))`
 * with no server-side cap and one `ctx.db.get` per ELEMENT, duplicates
 * included.
 *
 * Convex charges one system op per CALL, so the cost of one execution was
 * exactly the length of the array the caller happened to build — and the
 * entity-review wizard built one entry per link-decided review row with no
 * dedup, so a 754-row batch spent ~754 ops inside a live `useQuery`
 * subscription that re-runs for the whole wizard session. Calibration (see
 * `CARDS_PER_COMMIT_CHUNK` in `convex/selectorOptions.ts`): ~900 ops in one
 * transaction is comfortable, ~1,800 strains, ~4,000 fails. That call sat one
 * operator decision short of the straining band, and a failing QUERY blanks
 * the screen rather than refusing a click.
 *
 * Two bounds, in this order:
 *
 *   1. **Distinct ids only.** One `db.get` per distinct id, first-appearance
 *      order kept, so a caller asking for the same team four hundred times
 *      pays for one. Callers dedup too — `components/admin/PlayerManagement.tsx`
 *      has done it at its own call site since NEO-235 — but the server must not
 *      depend on any caller remembering to.
 *   2. **At most `GET_MANY_BY_IDS_MAX` distinct ids per call**, truncated to
 *      the first that many in input order.
 *
 * **Truncated, not refused — the opposite of `teams.resolveNames` one file
 * over, deliberately.** `resolveNames` answers a COUNT the operator acts on
 * ("will create N new teams"), so a silently short answer is a WRONG answer
 * and a throw is the only honest outcome. This one answers a NAME MAP, and
 * every consumer already renders a missing id truthfully, because an id that
 * resolves to nothing has always been dropped here: the wizard's decided list
 * falls back to "Linked to an existing record" (`describeDecision`), the
 * checklist reconciliation hint treats a dangling id as no hint at all, and
 * the pickers render a chip for each row they got. Less specific, still true —
 * where a throw would take the whole panel down for every row on it.
 *
 * The truncation is not silent: it is a documented prefix of the caller's own
 * input, and the one execution that hits it says so in the function log.
 */

import type { QueryCtx } from "../_generated/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";

/**
 * The most rows one batch id → row query answers for.
 *
 * 512 is the smallest power of two above the longest list any caller can build
 * in one go — `PlayerManagement`'s master list is capped at 500 rows, and a
 * page that size cannot name more distinct teams than it has rows. With the
 * identity read that is ~514 system ops, comfortably inside the ~900 band with
 * room for whatever else the caller's transaction is doing.
 *
 * A caller that must name MORE than this chunks its list across calls; one
 * query cannot page itself, because `useQuery` subscribes to a single argument
 * set.
 */
export const GET_MANY_BY_IDS_MAX = 512;

/**
 * Read `ids` back as rows: deduped, bounded, and with ids that resolve to
 * nothing dropped.
 *
 * `label` names the calling function in the truncation warning — the log line
 * is the only place the bound is visible once the answer is on screen.
 */
export async function readManyByIds<T extends TableNames>(
  ctx: QueryCtx,
  label: string,
  ids: ReadonlyArray<Id<T>>,
): Promise<Array<Doc<T>>> {
  const seen = new Set<string>();
  const distinct: Array<Id<T>> = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    distinct.push(id);
  }

  const window = distinct.slice(0, GET_MANY_BY_IDS_MAX);
  if (window.length < distinct.length) {
    // The COUNTS, never the ids: this line reaches the function log, and an id
    // is a row reference rather than a number.
    console.warn(
      `[${label}] asked for ${distinct.length} distinct ids; answering the ` +
        `first ${GET_MANY_BY_IDS_MAX} (NEO-296 read bound). The rest resolve ` +
        `to no name for this caller.`,
    );
  }

  const rows: Array<Doc<T>> = [];
  for (const id of window) {
    // `ctx.db.get` resolves the table from the id, but TypeScript cannot prove
    // that through an unresolved `T`; the cast restates what the call already
    // guarantees at every concrete call site.
    const row = (await ctx.db.get(id)) as Doc<T> | null;
    if (row !== null) rows.push(row);
  }
  return rows;
}
