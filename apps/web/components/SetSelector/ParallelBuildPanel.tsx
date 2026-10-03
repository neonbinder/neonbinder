import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
  type SVGProps,
} from "react";
import { useAction, useConvex, type ConvexReactClient } from "convex/react";
import {
  ArrowPathIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  NoSymbolIcon,
  StopCircleIcon,
} from "@heroicons/react/24/outline";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import NeonButton from "../modules/NeonButton";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { SIDE_LABEL, type SyncSide } from "./selector-sync-feedback";

/**
 * NEO-312 — building an insert's parallels from the insert's own checklist.
 *
 * A parallel is the same checklist as its insert, printed in another colour.
 * So a parallel's cards are a COPY of the insert's NB cards, each re-linked to
 * the parallel's own marketplace card on every side the parallel holds an id
 * for (`convex/parallelChecklistBuild.ts`). Nothing is fetched by name and
 * nothing is matched by hand: there is no pairing dialog, no content review
 * and no entity wizard on a parallel (J4).
 *
 * Two ways in, one server call (`buildParallelChecklist`):
 *
 *   - **After an insert's checklist is saved** (J1), every parallel under it
 *     is built, one at a time, automatically — including the ones that
 *     already have cards, which are rebuilt without a confirm (Jason,
 *     2026-09-28). `useParallelBuildRun` is the runner and
 *     `ParallelBuildPanel` is what it says on screen, under the "Saved N
 *     cards." notice. The operator can stop it between parallels, never
 *     mid-call.
 *   - **On a parallel's own row** (J4), `ParallelBuildButton` stands where the
 *     Sync button stands on every other row: "Build from Anime", or — once the
 *     parallel has cards — "Rebuild from Anime" behind a confirm (J3).
 *
 * ## Where the runner lives
 *
 * In the SET BUILDER (`modules/SetSelector.tsx`), handed down to the
 * checklist — not in the checklist and not in the panel. The operator moves
 * around the set builder while a run goes (into the parallel it just built,
 * up to another variant type, to a sibling insert), and every one of those
 * moves either reuses the checklist through a `cards === undefined` beat or
 * unmounts it outright. The set builder is the one owner that outlives all
 * of them, and it shows the panel itself whenever no checklist is open to
 * show it (hobby review A10).
 *
 * Leaving the set builder entirely does end the run: the call in flight
 * finishes on the server and nothing after it is sent. Two things keep that
 * from being silent: a `beforeunload` prompt while a run is live (closing or
 * reloading the tab), and a record left behind (`leftBehind`) that the next
 * set builder picks up, so the insert's panel reads "stopped when you left".
 *
 * ## One build per parallel, per tab
 *
 * The runner owns the set of parallels with a build in flight (security
 * review 4), and every build goes through it — the automatic run AND the
 * parallel-row button. A button that was unmounted and remounted mid-build
 * still sees its parallel as busy, and the run waits for a manual build of
 * the same parallel to land before rebuilding it. The server has its own
 * guard for everything a tab cannot see.
 *
 * Every Convex reference is read at CALL time (`convex.query`/`convex.action`
 * inside the run, `useAction` only inside the parallel-row button, which mounts
 * only on a parallel row), so a component test that hand-builds the `api`
 * mock without this module keeps rendering the checklist.
 *
 * Copy is DRAFT (Jason signs off); every string is one constant or one pure
 * function here so the sign-off is one file.
 */

// ---------------------------------------------------------------------------
// The contract (M5). Declared here, not re-derived, so the view is typed
// against what it renders; the calls below are NOT cast, so a server that
// returns a different shape fails the typecheck at the assignment.
// ---------------------------------------------------------------------------

/** One parallel of the insert, as `getParallelsForBuild` lists it. */
export type ParallelPlanEntry = {
  _id: Id<"selectorOptions">;
  value: string;
  /** Which marketplace ids the parallel ITSELF holds (M4 — never inherited). */
  sides: { bsc: boolean; sportlots: boolean };
  hasCards: boolean;
  /** Set when the server already knows a build would be refused. */
  blocked?: string;
};

export type ParallelBuildPlan = {
  parallels: ParallelPlanEntry[];
  truncated: boolean;
};

type SideCounts = { bsc: number; sportlots: number };
/** Card labels ("#12 Player Name"), at most 50 per list. */
type SideCardLists = { bsc: string[]; sportlots: string[] };

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
  /** Per side: old links that pointed at the insert's own cards, removed. */
  legacyLinksRemoved: SideCounts;
  skippedChangedSource: number;
  /**
   * Old cards already deleted when a block fired mid-delete — the parallel is
   * short that many cards until it is built again.
   */
  deletedCount?: number;
  /** Per side: cards the parallel's marketplace lists that the insert does not have. */
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

