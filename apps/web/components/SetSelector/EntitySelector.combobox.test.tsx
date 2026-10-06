/**
 * NEO-224 — the column is a COMBOBOX over a listbox: one search box that keeps
 * DOM focus, `aria-activedescendant` naming the option Enter would pick.
 *
 * `EntitySelector.listbox.test.tsx` pins the arrow/Tab/Left-Right contract and
 * `EntitySelector.pinned.test.tsx` the pinned view. This file pins what the
 * keyboard-only drill leans on: how the highlight is SEEDED (selection, first
 * match, none), Escape's three-way decision (Jason, D1), Enter with no match
 * (D2), where focus does and does not move, loading, and that the strings
 * ~40 Maestro flows target are untouched.
 *
 * happy-dom has no layout, so the scroll tests install a flat model on the
 * prototypes (a 400px fold, 50px rows on a 58px pitch) as
 * `EntitySelector.reexpand-scroll.test.tsx` does.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
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

const YEARS = [
  { _id: "y2024", value: "2024" },
  { _id: "y2000", value: "2000" },
  { _id: "y1999", value: "1999" },
  { _id: "y1995", value: "1995" },
  { _id: "y1980", value: "1980" },
];

type Props = {
  title?: string;
  selectedId?: string | null;
  expanded?: boolean;
  onSelect?: (id: string) => void;
  setExpanded?: (v: boolean) => void;
};

function column(props: Props = {}) {
  return (
    <EntitySelector
      title={props.title ?? "Years"}
      query={"getSelectorOptions" as never}
      queryArgs={{ level: "year" } as never}
      selectedId={props.selectedId ?? null}
      onSelect={props.onSelect ?? vi.fn()}
      expanded={props.expanded ?? true}
      setExpanded={props.setExpanded ?? vi.fn()}
      getDisplayName={displayByValue as (i: SelectorItem) => string}
      selectedColor="bg-blue-100"
    />
  );
}

/**
 * The parent the column really has: it owns `selectedId` and `expanded`, and
 * `onSelect` commits the id. Needed wherever the test follows a collapse or a
 * re-expand, since those cross the column's own props.
 */
function Harness(props: {
  initialSelected?: string | null;
  initialExpanded?: boolean;
  spy?: { onSelect?: (id: string) => void };
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    props.initialSelected ?? null,
  );
  const [expanded, setExpanded] = useState(props.initialExpanded ?? true);
  return column({
    selectedId,
    expanded,
    setExpanded,
    onSelect: (id) => {
      props.spy?.onSelect?.(id);
      setSelectedId(id);
    },
  });
}

const combo = () => screen.getByRole("combobox") as HTMLInputElement;
const options = () => screen.getAllByRole("option");
const highlightedId = (box: HTMLElement = combo()) =>
  box.getAttribute("aria-activedescendant");
const highlightedText = (box: HTMLElement = combo()) => {
  const id = highlightedId(box);
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
};
const type = (value: string) =>
  fireEvent.change(combo(), { target: { value } });
const chip = (name = "Years: 2000 — change") =>
  screen.getByRole("button", { name });

