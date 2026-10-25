/**
 * WCAG 2.4.11 under the pinned pack tray: keep a keyboard-focused control
 * clear of it, and leave a pointer's focus where it is.
 */

/** Set by `trackInputModality`: the last input the page saw was a pointer press. */
let pointerLast = false;

/**
 * For a browser without `:focus-visible` only: remembers whether the last
 * input was a pointer press or a key, which is what `:focus-visible` would
 * have told us. Returns the cleanup. Where `:focus-visible` works it does
 * nothing.
 */
export function trackInputModality(doc: Document = document): () => void {
  if (supportsFocusVisible(doc)) return () => {};
  const pointer = () => {
    pointerLast = true;
  };
  const key = () => {
    pointerLast = false;
  };
  doc.addEventListener("pointerdown", pointer, true);
  doc.addEventListener("mousedown", pointer, true);
  doc.addEventListener("keydown", key, true);
  return () => {
    doc.removeEventListener("pointerdown", pointer, true);
    doc.removeEventListener("mousedown", pointer, true);
    doc.removeEventListener("keydown", key, true);
  };
}

function supportsFocusVisible(doc: Document): boolean {
  try {
    doc.createElement("button").matches(":focus-visible");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether focus came from the keyboard (or a script acting for it): the
 * browser's own `:focus-visible` call, the same one that draws the ring. A
 * mouse or touch press is not, so it never moves the page.
 */
export function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return !pointerLast;
  }
}

/**
 * The pack tray is pinned over the bottom of the page, and a control it
 * covers still counts as on screen, so the browser never scrolls to it. When
 * the keyboard lands on one, scroll it up clear of the tray (its height is
 * `--nb-tray-h`, which PackTray publishes).
 *
 * Keyboard focus only: a mouse press focuses its control between mousedown
 * and mouseup, so scrolling then would move the control out from under the
 * pointer, the mouseup would land somewhere else, and the click would be
 * lost.
 */
export function keepClearOfTray(target: EventTarget | null) {
  // The tray's own controls, and a dialog's (it sits over the tray), are left alone.
  if (!(target instanceof HTMLElement) || target.closest(".p2-pack, [role='dialog'], [role='alertdialog']")) return;
  if (!isKeyboardFocus(target)) return;
  const tray = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--nb-tray-h")) || 0;
  if (tray <= 0) return;
  const rect = target.getBoundingClientRect();
  const limit = window.innerHeight - tray - 16;
  // Never scroll a control taller than the room above the tray off its top.
  if (rect.bottom > limit && rect.top > 0) window.scrollBy({ top: Math.min(rect.bottom - limit, rect.top) });
}