/** Where the open checklist sits in the insert → parallel pair. */
export type ParallelBuildRole =
  | { role: "insert" }
  | {
      role: "parallel";
      insertId: Id<"selectorOptions">;
      /** Undefined while the chain loads; the button waits for it. */
      insertValue?: string;
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

export type ParallelRun = {
  insertId: Id<"selectorOptions">;
  insertValue: string;
  entries: ParallelRunEntry[];
  truncated: boolean;
  /**
   * `running` → the loop is live. `stopping` → Stop was pressed and the one
   * in flight is finishing. `finished` / `stopped` → the loop has ended.
   * `left` → the set builder was left mid-run, and this is what it left.
   */
  phase: "running" | "stopping" | "finished" | "stopped" | "left";
  /** Index of the entry most recently sent to the server; null before the first. */
  atIndex: number | null;
  /** What the live region says; see `ParallelBuildPanel`. */
  announcement: string;
};

// ---------------------------------------------------------------------------
// Copy (DRAFT)
// ---------------------------------------------------------------------------

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const SIDES = ["bsc", "sportlots"] as const;

export const WAITING_TEXT = "Waiting";
export const BUILDING_TEXT = "Building…";
export const SKIPPED_TEXT = "Skipped — not linked to a marketplace yet";
export const STOPPED_TEXT = "Stopped";
export const UNFINISHED_TEXT =
  "Still building when you left — open it to check";
export const STOP_LABEL = "Stop after this one";
export const STOPPING_LABEL = "Stopping after this one…";
export const RESULTS_GROUP_LABEL = "Parallel build results";
export const BUILD_BUSY_LABEL = "Building…";
export const REBUILD_CONFIRM_LABEL = "Replace the cards";
export const REBUILD_BUSY_LABEL = "Rebuilding…";
export const SEE_CARDS_LABEL = "See which cards";

/** The heading's id, for a held control's `aria-describedby` on the insert. */
export const PARALLEL_BUILD_HEADING_ID = "parallel-build-heading";
/** A ledger line's id, for a held control's `aria-describedby` on that parallel. */
export const parallelLineId = (parallelId: string) =>
  `parallel-build-line-${parallelId}`;

/**
 * "Built 48 cards" — or "Rebuilt 48 cards" — then only the clauses that are
 * true, per side and never summed (a card can be unlinked or ambiguous on
 * both, and a summed count would claim more cards than there are):
 *
 *   "Rebuilt 45 cards, 2 without a BSC card, 1 matched more than one
 *    SportLots card, 3 left off — not on either marketplace's list, 2 BSC
 *    links dropped — those cards didn't come back, 4 on BSC that Anime
 *    doesn't have"
 *
 * A first build that copied nothing gets one sentence saying why instead of
 * "Built 0 cards, 48 left off". `insertValue` names the insert in the clauses
 * that need it; without one they say "the insert".
 */
export function builtText(
  result: ParallelBuildResult,
  insertValue?: string,
): string {
  const insert = insertValue ?? "the insert";
  const extras = SIDES.map(
    (side) => [side, result.extraOnMarketplace?.[side]?.count ?? 0] as const,
  ).filter(([, count]) => count > 0);
  const extraClauses = extras.map(
    ([side, count]) => `${count} on ${SIDE_LABEL[side]} that ${insert} doesn't have`,
  );

  if (!result.rebuilt && result.copied === 0) {
    const total = result.copied + result.notCopied;
    return [
      `Nothing copied — none of ${insert}'s ${plural(total, "card", "cards")} turned up on this parallel's marketplace checklists`,
      ...extraClauses,
    ].join(", ");
  }

  const verb = result.rebuilt ? "Rebuilt" : "Built";
  const parts = [`${verb} ${plural(result.copied, "card", "cards")}`];
  for (const side of SIDES) {
    if (result.unlinked[side] > 0) {
      parts.push(`${result.unlinked[side]} without a ${SIDE_LABEL[side]} card`);
    }
  }
  for (const side of SIDES) {
    if (result.ambiguous[side] > 0) {
      parts.push(
        `${result.ambiguous[side]} matched more than one ${SIDE_LABEL[side]} card`,
      );
    }
  }
  if (result.notCopied > 0) {
    parts.push(`${result.notCopied} left off — not on either marketplace's list`);
  }
  if ((result.skippedChangedSource ?? 0) > 0) {
    parts.push(
      `${result.skippedChangedSource} skipped — ${insert} changed them mid-build`,
    );
  }
  for (const side of SIDES) {
    const k = result.stillListedNotRelinked?.[side] ?? 0;
    if (k > 0) {
      parts.push(
        k === 1
          ? `1 ${SIDE_LABEL[side]} link not re-linked — still listed, check it`
          : `${k} ${SIDE_LABEL[side]} links not re-linked — still listed, check them`,
      );
    }
  }
  for (const side of SIDES) {
    const k = result.earlierLinksMissing[side];
    if (k > 0) {
      parts.push(
        k === 1
          ? `1 ${SIDE_LABEL[side]} link dropped — that card didn't come back`
          : `${k} ${SIDE_LABEL[side]} links dropped — those cards didn't come back`,
      );
    }
  }
  const legacy =
    (result.legacyLinksRemoved?.bsc ?? 0) +
    (result.legacyLinksRemoved?.sportlots ?? 0);
  if (legacy > 0) {
    parts.push(
      `${plural(legacy, "old link", "old links")} to ${insert}'s cards removed`,
    );
  }
  parts.push(...extraClauses);
  return parts.join(", ");
}

/** "BSC only" / "SportLots only" when exactly one side was fetched. */
export function sideOnlyText(result: ParallelBuildResult): string | null {
  if (result.sidesFetched.length !== 1) return null;
  return `${SIDE_LABEL[result.sidesFetched[0]]} only`;
}

/**
 * "Blocked — {reason}". A block that fired partway through removing the old
 * cards says so, because the parallel is now short of cards:
 * "Blocked — {reason}, after 40 old cards were removed — build it again".
 */
export function blockedText(reason?: string, deleted?: number): string {
  const base = reason ? `Blocked — ${reason}` : "Blocked";
  if (!deleted) return base;
  return `${base}, after ${plural(deleted, "old card was", "old cards were")} removed — build it again`;
}

export function failedText(message: string): string {
  return `Failed — ${message}`;
}

/** A line's status, without the parallel's name. */
export function lineStatusText(line: ParallelLine, insertValue?: string): string {
  switch (line.kind) {
    case "waiting":
      return WAITING_TEXT;
    case "building":
      return BUILDING_TEXT;
    case "built":
      return builtText(line.result, insertValue);
    case "skipped":
      return SKIPPED_TEXT;
    case "blocked":
      return blockedText(line.reason, line.deleted);
    case "stopped":
      return STOPPED_TEXT;
    case "failed":
      return failedText(line.message);
    case "unfinished":
      return UNFINISHED_TEXT;
  }
}

/**
 * "Anime Kanji — Built 48 cards". One string in one element on purpose: the
 * E2E driver's `text:` is an element's own text nodes, so a line split across
 * spans could never be asserted whole.
 */
export function parallelLineText(
  value: string,
  line: ParallelLine,
  insertValue?: string,
): string {
  return `${value} — ${lineStatusText(line, insertValue)}`;
}

/** Built lines in a run, rebuilds included. */
const countKind = (run: ParallelRun, kind: ParallelLine["kind"]) =>
  run.entries.filter((e) => e.line.kind === kind).length;

/**
 * The heading.
 *
 *   running  "Building parallels of Anime — 2 of 5"   (the line being built)
 *   finished "Anime parallels — 3 built, 1 blocked, 1 skipped"  (non-zero parts only)
 *   stopped  "Anime parallels — stopped after 2 of 5"  (2 = built)
 *   left     "Anime parallels — stopped when you left, 2 of 5 built"
 */
export function panelHeading(run: ParallelRun): string {
  const total = run.entries.length;
  const insert = run.insertValue;
  if (run.phase === "running" || run.phase === "stopping") {
    const at =
      run.atIndex ??
      Math.max(
        0,
        run.entries.findIndex((e) => e.line.kind === "waiting"),
      );
    return `Building parallels of ${insert} — ${Math.min(at + 1, total)} of ${total}`;
  }
  const built = countKind(run, "built");
  if (run.phase === "stopped") {
    return `${insert} parallels — stopped after ${built} of ${total}`;
  }
  if (run.phase === "left") {
    return `${insert} parallels — stopped when you left, ${built} of ${total} built`;
  }
  const parts = [
    [built, "built"],
    [countKind(run, "blocked"), "blocked"],
    [countKind(run, "skipped"), "skipped"],
    [countKind(run, "failed"), "failed"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, word]) => `${n} ${word}`);
  return `${insert} parallels — ${parts.join(", ")}`;
}

