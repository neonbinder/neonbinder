/**
 * NEO-260 — "Enter activates this button", written out in JS because the
 * browser's own default action is not enough here.
 *
 * ## Why a focused button needs its own Enter handler
 *
 * A real keypress on a focused `<button>` fires a click through the browser's
 * DEFAULT ACTION on the keydown. A **synthetic** `KeyboardEvent` has no default
 * action at all: `dispatchEvent` runs the listeners and stops. maestro-web's
 * `pressKey: Enter` is exactly that — a constructed event dispatched at the
 * element it re-found — so a focused button is never clicked by it. Anything a
 * flow drives with Enter therefore has to handle Enter itself
 * (`.maestro/README.md`, and `EntityReviewWizard`'s Confirm & Save is the
 * original worked example).
 *
 * That is the driver's half. The product half is the house rule in CLAUDE.md:
 * every flow is fully operable from the keyboard, Enter confirms and Escape
 * cancels. A handler that spells the activation out satisfies both, and is a
 * no-op for a mouse user.
 *
 * ## What it does and does not touch
 *
 * `preventDefault` suppresses the browser's own click-on-Enter, so a REAL
 * keypress runs `action` exactly once instead of twice. `stopPropagation` keeps
 * the key from also reaching an ancestor form/dialog handler that treats Enter
 * as "submit the default action" — pressing Enter on a focused control does
 * what THAT control does, never two things.
 *
 * **Space is deliberately untouched.** The browser fires a button's click on
 * key*up* for Space; intercepting keydown would either double-fire or, with a
 * `preventDefault`, silently break the second half of the native contract.
 *
 * `disabled` mirrors the button's own disabled/aria-disabled state: a control
 * that cannot be clicked must not be activatable by keyboard either, and an
 * `aria-disabled` button (kept in the tab order on purpose — see NeonButton)
 * is still focusable, so the guard has to live here rather than rely on the
 * native attribute.
 *
 * Takes the EVENT first and is called from inside the handler
 * (`onKeyDown={(e) => activateOnEnter(e, save)}`) rather than returning a
 * handler built during render. A factory would mean passing the action —
 * which in these components closes over a ref — to a function while rendering,
 * which is what `react-hooks/refs` (correctly) refuses.
 */
export function activateOnEnter(
  event: { key: string; preventDefault: () => void; stopPropagation: () => void },
  action: () => void,
  disabled?: boolean,
): void {
  if (event.key !== "Enter" || disabled) return;
  event.preventDefault();
  event.stopPropagation();
  action();
}
