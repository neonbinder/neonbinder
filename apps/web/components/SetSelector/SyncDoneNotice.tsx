import { useId, useState } from "react";
import {
  TWIN_LINES_SHOWN,
  twinLeftIdsText,
  twinsLeftGuidance,
  twinsLeftSummary,
  type SelectorLevel,
  type TwinLeftEntry,
  type UnlinkedNotice as Notice,
} from "./selector-sync-feedback";

/**
 * NEO-211 (plans B + D) — everything a FINISHED sync still has to tell you.
 *
 * Two different things land here, because the backend folds them into one
 * `status: "done"` row and either can arrive without the other:
 *
 *   `message`  — one marketplace could not be reached while the other stored
 *                fine (plan B). A FIXED server-composed string; rendered
 *                verbatim, never rebuilt here.
 *   `notices`  — links this sync detached because a reached marketplace no
 *                longer lists those rows (plan D).
 *
 * They share one box and ONE dismiss control deliberately. A message-only done
 * row is the common partial-failure case, and giving it no way to clear itself
 * would leave a permanent banner over the column; giving each half its own
 * Dismiss would put two of them side by side in a 260-340px column for the case
 * where both arrive together.
 *
 * ## "The marketplace stopped listing these"
 *
 * Jason, 2026-09-03: "just remove BSC from the platform data and alert the user
 * that it was done. No need to track it in the DB." So there is no flag, no
 * staging row and no second screen: the store detaches the link, reports what it
 * detached, and this is the report. Nothing here is recoverable from the
 * database afterwards, which is exactly why it must not be possible to miss.
 *
 * ## Not an error, and not a delete
 *
 * The row, its name and its entire subtree are untouched — only that one
 * marketplace's link went away, and a later sync that returns the set under a
 * new id re-links it by name. So this is AMBER — the same "an unanswered
 * question, nothing broke" register as the suggestions pill and
 * `CardAttentionBadge` — never pink (destructive) or blue (neutral info): an
 * admin who reads "No longer listed on BSC" as "I lost my sets" has been told
 * the wrong thing, and one who scrolls past it as chrome has been told nothing.
 *
 * `role="status"` (implying `aria-live="polite"`) rather than `role="alert"`,
 * for the same reason: it is worth announcing when it appears, but it does not
 * interrupt. At levels 1-5 `EntityColumn` additionally fires the codebase's
 * existing toast pattern (`SetAttributesPanel`'s fixed-position `role="status"`
 * banner) on the syncing→done transition, because that column may well have
 * scrolled out of view by the time the sync lands.
 *
 * ## Dismissable, and the column stays usable behind it
 *
 * Rendered inline above the column's own controls rather than as an overlay:
 * the operator is mid-data-entry, and a modal for "an id changed upstream" would
 * be a stop sign in front of a signpost. Dismissal is per-surface — the column
 * calls the server's dismiss mutation so it does not come back on every
 * re-subscribe; the forms just drop their local copy.
 */
