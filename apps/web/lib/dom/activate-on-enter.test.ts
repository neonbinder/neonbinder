/**
 * @vitest-environment happy-dom
 *
 * The docblock is load-bearing, for the same reason `is-editable-target.test.ts`
 * carries one: `lib/**\/*.test.ts` is collected by the `convex-lib` project,
 * which runs in `node`, and this helper is about DOM keyboard events.
 *
 * NEO-260 — `activateOnEnter`, the explicit "Enter activates this button"
 * handler the set-selector columns hang on every control a flow or a
 * keyboard-only operator drives.
 *
 * The first test is the premise the whole helper exists for, and it is worth
 * asserting rather than believing: a KeyboardEvent constructed in JS and
 * dispatched at a focused <button> does NOT click it. That is exactly what
 * maestro-web's `pressKey` does, and it is why the browser's own default action
 * cannot be relied on here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { activateOnEnter } from "./activate-on-enter";

function button(): HTMLButtonElement {
  const el = document.createElement("button");
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("activateOnEnter", () => {
  it("PREMISE: a synthetic Enter does not click a focused button on its own", () => {
    const el = button();
    const clicked = vi.fn();
    el.addEventListener("click", clicked);
    el.focus();

    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    expect(clicked).not.toHaveBeenCalled();
  });

  it("runs the action when the key is Enter", () => {
    const action = vi.fn();
    const el = button();
    el.addEventListener("keydown", (e) => activateOnEnter(e, action));

    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("cancels the event, so a REAL keypress cannot also fire the native click", () => {
    const action = vi.fn();
    const el = button();
    el.addEventListener("keydown", (e) => activateOnEnter(e, action));

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("stops the key reaching an ancestor, so Enter does one thing, not two", () => {
    const outer = document.createElement("div");
    const onAncestor = vi.fn();
    outer.addEventListener("keydown", onAncestor);
    document.body.appendChild(outer);
    const el = document.createElement("button");
    outer.appendChild(el);
    el.addEventListener("keydown", (e) => activateOnEnter(e, vi.fn()));

    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    expect(onAncestor).not.toHaveBeenCalled();
  });

  it("ignores every other key, Space included — the browser owns Space on keyup", () => {
    const action = vi.fn();
    const el = button();
    el.addEventListener("keydown", (e) => activateOnEnter(e, action));

    for (const key of [" ", "Escape", "Tab", "ArrowDown", "a"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(action).not.toHaveBeenCalled();
  });

  it("does nothing while disabled, and does not swallow the key either", () => {
    const action = vi.fn();
    const el = button();
    el.addEventListener("keydown", (e) => activateOnEnter(e, action, true));

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(action).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
