import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";

/**
 * NEO-294 — move this set under a different brand.
 *
 * The operator's undo for every AUTOMATIC placement: the prefix re-home, the
 * known-brands list that mints a brand and files a set under it, and the
 * sync's own bucketing into Unknown. Auto-create is irreversible without it,
 * which is why it ships in the same ticket — and why it sits beside the
 * delete: those two are the whole of what an operator can do to a set row
 * itself, as opposed to its attributes.
 *
 * SET ROWS ONLY. A brand is a set's parent; nothing above or below a set has
 * one to move between, and the server refuses any other level.
 *
 * ## The shape
 *
 * A text button in the panel header (the "Fill teams" idiom — same weight,
 * same ring), which opens a LIST of the brands in this set's own year, Unknown
 * among them and the set's current brand left out. Picking one raises the
 * house `ConfirmDialog`, which names the destination and answers the question
 * the operator actually has — do my cards and my marketplace links come with
 * it — before they commit. That sentence is the one place this control spends
 * any weight; the list itself is bare rows, because a list of brand names that
 * tries to be interesting is a list that is harder to scan.
 *
 * A list of BUTTONS rather than a `<select>`: the Maestro web driver can only
 * reach options in the first native select on a page, and this panel already
 * has selects among its feature rows.
 *
 * ## Keyboard and focus
 *
 * The trigger is a disclosure (`aria-expanded`), so the same button closes the
 * list it opened and there is no second "Cancel" competing with the dialog's.
 * Opening moves focus to the first brand; Escape closes and puts it back on
 * the trigger. A completed move unmounts the whole list — the thing focus was
 * on — so focus is parked back on the trigger, which is the one element in
 * this control that survives every transition. The busy window is `aria-busy`
 * + `aria-disabled` on the trigger, never native `disabled`: disabling the
 * focused element blurs it to `<body>` and drops a keyboard operator at the
 * top of the document.
 *
 * ## Refusals
 *
 * They land INSIDE the dialog, where the question was asked, exactly as the
 * delete control's do — the dialog is already open and already announced, so a
 * toast behind the modal barrier would be read by nobody. The one refusal that
 * is expected in ordinary use is a fold-equal set name already under the
 * target: nothing is merged and nothing is deleted, and the sentence names the
 * set already sitting there, because renaming one of the two is the way out.
 */

/** The trigger's text, which is also its accessible name. */
export const MOVE_SET_LABEL = "Move to another brand";

/**
 * Why an operator would: said in terms of what survives, because "will I lose
 * my cards" is the question this control raises and a tooltip is where a
 * hesitating operator looks first.
 */
export const MOVE_SET_TOOLTIP =
  "File this set under a different brand in the same year. Its cards and marketplace links come with it.";

/** The list's visible prompt. */
export const MOVE_SET_PROMPT = "Move to which brand?";

export type BrandChoice = {
  _id: Id<"selectorOptions">;
  value: string;
  isCurrent: boolean;
};

/**
 * The server's clash refusal, matched STRUCTURALLY rather than with
 * `instanceof ConvexError` — the house rule for every refusal this panel
 * reads (`prefixTakenRefusal`, `deleteRefusalMessage`): a rethrown error in a
 * test, or a version skew in the convex client, must still surface the
 * server's own answer. Only `data` is text a backend chose for a person;
 * production redacts the message of a plain `Error` to "Server Error".
 */
export function moveClashRefusal(e: unknown, targetName: string): string | null {
  if (typeof e !== "object" || e === null) return null;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, value } = data as { code?: unknown; value?: unknown };
  if (code !== "SET_NAME_CLASH_AT_TARGET") return null;
  const existing =
    typeof value === "string" && value.length > 0 ? value : "a set of that name";
  return `${targetName} already has a set called "${existing}" — nothing moved. Rename one of them first.`;
}

