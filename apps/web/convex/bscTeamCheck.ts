/**
 * NEO-330 — the post-commit BSC team queue gives up on a card, and says so.
 *
 * Jason, 2026-10-11: "If a team lookup never returns then the user must select
 * a team." `processBscTeamEnrichmentQueue` asks BSC for each committed card's
 * team. A card whose lookup FAILS (network, non-2xx, timeout) used to be left
 * exactly as it was, with `teamCheckDoneAt` unset so a later enqueue could try
 * again. But no enqueue was ever coming for it, and an unset `teamCheckDoneAt`
 * on a BSC-linked card is what `features/cardAttention.ts` reads as "still
 * waiting on the automatic answer" — so the card was never badged and never
 * offered to Fill. It sat with no team and nobody was told.
 *
 * The queue now retries a failed card a bounded number of times (see
 * `BSC_TEAM_CHECK_MAX_PASSES` in `adapters/buysportscards.ts`) and, when the
 * last pass fails too, calls this. It stamps `teamCheckDoneAt` and nothing
 * else:
 *
 * - `teamCheckDoneAt` means "the automatic lookup has been and gone,
 *   regardless of outcome" (`cardChecklist.applyBscTeamResolution`). Giving up
 *   is an outcome. With it set, a card with no team on file is badged "no team
 *   on this card yet" in the need-attention lane, where the operator picks.
 * - No team is written. Nothing came back, so there is nothing to link and
 *   nothing may be guessed (root CLAUDE.md, invariant 8).
 * - `bscTeamName` is left alone, so any hint an earlier answer stored stays.
 *
 * Lives in its own module rather than `cardChecklist.ts` because it is the
 * queue's bookkeeping, not card content, and `adapters/buysportscards.ts` is a
 * `"use node"` file that cannot define a mutation.
 */

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const markBscTeamCheckGivenUp = internalMutation({
  args: { cardChecklistId: v.id("cardChecklist") },
  /** Whether this call stamped the card. False when nothing was owed. */
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // A fresh read, inside the writing mutation: the retries span minutes and
    // the operator works the same checklist meanwhile.
    const row = await ctx.db.get(args.cardChecklistId);
    if (!row || !row.platformData?.bsc) return false;
    // Already answered — by a late success, an operator's team, or an
    // operator's "no team" (which `applyBscTeamResolution` stamps as well).
    if (row.teamCheckDoneAt) return false;
    await ctx.db.patch(row._id, { teamCheckDoneAt: Date.now() });
    return true;
  },
});
