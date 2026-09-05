/**
 * NEO-220 — "was this keystroke aimed at a text field?"
 *
 * Every modal in the Set Builder owns its own Escape handler on the dialog
 * root, and Escape means "throw this session away". That is the right meaning
 * at the dialog level and the wrong one inside a field: an operator clearing a
 * mistyped filter, or dismissing a typeahead dropdown, presses Escape and loses
 * an entire review or matching session. The keystroke never announced itself as
 * destructive, and nothing on screen was about to be discarded.
 *
 * So the root handlers ask this first and return when it answers true, leaving
 * the field's own handler to decide what Escape means locally (clear the text,
 * close the dropdown, close the sub-panel). One shared predicate rather than
 * five copies of `tagName !== "INPUT"`, because the failure mode of five copies
 * is the one that forgets `<textarea>`.
 *
 * ## What counts as editable
 * - `<textarea>`, and `<input>` EXCEPT the types that are not text entry at
 *   all. A checkbox is an `<input>`, and Escape with a career-team proposal
 *   focused has no local meaning — swallowing it there would just make the key
 *   dead. The excluded list mirrors `NON_TEXT_INPUT_TYPES` in
 *   `eslint.config.mjs`, which already draws this same line for the NEO-44
 *   raw-input rule; keeping one definition of "text-ish input" in the codebase
 *   is worth the few extra lines over a bare `tagName === "INPUT"`.
 * - Anything with `role="combobox"`. A typeahead is an editable field wearing a
 *   widget role, and both `CareerTeamEntry`'s team field and the pairing
 *   filters are exactly that shape. Checked by role rather than by tag so a
 *   combobox built on a `<div>` is covered too.
 * - `contenteditable` regions, for the same reason: the browser treats them as
 *   text entry even though no form element is involved.
 *
 * A `<select>` is deliberately NOT here. Escape on a closed select is not text
 * editing, and the native open-dropdown case swallows the key before it ever
 * reaches a React handler.
 *
 * Anything that is not an `Element` (the window, a detached target, null)
 * answers false: a keystroke with no element behind it is not in a field.
 */
/** Input types that are controls rather than text entry. Mirrors eslint.config.mjs. */
const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "file",
  "color",
  "range",
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
]);

export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (!target || !(target instanceof Element)) return false;

  const tag = target.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    // An input with no `type` is a text input.
    const type = (target.getAttribute("type") ?? "text").toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }

  if (target.getAttribute("role") === "combobox") return true;

  // `isContentEditable` is only defined on HTMLElement, and it is inherited —
  // a <span> inside a contenteditable <div> reports true, which is what we
  // want, since that span is where the caret actually is.
  if (target instanceof HTMLElement && target.isContentEditable) return true;

  return false;
}
