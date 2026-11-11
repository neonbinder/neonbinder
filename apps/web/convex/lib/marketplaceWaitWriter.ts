/**
 * PR 451 (NEO-487) — turns a BSC call recorder's wait edges
 * (`BscRecorderOptions.onWaitEdge`, lib/bscCallTelemetry.ts) into
 * `marketplaceWaits` writes, so the client can show "Waiting on
 * BuySportsCards…" while a checklist fetch, Build from Base or the Base match
 * probe is waiting on BSC.
 *
 * Lives in `lib/` because both the "use node" adapter
 * (`adapters/buysportscards.ts`) and default-runtime actions use it, and a
 * default-runtime module cannot import a "use node" one.
 *
 * One writer per recorder, so one `marketplaceWaits` row per recorder: the
 * first open edge inserts the row (`marketplaceWaits.open`), every later edge
 * patches it by id (`marketplaceWaits.edge`). The writes are CHAINED, so a
 * close never lands before the open it closes, and the hook stays
 * synchronous for the recorder. The caller awaits `drain()` in its `finally`,
 * after the recorder's flush (which emits the last close edge).
 *
 * No `runKey`, or one that fails the shape check: no writer at all, nothing is
 * written (the contract's "when it's absent, nothing is written"). A write
 * that fails is logged (platform, operation, error name) and swallowed: the
 * status is a convenience, never a reason to fail a fetch.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { BscWaitEdge } from "./bscCallTelemetry";

/** The client-minted run key's bounds (contract: ≤ 64, `[A-Za-z0-9_-]`). */
export const WAIT_KEY_MAX_LENGTH = 64;
export const WAIT_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidWaitKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= WAIT_KEY_MAX_LENGTH &&
    WAIT_KEY_PATTERN.test(key)
  );
}

export interface MarketplaceWaitWriter {
  /** Hand to `createBscRecorder(op, { onWaitEdge })`. */
  onWaitEdge: (edge: BscWaitEdge) => void;
  /** Settles once every write queued so far has landed (or failed). Never rejects. */
  drain: () => Promise<void>;
}

export function createMarketplaceWaitWriter(
  ctx: Pick<ActionCtx, "runMutation">,
  runKey: string | undefined,
  operation: string,
): MarketplaceWaitWriter | undefined {
  if (runKey === undefined || !isValidWaitKey(runKey)) return undefined;
  let chain: Promise<void> = Promise.resolve();
  // undefined: no row yet; null: the open was refused (no identity), stop.
  let waitId: Id<"marketplaceWaits"> | null | undefined;
  const onWaitEdge = (edge: BscWaitEdge): void => {
    chain = chain
      .then(async () => {
        if (waitId === null) return;
        if (waitId === undefined) {
          // A close with no row is a wait whose open failed: nothing to close.
          if (!edge.waiting) return;
          waitId = await ctx.runMutation(internal.marketplaceWaits.open, {
            runKey,
            platform: "bsc",
            waitingSince: edge.at,
          });
          return;
        }
        await ctx.runMutation(internal.marketplaceWaits.edge, {
          waitId,
          waitingSince: edge.waiting ? edge.at : null,
          accumulatedMs: edge.accumulatedMs,
        });
      })
      .catch((error: unknown) => {
        try {
          console.warn(
            JSON.stringify({
              msg: "marketplace_wait_write_failed",
              platform: "bsc",
              operation,
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
        } catch {
          // never throws into a call
        }
      });
  };
  return { onWaitEdge, drain: () => chain };
}
