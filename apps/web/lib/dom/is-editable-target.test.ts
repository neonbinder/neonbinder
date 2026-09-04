/**
 * @vitest-environment happy-dom
 *
 * The docblock is load-bearing. `lib/**\/*.test.ts` is collected by the
 * `convex-lib` project, which runs in `node` (its only environment override is
 * `convex/**` → edge-runtime), and this predicate is about DOM elements. Rather
 * than widen a shared glob or move a DOM helper out of `lib/dom`, the file
 * declares the environment it needs.
 *
 * NEO-220 — `isEditableTarget`, the predicate every dialog root's Escape
 * handler consults before treating the key as "discard this session".
 *
 * The cases below are the ones that actually reached a root handler in the Set
 * Builder and cancelled something: a filter field, a typeahead combobox, and a
 * search input inside a sub-panel.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isEditableTarget } from "./is-editable-target";

function mount(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild!;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isEditableTarget", () => {
  it("is true for a text input", () => {
    expect(isEditableTarget(mount('<input type="text" />'))).toBe(true);
  });

  it("is true for a number input — the year fields are still text entry", () => {
    expect(isEditableTarget(mount('<input type="number" />'))).toBe(true);
  });

  it("is true for a textarea", () => {
    expect(isEditableTarget(mount("<textarea></textarea>"))).toBe(true);
  });

  it("is true for anything wearing role=combobox, whatever its tag", () => {
    expect(isEditableTarget(mount('<div role="combobox"></div>'))).toBe(true);
  });

  it("is true inside a contenteditable region, including a child node", () => {
    const region = mount('<div contenteditable="true"><span>text</span></div>');
    expect(isEditableTarget(region)).toBe(true);
    expect(isEditableTarget(region.firstElementChild)).toBe(true);
  });

  it("is false for a button — Escape there is a dialog-level dismissal", () => {
    expect(isEditableTarget(mount("<button>Cancel</button>"))).toBe(false);
  });

  it("is false for the dialog container itself", () => {
    expect(isEditableTarget(mount('<div role="dialog"></div>'))).toBe(false);
  });

  it("is false for a checkbox — a career-team proposal is not text entry", () => {
    // Deliberate: Escape with a checkbox focused should still reach the dialog.
    expect(isEditableTarget(mount('<input type="checkbox" />'))).toBe(false);
  });

  it("is false for null, undefined and a non-Element target", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
    expect(isEditableTarget(window as unknown as EventTarget)).toBe(false);
  });
});