/** Said once as a run starts: "Building 5 parallels of Anime". */
export function startText(insertValue: string, total: number): string {
  return `Building ${plural(total, "parallel", "parallels")} of ${insertValue}`;
}

/** The live region's periodic pulse on a large run: "12 of 40 done". */
export function pulseText(done: number, total: number): string {
  return `${done} of ${total} done`;
}

/** Shown when the server capped the list (M5: at most 500 parallels). */
export function truncatedText(count: number): string {
  return `Only the first ${count} parallels are listed — build the rest from their own rows.`;
}

/** Appended to "Saved N cards." when the parallels could not even be listed. */
export function planFailedText(message: string): string {
  return `Parallels not built — ${message}`;
}

/** The parallel row's button. */
export function buildButtonLabel(insertValue: string, hasCards: boolean) {
  return hasCards ? `Rebuild from ${insertValue}` : `Build from ${insertValue}`;
}

/** Said to a screen reader for a held control during a parallel-row build. */
export function manualBuildNote(insertValue: string): string {
  return `Building from ${insertValue}…`;
}

/**
 * The rebuild confirm (J3). The title is the question; the description is
 * what a rebuild does to the cards already there.
 */
export function rebuildConfirmCopy(
  parallelValue: string,
  insertValue: string,
  cardCount: number,
): { title: string; description: string } {
  return {
    title: `Replace ${parallelValue}'s ${plural(cardCount, "card", "cards")} with a fresh copy of ${insertValue}'s?`,
    description: `Every card is made fresh from ${insertValue}: hand edits on ${parallelValue}'s cards are replaced. Cards keep their SKU when they're the same card. Cards ${parallelValue}'s marketplaces don't list are left off.`,
  };
}

/**
 * What a parallel-row build says in the checklist's notice line, and in which
 * tone. Named, because the operator may have moved to another checklist by
 * the time it lands. A refusal and a failure are alerts; a build is the
 * committed notice (cards landed, so the attention call-to-action may follow).
 */
export function buildNotice(
  result: ParallelBuildResult,
  parallelValue: string,
  insertValue: string,
): { text: string; tone: "status" | "error" } {
  if (result.status === "blocked") {
    return {
      text: `${parallelValue} — ${blockedText(result.blockedReason, result.deletedCount)}`,
      tone: "error",
    };
  }
  const only = sideOnlyText(result);
  return {
    text: `${parallelValue} — ${builtText(result, insertValue)}.${only ? ` ${only}.` : ""}`,
    tone: "status",
  };
}

// ---------------------------------------------------------------------------
// Which cards (the disclosure)
// ---------------------------------------------------------------------------

type DetailBucket = { label: string; count: number; cards: string[] };

/**
 * The per-bucket card lists behind a built line — which cards were left off,
 * which have no card on a side, which matched more than one, and what the
 * parallel's marketplace lists that the insert does not. Only non-empty
 * buckets; the count is the server's (lists are capped at 50, counts are not).
 */
