/**
 * NEO-224 — the set builder's address bar, checked.
 *
 * The set builder keeps its drill in the URL (`?sport=…&year=…&brand=…&set=…
 * &type=…&insert=…&parallel=…`, NB `selectorOptions` ids only), so a link or a
 * reload reopens the same spot. That puts ids somewhere anybody can retype,
 * and the cascade's column queries take `v.id("selectorOptions")` arguments: a
 * string that does not parse is an ARGUMENT VALIDATION failure, raised before
 * any handler runs, thrown into render by `useQuery` and answered by the
 * app-level error boundary. A hand-mangled query string is not a broken
 * application, so a raw URL value never reaches those queries. It comes here
 * first (the client's trusted-id gate, `useDrillUrlState`).
 *
 * `normalizeId` is the honest check, and the only one that knows the id names
 * THIS table, so it happens on the server (the `leagues.getByIdParam` /
 * `franchises` precedent). On top of it the path is checked as a PATH: the id
 * at position n must be a row of level n, and its parent must be the row
 * before it. A sport id sitting in the `year` slot, or a real set under some
 * other brand, is as wrong as an id that does not parse.
 *
 * The answer is the deepest valid ROOT-FIRST prefix. Everything from the
 * first bad position on is dropped, including later ids that would have been
 * fine on their own: below a broken link there is no parent to hang them on.
 * The client rewrites the URL to that prefix and says it did.
 *
 * Base is terminal (NEO-239: an NB role flag, never the name). The cascade
 * shows no Variants column beneath it, so a path that carries anything past a
 * Base variant type stops at the Base.
 *
 * Admin-only, like every other read behind the set builder.
 */
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { selectorOptionLevelValidator } from "./schema";
import { variantTypeRole } from "./variantRole";

/**
 * The cascade's levels, root first. Position n of the `ids` argument is a
 * row of level `DRILL_LEVELS[n]`.
 *
 * Keep in step with `DRILL_LEVELS` in
 * `components/SetSelector/useDrillUrlState.ts` — the client cannot import this
 * module (it pulls the server graph into the bundle), so the order is written
 * down twice.
 */
export const DRILL_LEVELS = [
  "sport",
  "year",
  "manufacturer",
  "setName",
  "variantType",
  "insert",
  "parallel",
] as const;

/**
 * One id per level, so seven at most. Anything past the seventh is ignored
 * rather than refused: a query that throws takes the page down with it, and
 * the bound is what matters — at most seven point reads per call.
 */
export const MAX_DRILL_IDS = DRILL_LEVELS.length;

/**
 * Longer than any Convex id by a wide margin. A value past it is not an id,
 * and is refused before `normalizeId` spends anything on it.
 */
const MAX_ID_LENGTH = 128;

export const resolveDrillPath = query({
  args: { ids: v.array(v.string()) },
  returns: v.array(
    v.object({
      _id: v.id("selectorOptions"),
      level: selectorOptionLevelValidator,
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const path: Array<{
      _id: Id<"selectorOptions">;
      level: (typeof DRILL_LEVELS)[number];
    }> = [];
    let parentId: Id<"selectorOptions"> | null = null;
    for (const [position, raw] of args.ids.slice(0, MAX_DRILL_IDS).entries()) {
      const level = DRILL_LEVELS[position];
      if (raw.length === 0 || raw.length > MAX_ID_LENGTH) break;
      const id = ctx.db.normalizeId("selectorOptions", raw);
      if (id === null) break;
      const row = await ctx.db.get(id);
      if (row === null) break;
      if (row.level !== level) break;
      // A sport has no parent; every deeper row hangs off the one before it.
      if ((row.parentId ?? null) !== parentId) break;
      path.push({ _id: row._id, level });
      if (level === "variantType" && variantTypeRole(row) === "base") break;
      parentId = row._id;
    }
    return path;
  },
});
