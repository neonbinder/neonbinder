import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import NeonButton from "../modules/NeonButton";
import { Input } from "../primitives/Input";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";

/**
 * NEO-305 — the dialog behind "Make parallel of…" and "Promote to set".
 *
 * Both controls ask the operator to CHOOSE (a set, a parallel, a SportLots
 * set), which `ConfirmDialog` does not do: its body is read-only detail, its
 * focus opens on Cancel and its confirm is always live. So this is the same
 * keyboard contract with a choice in the middle, rather than a third
 * hand-rolled variant of it:
 *
 * - **Escape cancels** from anywhere inside, unless the write is in flight.
 * - **Tab is trapped** (`aria-modal="true"` promises it), and while `busy`
 *   disables every button focus is parked on the container rather than
 *   leaking to the page behind.
 * - **Focus opens on the preselected choice** (`data-autofocus`, else the
 *   checked radio of the first list still open), so the operator lands on the
 *   thing the dialog is asking about, and Enter confirms it from the confirm
 *   button — every button here spells Enter out (`activateOnEnter`) because
 *   maestro-web's `pressKey` is synthetic.
 * - **Focus goes back to the opener** on close, if it is still in the
 *   document. A completed move usually unmounts it (the row changed); the
 *   owner parks focus then, because only it knows where "stable" is.
 * - Refusals land INSIDE the dialog (`role="alert"`, joined onto
 *   `aria-describedby`), where the question was asked.
 * - The destination preview is `aria-live="polite"`: changing the choice
 *   changes where the row lands, and that is said.
 *
 * Not portalled, like `ConfirmDialog`: a fixed overlay inside the attributes
 * panel header. The owner puts `inert` on its trigger while this is up.
 *
 * **It fits under the site header** (NEO-306). Being inside the panel, the
 * overlay sits in a stacking context BELOW the sticky `binder-header`, so a
 * dialog centred in the whole viewport had its title under the header at the
 * 1024×629 E2E viewport. The overlay's top padding is the header's measured
 * bottom (it wraps taller on a phone), the panel is at most the height left,
 * and only the middle scrolls: the title and the footer — the landing preview
 * and the buttons — are always on screen.
 */
export function SetShapeDialog({
  title,
  description,
  children,
  preview,
  confirmLabel,
  busyLabel,
  busy,
  confirmDisabled,
  autofocusConfirm,
  confirmDescribedBy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** A line under the title. Optional: the set-shape doors carry none (NEO-306). */
  description?: string;
  children?: ReactNode;
  /** Where the row lands, said as a path. Announced when it changes. */
  preview?: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  /** Nothing valid is chosen yet (or the move is refused regardless). */
  confirmDisabled?: boolean;
  /** No choice to land on (a single option): open on the confirm instead. */
  autofocusConfirm?: boolean;
  /**
   * Ids of text saying why the confirm is unavailable (or what it will leave
   * behind), so a screen reader hears the reason on the button itself.
   */
  confirmDescribedBy?: string;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const headerBottom = usePageHeaderBottom();

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    // Hold focus inside the dialog from the first frame: the owner's trigger
    // goes `inert` in this same commit, which blurs it to <body>. The landing
    // effect below moves focus on to the choice once it exists.
    dialogRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // Land on the preselected choice once it exists — choices arrive one query
  // round-trip after the dialog does, so this re-runs until one is found and
  // then stops (focus that has moved on is never pulled back). A list folded
  // to its answer has no radios, so with the set preselected and folded this
  // lands on the next list's checked choice: the question still open.
  const landedRef = useRef(false);
  useEffect(() => {
    if (landedRef.current) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const target =
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog.querySelector<HTMLElement>("[data-choice][aria-checked='true']") ??
      dialog.querySelector<HTMLElement>("[data-choice]:not([aria-disabled='true'])");
    if (!target) return;
    landedRef.current = true;
    target.focus();
  });

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const confirmInert = busy || confirmDisabled === true;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={
        [...(description ? [descriptionId] : []), ...(error ? [errorId] : [])].join(" ") ||
        undefined
      }
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 outline-none"
      // The header's bottom plus the same 1rem margin the other three sides get.
      style={{ paddingTop: headerBottom + 16 }}
      onKeyDown={onKeyDown}
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        // max-h-full: the height the overlay leaves under the header.
        className="flex max-h-full w-full max-w-md flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 pt-5">
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="mt-1 text-sm text-slate-400">
              {description}
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {children}
        </div>
        {preview !== undefined && preview !== null && (
          <div
            aria-live="polite"
            className="mx-5 mb-3 rounded border border-slate-500 px-3 py-2 text-sm"
          >
            {preview}
          </div>
        )}
        {error && (
          <p id={errorId} role="alert" className="mx-5 mb-3 text-sm text-[#FF2EB3]">
            {error}
          </p>
        )}
        {/* Wraps at a phone's width: a join confirm names the row it joins. */}
        <div className="flex flex-wrap gap-3 px-5 pb-5">
          <NeonButton
            type="button"
            {...(autofocusConfirm ? { "data-autofocus": true } : {})}
            onClick={() => {
              if (!confirmInert) onConfirm();
            }}
            onKeyDown={(event) => activateOnEnter(event, onConfirm, confirmInert)}
            // aria-disabled, not native `disabled`, while nothing is chosen:
            // the button stays reachable so the reason beside it is too.
            // Native `disabled` only while the write runs (the ConfirmDialog
            // busy contract, with the container holding focus).
            disabled={busy}
            aria-disabled={confirmDisabled && !busy ? true : undefined}
            aria-describedby={confirmDescribedBy || undefined}
          >
            {busy ? busyLabel : confirmLabel}
          </NeonButton>
          <NeonButton
            secondary
            type="button"
            onClick={onCancel}
            onKeyDown={(event) => activateOnEnter(event, onCancel, busy)}
            disabled={busy}
          >
            Cancel
          </NeonButton>
        </div>
      </div>
    </div>
  );
}

