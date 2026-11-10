/**
 * PR 451 (NEO-487) — the background BSC team lane: a workpool with ONE slot
 * in front of BSC's public per-card endpoint (`card-listing`).
 *
 * Replaces `processBscTeamEnrichmentQueue`'s self-rescheduling chain (which is
 * kept, with the same args, as a shim that enqueues here). The chain had no
 * notion of the rest of the deployment: two commits ran two chains in
 * parallel, and a chain kept asking straight through a 429 block, which only
 * extended it. One lane, one card at a time, deployment wide, and a 429 or an
 * open cooldown (`marketplaceCooldowns`) pushes the card back to the end of
 * the window instead of spending one of its passes.
 *
 * Each card is one work item (`adapters/buysportscards.runBscTeamCheckItem`),
 * re-enqueued by its completion (`onBscTeamCheckComplete`) when it has to be
 * asked again:
 *
 *  - answered / not needed: done.
 *  - failed (a timeout, a 5xx, a network error after its own one retry; or
 *    the item threw): the NEO-330 ladder, unchanged. Passes at now, +60 s,
 *    +5 min; a card that fails the third is handed to the operator
 *    (`bscTeamCheck.markBscTeamCheckGivenUp`), never given a guessed team.
 *  - deferred (BSC answered 429, or a cooldown is open): pushed back to the
 *    window's end WITHOUT using a pass. Once a card has been waiting 30 min in
 *    all since it was first queued it goes to the operator.
 *
 * Kept in its own module for the reason `wikidataPool.ts` gives: this is the
 * only file that touches `components.bscTeamPool`. The decision itself is the
 * pure `nextBscTeamCheckStep`, so tests drive it without mounting the
 * component (convex-test cannot register it).
 */
