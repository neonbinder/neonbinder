/**
 * NEO-464 — the signed-in dashboard's own Convex reads (`convex/dashboard.ts`),
 * apart from the collection store. Kept in one module so the page's tests
 * answer them without a live server.
 *
 * Which read is subscribed and which is read once (CLAUDE.md, "A subscribed
 * query stays small"):
 * - read ONCE on mount (`useConvex().query`): the completions, each set
 *   board's base checklist, each smart binder's checklist count and the
 *   cards that could fit it, what is still in intake, the sales (the
 *   sales section's gate and the orders to ship) and New on NeonBinder. Each
 *   walks a checklist, a binder's fits, a run's match rows, the order
 *   history or the catalog's newest cards, so none is ever subscribed. They refresh
 *   when the dashboard is opened again, or when the sets or binders asked
 *   for change.
 * - subscribed: "new since your last visit" (lines filed or moved in) and
 *   Fresh Pulls' last two weeks (lines added new), at most 100 lines each.
 * - the visit stamp: one mutation on mount, which answers the previous visit
 *   before it stamps this one.
 */

import { useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";

export type CompletionRaw = FunctionReturnType<typeof api.dashboard.justCompleted>[number];
export type SetBoardRaw = NonNullable<FunctionReturnType<typeof api.dashboard.setBoard>>;
export type SmartChecklistRaw = NonNullable<FunctionReturnType<typeof api.dashboard.smartChecklist>>;
export type NewSinceRaw = FunctionReturnType<typeof api.dashboard.newSince>;
export type FreshPullsRaw = FunctionReturnType<typeof api.dashboard.freshPulls>;
export type CouldFitRaw = NonNullable<FunctionReturnType<typeof api.dashboard.couldFit>>;
export type IntakeRaw = FunctionReturnType<typeof api.dashboard.intake>;
export type SalesRaw = FunctionReturnType<typeof api.dashboard.sales>;
export type NewSetRaw = FunctionReturnType<typeof api.dashboard.newSets>[number];

/**
 * Run `read` once per `key` (null: not yet), keep its answer, and drop an
 * answer to a key that is no longer asked. A read that fails answers
 * `fallback`, so its section stays empty instead of loading for ever.
 */
function useReadOnce<T>(key: string | null, read: () => Promise<T>, fallback: T): T | undefined {
  const [held, setHeld] = useState<{ key: string; value: T } | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    if (key === null) return;
    let live = true;
    readRef.current().then(
      (value) => {
        if (live) setHeld({ key, value });
      },
      (error: unknown) => {
        console.warn("dashboard: a read failed, its section stays empty", error);
        if (live) setHeld({ key, value: fallbackRef.current });
      },
    );
    return () => {
      live = false;
    };
  }, [key]);
  return held && held.key === key ? held.value : undefined;
}

/**
 * Where this visit's "new" starts (ms), null on the first visit ever,
 * undefined until the stamp answers. Stamps the visit once per mount.
 */
export function useVisitSince(): number | null | undefined {
  const mark = useMutation(api.dashboard.markVisit);
  const [since, setSince] = useState<number | null | undefined>(undefined);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    mark({}).then(
      (r) => setSince(r.sinceMs),
      () => setSince(null),
    );
  }, [mark]);
  return since;
}

/** The collection lines touched since `sinceMs` (subscribed, bounded); skipped while `sinceMs` is not known. */
export function useNewSince(sinceMs: number | null | undefined): NewSinceRaw | undefined {
  return useQuery(api.dashboard.newSince, typeof sinceMs === "number" ? { sinceMs } : "skip");
}

/**
 * Fresh Pulls: the collection lines whose cards were added new since `sinceMs`
 * (the start of its window, not the visit), subscribed, so an add shows at
 * once. Never a move: that is `useNewSince`'s news, not a pull.
 */
export function useFreshPullLines(sinceMs: number): FreshPullsRaw | undefined {
  return useQuery(api.dashboard.freshPulls, { sinceMs });
}

/**
 * New on NeonBinder: the latest checklist uploads, grouped by set, read once.
 * It walks the newest cards, so a subscription would re-run on every card
 * added anywhere in the catalog.
 */
export function useNewSets(): NewSetRaw[] | undefined {
  const convex = useConvex();
  return useReadOnce("new-sets", () => convex.query(api.dashboard.newSets, {}), []);
}

/** The base checklists finished at or after `sinceMs`, read once. */
export function useJustCompletedRaw(sinceMs: number): CompletionRaw[] | undefined {
  const convex = useConvex();
  return useReadOnce(String(sinceMs), () => convex.query(api.dashboard.justCompleted, { sinceMs }), []);
}

/** Each set's base checklist as bulbs, read once per set (null: no board for it). */
export function useSetBoards(setIds: readonly string[] | null): Map<string, SetBoardRaw | null> | undefined {
  const convex = useConvex();
  const key = setIds ? setIds.join("\n") : null;
  return useReadOnce(
    key,
    async () => {
      const ids = key ? key.split("\n") : [];
      const boards = await Promise.all(ids.map((setId) => convex.query(api.dashboard.setBoard, { setId })));
      return new Map(ids.map((id, i) => [id, boards[i]]));
    },
    new Map(),
  );
}

/** Each smart binder's checklist count, read once per binder (null: no honest number). */
export function useSmartChecklists(
  binderIds: readonly string[] | null,
): Map<string, SmartChecklistRaw | null> | undefined {
  const convex = useConvex();
  const key = binderIds ? binderIds.join("\n") : null;
  return useReadOnce(
    key,
    async () => {
      const ids = key ? key.split("\n") : [];
      const counts = await Promise.all(
        ids.map((containerId) => convex.query(api.dashboard.smartChecklist, { containerId })),
      );
      return new Map(ids.map((id, i) => [id, counts[i]]));
    },
    new Map(),
  );
}

/** Each smart binder's could-fit cards, read once per binder (null: no honest answer). */
export function useCouldFit(binderIds: readonly string[] | null): Map<string, CouldFitRaw | null> | undefined {
  const convex = useConvex();
  const key = binderIds ? binderIds.join("\n") : null;
  return useReadOnce(
    key,
    async () => {
      const ids = key ? key.split("\n") : [];
      const answers = await Promise.all(ids.map((containerId) => convex.query(api.dashboard.couldFit, { containerId })));
      return new Map(ids.map((id, i) => [id, answers[i]]));
    },
    new Map(),
  );
}

const NO_INTAKE_RAW: IntakeRaw = { needsYou: 0, unidentified: 0, runs: [], guesses: [], unknown: [], truncated: false };

/** What is still in intake, read once on mount. */
export function useIntakeRaw(): IntakeRaw | undefined {
  const convex = useConvex();
  return useReadOnce("intake", () => convex.query(api.dashboard.intake, {}), NO_INTAKE_RAW);
}

const NO_SALES_RAW: SalesRaw = { dealer: false, orders: [], more: false };

/** The sales gate and the orders still to ship, read once on mount. A failed read shows no sales section. */
export function useSalesRaw(): SalesRaw | undefined {
  const convex = useConvex();
  return useReadOnce("sales", () => convex.query(api.dashboard.sales, {}), NO_SALES_RAW);
}