/**
 * The bottom edge of the page's own sticky/fixed header, in viewport pixels
 * (0 when there is none), kept current across resizes. Measured rather than
 * hard-coded: `binder-header` is ~78px at the E2E viewport and can wrap taller
 * on a phone.
 */
function usePageHeaderBottom(): number {
  const [bottom, setBottom] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      let lowest = 0;
      for (const header of Array.from(document.querySelectorAll("header"))) {
        const { position } = getComputedStyle(header);
        if (position !== "sticky" && position !== "fixed") continue;
        const rect = header.getBoundingClientRect();
        // Only a header pinned to the top edge covers the dialog's top.
        if (rect.top <= 1 && rect.bottom > lowest) lowest = rect.bottom;
      }
      setBottom(Math.round(lowest));
    };
    measure();
    window.addEventListener("resize", measure);
    // The header can change height AFTER the resize event (its content
    // re-renders for the new width), so watch the headers themselves too.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const header of Array.from(document.querySelectorAll("header"))) {
      observer?.observe(header);
    }
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);
  return bottom;
}

export type Choice = {
  id: string;
  /** The visible text. */
  label: string;
  /** The accessible name — says what pressing it does. */
  ariaLabel: string;
  /** Unavailable, with the reason shown beside it. */
  unavailable?: string;
  /** A short tag after the label ("new"). */
  tag?: string;
};

/** Lists longer than this get a filter box. */
export const CHOICE_FILTER_THRESHOLD = 12;

/** "3 matches" — the filter's polite count. DRAFT copy (NEO-305). */
export function filterCountText(n: number): string {
  return n === 0 ? "Nothing matches that." : `${n} ${n === 1 ? "match" : "matches"}`;
}

/** The folded list's button text. Its accessible name starts with it. DRAFT copy (NEO-306). */
export const CHANGE_LABEL = "Change";