import { v } from "convex/values";
import { Workpool } from "@convex-dev/workpool";
import type { RunResult } from "@convex-dev/workpool";
import { components, internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { markBscTeamCheckGivenUpImpl } from "./bscTeamCheck";

/** One BSC call at a time, deployment wide. */
export const BSC_TEAM_POOL_MAX_PARALLELISM = 1;
/** NEO-330 — passes a failing card gets: now, +60 s, +5 min. */
export const BSC_TEAM_CHECK_MAX_PASSES = 3;
export const BSC_TEAM_CHECK_RETRY_DELAYS_MS = [60_000, 300_000] as const;
/** PR 451 — total time a card may be pushed back before the operator gets it. */
export const BSC_TEAM_CHECK_OPERATOR_AFTER_MS = 30 * 60_000;
/** Items one enqueue mutation adds before scheduling the rest (wikidataPool's figure). */
export const BSC_TEAM_ENQUEUE_CHUNK_SIZE = 25;

/**
 * No pool-level retries: the ladder above is the retry policy, and it needs
 * to tell a 429 (no pass spent) from a failure, which a workpool retry cannot.
 */
export const bscTeamPool = new Workpool(components.bscTeamPool, {
  maxParallelism: BSC_TEAM_POOL_MAX_PARALLELISM,
  retryActionsByDefault: false,
});

export const bscTeamCheckItemValidator = v.object({
  cardChecklistId: v.id("cardChecklist"),
  /** 1-based pass; a push-back keeps it. */
  pass: v.number(),
  /** When the card was first queued (epoch ms): the 30-minute clock. */
  firstQueuedAt: v.number(),
});
export type BscTeamCheckItem = {
  cardChecklistId: Id<"cardChecklist">;
  pass: number;
  firstQueuedAt: number;
};

/** What one work item reports. `until` only with "deferred". */
export const bscTeamCheckItemResultValidator = v.object({
  outcome: v.union(
    v.literal("answered"),
    v.literal("notNeeded"),
    v.literal("failed"),
    v.literal("deferred"),
  ),
  until: v.optional(v.number()),
});
export type BscTeamCheckItemResult = {
  outcome: "answered" | "notNeeded" | "failed" | "deferred";
  until?: number;
};

export type BscTeamCheckStep =
  | { kind: "done" }
  | { kind: "retry"; pass: number; runAt: number }
  | { kind: "pushBack"; runAt: number }
  | { kind: "giveUp"; reason: "passes" | "waited" };

/** The ladder. Pure. */
export function nextBscTeamCheckStep(
  result: BscTeamCheckItemResult,
  item: Pick<BscTeamCheckItem, "pass" | "firstQueuedAt">,
  now: number,
): BscTeamCheckStep {
  if (result.outcome === "answered" || result.outcome === "notNeeded") return { kind: "done" };
  if (result.outcome === "deferred") {
    const deadline = item.firstQueuedAt + BSC_TEAM_CHECK_OPERATOR_AFTER_MS;
    if (now >= deadline) return { kind: "giveUp", reason: "waited" };
    const until = result.until !== undefined && Number.isFinite(result.until) ? result.until : now;
    // Never past the deadline: at the deadline the card is looked at once
    // more, and handed to the operator if BSC is still closed.
    return { kind: "pushBack", runAt: Math.min(Math.max(until, now), deadline) };
  }
  if (item.pass < BSC_TEAM_CHECK_MAX_PASSES) {
    const delay = BSC_TEAM_CHECK_RETRY_DELAYS_MS[item.pass - 1] ?? BSC_TEAM_CHECK_RETRY_DELAYS_MS[1];
    return { kind: "retry", pass: item.pass + 1, runAt: now + delay };
  }
  return { kind: "giveUp", reason: "passes" };
}

async function enqueueItem(ctx: MutationCtx, item: BscTeamCheckItem, runAt?: number): Promise<void> {
  await bscTeamPool.enqueueAction(
    ctx,
    internal.adapters.buysportscards.runBscTeamCheckItem,
    item,
    {
      onComplete: internal.bscTeamPool.onBscTeamCheckComplete,
      context: item,
      ...(runAt !== undefined ? { runAt } : {}),
    },
  );
}

/**
 * Queue cards for a BSC team lookup on the lane. Chunked, self-scheduling for
 * the rest, so the mutation that queues a 900-card commit stays a fixed size.
 * `pass` / `firstQueuedAt` default to a fresh card.
 */
export const enqueueBscTeamChecks = internalMutation({
  args: {
    cardChecklistIds: v.array(v.id("cardChecklist")),
    pass: v.optional(v.number()),
    firstQueuedAt: v.optional(v.number()),
    from: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const from = args.from ?? 0;
    const firstQueuedAt = args.firstQueuedAt ?? Date.now();
    const pass = Math.min(Math.max(1, Math.floor(args.pass ?? 1)), BSC_TEAM_CHECK_MAX_PASSES);
    const chunk = args.cardChecklistIds.slice(from, from + BSC_TEAM_ENQUEUE_CHUNK_SIZE);
    for (const cardChecklistId of chunk) {
      await enqueueItem(ctx, { cardChecklistId, pass, firstQueuedAt });
    }
    const next = from + BSC_TEAM_ENQUEUE_CHUNK_SIZE;
    if (next < args.cardChecklistIds.length) {
      await ctx.scheduler.runAfter(0, internal.bscTeamPool.enqueueBscTeamChecks, {
        cardChecklistIds: args.cardChecklistIds,
        pass,
        firstQueuedAt,
        from: next,
      });
    } else {
      // Counts only.
      console.log(
        JSON.stringify({
          msg: "bsc_team_check_enqueued",
          platform: "bsc",
          operation: "enqueueBscTeamChecks",
          cards: args.cardChecklistIds.length,
          pass,
        }),
      );
    }
    return null;
  },
});

/** The work item's answer, read defensively (a stale item may return anything). */
function readItemResult(result: RunResult): BscTeamCheckItemResult | null {
  if (result.kind === "canceled") return null;
  if (result.kind === "failed") return { outcome: "failed" };
  const value = result.returnValue as Partial<BscTeamCheckItemResult> | null | undefined;
  const outcome = value?.outcome;
  if (outcome === "answered" || outcome === "notNeeded" || outcome === "failed") return { outcome };
  if (outcome === "deferred") {
    return { outcome, ...(typeof value?.until === "number" ? { until: value.until } : {}) };
  }
  return { outcome: "failed" };
}

/**
 * One card's item finished. Writes only that card's own row (a give-up) or
 * enqueues that card again, so batched-inline completions cannot interfere
 * (the NEO-170 shared-document trap does not apply).
 */
export const onBscTeamCheckComplete = bscTeamPool.defineOnComplete({
  context: bscTeamCheckItemValidator,
  handler: async (
    ctx: MutationCtx,
    { context, result }: { context: BscTeamCheckItem; result: RunResult },
  ) => {
    const read = readItemResult(result);
    if (!read) return;
    const step = nextBscTeamCheckStep(read, context, Date.now());
    if (step.kind === "done") return;
    if (step.kind === "retry") {
      await enqueueItem(ctx, { ...context, pass: step.pass }, step.runAt);
      console.warn(
        JSON.stringify({
          msg: "bsc_team_check_retry_scheduled",
          platform: "bsc",
          operation: "resolveBscCardTeam",
          pass: context.pass,
          nextPass: step.pass,
          delayMs: step.runAt - Date.now(),
        }),
      );
      return;
    }
    if (step.kind === "pushBack") {
      await enqueueItem(ctx, context, step.runAt);
      return;
    }
    const flagged = await markBscTeamCheckGivenUpImpl(ctx, context.cardChecklistId);
    console.warn(
      JSON.stringify({
        msg: "bsc_team_check_gave_up",
        platform: "bsc",
        operation: "resolveBscCardTeam",
        reason: step.reason,
        flagged,
        passes: context.pass,
        waitedMs: Date.now() - context.firstQueuedAt,
      }),
    );
  },
});
