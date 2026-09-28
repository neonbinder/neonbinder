import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
  type SVGProps,
} from "react";
import { useAction, useConvex } from "convex/react";
import {
  ArrowPathIcon,
  CheckIcon,
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
 *     is built, one at a time, automatically. `useParallelBuildRun` is the
 *     runner and `ParallelBuildPanel` is what it says on screen, under the
 *     "Saved N cards." notice. The operator can stop it between parallels,
 *     never mid-call.
 *   - **On a parallel's own row** (J4), `ParallelBuildButton` stands where the
 *     Sync button stands on every other row: "Build from Anime", or — once the
 *     parallel has cards — "Rebuild from Anime" behind a confirm (J3 replaces
 *     the cards with a fresh copy).
 *
 * The runner lives in a HOOK the checklist calls above its loading
 * early-return, not in the panel: the checklist is reused (not remounted) when
 * the operator clicks from the insert into one of its parallels, and its
 * `cards` query goes `undefined` for a beat on every such move. A loop owned
 * by the panel would be unmounted by that beat and silently drop every
 * parallel still waiting. Owned by the hook, the run survives the operator
 * looking at the parallel it has just built.
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

export type ParallelBuildResult = {
  status: "built" | "blocked";
  copied: number;
  notCopied: number;
  unlinked: { bsc: number; sportlots: number };
  ambiguous: { bsc: number; sportlots: number };
  sidesFetched: SyncSide[];
  sidesSkipped: SyncSide[];
  earlierLinksMissing: { bsc: number; sportlots: number };
  rebuilt: boolean;
  blockedReason?: string;
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
  | { kind: "blocked"; reason?: string }
  | { kind: "stopped" }
  | { kind: "failed"; message: string };

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
   */
  phase: "running" | "stopping" | "finished" | "stopped";
  /** Index of the entry most recently sent to the server; null before the first. */
  atIndex: number | null;
  /**
   * The one sentence the live region says. It changes when a parallel
   * FINISHES (and once at the start and once at the end) — never on
   * "Building…" and never on the heading's counter.
   */
  announcement: string;
};

// ---------------------------------------------------------------------------
// Copy (DRAFT)
// ---------------------------------------------------------------------------

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export const WAITING_TEXT = "Waiting";
export const BUILDING_TEXT = "Building…";
export const SKIPPED_TEXT = "Skipped — no marketplace ids";
export const STOPPED_TEXT = "Stopped";
export const STOP_LABEL = "Stop after this one";
export const STOPPING_LABEL = "Stopping after this one…";
export const RESULTS_GROUP_LABEL = "Parallel build results";
export const BUILD_BUSY_LABEL = "Building…";
export const REBUILD_CONFIRM_LABEL = "Replace the cards";
export const REBUILD_BUSY_LABEL = "Rebuilding…";

/**
 * "Built 48 cards", then only the clauses that are true:
 *
 *   "Built 48 cards, 2 without a BSC card, 1 matched more than one SportLots
 *    card, 3 left off — no card on any side, 1 earlier link wasn't found,
 *    rebuilt"
 *
 * Per side, never summed: a card can be unlinked or ambiguous on both, and a
 * summed count would claim more cards than there are.
 */
export function builtText(result: ParallelBuildResult): string {
  const parts = [`Built ${plural(result.copied, "card", "cards")}`];
  for (const side of ["bsc", "sportlots"] as const) {
    if (result.unlinked[side] > 0) {
      parts.push(`${result.unlinked[side]} without a ${SIDE_LABEL[side]} card`);
    }
  }
  for (const side of ["bsc", "sportlots"] as const) {
    if (result.ambiguous[side] > 0) {
      parts.push(
        `${result.ambiguous[side]} matched more than one ${SIDE_LABEL[side]} card`,
      );
    }
  }
  if (result.notCopied > 0) {
    parts.push(`${result.notCopied} left off — no card on any side`);
  }
  const missing =
    result.earlierLinksMissing.bsc + result.earlierLinksMissing.sportlots;
  if (missing > 0) {
    parts.push(
      missing === 1
        ? "1 earlier link wasn't found"
        : `${missing} earlier links weren't found`,
    );
  }
  if (result.rebuilt) parts.push("rebuilt");
  return parts.join(", ");
}

/** "BSC only" / "SportLots only" when exactly one side was fetched. */
export function sideOnlyText(result: ParallelBuildResult): string | null {
  if (result.sidesFetched.length !== 1) return null;
  return `${SIDE_LABEL[result.sidesFetched[0]]} only`;
}

export function blockedText(reason?: string): string {
  return reason ? `Blocked — ${reason}` : "Blocked";
}

export function failedText(message: string): string {
  return `Failed — ${message}`;
}

/** A line's status, without the parallel's name. */
export function lineStatusText(line: ParallelLine): string {
  switch (line.kind) {
    case "waiting":
      return WAITING_TEXT;
    case "building":
      return BUILDING_TEXT;
    case "built":
      return builtText(line.result);
    case "skipped":
      return SKIPPED_TEXT;
    case "blocked":
      return blockedText(line.reason);
    case "stopped":
      return STOPPED_TEXT;
    case "failed":
      return failedText(line.message);
  }
}

/**
 * "Anime Kanji — Built 48 cards". One string in one element on purpose: the
 * E2E driver's `text:` is an element's own text nodes, so a line split across
 * spans could never be asserted whole.
 */
export function parallelLineText(value: string, line: ParallelLine): string {
  return `${value} — ${lineStatusText(line)}`;
}

/**
 * The heading.
 *
 *   running  "Building parallels of Anime — 2 of 5"  (the line being built)
 *   finished "Parallels of Anime — 4 of 5 built"
 *   stopped  "Parallels of Anime — stopped, 2 of 5 built"
 */
export function panelHeading(run: ParallelRun): string {
  const total = run.entries.length;
  if (run.phase === "running" || run.phase === "stopping") {
    const at =
      run.atIndex ??
      Math.max(
        0,
        run.entries.findIndex((e) => e.line.kind === "waiting"),
      );
    return `Building parallels of ${run.insertValue} — ${Math.min(at + 1, total)} of ${total}`;
  }
  const built = run.entries.filter((e) => e.line.kind === "built").length;
  return run.phase === "stopped"
    ? `Parallels of ${run.insertValue} — stopped, ${built} of ${total} built`
    : `Parallels of ${run.insertValue} — ${built} of ${total} built`;
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

/**
 * The rebuild confirm (J3). The title is the question; the description is
 * the one rule the operator can SEE the effect of — cards may come back fewer
 * (J2).
 */
export function rebuildConfirmCopy(
  parallelValue: string,
  insertValue: string,
  cardCount: number,
): { title: string; description: string } {
  return {
    title: `Replace ${parallelValue}'s ${plural(cardCount, "card", "cards")} with a fresh copy of ${insertValue}'s?`,
    description: `Each copy links to ${parallelValue}'s own marketplace cards. A card that links on neither marketplace is left off.`,
  };
}

/**
 * What a parallel-row build says in the checklist's notice line, and in which
 * tone. A refusal and a failure are alerts; a build is the committed notice
 * (cards landed, so the attention call-to-action may follow it).
 */
export function buildNotice(result: ParallelBuildResult): {
  text: string;
  tone: "status" | "error";
} {
  if (result.status === "blocked") {
    return { text: blockedText(result.blockedReason), tone: "error" };
  }
  const only = sideOnlyText(result);
  return {
    text: `${builtText(result)}.${only ? ` ${only}.` : ""}`,
    tone: "status",
  };
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

export type ParallelBuildRunner = {
  run: ParallelRun | null;
  /** True while the loop is live — the checklist holds its Sync buttons. */
  active: boolean;
  /**
   * List the insert's parallels and build each in turn. Resolves when the
   * loop has ended; resolves to a message only when the LIST could not be
   * read (nothing was built), so the caller can say so beside "Saved N".
   */
  start: (
    insertId: Id<"selectorOptions">,
    insertValue: string,
  ) => Promise<string | null>;
  /** Finish the parallel in flight, then build no more. */
  stop: () => void;
};

export function useParallelBuildRun(): ParallelBuildRunner {
  const convex = useConvex();
  const [run, setRun] = useState<ParallelRun | null>(null);
  /** Read between calls; set by Stop, cleared by the next start. */
  const stopRef = useRef(false);
  /** Which start is current — a superseded loop stops writing. */
  const runIdRef = useRef(0);
  /** The loop outlives nothing: an unmounted checklist builds no more. */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const start = useCallback(
    async (
      insertId: Id<"selectorOptions">,
      insertValue: string,
    ): Promise<string | null> => {
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
      opening.announcement = panelHeading(opening);
      setRun(opening);

      for (let i = 0; i < entries.length; i++) {
        if (!current()) return null;
        if (entries[i].line.kind !== "waiting") continue;
        if (stopRef.current) break;
        entries[i] = { ...entries[i], line: { kind: "building" } };
        publish({ atIndex: i });
        let line: ParallelLine;
        try {
          const result: ParallelBuildResult = await convex.action(
            api.parallelChecklistBuild.buildParallelChecklist,
            { parallelId: entries[i].id },
          );
          line =
            result.status === "blocked"
              ? { kind: "blocked", reason: result.blockedReason }
              : { kind: "built", result };
        } catch (error) {
          // One parallel failing is that parallel's news, not the run's end.
          line = { kind: "failed", message: errorMessage(error) };
        }
        if (!current()) return null;
        entries[i] = { ...entries[i], line };
        publish({ announcement: parallelLineText(entries[i].value, line) });
      }

      const stopped = stopRef.current;
      setRun((prev) => {
        if (!prev) return prev;
        const done: ParallelRun = {
          ...prev,
          entries: snapshot(),
          phase: stopped ? "stopped" : "finished",
        };
        done.announcement = panelHeading(done);
        return done;
      });
      return null;
    },
    [convex],
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

  const active = run?.phase === "running" || run?.phase === "stopping";
  return { run, active, start, stop };
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
};

/**
 * The sleeve strip — one card-shaped slot per parallel, filling like a binder
 * page as each one lands. Decorative (the ledger below says everything in
 * words), so the whole strip is `aria-hidden`; a slot's `title` repeats its
 * line for a pointer.
 */
const SLEEVE_TONE: Record<ParallelLine["kind"], string> = {
  waiting: "border-blue-400 dark:border-blue-500 bg-transparent",
  building:
    "border-[#00C2FF] bg-[#00C2FF]/40 motion-safe:animate-pulse",
  built: "border-green-700 dark:border-[#00D558] bg-[#00D558]",
  skipped: "border-blue-300 dark:border-blue-700 bg-blue-300/40 dark:bg-blue-700/40",
  blocked: "border-amber-700 dark:border-amber-400 bg-amber-400",
  stopped: "border-blue-300 dark:border-blue-700 bg-blue-300/40 dark:bg-blue-700/40",
  failed: "border-pink-700 dark:border-pink-400 bg-[#FF2E9A]",
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
  const headingId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
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
   * after a save, and holding the insert's Sync button for the run blurs it
   * if it had focus; the solo-fetch park's answer applies — land on the
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

  const list = (
    <ul className="space-y-0.5">
      {run.entries.map((entry, i) => {
        const glyph = LINE_GLYPH[entry.line.kind];
        const Icon = glyph.icon;
        const only =
          entry.line.kind === "built" ? sideOnlyText(entry.line.result) : null;
        return (
          <li
            key={entry.id}
            data-parallel-line={i}
            className="flex items-start gap-1.5 leading-5"
          >
            <Icon
              aria-hidden="true"
              className={`mt-0.5 h-4 w-4 shrink-0 ${glyph.tone}`}
            />
            <span className="min-w-0 break-words">
              {parallelLineText(entry.value, entry.line)}
            </span>
            {only && (
              <span className="ml-auto shrink-0 rounded-full border border-blue-500 dark:border-blue-400 px-1.5 text-[11px] font-medium leading-4 mt-0.5">
                {only}
              </span>
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
    // one live line is the sr-only status below, which speaks once at the
    // start, once per parallel as it FINISHES, and once at the end.
    // `tabIndex={-1}`: the focus park for a Stop that unmounted under focus,
    // with its own ring because a programmatic target still needs one (2.4.7).
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="p-3 mb-3 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md text-blue-800 dark:text-blue-200 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:focus-visible:ring-blue-300"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="font-semibold tabular-nums">
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
          // action; the id is how that driver re-finds the focused control.
          <button
            type="button"
            id="parallel-build-stop"
            onClick={() => {
              if (!stopping) onStop();
            }}
            onKeyDown={(event) => activateOnEnter(event, onStop, stopping)}
            aria-disabled={stopping || undefined}
            className="shrink-0 rounded-sm font-semibold underline decoration-dotted hover:decoration-solid py-1.5 -my-1.5 aria-disabled:no-underline aria-disabled:cursor-not-allowed aria-disabled:opacity-75"
          >
            {stopping ? STOPPING_LABEL : STOP_LABEL}
          </button>
        )}
      </div>

      <div aria-hidden="true" className="mt-2 flex flex-wrap gap-1">
        {run.entries.map((entry) => (
          <span
            key={entry.id}
            title={parallelLineText(entry.value, entry.line)}
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

      <p className="sr-only" role="status">
        {run.announcement}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The parallel row's button (J4)
// ---------------------------------------------------------------------------

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
 * same weight as its neighbours (Add Card, Add Cross-Release Cards).
 */
export function ParallelBuildButton({
  parallelId,
  parallelValue,
  insertValue,
  cardCount,
  primary = false,
  held = false,
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
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** The checklist's notice line. */
  onResult: (
    text: string,
    tone: "status" | "error",
    committed: boolean,
  ) => void;
}) {
  const buildParallel = useAction(
    api.parallelChecklistBuild.buildParallelChecklist,
  );
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
  const blocked = building || held;

  const build = async () => {
    if (building) return;
    setBuilding(true);
    try {
      const result: ParallelBuildResult = await buildParallel({ parallelId });
      const notice = buildNotice(result);
      onResult(notice.text, notice.tone, result.status === "built");
    } catch (error) {
      onResult(failedText(errorMessage(error)), "error", false);
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

  return (
    <>
      <NeonButton
        ref={triggerRef}
        // One per checklist (header OR empty state, never both), so the E2E
        // driver's `pressKey` can re-find it.
        id="parallel-build"
        secondary={!primary}
        onClick={activate}
        onKeyDown={(event) => activateOnEnter(event, activate, blocked)}
        aria-disabled={blocked || undefined}
        aria-busy={building || undefined}
        aria-haspopup={hasCards ? "dialog" : undefined}
        inert={confirming || undefined}
      >
        {building && !confirming
          ? BUILD_BUSY_LABEL
          : buildButtonLabel(insertValue, hasCards)}
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
