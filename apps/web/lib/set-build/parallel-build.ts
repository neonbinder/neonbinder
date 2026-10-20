/**
 * NEO-339 — the parallel-build plan, as plain functions.
 *
 * Moved out of `ParallelBuildPanel` with no change in behaviour: the server
 * contract the run is typed against, and which parallels a run sends to
 * `buildParallelChecklist`, in what order. The panel keeps the live run (the
 * ledger, Stop, the announcements) and re-exports the types; the set-building
 * tool (`tools/setbuild/`) plans its builds through the same function.
 *
 * Pure and env-free: no React, no `convex/react`, no `process.env`, and only
 * relative imports, so a Node script can load it.
 */

import type { Id } from "../../convex/_generated/dataModel";

import type { SyncSide } from "../../components/SetSelector/selector-sync-feedback";

// ---------------------------------------------------------------------------
// The contract (M5). Declared here, not re-derived, so the view is typed
// against what it renders; the panel's calls are NOT cast, so a server that
// returns a different shape fails the typecheck at the assignment.
// ---------------------------------------------------------------------------

/** One parallel of the source, as `getParallelsForBuild` lists it. */
export type ParallelPlanEntry = {
  _id: Id<"selectorOptions">;
  value: string;
  /** Which marketplace ids the parallel ITSELF holds (M4 — never inherited). */
  sides: { bsc: boolean; sportlots: boolean };
  hasCards: boolean;
  /** Set when the server already knows a build would be refused. */
  blocked?: string;
};

/** What the parallels are copied from, as the server resolved it (NEO-321). */
export type ParallelBuildSource = {
  id: Id<"selectorOptions">;
  value: string;
  /** An insert's own checklist, or the Base checklist for the base set's parallels. */
  kind: "insert" | "base";
  hasCards: boolean;
};

export type ParallelBuildPlan = {
  parallels: ParallelPlanEntry[];
  truncated: boolean;
  /**
   * Optional in this type so the view reads it defensively: a row the server
   * could not resolve a source for answers without one, and the run falls
   * back to what the caller said it stands on.
   */
  source?: ParallelBuildSource | null;
  /** Why there is no `source` (a Parallel variant type with no single Base). */
  sourceBlocked?: string;
};

export type SideCounts = { bsc: number; sportlots: number };
/** Card labels ("#12 Player Name"), at most 50 per list. */
export type SideCardLists = { bsc: string[]; sportlots: string[] };

export type ParallelBuildResult = {
  status: "built" | "blocked";
  copied: number;
  notCopied: number;
  unlinked: SideCounts;
  ambiguous: SideCounts;
  sidesFetched: SyncSide[];
  sidesSkipped: SyncSide[];
  earlierLinksMissing: SideCounts;
  rebuilt: boolean;
  blockedReason?: string;
  /** Per side: old links that were NOT carried over although the marketplace still lists the card. */
  stillListedNotRelinked: SideCounts;
  /** Per side: old links that pointed at the source's own cards, removed. */
  legacyLinksRemoved: SideCounts;
  skippedChangedSource: number;
  /**
   * Old cards already deleted when a block fired mid-delete — the parallel is
   * short that many cards until it is built again.
   */
  deletedCount?: number;
  /** Per side: cards the parallel's marketplace lists that the source does not have. */
  extraOnMarketplace: {
    bsc: { count: number; cards: string[] };
    sportlots: { count: number; cards: string[] };
  };
  /** WHICH cards, per bucket — each list capped at 50. */
  cards: {
    leftOff: string[];
    unlinked: SideCardLists;
    ambiguous: SideCardLists;
  };
};

/** One parallel's line in the panel. */
export type ParallelLine =
  | { kind: "waiting" }
  | { kind: "building" }
  | { kind: "built"; result: ParallelBuildResult }
  | { kind: "skipped" }
  | { kind: "blocked"; reason?: string; deleted?: number }
  | { kind: "stopped" }
  | { kind: "failed"; message: string }
  /** Was being built when the set builder was left; its result never came back here. */
  | { kind: "unfinished" };

export type ParallelRunEntry = {
  id: Id<"selectorOptions">;
  value: string;
  line: ParallelLine;
};

/**
 * Lines the server has already answered: a parallel holding no marketplace id
 * of its own has nothing to copy links from (and the source's ids are never
 * borrowed — M4), and one the plan marks `blocked` would be refused. Neither is
 * sent to the action.
 */
export function initialLine(entry: ParallelPlanEntry): ParallelLine {
  if (entry.blocked) return { kind: "blocked", reason: entry.blocked };
  if (!entry.sides.bsc && !entry.sides.sportlots) return { kind: "skipped" };
  return { kind: "waiting" };
}

/**
 * NEO-339 — what a run does with a plan: every parallel's opening line, in
 * plan order, and the ids it sends to `buildParallelChecklist`, one at a time,
 * in that order — the ones still `waiting` (a skipped or blocked line is never
 * sent). The panel's run starts from `entries`; the set-building tool builds
 * `toBuild`.
 */
export function planParallelBuildOrder(plan: Pick<ParallelBuildPlan, "parallels">): {
  entries: ParallelRunEntry[];
  toBuild: Id<"selectorOptions">[];
} {
  const entries: ParallelRunEntry[] = plan.parallels.map((p) => ({
    id: p._id,
    value: p.value,
    line: initialLine(p),
  }));
  return {
    entries,
    toBuild: entries
      .filter((e) => e.line.kind === "waiting")
      .map((e) => e.id),
  };
}

// ---------------------------------------------------------------------------
// NEO-339 — a build that copied nothing while the parallel's own listing has
// cards. Shared by the panel (which says so) and the set-building tool (which
// makes it an open decision), so both read the same signal.
// ---------------------------------------------------------------------------

/**
 * Cards the parallel's own marketplace listing returned that no source card
 * matched, per side. Read defensively: an older server's result may not carry
 * the field.
 */
export function listedOnlyCounts(
  result: Pick<ParallelBuildResult, "extraOnMarketplace">,
): SideCounts {
  const extra = result.extraOnMarketplace as
    | Partial<ParallelBuildResult["extraOnMarketplace"]>
    | undefined;
  return {
    bsc: extra?.bsc?.count ?? 0,
    sportlots: extra?.sportlots?.count ?? 0,
  };
}

/**
 * Did this build copy nothing while the parallel's marketplaces list cards?
 * Then not one of its cards shares a number with the source: it is probably
 * its own insert, not a parallel, and the operator decides what it is. A build
 * that copies some cards (a short-print subset) is an ordinary build, and so
 * is one whose listing returned nothing.
 */
export function sharesNoNumbers(
  result: Pick<ParallelBuildResult, "status" | "copied" | "extraOnMarketplace">,
): boolean {
  if (result.status !== "built" || result.copied !== 0) return false;
  const listed = listedOnlyCounts(result);
  return listed.bsc + listed.sportlots > 0;
}
