import React, { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AddLeagueForm,
  type CreatedLeague,
  type Status,
} from "./AddLeagueForm";

/**
 * NEO-240 — creating a league without leaving the team you were editing.
 *
 * Team Management's League select used to answer `+ Add a new league…` by
 * revealing two inputs under the dropdown, captioned "Created for this team's
 * sport when you save." The owner's review of PR #228 called that confusing,
 * and the confusion was structural rather than cosmetic: the fields described a
 * LEAGUE while sitting inside a form that saves a TEAM, and the league only
 * came into existence as a side effect of a button labelled "Save" that appears
 * to be about the team. Two objects, one commit, no way to tell from the screen
 * which one a press was about.
 *
 * The other option on the table was to send the operator to `/admin/leagues`
 * and bring them back. That loses the team draft — an unsaved name, colours and
 * era, gone on a navigation — so this is the modal instead: the decision is
 * finished before it is applied, and the draft behind it is never touched. On
 * close, the League select is exactly where it was.
 *
 * ## Why this is hand-rolled
 * Because everything else in this app is, and a second keyboard contract is a
 * worse outcome than a second implementation of the same one. `ConfirmDialog`,
 * `EntityReviewWizard` and the credentials modals all assert `role="dialog"` +
 * `aria-modal="true"` on a fixed overlay and own Escape/Tab themselves. This
 * follows `ConfirmDialog` line for line — trap, Escape, scrim click, focus
 * return — and differs only where a form differs from a confirmation:
 *
 *  - **Focus opens on the first FIELD, not on Cancel.** `ConfirmDialog` opens
 *    on Cancel because its confirm button is destructive and the reflexive
 *    first keystroke must do the safe thing. Nothing here is destructive —
 *    creating a league is additive, and the near-match panel is what guards the
 *    only real mistake available (a duplicate row). The safe thing and the
 *    thing the operator came to do are the same thing, so focus lands where
 *    they are about to type.
 *  - **No confirm on dismissal.** Same reason: a half-typed league name is not
 *    state worth defending with a second dialog.
 *
 * Escape and the scrim are refused only while a create is in flight — not to
 * protect a draft, but because closing over a round trip leaves the result
 * landing on an unmounted host, and a league would appear in the table that the
 * operator was never shown.
 */

export interface AddLeagueDialogProps {
  /** The sport the league is created under — the team's own, and not editable. */
  sportId: Id<"selectorOptions">;
  /**
   * The league that was created, or the existing one an `Open {name}` pick
   * chose instead. Always followed immediately by `onClose` — the decision is
   * made, and there is nothing left on screen to decide.
   */
  onSelect: (league: CreatedLeague) => void;
  onClose: () => void;
  /**
   * Forwarded to the host's page-level status line as well as shown here.
   *
   * Both, because the two messages have different fates: a failure has to be
   * readable while the dialog is still up, and the success line ("Added
   * American League.") is only read after it closes.
   */
  onStatus?: (status: Status) => void;
  /**
   * Where focus goes on close — the control that opened this, which the host
   * knows and `document.activeElement` only usually does. A `<select>` changed
   * with a pointer is focused; one changed by a script, or by a keyboard user
   * who committed with Enter, may not be.
   */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}

export function AddLeagueDialog({
  sportId,
  onSelect,
  onClose,
  onStatus,
  returnFocusTo,
}: AddLeagueDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

  /**
   * Whatever had focus when the dialog opened, as the fallback for a host that
   * did not name a return target.
   *
   * Read in a lazy initializer — during the FIRST render — rather than in a
   * mount effect. React runs a child's effects before its parent's, and the
   * form's own effect moves focus into the name field: by the time a mount
   * effect here ran, `document.activeElement` was already a node inside this
   * dialog, so the fallback would have "returned" focus to something that is
   * about to be unmounted.
   */
  const [trigger] = useState<HTMLElement | null>(
    () => document.activeElement as HTMLElement | null,
  );

  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  // Only mounted while the dialog is open, so the subscription costs nothing
  // the rest of the time. The team carries a `sportId` and no sport NAME, and
  // the form has to be able to say which sport it is about to create under.
  const sports = useQuery(api.selectorOptions.getSelectorOptions, {
    level: "sport",
  });
  const sportLabel =
    sports === undefined
      ? // Still loading. Not "unknown" — that is an answer, and this is the
        // absence of one.
        "…"
      : (sports.find((sport) => sport._id === sportId)?.value ?? "unknown");

  /**
   * Put focus back, then close.
   *
   * Explicitly rather than in an unmount cleanup: React does not move focus
   * when it removes a focused node, it leaves it on `<body>` — so the
   * operator's next Tab restarts at the top of the page and a screen reader is
   * told nothing about where they now are (WCAG 2.2 SC 2.4.3). Restoring before
   * `onClose` means the target is still mounted and still focusable at the
   * moment we ask.
   */
  const close = () => {
    const explicit = returnFocusTo?.current;
    const target = explicit?.isConnected === true ? explicit : trigger;
    if (target?.isConnected) target.focus();
    onClose();
  };

  const handleStatus = (next: Status) => {
    setStatus(next);
    onStatus?.(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (!busy) close();
      return;
    }

    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      // The busy window, if every control in the form has disabled itself: Tab
      // would otherwise walk out of the dialog and into the page behind it,
      // ending the modality `aria-modal` promises.
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

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 outline-none"
      onKeyDown={handleKeyDown}
      onClick={() => {
        if (!busy) close();
      }}
    >
      {/* Wider than ConfirmDialog's `max-w-md`, which holds one sentence and two
          buttons; this holds a two-column field row, a level group and a
          possible-matches list. `max-h-full` with its own scroller rather than a
          taller box: CI runs at 1024x629, and a dialog that overflows the
          viewport puts its primary action below the fold with no way to reach
          it — the failure NEO-110 documents on the review wizard. */}
      <div
        className="max-h-full w-full max-w-xl overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <AddLeagueForm
          // `sports` is unread under `lockSport` — the team fixes the sport, so
          // there is nothing to choose from.
          sports={[]}
          sportId={sportId}
          sportLabel={sportLabel}
          lockSport
          headingId={headingId}
          initialFocus="name"
          onStatus={handleStatus}
          onBusyChange={setBusy}
          onCreated={(league) => {
            onSelect(league);
            close();
          }}
          onCancel={close}
        />

        {/* Under the action row, where the press that produced it happened. The
            host's page-level line is behind the scrim at this moment, so a
            failure routed only there is a failure the operator cannot read. */}
        {status && (
          <p
            className={`mt-4 text-sm ${status.isError ? "text-neon-pink" : "text-slate-300"}`}
            role={status.isError ? "alert" : "status"}
          >
            {status.text}
          </p>
        )}
      </div>
    </div>
  );
}

export default AddLeagueDialog;
