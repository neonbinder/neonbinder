import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
 * - **Focus opens on the preselected choice** (`data-autofocus`), so the
 *   operator lands on the thing the dialog is asking about, and Enter confirms
 *   it from the confirm button — every button here spells Enter out
 *   (`activateOnEnter`) because maestro-web's `pressKey` is synthetic.
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
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
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
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();

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
  // then stops (focus that has moved on is never pulled back).
  const landedRef = useRef(false);
  useEffect(() => {
    if (landedRef.current) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const target =
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
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
      aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 outline-none"
      onKeyDown={onKeyDown}
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="flex w-full max-w-md max-h-[90vh] flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 pt-5">
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            {title}
          </h2>
          <p id={descriptionId} className="mt-1 text-sm text-slate-400">
            {description}
          </p>
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
        <div className="flex gap-3 px-5 pb-5">
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

/**
 * One choice among buttons (`aria-pressed`) — never a `<select>`: the Maestro
 * web driver reaches options only in the FIRST native select on a page, and
 * the attributes panel has selects of its own. Bounded and scrolled so a
 * brand of forty sets cannot push the confirm off the 1024×629 E2E viewport;
 * the buttons are the scroll's own keyboard handles.
 */
export function ChoiceList({
  legend,
  choices,
  selectedId,
  onSelect,
  autofocusId,
  filterLabel,
}: {
  legend: string;
  choices: Choice[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The choice focus lands on when the dialog opens. */
  autofocusId?: string | null;
  /** The filter box's accessible name, when the list is long enough for one. */
  filterLabel: string;
}) {
  const legendId = useId();
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = q
    ? choices.filter((c) => c.label.toLowerCase().includes(q))
    : choices;
  return (
    <div>
      <p id={legendId} className="mb-1 text-xs text-slate-400">
        {legend}
      </p>
      {choices.length > CHOICE_FILTER_THRESHOLD && (
        <Input
          bare
          type="search"
          aria-label={filterLabel}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mb-1 w-full rounded px-2 py-1 text-sm"
        />
      )}
      <div
        role="group"
        aria-labelledby={legendId}
        className="max-h-40 overflow-y-auto flex flex-col gap-0.5 rounded border border-slate-500 p-1"
      >
        {shown.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-slate-400">Nothing matches that.</p>
        )}
        {shown.map((choice) => {
          const pressed = choice.id === selectedId;
          const unavailable = choice.unavailable !== undefined;
          return (
            <button
              key={choice.id}
              type="button"
              data-choice={choice.id}
              {...(autofocusId === choice.id ? { "data-autofocus": true } : {})}
              aria-label={choice.ariaLabel}
              aria-pressed={pressed}
              aria-disabled={unavailable || undefined}
              title={choice.unavailable}
              onClick={() => {
                if (!unavailable) onSelect(choice.id);
              }}
              onKeyDown={(event) =>
                activateOnEnter(event, () => onSelect(choice.id), unavailable)
              }
              // py-1.5 keeps each row at WCAG 2.5.8's 24px minimum.
              className={`flex items-baseline justify-between gap-2 rounded border px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] ${
                pressed
                  ? "border-[#00D558] text-[#00D558]"
                  : "border-transparent text-slate-200 hover:border-slate-500"
              } ${unavailable ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <span>{choice.label}</span>
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