/**
 * One choice among several, as the APG single-select RADIO GROUP
 * (`role="radiogroup"` / `role="radio"` + `aria-checked`), the pattern
 * `CardPairingModal`'s name-conflict pills follow: one Tab stop (roving
 * `tabIndex` — the checked radio, else the first one that can be chosen),
 * and the arrow keys move focus WITH the selection, wrapping at both ends and
 * skipping choices that are unavailable. Enter and a click choose too.
 *
 * Never a `<select>`: the Maestro web driver reaches options only in the
 * FIRST native select on a page, and the attributes panel has selects of its
 * own. The radios are buttons carrying their `aria-label`, which is what the
 * E2E flows target. Bounded and scrolled so a brand of forty sets cannot push
 * the confirm off the 1024×629 E2E viewport.
 *
 * A list longer than `CHOICE_FILTER_THRESHOLD` gets a filter box, and the
 * filter's result count is said politely (`aria-live`), "Nothing matches
 * that." included.
 *
 * **Folding (NEO-306).** Once its answer is settled the owner can fold the
 * list to ONE line — "{legend}: {chosen}" and a `Change` button — so the next
 * question is on screen instead of under the pinned preview. The line is text,
 * not a radio; `Change` (named "Change {legend}") unfolds it with the choice
 * still checked. The owner decides WHEN: a click or Enter reports `onPick` as
 * well as `onSelect`, while the arrow keys report only `onSelect` — they browse
 * a group, so a list that folded on every arrow could not be browsed at all.
 * State (the filter) lives on across a fold, because the component does.
 *
 * `takeFocus` asks the list to take focus — its checked (or first) radio, or
 * `Change` when folded — as soon as it can; `onTookFocus` says it did, so the
 * owner clears the request and a later re-render never pulls focus back.
 */
