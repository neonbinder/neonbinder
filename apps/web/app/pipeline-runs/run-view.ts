/**
 * The pure view logic behind /pipeline-runs (NEO-170) — queue math, the source
 * label, and the filter/sort the operator drives.
 *
 * Kept out of the component and free of React so the ordering and null-handling
 * rules — which are the whole substance of the filter/sort feature and are
 * invisible in a screenshot — are tested directly. The functions take a
 * structural `RunRow`, a subset of what `adminListPlaceholderJobs` returns, so a
 * test can build a row without the full query type and the page can pass its
 * rows straight through.
 */

export type RunStatus =
  | "pending"
  | "uploaded"
  | "collecting"
  | "extracting"
  | "processing"
  | "pairing"
  | "succeeded"
  | "failed";

export type RunSource = "scanner" | "web";

export type SortKey = "lastActivity" | "created" | "status" | "error";

export type StatusFilter = RunStatus | "all";

/** The fields the view logic reads. A structural subset of a job row. */
export interface RunRow {
  status: RunStatus;
  createdAt: number;
  lastActivityAt?: number;
  errorCode?: string;
  totalImages: number;
  processedImages: number;
  failedImages: number;
  source?: RunSource;
}

/**
 * Images still queued or in flight: everything the batch expects, minus the
 * ones that have reached a terminal per-image state (done or failed).
 *
 * Floored at zero so a mid-poll row where the counters have not caught up to
 * each other — `processed + failed` momentarily exceeding `total` — reads as
 * "0 in queue" rather than a negative count.
 */
export function inQueueCount(run: RunRow): number {
  return Math.max(0, run.totalImages - run.processedImages - run.failedImages);
}

/**
 * Progress as one composed sentence, so the E2E driver (and a screen reader)
 * can assert the string it sees rather than three separate cells.
 *
 * Always names the queue depth — "0 in queue" included, since an operator
 * scanning for wedged work needs the zero stated, not implied by its absence.
 * The failed tail appears only when there is something to report.
 */
export function progressText(run: RunRow): string {
  if (run.totalImages === 0) return "No images yet";
  const done = run.processedImages + run.failedImages;
  const base = `${done} of ${run.totalImages} images · ${inQueueCount(run)} in queue`;
  return run.failedImages > 0 ? `${base} · ${run.failedImages} failed` : base;
}

/**
 * How a run was started. `scanner` is the cardlister CLI, `web` is a browser
 * upload; absent means a row written before the field existed, shown as an
 * em dash rather than guessed. Text, never colour alone.
 */
export function sourceLabel(source: RunSource | undefined): string {
  if (source === "scanner") return "Scanner";
  if (source === "web") return "Web app";
  return "—";
}

/**
 * Status ordering for the "Status" sort: the active pipeline first (in the order
 * a run moves through it), then the pre-active states, then the terminal ones.
 * An operator sorting by status is looking for live work, so live work sorts to
 * the top.
 */
const STATUS_SORT_ORDER: RunStatus[] = [
  "collecting",
  "extracting",
  "processing",
  "pairing",
  "pending",
  "uploaded",
  "succeeded",
  "failed",
];

const statusRank = (status: RunStatus): number => {
  const index = STATUS_SORT_ORDER.indexOf(status);
  // An unknown status (a value added to the union but not here) sorts last
  // rather than to the top, where it would hide live work.
  return index === -1 ? STATUS_SORT_ORDER.length : index;
};

/** Newest first — the deterministic tiebreaker under every sort. */
const byCreatedDesc = (a: RunRow, b: RunRow): number => b.createdAt - a.createdAt;

/** Missing activity sorts as "longest ago", i.e. last under a desc sort. */
const activityOf = (run: RunRow): number =>
  run.lastActivityAt ?? Number.NEGATIVE_INFINITY;

/** The sort options, in menu order. The first is the page default. */
export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "lastActivity", label: "Last activity" },
  { key: "created", label: "Created" },
  { key: "status", label: "Status" },
  { key: "error", label: "Error" },
];

export const DEFAULT_SORT: SortKey = "lastActivity";

/**
 * A fresh, sorted array — the input (a live Convex result) is never mutated.
 *
 * Every branch ends in `byCreatedDesc` so the order is total and deterministic:
 * two rows that tie on the primary key never depend on input order or the
 * engine's sort stability.
 */
export function sortRuns<T extends RunRow>(runs: readonly T[], key: SortKey): T[] {
  const copy = [...runs];
  switch (key) {
    case "created":
      copy.sort(byCreatedDesc);
      break;
    case "status":
      copy.sort(
        (a, b) =>
          statusRank(a.status) - statusRank(b.status) ||
          activityOf(b) - activityOf(a) ||
          byCreatedDesc(a, b),
      );
      break;
    case "error":
      copy.sort((a, b) => {
        // Runs with an error group together and sort alphabetically by code;
        // runs with none fall to the bottom (nulls last).
        if (a.errorCode && b.errorCode) {
          return a.errorCode.localeCompare(b.errorCode) || byCreatedDesc(a, b);
        }
        if (a.errorCode) return -1;
        if (b.errorCode) return 1;
        return byCreatedDesc(a, b);
      });
      break;
    case "lastActivity":
    default:
      copy.sort((a, b) => activityOf(b) - activityOf(a) || byCreatedDesc(a, b));
      break;
  }
  return copy;
}

/** Narrow to one status, or pass everything through for "all". */
export function filterRuns<T extends RunRow>(
  runs: readonly T[],
  filter: StatusFilter,
): T[] {
  if (filter === "all") return [...runs];
  return runs.filter((run) => run.status === filter);
}

/**
 * The status filter's fixed option set: "All" plus every status the query can
 * return, in the sort order above. Fixed rather than derived from the loaded
 * rows so the control — and the E2E selectors that drive it — do not change
 * shape as runs come and go.
 */
export const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "collecting", label: "Collecting" },
  { value: "extracting", label: "Extracting" },
  { value: "processing", label: "Processing" },
  { value: "pairing", label: "Pairing" },
  { value: "pending", label: "Pending" },
  { value: "uploaded", label: "Uploaded" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];