export default function MoveSetToBrandControl({
  setId,
  setValue,
  yearLabel,
  showToast,
}: {
  setId: Id<"selectorOptions">;
  /** The set's own NB name, for the confirm's question. */
  setValue: string;
  /** The year this set's brands belong to, for the list's accessible name. */
  yearLabel?: string;
  /** The panel's `role="status"` toast — one live region for the whole panel. */
  showToast: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<BrandChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /**
   * Armed when this control's own transition is what unmounts the focused
   * element, so the restore below never steals focus from something else that
   * happened to re-render the panel (`BaseRoleControl`'s `actedRef`, same
   * reasoning).
   */
  const restoreFocusRef = useRef(false);

  const moveSetToBrand = useMutation(api.brandView.moveSetToBrand);
  // Asked only while the list is open: this control mounts on every set row in
  // the builder, and a year's brand list is not worth a subscription per row
  // for a control that is pressed once in a hundred drills.
  const brands: BrandChoice[] | undefined = useQuery(
    api.brandView.getBrandsForYearOfSet,
    open ? { setId } : "skip",
  );

  // The current brand is never an option — "move it to where it already is" is
  // not a thing to offer, and the server refuses it.
  const choices = (brands ?? []).filter((brand) => !brand.isCurrent);

  // Opening hands focus to the first brand, so the list is usable without
  // leaving the keyboard. Runs on `choices.length` as well as `open` because
  // the rows arrive one round-trip after the list does.
  const firstChoiceId = choices[0]?._id;
  useEffect(() => {
    if (!open || !firstChoiceId) return;
    listRef.current?.querySelector("button")?.focus();
  }, [open, firstChoiceId]);

  // The park. `restoreFocusRef` is armed by the two transitions that unmount
  // the list from under focus: a completed move, and Escape.
  useEffect(() => {
    if (open || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus();
  }, [open]);

  const closeList = () => {
    restoreFocusRef.current = true;
    setOpen(false);
  };

  const toggleList = () => {
    if (busy) return;
    if (open) {
      closeList();
      return;
    }
    setError(null);
    setOpen(true);
  };

  const handleConfirm = async () => {
    if (busy || !target) return;
    setBusy(true);
    setError(null);
    try {
      const { movedTo } = await moveSetToBrand({ setId, brandId: target._id });
      setTarget(null);
      // The list goes with the dialog: the set has left this brand, so the
      // question the list was asking has been answered.
      closeList();
      // The SERVER's name for the destination, not the one the list rendered —
      // a confirmation that echoes the row that was written is the one that
      // means the write landed where the operator pointed.
      showToast(`Moved to ${movedTo}`);
    } catch (e) {
      setError(
        moveClashRefusal(e, target.value) ??
          userFacingMessage(e, "Could not move this set"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        // A stable id so the E2E driver's `pressKey` can re-find this exact
        // control; the header shares one text-button idiom across levels.
        id="move-set-brand"
        ref={triggerRef}
        type="button"
        onClick={() => toggleList()}
        // maestro-web's `pressKey: Enter` is a synthetic event with no default
        // action, so a focused button is never clicked by it — anything a flow
        // drives from the keyboard spells the activation out.
        onKeyDown={(event) => activateOnEnter(event, toggleList, busy)}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // aria-disabled, never native `disabled`: this is the button the
        // operator just pressed, and disabling it would blur focus to <body>.
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        title={MOVE_SET_TOOLTIP}
        className="shrink-0 text-xs py-1.5 text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus-visible:ring-2 focus-visible:ring-[#00D558] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:text-gray-400"
      >
        {MOVE_SET_LABEL}
      </button>
      {open && (
        <div
          id={listId}
          ref={listRef}
          // Full width of the wrapping header row, so a year's worth of brands
          // is a column rather than a wrapped ribbon of buttons.
          // border-gray-500: the 3:1 boundary tone on this panel's surface;
          // gray-600 measures ~2.0:1 against gray-800 and fails SC 1.4.11.
          className="w-full mt-1 rounded border border-gray-500 bg-gray-900/40 p-2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closeList();
          }}
        >
          <p className="text-[11px] text-gray-400 mb-1">{MOVE_SET_PROMPT}</p>
          {brands === undefined ? (
            <p className="text-[11px] text-gray-400">Finding this year's brands…</p>
          ) : choices.length === 0 ? (
            // An empty list is a statement about the year, not a failure —
            // and the remedy (make a brand in the Manufacturers column) is
            // where the operator already knows to go.
            <p className="text-[11px] text-gray-400">
              This year has no other brand to move it to.
            </p>
          ) : (
            <div
              role="group"
              aria-label={`Brands in ${yearLabel ?? "this year"}`}
              // Bounded so a year with forty brands cannot push the card list
              // off the E2E viewport; the buttons inside are the scroll's own
              // keyboard handles.
              className="max-h-48 overflow-y-auto flex flex-col gap-0.5"
            >
              {choices.map((brand) => (
                <button
                  key={brand._id}
                  type="button"
                  // The visible text is the brand; the accessible name says
                  // what pressing it does, which is what a flow targets and
                  // what a screen reader needs from a row of bare names.
                  aria-label={`Move to ${brand.value}`}
                  onClick={() => {
                    setError(null);
                    setTarget(brand);
                  }}
                  onKeyDown={(event) =>
                    activateOnEnter(event, () => {
                      setError(null);
                      setTarget(brand);
                    })
                  }
                  // py-1.5 keeps each row at WCAG 2.5.8's 24px minimum target height;
                  // px-2 py-1 measured ~23px at this text size.
                  className="text-left text-xs px-2 py-1.5 rounded border border-transparent text-gray-200 hover:border-[#00D558] hover:text-[#00D558] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]"
                >
                  {brand.value}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {target && (
        <ConfirmDialog
          title={`Move "${setValue}" to ${target.value}?`}
          // The operator's real question, answered before they commit: this is
          // a pure NB re-parent, so everything they built under the set comes
          // with it, and the stamp the server writes is what keeps the next
          // Sync Sets from filing it back.
          description={`The set keeps its cards, its variants and its marketplace links — only the brand above it changes. Sync Sets will leave it where you put it.`}
          confirmLabel="Yes, move it"
          busyLabel="Moving…"
          busy={busy}
          error={error}
          onConfirm={() => void handleConfirm()}
          onCancel={() => {
            if (busy) return;
            setError(null);
            setTarget(null);
          }}
        />
      )}
    </>
  );
}