export function detailBuckets(
  result: ParallelBuildResult,
  insertValue: string,
): DetailBucket[] {
  const lists = result.cards;
  const buckets: DetailBucket[] = [
    {
      label: "Left off — not on either marketplace's list",
      count: result.notCopied,
      cards: lists?.leftOff ?? [],
    },
    ...SIDES.map((side) => ({
      label: `Without a ${SIDE_LABEL[side]} card`,
      count: result.unlinked[side],
      cards: lists?.unlinked?.[side] ?? [],
    })),
    ...SIDES.map((side) => ({
      label: `Matched more than one ${SIDE_LABEL[side]} card`,
      count: result.ambiguous[side],
      cards: lists?.ambiguous?.[side] ?? [],
    })),
    ...SIDES.map((side) => ({
      label: `On ${SIDE_LABEL[side]}, not in ${insertValue}`,
      count: result.extraOnMarketplace?.[side]?.count ?? 0,
      cards: result.extraOnMarketplace?.[side]?.cards ?? [],
    })),
  ];
  return buckets.filter((b) => b.cards.length > 0);
}

/** "…and 12 more" under a capped list. */
export function moreText(count: number): string {
  return `…and ${count} more`;
}

/**
 * The lists themselves. Quiet on purpose: sentence-case bucket labels in the
 * banner's own weight, card labels in a flowing two-column list, a thin rule
 * in the banner's border blue tying the block to the line it opened from.
 */
