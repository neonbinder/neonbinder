import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import { activateOnEnter } from "@/lib/dom/activate-on-enter";
import { FolderArrowDownIcon } from "@heroicons/react/24/outline";
import SetRowActionButton from "./SetRowActionButton";

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
 * A `SetRowActionButton` chip in the panel's "Set actions" row (NEO-306),
 * which opens a LIST of the brands in this set's own year, Unknown
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
  // "Rename one of them first" left the operator guessing WHICH one and
  // WHERE. Only one of the two is in front of him — the set he is moving —
  // and the control that renames it is the pencil sitting beside its name in
  // this same panel header, whose own accessible name starts with "Rename".
  // Naming it both ways is what turns a refusal into a next step.
  return `${targetName} already has a set called "${existing}" — nothing moved. Rename this set with the Rename pencil beside its name, then move it.`;
}

export default function MoveSetToBrandControl({
  setId,
  setValue,
  yearLabel,
  showToast,
  onMoved,
}: {
  setId: Id<"selectorOptions">;
  /** The set's own NB name, for the confirm's question. */
  setValue: string;
  /** The year this set's brands belong to, for the list's accessible name. */
  yearLabel?: string;
  /** The panel's `role="status"` toast — one live region for the whole panel. */
  showToast: (message: string) => void;
  /**
   * NEO-294 — the set now lives under `brandId`, so the Sets column the
   * operator is looking at is scoped to the WRONG parent. The owner
   * (`SetSelector`) re-points the Manufacturers column to the destination;
   * this control cannot, because it knows nothing about the cascade above
   * it. Same division as `onDeleted`: the control reports what happened to
   * the row, the owner decides where the selection goes.
   */
  onMoved?: (brandId: Id<"selectorOptions">) => void;
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
  /**
   * NEO-294 (a11y) — the brand whose button opened the confirm, so cancelling
   * can put focus back on it. Needed because the list goes `inert` while the
   * dialog is up (see the list container below) and a browser blurs whatever
   * was focused inside an element the moment it becomes inert — which means
   * `ConfirmDialog`'s own restore-on-close captures `<body>` and has nothing
   * useful to go back to. This holds the answer across that window.
   */
  const returnFocusToRef = useRef<string | null>(null);

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

  // NEO-294 (a11y) — cancelling the confirm lifts `inert` off the list and
  // leaves it open on the same brands. Focus has to come back to the brand
  // that was chosen, or a keyboard operator who changed their mind restarts
  // at the top of the document. Runs as an effect rather than inside
  // `onCancel` so it lands AFTER the commit that removed `inert` — focusing a
  // still-inert element is a no-op.
  useEffect(() => {
    if (target !== null || !open) return;
    const brandId = returnFocusToRef.current;
    if (!brandId) return;
    returnFocusToRef.current = null;
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-brand-id="${brandId}"]`)
      ?.focus();
  }, [target, open]);

  const closeList = () => {
    restoreFocusRef.current = true;
    setOpen(false);
  };

  const toggleList = () => {
    if (busy) return;
    // NEO-294 (a11y) — the trigger is `inert` while the confirm is up, so in
    // any browser that honours it this is unreachable. The guard is the
    // second lock, and the one that holds if `inert` is ever removed or
    // unsupported: toggling from here would call `closeList()`, unmount the
    // list AND `listRef` while the dialog is still showing, and leave both
    // restore paths with nothing to focus — the cancel effect finds
    // `listRef.current === null`, and `ConfirmDialog`'s own restore finds its
    // captured node no longer `isConnected`. Focus lands on `<body>`.
    if (target !== null) return;
    if (open) {
      closeList();
      return;
    }
    setError(null);
    setOpen(true);
  };

  /**
   * Raise the confirm for one brand, remembering which row asked so Cancel
   * can hand focus back to it.
   */
  const choose = (brand: BrandChoice) => {
    setError(null);
    returnFocusToRef.current = brand._id;
    setTarget(brand);
  };

  const handleConfirm = async () => {
    if (busy || !target) return;
    setBusy(true);
    setError(null);
    try {
      const { movedTo } = await moveSetToBrand({ setId, brandId: target._id });
      const brandId = target._id;
      setTarget(null);
      // Nothing to return focus to inside the list — it is going away with
      // the dialog, and `closeList` parks focus on the trigger instead.
      returnFocusToRef.current = null;
      // The list goes with the dialog: the set has left this brand, so the
      // question the list was asking has been answered.
      closeList();
      // The SERVER's name for the destination, not the one the list rendered —
      // a confirmation that echoes the row that was written is the one that
      // means the write landed where the operator pointed.
      showToast(`Moved to ${movedTo}`);
      // Last, and after the toast: the owner re-points the Sets column at the
      // destination brand, so the row the operator just moved is still under
      // the cursor rather than silently gone from a column scoped to the brand
      // it left. A toast is a claim; the row sitting under its new brand is
      // the evidence.
      onMoved?.(brandId);
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
      <SetRowActionButton
        // A stable id so the E2E driver's `pressKey` can re-find this exact
        // control; the action row's chips share one class string.
        id="move-set-brand"
        ref={triggerRef}
        icon={FolderArrowDownIcon}
        // Enter is spelled out by the primitive (maestro-web's `pressKey` is
        // synthetic), and swallowed while `busy`, as a click is.
        onActivate={toggleList}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // aria-disabled + aria-busy (the primitive's `busy`), never native
        // `disabled`: this is the button the operator just pressed, and
        // disabling it would blur focus to <body>.
        busy={busy}
        // NEO-294 (a11y) — the barrier has to cover the TRIGGER as well as
        // the list. Both are DOM siblings of the dialog, so `aria-modal`
        // alone hides neither: Tab cannot reach the trigger and the backdrop
        // blocks the mouse, but a screen reader's virtual cursor navigates
        // independently of both and can activate it. Doing so collapses the
        // list out from under an open confirm and loses focus to `<body>` —
        // for exactly the audience `aria-modal` exists to protect. See
        // `toggleList` for the second lock.
        inert={target !== null}
        title={MOVE_SET_TOOLTIP}
      >
        {MOVE_SET_LABEL}
      </SetRowActionButton>
      {open && (
        <div
          id={listId}
          ref={listRef}
          // Full width of the wrapping action row, so a year's worth of brands
          // is a column rather than a wrapped ribbon of buttons.
          // `order-last` (NEO-306): it drops BELOW every chip in the "Set
          // actions" row instead of wedging in after this one — in flow, a
          // full-width list would push "Make parallel of…" onto a new line,
          // moving it out from under a pointer on its way there. The DOM order
          // (and so the Tab order) is unchanged: trigger, then its list.
          // border-gray-500: the 3:1 boundary tone on this panel's surface;
          // gray-600 measures ~2.0:1 against gray-800 and fails SC 1.4.11.
          className="order-last w-full mt-1 rounded border border-gray-500 bg-gray-900/40 p-2"
          // NEO-294 (a11y) — the list stays MOUNTED behind the confirm so
          // Cancel returns to the same open list rather than making the
          // operator find their brand again. Mounted is not the same as
          // reachable: `ConfirmDialog` is `aria-modal="true"`, which promises
          // a screen reader that nothing outside it exists, and its Tab trap
          // only holds for Tab — a browse cursor walks straight into a year's
          // worth of brand buttons that cannot be pressed. `inert` is the one
          // attribute that keeps that promise for both, and unlike
          // `aria-hidden` it does not leave focusable children inside a
          // hidden subtree (axe's `aria-hidden-focus`). Focus restore on
          // cancel is handled by the effect above, because going inert blurs
          // whatever was focused in here.
          inert={target !== null}
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
            // so it says what to do about it. "This year has no other brand
            // to move it to." was a dead end: the operator came here because
            // the set is misfiled, and a shrug is not an answer. The remedy
            // is one column to the left.
            <p className="text-[11px] text-gray-400">
              {`No other brand in ${yearLabel ?? "this year"} yet. Add one in the Manufacturers column, then come back.`}
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
                  // NOT an E2E target — flows address this button by its
                  // `aria-label`. It is how the cancel-restore effect above
                  // finds this exact row again after `inert` blurred it.
                  data-brand-id={brand._id}
                  // The visible text is the brand; the accessible name says
                  // what pressing it does, which is what a flow targets and
                  // what a screen reader needs from a row of bare names.
                  aria-label={`Move to ${brand.value}`}
                  onClick={() => choose(brand)}
                  onKeyDown={(event) => activateOnEnter(event, () => choose(brand))}
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
