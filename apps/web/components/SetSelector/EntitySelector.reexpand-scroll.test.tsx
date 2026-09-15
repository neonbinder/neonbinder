/**
 * NEO-276 — re-opening a column with a selection opens the list AT the
 * selection, not at the top of it.
 *
 * ## The defect
 *
 * Once a column has a selection it collapses to a single card; tapping the
 * card mounts the listbox again, scrolled to the top. On any column longer
 * than the 400px fold (a synced Sets column runs to ~40 rows) the selected row
 * is below it, and the operator has to hunt for the row they already chose.
 *
 * ## What is pinned here
 *
 * The fix writes the listbox's OWN `scrollTop` — never `scrollIntoView`, which
 * would also move the horizontal column row EntityColumn owns and the page
 * under maestro-web — and it fires exactly once per "list shown" transition:
 * not on a later reactive `items` re-emit, not on a keystroke in the search
 * box. The Maestro tripwire from the listbox tests is repeated for the list
 * container, since ~105 flows read this DOM and the change is refs-only.
 *
 * ## The layout model
 *
 * happy-dom has no layout: every rect is 0x0 at 0,0 and every `clientHeight`
 * is 0. The tests install a flat model on the prototypes — a 400px fold, 50px
 * rows on a 58px pitch (p-3 rows under space-y-2), a row's rect following the
 * list's scroll offset the way a real one does — so the expected `scrollTop`
 * values below are the ones a browser would compute for the same DOM.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: { selectorOptions: { getSelectorOptions: "getSelectorOptions" } },
}));

const state: { items: unknown } = { items: [] };

vi.mock("convex/react", () => ({
  useQuery: () => state.items,
}));

import EntitySelector, { displayByValue } from "./EntitySelector";
import type { SelectorItem } from "./EntitySelector";

/** Zero-padded so the component's localeCompare sort is also the DOM order. */
const SETS = Array.from({ length: 40 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return { _id: `set${n}`, value: `Set ${n}` };
});

const FOLD_PX = 400;
const ROW_PX = 50;
const ROW_PITCH_PX = 58;

/** Where the fix should land row `index` to centre it in the fold. */
const centredOn = (index: number) =>
  Math.max(0, index * ROW_PITCH_PX - (FOLD_PX - ROW_PX) / 2);

const restoreLayout: Array<() => void> = [];

function installLayoutModel() {
  const clientHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  const offsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "listbox" ? FOLD_PX : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute("role") === "option" ? ROW_PX : 0;
    },
  });
  const rect = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      let top = 0;
      if (this.getAttribute("role") === "option") {
        const list = this.parentElement!;
        const index = Array.from(list.children).indexOf(this);
        top = index * ROW_PITCH_PX - list.scrollTop;
      }
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0 };
    } as never);
  restoreLayout.push(() => {
    rect.mockRestore();
    if (clientHeight) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    }
    if (offsetHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
    }
  });
}

function column(props: { selectedId: string | null; expanded: boolean }) {
  return (
    <EntitySelector
      title="Sets"
      query={"getSelectorOptions" as never}
      queryArgs={{ level: "set" } as never}
      selectedId={props.selectedId}
      onSelect={vi.fn()}
      expanded={props.expanded}
      setExpanded={vi.fn()}
      getDisplayName={displayByValue as (i: SelectorItem) => string}
      selectedColor="bg-pink-100"
    />
  );
}

const list = () => screen.getByRole("listbox", { name: "Sets" });

describe("EntitySelector — re-expanding opens at the selection (NEO-276)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = SETS;
    installLayoutModel();
  });

  afterEach(() => {
    restoreLayout.splice(0).forEach((restore) => restore());
  });

  it("centres a selection below the fold when the collapsed card is opened", () => {
    // Row 30 of 40 sits at y=1682 — four folds down.
    const { rerender } = render(column({ selectedId: "set30", expanded: false }));
    expect(screen.queryByRole("listbox")).toBeNull();

    rerender(column({ selectedId: "set30", expanded: true }));

    expect(list().scrollTop).toBe(centredOn(29));
    expect(centredOn(29)).toBeGreaterThan(0);
  });

  it("leaves the list at the top when the selection is already in the first fold", () => {
    const { rerender } = render(column({ selectedId: "set02", expanded: false }));

    rerender(column({ selectedId: "set02", expanded: true }));

    expect(list().scrollTop).toBe(0);
  });

  it("does not re-scroll a list the operator has moved when items re-emit", () => {
    const { rerender } = render(column({ selectedId: "set30", expanded: false }));
    rerender(column({ selectedId: "set30", expanded: true }));
    expect(list().scrollTop).toBe(centredOn(29));

    // The operator scrolls back to the top of the list…
    list().scrollTop = 0;
    fireEvent.scroll(list());
    // …and the reactive query re-emits the same rows as a new array.
    state.items = SETS.map((s) => ({ ...s }));
    rerender(column({ selectedId: "set30", expanded: true }));

    expect(list().scrollTop).toBe(0);
  });

  it("does not re-scroll when the operator types in the search box", () => {
    const { rerender } = render(column({ selectedId: "set30", expanded: false }));
    rerender(column({ selectedId: "set30", expanded: true }));
    list().scrollTop = 0;
    fireEvent.scroll(list());

    // "Set 3" keeps the selected row in the (now shorter) list; the rows are
    // rebuilt on the keystroke, which must not count as the list being shown.
    fireEvent.change(screen.getByLabelText("Search sets"), {
      target: { value: "Set 3" },
    });

    expect(screen.getAllByRole("option")).toHaveLength(10);
    expect(list().scrollTop).toBe(0);
  });

  it("scrolls once the rows land when the list is shown while items are loading", () => {
    state.items = undefined;
    const { rerender } = render(column({ selectedId: "set30", expanded: true }));
    expect(screen.queryByRole("listbox")).toBeNull();

    state.items = SETS;
    rerender(column({ selectedId: "set30", expanded: true }));

    expect(list().scrollTop).toBe(centredOn(29));
  });

  it("has nothing to do when the column has no selection", () => {
    const { rerender } = render(column({ selectedId: null, expanded: false }));
    rerender(column({ selectedId: null, expanded: true }));

    expect(list().scrollTop).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The Maestro tripwire
  // -------------------------------------------------------------------------

  it("changes no node and no class string on the list it scrolls", () => {
    // ~105 flows read this DOM. The scroll is a `scrollTop` write on the node
    // that already existed; nothing wraps it and its class string is the one
    // the flows were written against.
    const { rerender } = render(column({ selectedId: "set30", expanded: false }));
    rerender(column({ selectedId: "set30", expanded: true }));

    expect(list().className).toBe("space-y-2 max-h-[400px] overflow-y-auto");
    expect(list().parentElement?.className).toBe(
      "bg-white dark:bg-gray-800 p-6 rounded-lg shadow",
    );
    for (const option of screen.getAllByRole("option")) {
      expect(option.parentElement).toBe(list());
      expect(option.getAttribute("id")).toBeNull();
    }
  });
});