describe("EntitySelector — combobox highlight (NEO-224)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = YEARS;
  });

  // -------------------------------------------------------------------------
  // Typing seeds the highlight on the first match
  // -------------------------------------------------------------------------

  it("typing '199' in a years list highlights 1999, and Enter selects it", () => {
    const onSelect = vi.fn();
    render(column({ onSelect }));

    type("199");

    expect(options().map((o) => o.textContent)).toEqual(["1999", "1995"]);
    expect(highlightedText()).toBe("1999");
    fireEvent.keyDown(combo(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("y1999");
  });

  it("selecting clears the typed filter", () => {
    render(column());
    type("199");

    fireEvent.keyDown(combo(), { key: "Enter" });

    expect(combo().value).toBe("");
    expect(options()).toHaveLength(YEARS.length);
  });

  it("a match on any part of the name counts, case-insensitively", () => {
    state.items = [
      { _id: "a", value: "Topps Chrome" },
      { _id: "b", value: "Panini" },
    ];
    render(column({ title: "Manufacturers" }));

    type("CHROME");

    expect(highlightedText()).toBe("Topps Chrome");
  });

  it("with no match nothing is highlighted, and Enter does nothing (D2)", () => {
    const onSelect = vi.fn();
    render(column({ onSelect }));

    type("zzz");

    expect(highlightedId()).toBeNull();
    expect(screen.getByText("No matches found")).not.toBeNull();
    const notPrevented = fireEvent.keyDown(combo(), {
      key: "Enter",
      cancelable: true,
    });
    // Not cancelled either: the key still means what it would anywhere else.
    expect(notPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Down with no match stays on nothing", () => {
    render(column());
    type("zzz");

    fireEvent.keyDown(combo(), { key: "ArrowDown" });
    fireEvent.keyDown(combo(), { key: "ArrowUp" });

    expect(highlightedId()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Opening on the selection
  // -------------------------------------------------------------------------

  it("opens with the selected row highlighted, not the first", () => {
    render(column({ selectedId: "y1995" }));

    expect(highlightedText()).toBe("1995");
  });

  it("after a chip re-expand the highlight starts on the selected row, forgetting an earlier arrow move", () => {
    const { rerender } = render(column({ selectedId: "y1999" }));
    fireEvent.keyDown(combo(), { key: "ArrowDown" });
    expect(highlightedText()).toBe("1995");

    rerender(column({ selectedId: "y1999", expanded: false }));
    expect(screen.queryByRole("combobox")).toBeNull();
    rerender(column({ selectedId: "y1999", expanded: true }));

    expect(highlightedText()).toBe("1999");
  });

  it("re-expanding the chip focuses the search box", () => {
    render(<Harness initialSelected="y2000" initialExpanded={false} />);

    fireEvent.click(chip());

    expect(document.activeElement).toBe(combo());
    expect(highlightedText()).toBe("2000");
  });

  it("falls back to the first row when the selection is not listed", () => {
    render(column({ selectedId: "gone" }));

    expect(highlightedText()).toBe("2024");
  });

  // -------------------------------------------------------------------------
  // Escape (D1) and the Collapse button
  // -------------------------------------------------------------------------

  it("Escape with text in the box clears it and re-seeds the highlight, collapsing nothing", () => {
    const setExpanded = vi.fn();
    render(column({ selectedId: "y2000", setExpanded }));
    type("199");
    expect(highlightedText()).toBe("1999");

    const notPrevented = fireEvent.keyDown(combo(), {
      key: "Escape",
      cancelable: true,
    });

    expect(notPrevented).toBe(false);
    expect(combo().value).toBe("");
    expect(highlightedText()).toBe("2000");
    expect(setExpanded).not.toHaveBeenCalled();
  });

  it("Escape on an empty box in a column with a selection collapses it and focuses the chip", () => {
    render(<Harness initialSelected="y2000" initialExpanded={true} />);
    combo().focus();

    fireEvent.keyDown(combo(), { key: "Escape" });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("Escape twice from a filtered box clears first, then collapses", () => {
    render(<Harness initialSelected="y2000" initialExpanded={true} />);
    type("199");

    fireEvent.keyDown(combo(), { key: "Escape" });
    expect(screen.getByRole("combobox")).not.toBeNull();
    fireEvent.keyDown(combo(), { key: "Escape" });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("Escape on an empty box with no selection does nothing and is left uncancelled", () => {
    const setExpanded = vi.fn();
    render(column({ selectedId: null, setExpanded }));
    combo().focus();

    const notPrevented = fireEvent.keyDown(combo(), {
      key: "Escape",
      cancelable: true,
    });

    expect(notPrevented).toBe(true);
    expect(setExpanded).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(combo());
  });

  it("the Collapse button focuses the chip", () => {
    render(<Harness initialSelected="y2000" initialExpanded={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse years" }));

    expect(document.activeElement).toBe(chip());
  });

  it("the Collapse button's hit area is padded to 2.5.8's minimum without moving it (p-2 -m-2)", () => {
    render(<Harness initialSelected="y2000" initialExpanded={true} />);
    const collapse = screen.getByRole("button", { name: "Collapse years" });

    expect(collapse.classList.contains("p-2")).toBe(true);
    expect(collapse.classList.contains("-m-2")).toBe(true);
    expect(collapse.getAttribute("aria-label")).toBe("Collapse years");
  });

  it("collapsing from the keyboard (Enter on the Collapse button) focuses the chip too", () => {
    render(<Harness initialSelected="y2000" initialExpanded={true} />);

    fireEvent.keyDown(
      screen.getByRole("button", { name: "Collapse years" }),
      { key: "Enter" },
    );

    expect(document.activeElement).toBe(chip());
  });

  it("a collapse the column did not ask for (parent sets expanded=false) does not take focus", () => {
    const { rerender } = render(column({ selectedId: "y2000" }));
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    rerender(column({ selectedId: "y2000", expanded: false }));

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  // -------------------------------------------------------------------------
  // Selecting moves no focus (the cascade owns that)
  // -------------------------------------------------------------------------

  it("selecting a row by Enter leaves focus in the search box", () => {
    render(column());
    combo().focus();

    fireEvent.keyDown(combo(), { key: "Enter" });

    expect(document.activeElement).toBe(combo());
  });

  it("re-picking the selected row by Enter after a chip re-expand lands focus on the chip", () => {
    // The row the operator re-picked opens no new column, so the cascade has
    // nowhere to send focus; without this it fell to <body> as the list
    // unmounted.
    const spy = { onSelect: vi.fn() };
    render(<Harness initialSelected="y2000" initialExpanded={false} spy={spy} />);
    fireEvent.click(chip());
    expect(document.activeElement).toBe(combo());
    expect(highlightedText()).toBe("2000");

    fireEvent.keyDown(combo(), { key: "Enter" });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(chip());
    // Still reported: re-picking Base re-arms its mapping prompt upstream.
    expect(spy.onSelect).toHaveBeenCalledWith("y2000");
  });

  it("re-picking the selected row by click lands focus on the chip too", () => {
    render(<Harness initialSelected="y2000" initialExpanded={true} />);

    fireEvent.click(screen.getByRole("option", { name: "2000" }));

    expect(document.activeElement).toBe(chip());
  });

  it("picking a DIFFERENT row moves no focus to the chip (the cascade owns that)", () => {
    render(<Harness initialSelected="y2000" initialExpanded={true} />);
    combo().focus();

    fireEvent.keyDown(combo(), { key: "ArrowDown" });
    expect(highlightedText()).toBe("1999");
    fireEvent.keyDown(combo(), { key: "Enter" });

    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Years: 1999 — change" }),
    );
  });

  it("selecting a row by click moves no focus", () => {
    render(column());
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    fireEvent.click(options()[1]);

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  it("renders the combobox while the read is in flight, with no popup to point at yet", () => {
    state.items = undefined;
    render(column());

    const box = combo();
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(box.getAttribute("aria-controls")).toBeNull();
    expect(box.getAttribute("aria-activedescendant")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the same search box, focus and typed text across the moment rows land, and filters once they do", () => {
    state.items = undefined;
    const { rerender } = render(column());
    const box = combo();
    box.focus();
    type("199");
    expect(box.value).toBe("199");

    state.items = YEARS;
    rerender(column());

    expect(combo()).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(options().map((o) => o.textContent)).toEqual(["1999", "1995"]);
    expect(highlightedText()).toBe("1999");
  });

  it("Enter while loading does nothing", () => {
    state.items = undefined;
    const onSelect = vi.fn();
    render(column({ onSelect }));

    fireEvent.keyDown(combo(), { key: "Enter" });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("an empty column still has its combobox, and says so", () => {
    state.items = [];
    render(column());

    expect(combo().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText(/No years available/)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Identity strings ~40 flows target
  // -------------------------------------------------------------------------

  it.each([
    ["Years", "Search years", "Search years...", "mb-search-years"],
    ["Sets", "Search sets", "Search sets...", "mb-search-sets"],
    [
      "Variant Types",
      "Search variant types",
      "Search variant types...",
      "mb-search-variant-types",
    ],
  ])(
    "keeps %s's aria-label, placeholder and per-column class byte-identical",
    (title, label, placeholder, cls) => {
      render(column({ title }));

      const box = combo();
      expect(box.getAttribute("aria-label")).toBe(label);
      expect(box.getAttribute("placeholder")).toBe(placeholder);
      expect(box.classList.contains(cls)).toBe(true);
      // The Input primitive must never invent a DOM id: it would shadow the
      // aria-label as the box's maestro resource-id.
      expect(box.getAttribute("id")).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// The highlight scrolls the list (`nearest`), by `scrollTop` only
// ---------------------------------------------------------------------------

describe("EntitySelector — highlight scrolls the list (NEO-224)", () => {
  const FOLD_PX = 400;
  const ROW_PX = 50;
  const ROW_PITCH_PX = 58;
  const restore: Array<() => void> = [];

  const SETS = Array.from({ length: 40 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return { _id: `set${n}`, value: `Set ${n}` };
  });

  beforeEach(() => {
    state.items = SETS;
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
          top =
            Array.from(list.children).indexOf(this) * ROW_PITCH_PX -
            list.scrollTop;
        }
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0 };
      } as never);
    restore.push(() => {
      rect.mockRestore();
      if (clientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      }
      if (offsetHeight) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
      }
    });
  });

  afterEach(() => {
    restore.splice(0).forEach((r) => r());
  });

  const list = () => screen.getByRole("listbox");
  const down = (n: number) => {
    for (let i = 0; i < n; i++) {
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    }
  };
  const setsColumn = () => column({ title: "Sets" });

  it("does not scroll while the highlight stays inside the fold", () => {
    render(setsColumn());

    down(6); // row index 6 ends at 398 <= 400

    expect(list().scrollTop).toBe(0);
  });

  it("scrolls the smallest amount that shows a row pushed below the fold", () => {
    render(setsColumn());

    down(7); // index 7: 7*58 + 50 - 400 = 56
    expect(list().scrollTop).toBe(56);

    down(1); // index 8: 8*58 + 50 - 400 = 114
    expect(list().scrollTop).toBe(114);
  });

  it("scrolls back up only when the highlight rises above the fold, to that row's top", () => {
    render(setsColumn());
    down(8);
    expect(list().scrollTop).toBe(114);

    for (let i = 0; i < 6; i++) {
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" });
    }
    // Index 2 sits at 116 >= 114: still visible, no write.
    expect(list().scrollTop).toBe(114);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" });
    // Index 1 sits at 58 < 114: its top becomes the new scrollTop.
    expect(list().scrollTop).toBe(58);
  });

  it("does not undo the operator's own scroll on a re-render with the highlight unchanged", () => {
    const { rerender } = render(setsColumn());
    down(8);
    list().scrollTop = 0;
    fireEvent.scroll(list());

    state.items = SETS.map((s) => ({ ...s }));
    rerender(setsColumn());

    expect(list().scrollTop).toBe(0);
  });

  it("follows a filter that lands the highlight on a new row", () => {
    render(setsColumn());
    down(8);
    expect(list().scrollTop).toBe(114);

    // "Set 3" matches Set 03 and Set 30..39: first match is index 0 of the
    // filtered list, at the top of a list whose scrollTop is still 114.
    act(() => {
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "Set 3" },
      });
    });

    expect(list().scrollTop).toBe(0);
  });

  it("never calls scrollIntoView", () => {
    const spy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      render(setsColumn());
      down(12);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