export default function SyncDoneNotice({
  message,
  notices,
  onDismiss,
  dismissing,
  columnLabel,
  twins,
}: {
  /** Server-composed partial-failure text. Rendered verbatim. */
  message?: string;
  notices: Notice[];
  onDismiss: () => void;
  /** Server round-trip in flight (column path); locks the button. */
  dismissing?: boolean;
  /**
   * NEO-260 — the noun of the column this notice belongs to ("Sports",
   * "Sets"), used to NAME the Dismiss button.
   *
   * A bare `aria-label="Dismiss notice"` is ambiguous the moment two columns
   * are showing a notice at once: a screen-reader user moving across the
   * cascade hears the same button twice with nothing to say which sync it
   * clears, and Maestro's `resource-id` (`node.id || node.ariaLabel`, matched
   * as an UNANCHORED regex) finds both. Same ambiguity class as the bare
   * "Collapse" this ticket already fixed, and the same remedy.
   *
   * Optional because two callers outside this change's scope (VariantForm,
   * ParallelForm) still render the notice inside a sync form; they keep the
   * old bare name until they are given one.
   */
  columnLabel?: string;
  /**
   * NEO-325 — names this sync LEFT for the operator because two or more
   * marketplace ids share them (`selectorSyncStatus.twinsLeft`, capped; `total`
   * is the true count). `level` picks where the guidance line points.
   */
  twins?: {
    entries: TwinLeftEntry[];
    total?: number;
    level?: SelectorLevel;
  };
}) {
  const hasTwins = !!twins && twins.entries.length > 0;
  // NEO-325 (a11y re-audit N1): with nothing to say, the live region is still
  // rendered, empty and unstyled, in the SAME element the notice fills. A
  // caller that keeps this mounted for the whole sync (VariantForm,
  // ParallelForm) then has a region that exists before its text arrives,
  // which is what gets a polite region announced. (EntityColumn mounts it
  // only with content; its toast announces the transition instead.)
  if (!message && notices.length === 0 && !hasTwins) return <div role="status" />;

  return (
    <div
      role="status"
      // border-amber-700 / dark:border-amber-400/70 (not /60 and /40): composited
      // over this box's own bg-amber-400/10, the /60 and /40 weights measured
      // 2.45:1 (light) and 2.57:1 (dark) — both fail WCAG 1.4.11's 3:1 non-text
      // minimum. This is the same pairing EntityColumn's suggestions pill
      // already uses (4.75:1 light / 4.96:1 dark).
      className="p-3 mb-1 bg-amber-400/10 border border-amber-700 dark:border-amber-400/70 rounded-md text-amber-800 dark:text-amber-300 text-sm flex items-start justify-between gap-2"
    >
      <div className="min-w-0 space-y-1">
        {message && <p className="break-words">{message}</p>}
        {notices.map((n) => (
          <p key={n.side} className="break-words">
            {n.text}
          </p>
        ))}
        {/* The reassurance is the point of the unlink notice, not decoration on
            it: "no longer listed" reads as "deleted" unless we say otherwise.
            Scoped to the unlink half — it makes no sense over a message that is
            only reporting an unreachable marketplace. */}
        {notices.length > 0 && (
          <p className="text-xs opacity-80">
            These are still yours — only the marketplace link was removed.
          </p>
        )}
        {hasTwins && twins && (
          <TwinsLeft
            entries={twins.entries}
            total={twins.total}
            level={twins.level}
            columnLabel={columnLabel}
          />
        )}
      </div>
      <button
        type="button"
        // aria-disabled, not disabled: the column's own dismiss round-trip is
        // moot in every current caller (the notice already unmounts on the
        // same render the optimistic local dismiss lands), but a future
        // caller that keeps this visible while `dismissing` is true must not
        // hit the native-disabled-strands-focus bug this codebase keeps
        // finding one button at a time.
        onClick={dismissing ? undefined : onDismiss}
        aria-disabled={dismissing || undefined}
        aria-label={
          columnLabel ? `Dismiss ${columnLabel} notice` : "Dismiss notice"
        }
        // px-2 py-1.5 (not px-1, no py): a bare underline link with no
        // vertical padding measures well under WCAG 2.5.8's 24px minimum
        // target size.
        className="shrink-0 text-xs underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-[#00B7FF] rounded px-2 py-1.5 aria-disabled:opacity-50"
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * NEO-325 — the twin half of the notice: what the sync left alone because a
 * marketplace lists the name more than once, each with its ids, and where to
 * link it from this column.
 *
 * Three lines show; the rest sit behind "Show all N". The button comes
 * BEFORE the list it reveals, in the DOM and on screen, so a keyboard or
 * screen-reader user who opens it moves straight on into the new lines. The
 * revealed list is still wrapped in `aria-live="off"`: this whole box is
 * `role="status"`, which is atomic, so without it opening the list would
 * re-announce every line.
 *
 * Each line is ONE text node — "Anime (SportLots #378117, #378118)" — so a
 * flow's full-string `text:` on a set name never matches the notice by
 * accident.
 */
function TwinsLeft({
  entries,
  total,
  level,
  columnLabel,
}: {
  entries: TwinLeftEntry[];
  total?: number;
  level?: SelectorLevel;
  columnLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const shown = entries.slice(0, TWIN_LINES_SHOWN);
  const rest = entries.slice(TWIN_LINES_SHOWN);
  // Past the server's cap: named nowhere, counted here.
  const unnamed = Math.max(0, (total ?? entries.length) - entries.length);
  const guidance = twinsLeftGuidance(level);
  const where = columnLabel ? `the ${columnLabel} notice` : "this notice";
  const line = (e: TwinLeftEntry, i: number) => (
    <li key={`${i}:${e.name}`} className="break-words">
      {`${e.name} (${twinLeftIdsText(e)})`}
    </li>
  );
  return (
    <div className="space-y-1 pt-1">
      <p className="break-words">{twinsLeftSummary(entries, total)}</p>
      <ul className="space-y-0.5 pl-3 text-xs">{shown.map(line)}</ul>
      {rest.length > 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={
              open
                ? `Show fewer names in ${where}`
                : `Show all ${entries.length} names in ${where}`
            }
            onClick={() => setOpen((o) => !o)}
            // WCAG 2.5.8: padded to 24px+; the negative margin keeps the line.
            className="inline-block min-h-6 px-1 py-0.5 -my-0.5 -ml-1 text-xs underline underline-offset-2 hover:no-underline focus:outline-none focus:ring-2 focus:ring-[#00B7FF] rounded"
          >
            {open ? "Show fewer" : `Show all ${entries.length}`}
          </button>
          <div id={listId} aria-live="off">
            {open && (
              <ul className="space-y-0.5 pl-3 pt-0.5 text-xs">
                {rest.map((e, i) => line(e, i + TWIN_LINES_SHOWN))}
                {unnamed > 0 && <li>+ {unnamed} more</li>}
              </ul>
            )}
          </div>
        </div>
      ) : (
        unnamed > 0 && <p className="pl-3 text-xs">+ {unnamed} more</p>
      )}
      {guidance && <p className="text-xs opacity-80">{guidance}</p>}
    </div>
  );
}