export function ParallelBuildDetails({
  id,
  result,
  insertValue,
}: {
  id: string;
  result: ParallelBuildResult;
  insertValue: string;
}) {
  const buckets = detailBuckets(result, insertValue);
  return (
    <div
      id={id}
      className="mt-1 mb-2 ml-[1.375rem] border-l border-blue-300 dark:border-blue-700 pl-3 space-y-2"
    >
      {buckets.map((bucket) => (
        <div key={bucket.label}>
          <p className="font-semibold">{`${bucket.label} (${bucket.count})`}</p>
          <ul className="mt-0.5 columns-1 sm:columns-2 gap-x-6">
            {bucket.cards.map((card, i) => (
              <li key={`${card}-${i}`} className="break-inside-avoid leading-5">
                {card}
              </li>
            ))}
          </ul>
          {bucket.count > bucket.cards.length && (
            <p className="italic">{moreText(bucket.count - bucket.cards.length)}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return userFacingMessage(
    error,
    error instanceof Error ? error.message : "Unknown error",
  );
}

// ---------------------------------------------------------------------------
// The runner (J1)
// ---------------------------------------------------------------------------

/**
 * Lines the server has already answered: a parallel holding no marketplace id
 * of its own has nothing to copy links from (and the insert's ids are never
 * borrowed — M4), and one the plan marks `blocked` would be refused. Neither is
 * sent to the action.
 */
function initialLine(entry: ParallelPlanEntry): ParallelLine {
  if (entry.blocked) return { kind: "blocked", reason: entry.blocked };
  if (!entry.sides.bsc && !entry.sides.sportlots) return { kind: "skipped" };
  return { kind: "waiting" };
}

/**
 * Above this many parallels, plain successes are not announced one by one;
 * the live region pulses "12 of 40 done" every `PULSE_EVERY` instead.
 */
const PULSE_AFTER = 10;
const PULSE_EVERY = 5;

/**
 * The run a set builder was showing when it unmounted mid-run, for the next
 * one to pick up. Module scope because the owner is gone by definition; one
 * slot, because only the most recent run can still be news.
 */
let leftBehind: ParallelRun | null = null;

function asLeftBehind(run: ParallelRun): ParallelRun {
  return {
    ...run,
    phase: "left",
    entries: run.entries.map((e) =>
      e.line.kind === "waiting"
        ? { ...e, line: { kind: "stopped" } }
        : e.line.kind === "building"
          ? { ...e, line: { kind: "unfinished" } }
          : e,
    ),
  };
}

export type ParallelBuildRunner = {
  run: ParallelRun | null;
  /** True while the loop is live — the checklist holds its edit controls. */
  active: boolean;
  /** Parallels with a build in flight from this tab, automatic or by hand. */
  inFlight: ReadonlySet<string>;
  /**
   * List the insert's parallels and build each in turn. Resolves when the
   * loop has ended; resolves to a message only when the LIST could not be
   * read (nothing was built), so the caller can say so beside "Saved N".
   */
  start: (
    insertId: Id<"selectorOptions">,
    insertValue: string,
    /** The Convex client to build through; see `useHostedParallelBuildRun`. */
    client?: BuildClient,
  ) => Promise<string | null>;
  /** Finish the parallel in flight, then build no more. */
  stop: () => void;
  /**
   * Run one build of one parallel through the registry. Resolves `undefined`
   * WITHOUT calling when that parallel already has a build in flight — the
   * parallel-row button's path. The run itself waits its turn instead.
   */
  buildOne: <T>(
    parallelId: string,
    call: () => Promise<T>,
  ) => Promise<T | undefined>;
};

/** The two calls the run makes — a `ConvexReactClient`, as `useConvex()` returns it. */
export type BuildClient = Pick<ConvexReactClient, "query" | "action">;

/**
 * The runner, with the component's own Convex client as the default for
 * `start`. What a checklist on its own (and a test) uses.
 */
export function useParallelBuildRun(): ParallelBuildRunner {
  return useRunnerCore(useConvex());
}

/**
 * The runner for a HOST that does not talk to Convex itself (the set
 * builder): the caller that starts a run hands its client to `start`. Kept
 * free of `useConvex` so hosting it adds no Convex dependency to the host —
 * the checklist, which always starts the run, already holds a client.
 */
export function useHostedParallelBuildRun(): ParallelBuildRunner {
  return useRunnerCore(null);
}

function useRunnerCore(defaultClient: BuildClient | null): ParallelBuildRunner {
  // A set builder opened after one was left mid-run starts on what it left.
  // Read here, cleared in the mount effect below: an initializer must stay
  // pure (StrictMode runs it twice).
  const [run, setRun] = useState<ParallelRun | null>(() => leftBehind);
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** The builds in flight, as promises — what a second caller waits on. */
  const inFlightRef = useRef(new Map<string, Promise<unknown>>());
  /** Read between calls; set by Stop, cleared by the next start. */
  const stopRef = useRef(false);
  /** Which start is current — a superseded loop stops writing. */
  const runIdRef = useRef(0);
  /** The loop sends nothing more once its owner is gone. */
  const aliveRef = useRef(true);
  /** The latest run, for the unmount record. */
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  useEffect(() => {
    aliveRef.current = true;
    leftBehind = null;
    return () => {
      aliveRef.current = false;
      const last = runRef.current;
      if (last && (last.phase === "running" || last.phase === "stopping")) {
        leftBehind = asLeftBehind(last);
      }
    };
  }, []);

  const active = run?.phase === "running" || run?.phase === "stopping";

  /**
   * Closing or reloading the tab mid-run ends it; ask first. The browser
   * shows its own wording — the text is not settable.
   */
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const track = useCallback(
    <T,>(parallelId: string, call: () => Promise<T>): Promise<T> => {
      const tracked = (async () => {
        try {
          return await call();
        } finally {
          inFlightRef.current.delete(parallelId);
          setInFlight((prev) => {
            const next = new Set(prev);
            next.delete(parallelId);
            return next;
          });
        }
      })();
      inFlightRef.current.set(parallelId, tracked);
      setInFlight((prev) => new Set(prev).add(parallelId));
      return tracked;
    },
    [],
  );

  const buildOne = useCallback(
    async <T,>(
      parallelId: string,
      call: () => Promise<T>,
    ): Promise<T | undefined> => {
      if (inFlightRef.current.has(parallelId)) return undefined;
      return track(parallelId, call);
    },
    [track],
  );

  const start = useCallback(
    async (
      insertId: Id<"selectorOptions">,
      insertValue: string,
      client?: BuildClient,
    ): Promise<string | null> => {
      const convex = client ?? defaultClient;
      if (!convex) {
        throw new Error("A hosted parallel-build runner needs a Convex client to start.");
      }
      const myRun = ++runIdRef.current;
      stopRef.current = false;
      const current = () => aliveRef.current && runIdRef.current === myRun;

      let plan: ParallelBuildPlan;
      try {
        plan = await convex.query(
          api.parallelChecklistBuild.getParallelsForBuild,
          { insertId },
        );
      } catch (error) {
        return current() ? errorMessage(error) : null;
      }
      if (!current()) return null;
      if (plan.parallels.length === 0) {
        setRun(null);
        return null;
      }

      // The loop's own copy, written through and handed to React as a fresh
      // array on every change. Once Stop is pressed every line still waiting
      // is handed over as "Stopped" — `stop()` already showed it that way,
      // and a later publish must not put "Waiting" back.
      const entries: ParallelRunEntry[] = plan.parallels.map((p) => ({
        id: p._id,
        value: p.value,
        line: initialLine(p),
      }));
      const total = entries.length;
      const pulses = total > PULSE_AFTER;
      const snapshot = (): ParallelRunEntry[] =>
        stopRef.current
          ? entries.map((e) =>
              e.line.kind === "waiting"
                ? { ...e, line: { kind: "stopped" } }
                : e,
            )
          : [...entries];
      const publish = (patch: Partial<ParallelRun>) =>
        setRun((prev) =>
          prev ? { ...prev, ...patch, entries: snapshot() } : prev,
        );

      const opening: ParallelRun = {
        insertId,
        insertValue,
        entries: [...entries],
        truncated: plan.truncated,
        phase: "running",
        atIndex: null,
        announcement: "",
      };
      // Worded apart from the heading on purpose, so the page never carries
      // the heading's text twice (a text find would match both).
      opening.announcement = startText(insertValue, total);
      setRun(opening);

      for (let i = 0; i < entries.length; i++) {
        if (!current()) return null;
        if (entries[i].line.kind !== "waiting") continue;
        if (stopRef.current) break;
        entries[i] = { ...entries[i], line: { kind: "building" } };
        publish({ atIndex: i });
        const parallelId = entries[i].id;
        let line: ParallelLine;
        try {
          // A build of this parallel from its own row may still be in
          // flight (started before this save): let it land, then rebuild
          // from the checklist just saved.
          const pending = inFlightRef.current.get(parallelId);
          if (pending) await pending.catch(() => undefined);
          const result: ParallelBuildResult = await track(parallelId, () =>
            convex.action(api.parallelChecklistBuild.buildParallelChecklist, {
              parallelId,
            }),
          );
          line =
            result.status === "blocked"
              ? {
                  kind: "blocked",
                  reason: result.blockedReason,
                  deleted: result.deletedCount,
                }
              : { kind: "built", result };
        } catch (error) {
          // One parallel failing is that parallel's news, not the run's end.
          line = { kind: "failed", message: errorMessage(error) };
        }
        if (!current()) return null;
        entries[i] = { ...entries[i], line };
        // Blocked and failed are always said, one by one — each asks for a
        // look. A plain success is said one by one on a small run, and as a
        // "12 of 40 done" pulse on a large one; see the panel's live region.
        const done = i + 1;
        const announce =
          line.kind !== "built" || !pulses
            ? parallelLineText(entries[i].value, line, insertValue)
            : done % PULSE_EVERY === 0
              ? pulseText(done, total)
              : undefined;
        publish(announce === undefined ? {} : { announcement: announce });
      }

      const stopped = stopRef.current;
      setRun((prev) => {
        if (!prev) return prev;
        const done: ParallelRun = {
          ...prev,
          entries: snapshot(),
          phase: stopped ? "stopped" : "finished",
        };
        // The heading as a sentence — the full stop keeps it a different
        // string from the heading itself, for the same reason as the start.
        done.announcement = `${panelHeading(done)}.`;
        return done;
      });
      return null;
    },
    [defaultClient, track],
  );

  const stop = useCallback(() => {
    if (stopRef.current) return;
    stopRef.current = true;
    // Said at once rather than after the call in flight returns: the lines
    // still waiting will not be built from this moment on.
    setRun((prev) =>
      prev && prev.phase === "running"
        ? {
            ...prev,
            phase: "stopping",
            entries: prev.entries.map((e) =>
              e.line.kind === "waiting"
                ? { ...e, line: { kind: "stopped" } }
                : e,
            ),
          }
        : prev,
    );
  }, []);

  return { run, active, inFlight, start, stop, buildOne };
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Each state's glyph and colour. The glyph is `aria-hidden`: the line's text
 * says the state in words, so colour and shape are never the only signal
 * (SC 1.4.1). Colours are the `-700` / `-300` pairs this file's banner family
 * already clears 4.5:1 with on `blue-100` and `blue-900/30`-over-`gray-800`.
 */
const LINE_GLYPH: Record<ParallelLine["kind"], { icon: HeroIcon; tone: string }> = {
  waiting: { icon: ClockIcon, tone: "text-blue-700 dark:text-blue-300" },
  building: {
    icon: ArrowPathIcon,
    tone: "text-blue-700 dark:text-[#00C2FF] motion-safe:animate-spin",
  },
  built: { icon: CheckIcon, tone: "text-green-700 dark:text-[#00D558]" },
  skipped: { icon: MinusCircleIcon, tone: "text-blue-700 dark:text-blue-300" },
  blocked: { icon: NoSymbolIcon, tone: "text-amber-700 dark:text-amber-300" },
  stopped: { icon: StopCircleIcon, tone: "text-blue-700 dark:text-blue-300" },
  failed: {
    icon: ExclamationTriangleIcon,
    tone: "text-pink-700 dark:text-pink-300",
  },
  unfinished: { icon: ClockIcon, tone: "text-amber-700 dark:text-amber-300" },
};

/**
 * The sleeve strip — one card-shaped slot per parallel, filling like a binder
 * page as each one lands. Decorative (the ledger below says everything in
 * words), so the whole strip is `aria-hidden`; a slot's `title` repeats its
 * line for a pointer.
 */
const SLEEVE_TONE: Record<ParallelLine["kind"], string> = {
  waiting: "border-blue-400 dark:border-blue-500 bg-transparent",
  building: "border-[#00C2FF] bg-[#00C2FF]/40 motion-safe:animate-pulse",
  built: "border-green-700 dark:border-[#00D558] bg-[#00D558]",
  skipped: "border-blue-300 dark:border-blue-700 bg-blue-300/40 dark:bg-blue-700/40",
  blocked: "border-amber-700 dark:border-amber-400 bg-amber-400",
  stopped: "border-blue-300 dark:border-blue-700 bg-blue-300/40 dark:bg-blue-700/40",
  failed: "border-pink-700 dark:border-pink-400 bg-[#FF2E9A]",
  unfinished: "border-amber-700 dark:border-amber-400 bg-transparent",
};

/** Above this many lines the ledger scrolls inside the panel. */
const SCROLL_AFTER = 8;

export default function ParallelBuildPanel({
  run,
  onStop,
}: {
  run: ParallelRun;
  onStop: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // NEO-260: the E2E driver re-finds a focused control by an XPath built from
  // its class, so Stop carries the document-unique marker class — never a
  // DOM id (which would also hide an aria-label from its `id:` finds).
  const fieldClass = useFieldTestClass();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const live = run.phase === "running" || run.phase === "stopping";
  const stopping = run.phase === "stopping";
  const scrolls = run.entries.length > SCROLL_AFTER;

  /**
   * a11y (WCAG 2.4.3) — Stop unmounts when the run ends. If it had focus the
   * browser drops it to `<body>`; park it on the panel, whose heading now
   * says how the run ended. Only when focus really was dropped: anywhere
   * else, the operator put it there (the house guard, as in the solo-fetch
   * and fill-teams parks).
   */
  const wasLiveRef = useRef(live);
  useEffect(() => {
    const ended = wasLiveRef.current && !live;
    wasLiveRef.current = live;
    if (!ended) return;
    if (document.activeElement !== document.body) return;
    panelRef.current?.focus();
  }, [live]);

  /**
   * a11y (WCAG 2.4.3) — the other end of the same gap. A run starts right
   * after a save, and holding the insert's controls for the run can blur the
   * one that had focus; the solo-fetch park's answer applies — land on the
   * thing that now says what is happening, whose Stop is one Tab away. Once,
   * on mount, and only if focus was dropped.
   */
  useEffect(() => {
    if (!wasLiveRef.current) return;
    const active = document.activeElement;
    // A focused button that has just gone `disabled` counts as dropped: the
    // browser's focus fix-up that moves it to <body> can land after this.
    const dropped =
      active === document.body ||
      (active instanceof HTMLButtonElement && active.disabled);
    if (!dropped) return;
    panelRef.current?.focus();
  }, []);

  /**
   * Keep the line being built in view INSIDE the ledger. `scrollTop` rather
   * than `scrollIntoView`, which would also scroll the page under an operator
   * who is reading something else.
   */
  useEffect(() => {
    if (!scrolls || run.atIndex === null) return;
    const scroller = scrollerRef.current;
    const row = scroller?.querySelector<HTMLElement>(
      `[data-parallel-line="${run.atIndex}"]`,
    );
    if (!scroller || !row) return;
    scroller.scrollTop = Math.max(
      0,
      row.offsetTop - scroller.clientHeight / 2 + row.offsetHeight / 2,
    );
  }, [run.atIndex, scrolls]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const list = (
    <ul className="space-y-0.5">
      {run.entries.map((entry, i) => {
        const glyph = LINE_GLYPH[entry.line.kind];
        const Icon = glyph.icon;
        const result = entry.line.kind === "built" ? entry.line.result : null;
        const only = result ? sideOnlyText(result) : null;
        const text = parallelLineText(entry.value, entry.line, run.insertValue);
        const hasDetail =
          result !== null && detailBuckets(result, run.insertValue).length > 0;
        const expanded = open.has(entry.id);
        const detailId = `parallel-build-detail-${entry.id}`;
        return (
          <li
            key={entry.id}
            id={parallelLineId(entry.id)}
            data-parallel-line={i}
            className="leading-5"
          >
            <div className="flex items-start gap-1.5">
              <Icon
                aria-hidden="true"
                className={`mt-0.5 h-4 w-4 shrink-0 ${glyph.tone}`}
              />
              {hasDetail ? (
                // The line IS the disclosure: its text is the button's name,
                // so each one is unique and the E2E driver still reads the
                // whole line as one text node. The chevron is the only mark
                // that says it opens.
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  onClick={() => toggle(entry.id)}
                  onKeyDown={(event) =>
                    activateOnEnter(event, () => toggle(entry.id))
                  }
                  className="group min-w-0 break-words text-left rounded-sm underline decoration-dotted underline-offset-2 hover:decoration-solid"
                >
                  {text}
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={`ml-1 inline h-3.5 w-3.5 align-[-2px] motion-safe:transition-transform ${expanded ? "rotate-90" : ""}`}
                  />
                </button>
              ) : (
                <span className="min-w-0 break-words">{text}</span>
              )}
              {only && (
                <span className="ml-auto shrink-0 rounded-full border border-blue-500 dark:border-blue-400 px-1.5 text-[11px] font-medium leading-4 mt-0.5">
                  {only}
                </span>
              )}
            </div>
            {hasDetail && expanded && result && (
              <ParallelBuildDetails
                id={detailId}
                result={result}
                insertValue={run.insertValue}
              />
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    // a11y — a labelled region, NOT a live one. The ledger changes on every
    // step ("Waiting" → "Building…" → "Built 48 cards") and the heading's
    // counter ticks with it; a live panel would read all of that aloud. The
    // one live line is the sr-only status below. `tabIndex={-1}`: the focus
    // park for a Stop that unmounted under focus, with its own ring because a
    // programmatic target still needs one (2.4.7).
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={PARALLEL_BUILD_HEADING_ID}
      className="p-3 mb-3 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md text-blue-800 dark:text-blue-200 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:focus-visible:ring-blue-300"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id={PARALLEL_BUILD_HEADING_ID} className="font-semibold tabular-nums">
          {panelHeading(run)}
        </h3>
        {live && (
          // The in-banner button shape the solo fetch's Cancel and the
          // post-commit call-to-action already use, with the same 32px hit
          // area (`py-1.5 -my-1.5`, SC 2.5.8) and the UA focus ring left in
          // place. Its text is its name. `aria-disabled` (never native
          // `disabled`) once pressed, so focus stays on it for the rest of
          // the call in flight rather than blurring to <body>. Enter is
          // handled here because the E2E driver's `pressKey` has no default
          // action.
          <button
            type="button"
            onClick={() => {
              if (!stopping) onStop();
            }}
            onKeyDown={(event) => activateOnEnter(event, onStop, stopping)}
            aria-disabled={stopping || undefined}
            className={`${fieldClass("stop")} shrink-0 rounded-sm font-semibold underline decoration-dotted hover:decoration-solid py-1.5 -my-1.5 aria-disabled:no-underline aria-disabled:cursor-not-allowed aria-disabled:opacity-75`}
          >
            {stopping ? STOPPING_LABEL : STOP_LABEL}
          </button>
        )}
      </div>

      <div aria-hidden="true" className="mt-2 flex flex-wrap gap-1">
        {run.entries.map((entry) => (
          <span
            key={entry.id}
            title={parallelLineText(entry.value, entry.line, run.insertValue)}
            className={`h-3.5 w-2.5 rounded-[2px] border ${SLEEVE_TONE[entry.line.kind]}`}
          />
        ))}
      </div>

      <div className="mt-2 text-xs">
        {scrolls ? (
          // A scroller a keyboard cannot focus cannot be scrolled from the
          // keyboard; a named, focusable group is the pairing the lint rule
          // and `ConfirmDialog` already use.
          <div
            ref={scrollerRef}
            role="group"
            aria-label={RESULTS_GROUP_LABEL}
            tabIndex={0}
            className="relative max-h-48 overflow-y-auto pr-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:focus-visible:ring-blue-300"
          >
            {list}
          </div>
        ) : (
          list
        )}
      </div>

      {run.truncated && (
        <p className="mt-2 text-xs">{truncatedText(run.entries.length)}</p>
      )}

      {/*
        a11y — the one live line, and deliberately POLITE for everything it
        says, failures included. The house split (routine → role="status",
        failure → role="alert") is for a single result the operator is
        waiting on. A run is a stream: on a 40-parallel insert, an assertive
        region per blocked or failed parallel would cut into whatever the
        screen reader is reading every few seconds, for minutes, about
        parallels the operator is not being asked to act on mid-run. So each
        blocked or failed line is still said on its own (never folded into a
        count), plain successes are said one by one on a small run and as a
        "12 of 40 done" pulse on a large one, and the whole run is summed up
        in the final heading, said once at the end. Every line also stays in
        the ledger above to be read at leisure.
      */}
      <p className="sr-only" role="status">
        {run.announcement}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The parallel row's button (J4)
// ---------------------------------------------------------------------------

/** What a parallel-row build hands the checklist's notice line. */
export type ParallelBuildReport = {
  /** Which parallel — the operator may have moved on by the time it lands. */
  parallelId: Id<"selectorOptions">;
  insertValue: string;
  text: string;
  tone: "status" | "error";
  /** Cards landed. */
  committed: boolean;
  result?: ParallelBuildResult;
};

/**
 * Stands where the Sync button stands on every other row, and follows the
 * NEO-306 set-row action contract: the visible text is the accessible name
 * (no `aria-label`), busy and held are `aria-busy`/`aria-disabled` (never
 * native `disabled`, which would blur the button just pressed), Enter is
 * activation, and the trigger is `inert` while its confirm is up.
 *
 * Drawn as the `NeonButton` it replaces rather than a `SetRowActionButton`
 * chip: that component's quiet tone is grey-on-dark for the always-dark
 * attributes panel, and this sits on the checklist card, which is white in
 * a light OS theme — where `gray-200` text would all but vanish. Same slot,
 * same weight as its neighbours (Add Card, Add Cross-Release Cards). A long
 * insert name truncates, with the whole label in `title`.
 *
 * With a `runner`, the build goes through its in-flight registry, so a
 * button remounted mid-build (the operator moved away and back) still shows
 * its parallel as busy, and cannot start a second build of it.
 */
export function ParallelBuildButton({
  parallelId,
  parallelValue,
  insertValue,
  cardCount,
  primary = false,
  held = false,
  runner,
  buttonRef,
  onResult,
}: {
  parallelId: Id<"selectorOptions">;
  parallelValue: string;
  insertValue: string;
  /** The parallel's cards right now: 0 builds, anything else confirms a rebuild. */
  cardCount: number;
  /** The empty-state call-to-action is the primary green; the header one is secondary. */
  primary?: boolean;
  /** Held while the insert's own run is building parallels. */
  held?: boolean;
  runner?: Pick<ParallelBuildRunner, "inFlight" | "buildOne">;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** The checklist's notice line. */
  onResult: (report: ParallelBuildReport) => void;
}) {
  const buildParallel = useAction(
    api.parallelChecklistBuild.buildParallelChecklist,
  );
  const fieldClass = useFieldTestClass();
  const [confirming, setConfirming] = useState(false);
  const [building, setBuilding] = useState(false);
  /**
   * The trigger goes `inert` under the confirm, and going inert blurs it, so
   * the dialog's own restore captured `<body>`. Put focus back here in an
   * effect, after the commit that lifts `inert` (the house pattern).
   */
  const restoreRef = useRef(false);
  const ownRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = buttonRef ?? ownRef;
  useEffect(() => {
    if (confirming || !restoreRef.current) return;
    restoreRef.current = false;
    triggerRef.current?.focus();
  }, [confirming, triggerRef]);

  const hasCards = cardCount > 0;
  const busy = building || (runner?.inFlight.has(parallelId) ?? false);
  const blocked = busy || held;

  const build = async () => {
    if (busy) return;
    setBuilding(true);
    try {
      const call = () => buildParallel({ parallelId });
      const result: ParallelBuildResult | undefined = runner
        ? await runner.buildOne(parallelId, call)
        : await call();
      // Undefined: another build of this parallel was already in flight, and
      // its own caller reports it.
      if (result) {
        const notice = buildNotice(result, parallelValue, insertValue);
        onResult({
          parallelId,
          insertValue,
          ...notice,
          committed: result.status === "built",
          result,
        });
      }
    } catch (error) {
      onResult({
        parallelId,
        insertValue,
        text: `${parallelValue} — ${failedText(errorMessage(error))}`,
        tone: "error",
        committed: false,
      });
    } finally {
      setBuilding(false);
      if (confirming) restoreRef.current = true;
      setConfirming(false);
    }
  };

  const activate = () => {
    if (blocked) return;
    if (hasCards) setConfirming(true);
    else void build();
  };

  const copy = rebuildConfirmCopy(parallelValue, insertValue, cardCount);
  const label = busy && !confirming
    ? BUILD_BUSY_LABEL
    : buildButtonLabel(insertValue, hasCards);

  return (
    <>
      <NeonButton
        ref={triggerRef}
        className={`${fieldClass("build")} max-w-[18rem]`}
        secondary={!primary}
        onClick={activate}
        onKeyDown={(event) => activateOnEnter(event, activate, blocked)}
        aria-disabled={blocked || undefined}
        aria-busy={busy || undefined}
        aria-haspopup={hasCards ? "dialog" : undefined}
        inert={confirming || undefined}
        title={label}
      >
        <span className="min-w-0 truncate">{label}</span>
      </NeonButton>
      {confirming && (
        <ConfirmDialog
          title={copy.title}
          description={copy.description}
          confirmLabel={REBUILD_CONFIRM_LABEL}
          busyLabel={REBUILD_BUSY_LABEL}
          busy={building}
          onConfirm={() => void build()}
          onCancel={() => {
            if (building) return;
            restoreRef.current = true;
            setConfirming(false);
          }}
        />
      )}
    </>
  );
}