export function ChoiceList({
  legend,
  choices,
  selectedId,
  onSelect,
  onPick,
  autofocusId,
  filterLabel,
  describedBy,
  collapsed,
  changeLabel,
  onExpand,
  takeFocus,
  onTookFocus,
}: {
  legend: string;
  choices: Choice[];
  selectedId: string | null;
  /** The selection moved: a click, Enter, or an arrow key. */
  onSelect: (id: string) => void;
  /** The operator chose deliberately — a click or Enter, never an arrow key. */
  onPick?: (id: string) => void;
  /** The choice focus lands on when the dialog opens. */
  autofocusId?: string | null;
  /** The filter box's accessible name, when the list is long enough for one. */
  filterLabel: string;
  /** Ids of text explaining why choices here are unavailable. */
  describedBy?: string;
  /** Show the answer on one line. Ignored while nothing (shown) is chosen. */
  collapsed?: boolean;
  /** `Change`'s accessible name; it must start with "Change" (2.5.3). */
  changeLabel?: string;
  onExpand?: () => void;
  takeFocus?: boolean;
  onTookFocus?: () => void;
}) {
  const legendId = useId();
  const groupRef = useRef<HTMLDivElement | null>(null);
  const changeRef = useRef<HTMLButtonElement | null>(null);
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = q
    ? choices.filter((c) => c.label.toLowerCase().includes(q))
    : choices;
  const available = shown.filter((c) => c.unavailable === undefined);
  // The one Tab stop: the checked radio when it is shown, else the first
  // radio that can be chosen, else the first radio at all (so a list of
  // nothing-but-unavailable is still reachable, with its reasons).
  const tabStopId =
    (selectedId !== null && shown.some((c) => c.id === selectedId)
      ? selectedId
      : undefined) ??
    available[0]?.id ??
    shown[0]?.id;
  const chosen = choices.find((c) => c.id === selectedId);
  const folded = collapsed === true && chosen !== undefined && onExpand !== undefined;

  const focusChoice = (id: string) => {
    const radios = groupRef.current?.querySelectorAll<HTMLElement>("[data-choice]");
    Array.from(radios ?? [])
      .find((el) => el.getAttribute("data-choice") === id)
      ?.focus();
  };

  // Runs every render while asked, so a list that mounts a query later (the
  // next list after a fold) still takes focus the moment its radios exist.
  useEffect(() => {
    if (!takeFocus) return;
    if (folded) {
      if (!changeRef.current) return;
      changeRef.current.focus();
    } else {
      if (tabStopId === undefined) return;
      focusChoice(tabStopId);
    }
    onTookFocus?.();
  });

  const pick = (id: string) => {
    onSelect(id);
    onPick?.(id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    if (available.length === 0) return;
    const step = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
    const from = available.findIndex((c) => c.id === (selectedId ?? tabStopId));
    const at = from === -1 ? (step === 1 ? -1 : 0) : from;
    const next = available[(at + step + available.length) % available.length];
    onSelect(next.id);
    // The radio already exists (selection does not re-order the list), so
    // focus can move with the selection in the same event.
    focusChoice(next.id);
  };

  if (folded && chosen && onExpand) {
    return (
      <div className="flex items-center justify-between gap-3 rounded bg-slate-800/70 py-1 pl-2 pr-1 text-sm">
        <p className="flex min-w-0 items-baseline gap-1.5 text-slate-200">
          {/* The checked radio's mark, carried onto the line it folded to. */}
          <span aria-hidden="true" className="text-[#00D558]">
            ✓
          </span>
          {/* One text node, so the whole answer is one match for a flow. */}
          <span className="min-w-0 break-words">{`${legend}: ${chosen.label}`}</span>
        </p>
        <button
          ref={changeRef}
          type="button"
          data-change
          aria-label={changeLabel}
          onClick={onExpand}
          onKeyDown={(event) => activateOnEnter(event, onExpand)}
          // min-h-6: WCAG 2.5.8's 24px target.
          className="min-h-6 shrink-0 rounded px-2 text-xs font-medium text-[#00C2FF] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
        >
          {CHANGE_LABEL}
        </button>
      </div>
    );
  }

  return (
    <div>
      <p id={legendId} className="mb-1 text-xs text-slate-400">
        {legend}
      </p>
      {choices.length > CHOICE_FILTER_THRESHOLD && (
        <>
          <Input
            bare
            type="search"
            aria-label={filterLabel}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="mb-1 w-full rounded px-2 py-1 text-sm"
          />
          {/* Always rendered once there is a filter, so the region exists
              before its text changes and the count is actually announced. */}
          <p aria-live="polite" className="mb-1 text-xs text-slate-400">
            {q ? filterCountText(shown.length) : ""}
          </p>
        </>
      )}
      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby={legendId}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
        className="max-h-40 overflow-y-auto flex flex-col gap-0.5 rounded border border-slate-500 p-1"
      >
        {shown.length === 0 && choices.length <= CHOICE_FILTER_THRESHOLD && (
          <p className="px-2 py-1.5 text-xs text-slate-400">{filterCountText(0)}</p>
        )}
        {shown.map((choice) => {
          const checked = choice.id === selectedId;
          const unavailable = choice.unavailable !== undefined;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              data-choice={choice.id}
              {...(autofocusId === choice.id ? { "data-autofocus": true } : {})}
              aria-label={choice.ariaLabel}
              aria-checked={checked}
              aria-disabled={unavailable || undefined}
              tabIndex={choice.id === tabStopId ? 0 : -1}
              title={choice.unavailable}
              onClick={() => {
                if (!unavailable) pick(choice.id);
              }}
              onKeyDown={(event) =>
                activateOnEnter(event, () => pick(choice.id), unavailable)
              }
              // py-1.5 keeps each row at WCAG 2.5.8's 24px minimum.
              className={`flex items-baseline justify-between gap-2 rounded border px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] ${
                checked
                  ? "border-[#00D558] text-[#00D558]"
                  : "border-transparent text-slate-200 hover:border-slate-500"
              } ${unavailable ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <span className="flex items-baseline gap-1">
                {/* 1.4.1 — the checked state is not colour alone. A sibling
                    of the label, never inside it, so the label's own text
                    (what a flow matches) is unchanged. */}
                {checked && <span aria-hidden="true">✓</span>}
                <span>{choice.label}</span>
              </span>
              {(choice.tag || unavailable) && (
                <span className="shrink-0 text-xs text-slate-400">
                  {unavailable ? "unavailable" : choice.tag}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Where the row lands, as a path: every segment NB's own name, the last one —
 * the row this move creates or joins — in the neon that says "this is the
 * change". The one loud thing in the dialog.
 */
export function LandingPath({
  segments,
  verb,
}: {
  segments: string[];
  /** "new" or "joins" — said after the last segment. */
  verb: string;
}) {
  const last = segments[segments.length - 1];
  const lead = segments.slice(0, -1);
  return (
    <p className="text-slate-400">
      <span className="sr-only">Lands at </span>
      {lead.map((s, i) => (
        <span key={`${i}-${s}`}>
          {s}
          <span aria-hidden="true" className="mx-1.5 text-slate-500">
            ›
          </span>
          <span className="sr-only">, </span>
        </span>
      ))}
      <span className="font-semibold text-[#00D558]">{last}</span>
      <span className="ml-2 text-xs text-slate-400">{verb}</span>
    </p>
  );
}
