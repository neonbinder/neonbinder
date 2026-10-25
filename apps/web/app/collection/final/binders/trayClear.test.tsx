import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isKeyboardFocus, keepClearOfTray, trackInputModality } from "./trayClear";

/**
 * NEO-359 — keepClearOfTray scrolls a control up out from under the pinned
 * pack tray for KEYBOARD focus only. A mouse press focuses its control
 * between mousedown and mouseup; scrolling then moved the control from under
 * the pointer and the click was lost (seen on the Want List spine).
 */

const TRAY = 105;

/** A button whose box sits under the tray: bottom 40px above the viewport's foot. */
function buttonUnderTray(focusVisible: boolean | "unsupported") {
  const el = document.createElement("button");
  document.body.appendChild(el);
  const bottom = window.innerHeight - 40;
  el.getBoundingClientRect = () => ({ top: bottom - 32, bottom, left: 0, right: 80, width: 80, height: 32, x: 0, y: bottom - 32, toJSON: () => ({}) }) as DOMRect;
  const real = el.matches.bind(el);
  el.matches = ((selector: string) => {
    if (selector !== ":focus-visible") return real(selector);
    if (focusVisible === "unsupported") throw new SyntaxError("unknown pseudo-class");
    return focusVisible;
  }) as Element["matches"];
  return el;
}

let scrollBy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.documentElement.style.setProperty("--nb-tray-h", `${TRAY}px`);
  scrollBy = vi.fn();
  window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
});
afterEach(() => {
  document.documentElement.style.removeProperty("--nb-tray-h");
  document.body.innerHTML = "";
});

describe("keepClearOfTray", () => {
  it("scrolls a keyboard-focused control up clear of the tray", () => {
    const el = buttonUnderTray(true);
    keepClearOfTray(el);
    // Its foot goes to 16px above the tray's top.
    expect(scrollBy).toHaveBeenCalledWith({ top: TRAY + 16 - 40 });
  });

  it("leaves the page still for a mouse press, so the click lands on what was pressed", () => {
    const el = buttonUnderTray(false);
    keepClearOfTray(el);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("leaves the tray's own controls alone", () => {
    const tray = document.createElement("div");
    tray.className = "p2-pack";
    const el = buttonUnderTray(true);
    tray.appendChild(el);
    document.body.appendChild(tray);
    keepClearOfTray(el);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});

describe("without :focus-visible", () => {
  it("falls back to the last input: a pointer press does not scroll, a key does", () => {
    // Pretend the browser has no :focus-visible, so the tracker installs.
    const create = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = create(tag);
      el.matches = (() => {
        throw new SyntaxError("unknown pseudo-class");
      }) as unknown as Element["matches"];
      return el;
    });
    const stop = trackInputModality(document);
    spy.mockRestore();
    try {
      const el = buttonUnderTray("unsupported");
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(isKeyboardFocus(el)).toBe(false);
      keepClearOfTray(el);
      expect(scrollBy).not.toHaveBeenCalled();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      expect(isKeyboardFocus(el)).toBe(true);
      keepClearOfTray(el);
      expect(scrollBy).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});
