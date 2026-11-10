/**
 * PR 451 (NEO-487) — the `bscTeamPool` lane, run by hand in convex-test.
 *
 * convex-test cannot register the workpool component, so a test spies the
 * pool's `enqueueAction` (`captureBscTeamLane`): every item it is handed lands
 * in the returned list instead. `runBscTeamLane` then plays the pool's one
 * slot. It runs the items in `runAt` order, moving the fake clock to each
 * (`vi.setSystemTime`, so the caller needs fake timers; `shouldAdvanceTime`
 * lets the item's own pacing pause elapse), and hands each result to the REAL
 * completion (`bscTeamPool.onBscTeamCheckComplete`), which re-enqueues the
 * card or gives up on it. A throwing item reaches the completion as `failed`,
 * as the pool reports it.
 *
 * The spy is undone by `vi.restoreAllMocks()`.
 */
import { vi } from "vitest";
import type { convexTest } from "convex-test";
import { internal } from "../../convex/_generated/api";
import { bscTeamPool, type BscTeamCheckItem } from "../../convex/bscTeamPool";

export type BscTeamLaneItem = { item: BscTeamCheckItem; runAt: number; seq: number };

export function captureBscTeamLane(): BscTeamLaneItem[] {
  const lane: BscTeamLaneItem[] = [];
  let seq = 0;
  vi.spyOn(bscTeamPool, "enqueueAction").mockImplementation((async (
    _ctx: unknown,
    _fn: unknown,
    fnArgs: unknown,
    options?: { runAt?: number },
  ) => {
    seq += 1;
    lane.push({ item: fnArgs as BscTeamCheckItem, runAt: options?.runAt ?? Date.now(), seq });
    return `work-${seq}`;
  }) as never);
  return lane;
}

/** Runs up to `maxItems` items (re-enqueued ones included); returns how many ran. */
export async function runBscTeamLane(
  t: ReturnType<typeof convexTest>,
  lane: BscTeamLaneItem[],
  maxItems = 50,
): Promise<number> {
  let ran = 0;
  while (lane.length > 0 && ran < maxItems) {
    lane.sort((a, b) => a.runAt - b.runAt || a.seq - b.seq);
    const next = lane.shift()!;
    if (next.runAt > Date.now()) vi.setSystemTime(next.runAt);
    let result: { kind: "success"; returnValue: unknown } | { kind: "failed"; error: string };
    try {
      const returnValue = await t.action(
        internal.adapters.buysportscards.runBscTeamCheckItem,
        next.item,
      );
      result = { kind: "success", returnValue };
    } catch (error) {
      result = { kind: "failed", error: String(error) };
    }
    await t.mutation(internal.bscTeamPool.onBscTeamCheckComplete, {
      workId: `work-${next.seq}`,
      context: next.item,
      result,
    } as never);
    ran += 1;
  }
  return ran;
}
