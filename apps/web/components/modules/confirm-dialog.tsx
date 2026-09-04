import { useEffect, useRef } from "react";
import NeonButton from "./NeonButton";

interface ConfirmDialogProps {
  /** Question form, e.g. "Abort run 3f2a1b8c?" — becomes the dialog's name. */
  title: string;
  /** What confirming actually does, in one or two sentences. */
  description: string;
  /** Label on the destructive button, e.g. "Yes, Abort". */
  confirmLabel: string;
  /** Same button while `busy`, e.g. "Aborting...". */
  busyLabel: string;
  /** True while the confirmed action is in flight. Drives BOTH `disabled` and the label. */
  busy: boolean;
  /**
   * A refusal that arrived AFTER the dialog opened — e.g. the server declining
   * the delete because the row stopped being empty between render and click
   * (NEO-219). Rendered as a `role="alert"` inside the dialog and joined onto
   * `aria-describedby`, because the dialog is already open and already
   * announced: a message appended to the static description would never be
   * read out, and one rendered outside the dialog is behind the modal barrier.
   * Optional — most callers close on success and surface nothing here.
   */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The "are you sure" in front of a destructive action (NEO-170).
 *
 * Hand-rolled rather than pulled from a UI kit because that is what this app
 * already does — `app/profile/credentials/page.tsx` and the Set Builder modals
 * all assert `role="dialog"` + `aria-modal="true"` on a fixed overlay and own
 * the keyboard contract themselves. This is the same shape, extracted so the
 * pipeline pages do not each grow their own copy of it: the failure mode of
 * three hand-rolled dialogs is three slightly different keyboard contracts, and
 * the one that quietly loses its Escape handler is the one nobody notices.
 *
 * ## The keyboard contract
 * - **Escape cancels**, from anywhere inside the dialog.
 * - **Focus opens on Cancel**, so the reflexive first keystroke — Enter, on a
 *   dialog that has just been announced — does the SAFE thing. An earlier
 *   version focused the container and treated Enter as "confirm"; an
 *   accessibility audit called that out on its own terms (WCAG 3.3.4, Error
 *   Prevention): a screen-reader user acknowledging the dialog would have
 *   destroyed something without navigating anywhere, which defeats the point of
 *   having a confirm step. Enter still confirms — one Tab away, through the
 *   confirm button's native activation — and focus starting on a real button
 *   also means Radix's own `:focus-visible` ring shows where you are, which the
 *   container never did.
 * - **Tab is trapped**, because `aria-modal="true"` promises it. While `busy`
 *   disables both buttons there is nothing left to cycle between, so focus is
 *   parked on the container instead of being allowed to leak to the page
 *   behind — a disabled focused element otherwise blurs to `<body>` and quietly
 *   ends the modality for the whole round-trip.
 * - On close, focus goes back to whatever opened the dialog (WCAG 2.4.3) — but
 *   only if that element is still in the document. A confirmed action often
 *   unmounts its own trigger (an Abort button on a row that just became
 *   terminal); the caller is responsible for parking focus somewhere stable
 *   after that, since only it knows where "stable" is.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busyLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    // Focused directly rather than through requestAnimationFrame: this dialog
    // is not portalled, so the node exists by the time the effect runs.
    cancelRef.current?.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  useEffect(() => {
    // Both buttons disable together while the action runs. The browser blurs a
    // focused element the moment it is disabled, which drops focus to `<body>`
    // — outside the dialog, ending the modality mid-round-trip. Park focus on
    // the container, which is what `tabIndex={-1}` is here for.
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (!busy) onCancel();
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
      // The busy window: nothing inside is focusable, so Tab would walk out of
      // the dialog and into the page behind it.
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
      aria-labelledby="confirm-dialog-title"
      aria-describedby={
        error
          ? "confirm-dialog-description confirm-dialog-error"
          : "confirm-dialog-description"
      }
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 outline-none"
      onKeyDown={handleKeyDown}
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="confirm-dialog-title"
          className="mb-3 text-lg font-semibold text-foreground"
        >
          {title}
        </h2>
        <p
          id="confirm-dialog-description"
          className="mb-5 text-sm text-slate-400"
        >
          {description}
        </p>
        {error && (
          <p
            id="confirm-dialog-error"
            role="alert"
            className="mb-5 text-sm text-[#FF2EB3]"
          >
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <NeonButton cancel type="button" onClick={onConfirm} disabled={busy}>
            {/* Label keyed off the SAME condition as `disabled` (NEO-128): the
                E2E driver cannot read `enabled` on web, so the label is the only
                evidence that the control is inert. */}
            {busy ? busyLabel : confirmLabel}
          </NeonButton>
          <NeonButton
            ref={cancelRef}
            secondary
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </NeonButton>
        </div>
      </div>
    </div>
  );
}
