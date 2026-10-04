/**
 * NEO-260 / NEO-224 — the set-selector columns are listboxes, and the arrows
 * work. NEO-224 moved the arrows from the ROWS (a roving tabindex) to the
 * column's search box (a combobox with `aria-activedescendant`); the contract
 * below is the same one, restated for the new focus model.
 *
 * ## The defect
 *
 * Every option row was its own tab stop. Past a synced Sports list that is ~25
 * Tab presses to reach the Years column; six columns deep the cascade is not
 * operable from the keyboard at all, even though every control in it is
 * technically reachable. CLAUDE.md's UI section has always required the
 * opposite ("every flow must be fully operable from the keyboard").
 *
 * A column is a set of mutually-exclusive choices, which is a LISTBOX: one tab
 * stop, arrows inside it, `aria-selected` saying which row is chosen. This file
 * pins that contract.
 *
 * ## The constraint these tests also guard
 *
 * ~105 Maestro flows target these rows by their VISIBLE TEXT. The role,
 * `tabindex` and `aria-selected` are attribute-only additions: the row's
 * element, its class string and its text node are untouched. The last test in
 * this file is the tripwire for that — if a row's text ever picks up so much as
 * a suffix, it fails here rather than in CI's flow run.
 *
 * happy-dom cannot reproduce maestro-web's XPath re-find, so nothing here is
 * evidence about an E2E symptom; it is evidence the product exposes a real,
 * named, arrow-operable listbox.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: { selectorOptions: { getSelectorOptions: "getSelectorOptions" } },
}));

const state: { items: unknown } = { items: [] };

vi.mock("convex/react", () => ({
  useQuery: () => state.items,
}));

import EntitySelector, { displayByValue } from "./EntitySelector";
import type { SelectorItem } from "./EntitySelector";

/** Sorted alphabetically by the component, so this is also the DOM order. */
const SPORTS = [
  { _id: "baseball", value: "Baseball" },
  { _id: "basketball", value: "Basketball" },
  { _id: "football", value: "Football" },
  { _id: "hockey", value: "Hockey" },
];

const YEARS = [
  { _id: "y2023", value: "2023" },
  { _id: "y2024", value: "2024" },
];

function column(props: {
  title?: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  setExpanded?: (v: boolean) => void;
}) {
  return (
    <EntitySelector
      title={props.title ?? "Sports"}
      query={"getSelectorOptions" as never}
      queryArgs={{ level: "sport" } as never}
      selectedId={props.selectedId ?? null}
      onSelect={props.onSelect ?? vi.fn()}
      expanded={true}
      setExpanded={props.setExpanded ?? vi.fn()}
      getDisplayName={displayByValue as (i: SelectorItem) => string}
      selectedColor="bg-pink-100"
    />
  );
}

const options = () => screen.getAllByRole("option");
const optionNamed = (name: string) =>
  options().find((o) => o.textContent === name)!;
/** A column's one search box (the combobox). */
const combo = (name = "Search sports") =>
  screen.getByRole("combobox", { name }) as HTMLInputElement;
/** The option `aria-activedescendant` currently names. */
const highlightedOf = (box: HTMLElement) => {
  const id = box.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};
const highlightedText = (box: HTMLElement = combo()) =>
  highlightedOf(box)?.textContent ?? null;
const type = (box: HTMLElement, value: string) =>
  fireEvent.change(box, { target: { value } });
/** Every tab stop in a subtree: tabIndex 0 on anything focusable we render. */
const tabStops = (root: HTMLElement = document.body) =>
  Array.from(
    root.querySelectorAll<HTMLElement>("input, button, [role='option']"),
  ).filter((el) => el.tabIndex === 0);

describe("EntitySelector — listbox semantics (NEO-260, NEO-224)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = SPORTS;
  });

  it("exposes the column as a named listbox of options", () => {
    render(column({}));

    const list = screen.getByRole("listbox", { name: "Sports" });
    expect(within(list).getAllByRole("option")).toHaveLength(SPORTS.length);
  });

  // -------------------------------------------------------------------------
  // One tab stop — the search box
  // -------------------------------------------------------------------------

  it("makes the combobox the column's single tab stop, with every option at tabIndex -1", () => {
    // Was: "is a single tab stop, not one per row" (roving tabindex on rows).
    render(column({}));

    expect(tabStops()).toEqual([combo()]);
    expect(options().every((o) => o.tabIndex === -1)).toBe(true);
  });

  it("highlights the chosen row on open, so Enter lands on the selection", () => {
    // Was: "puts the tab stop on the chosen row".
    render(column({ selectedId: "football" }));

    expect(highlightedText()).toBe("Football");
    // aria-selected stays the COMMITTED row; the highlight is only the
    // combobox's aria-activedescendant.
    expect(optionNamed("Football").getAttribute("aria-selected")).toBe("true");
  });

  it("highlights the first row when nothing is selected", () => {
    render(column({}));

    expect(highlightedText()).toBe("Baseball");
  });

  it("points aria-activedescendant at an option inside the controlled popup", () => {
    render(column({}));
    const box = combo();

    const popup = document.getElementById(box.getAttribute("aria-controls")!);
    expect(popup).not.toBeNull();
    expect(popup!.contains(highlightedOf(box))).toBe(true);
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(box.getAttribute("aria-autocomplete")).toBe("list");
  });

  it("neither focus nor pointer movement on a row moves the highlight", () => {
    // Was: "moves the tab stop to follow focus". The highlight is now owned
    // by the keyboard alone: a pointer resting over the list must not retarget
    // Enter under the operator's typing.
    render(column({}));

    fireEvent.mouseEnter(optionNamed("Hockey"));
    fireEvent.mouseOver(optionNamed("Hockey"));
    fireEvent.mouseMove(optionNamed("Hockey"));
    fireEvent.focus(optionNamed("Hockey"));

    expect(highlightedText()).toBe("Baseball");
  });

  // -------------------------------------------------------------------------
  // Arrows
  // -------------------------------------------------------------------------

  it("Down and Up move the highlight one row at a time, focus staying in the box", () => {
    render(column({}));
    const box = combo();
    box.focus();

    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(highlightedText()).toBe("Basketball");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(highlightedText()).toBe("Football");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(highlightedText()).toBe("Basketball");
    expect(document.activeElement).toBe(box);
  });

  it("stops at the ends instead of wrapping", () => {
    // Wrapping silently re-enters the list from the other side, which reads as
    // a dropped keypress. The APG's default for a listbox is to stop.
    render(column({}));
    const box = combo();

    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(highlightedText()).toBe("Baseball");

    for (let i = 0; i < SPORTS.length + 3; i++) {
      fireEvent.keyDown(box, { key: "ArrowDown" });
    }
    expect(highlightedText()).toBe("Hockey");
  });

  it("leaves Home and End to the text caret", () => {
    // Was: "Home and End jump to the ends" (rows). In a text box those keys
    // move the caret, and the column has no use for them: they must not be
    // cancelled and must not move the highlight.
    render(column({}));
    const box = combo();

    const endNotPrevented = fireEvent.keyDown(box, {
      key: "End",
      cancelable: true,
    });
    const homeNotPrevented = fireEvent.keyDown(box, {
      key: "Home",
      cancelable: true,
    });

    expect(endNotPrevented).toBe(true);
    expect(homeNotPrevented).toBe(true);
    expect(highlightedText()).toBe("Baseball");
  });

  it("cancels the arrows it handles, so the caret and page do not also move", () => {
    render(column({}));

    const notPrevented = fireEvent.keyDown(combo(), {
      key: "ArrowDown",
      cancelable: true,
    });
    expect(notPrevented).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Typing filters (replaces typeahead)
  // -------------------------------------------------------------------------

  it("typing a name's first letters filters to it and highlights it", () => {
    // Was: "jumps to a row by typing its first letters" (typeahead moved focus
    // to the row). Typing now FILTERS, and the highlight lands on the first
    // match.
    render(column({}));

    type(combo(), "f");

    expect(options().map((o) => o.textContent)).toEqual(["Football"]);
    expect(highlightedText()).toBe("Football");
  });

  it("re-seeds the highlight on every keystroke, so 'bas' then 'bask' passes Baseball", () => {
    // Was: "accumulates letters, so 'bas' + 'k' passes Baseball".
    render(column({}));
    const box = combo();

    type(box, "bas");
    expect(options().map((o) => o.textContent)).toEqual([
      "Baseball",
      "Basketball",
    ]);
    expect(highlightedText()).toBe("Baseball");

    type(box, "bask");
    expect(options().map((o) => o.textContent)).toEqual(["Basketball"]);
    expect(highlightedText()).toBe("Basketball");
  });

  it("discards an arrow move when the filter changes", () => {
    render(column({}));
    const box = combo();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(highlightedText()).toBe("Football");

    type(box, "ba");

    expect(highlightedText()).toBe("Baseball");
  });

  it("leaves Space alone — the browser clicks a button on key UP", () => {
    const onSelect = vi.fn();
    render(column({ onSelect }));
    const baseball = optionNamed("Baseball");
    baseball.focus();

    const notPrevented = fireEvent.keyDown(baseball, {
      key: " ",
      cancelable: true,
    });
    // Neither swallowed nor turned into a select: intercepting keydown would
    // either double-fire or break the native contract.
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(baseball);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores keys held with a modifier, which belong to the browser", () => {
    render(column({}));
    const box = combo();

    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
      const notPrevented = fireEvent.keyDown(box, {
        key: "ArrowDown",
        [mod]: true,
        cancelable: true,
      });
      expect(notPrevented).toBe(true);
    }
    expect(highlightedText()).toBe("Baseball");
  });

  // -------------------------------------------------------------------------
  // Enter selects the highlight
  // -------------------------------------------------------------------------

  it("Enter in the box selects the row the arrows landed on", () => {
    const onSelect = vi.fn();
    render(column({ onSelect }));
    const box = combo();

    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("basketball");
  });

  it("Enter on a pointer-focused row still picks that row, once", () => {
    // Rows are not keyboard-focusable any more, but a click can focus one.
    const onSelect = vi.fn();
    render(column({ onSelect }));
    const hockey = optionNamed("Hockey");
    hockey.focus();

    fireEvent.keyDown(hockey, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("hockey");
  });

  // -------------------------------------------------------------------------
  // Left / Right across the cascade (D6: from an EMPTY box only)
  // -------------------------------------------------------------------------

  function twoColumns() {
    // The real page nests the columns in this scroll row
    // (components/modules/SetSelector.tsx), which is what Left/Right walks.
    return render(
      <div data-set-selector-scroll>
        {column({ title: "Sports" })}
        <EntitySelector
          title="Years"
          query={"getSelectorOptions" as never}
          queryArgs={{ level: "year" } as never}
          selectedId={null}
          onSelect={vi.fn()}
          expanded={true}
          setExpanded={vi.fn()}
          getDisplayName={displayByValue as (i: SelectorItem) => string}
          selectedColor="bg-blue-100"
        />
      </div>,
    );
  }

  it("leaves Right to the browser when there is no next column", () => {
    render(
      <div data-set-selector-scroll>
        {column({ title: "Sports" })}
      </div>,
    );
    const box = combo();
    box.focus();

    const notPrevented = fireEvent.keyDown(box, {
      key: "ArrowRight",
      cancelable: true,
    });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(box);
  });

  it("Right from an empty box focuses the next column's search box, Left comes back", () => {
    twoColumns();
    const sports = combo("Search sports");
    const years = combo("Search years");
    sports.focus();

    fireEvent.keyDown(sports, { key: "ArrowRight" });
    expect(document.activeElement).toBe(years);

    fireEvent.keyDown(years, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(sports);
  });

  it("leaves Left and Right to the caret while the box holds text", () => {
    twoColumns();
    const sports = combo("Search sports");
    type(sports, "ba");
    sports.focus();

    const right = fireEvent.keyDown(sports, {
      key: "ArrowRight",
      cancelable: true,
    });
    const left = fireEvent.keyDown(sports, {
      key: "ArrowLeft",
      cancelable: true,
    });

    expect(right).toBe(true);
    expect(left).toBe(true);
    expect(document.activeElement).toBe(sports);
  });

  it("remembers where you were in a column you hop back into", () => {
    twoColumns();
    const sports = combo("Search sports");
    sports.focus();
    for (let i = 0; i < 3; i++) fireEvent.keyDown(sports, { key: "ArrowDown" });
    expect(highlightedText(sports)).toBe("Hockey");

    fireEvent.keyDown(sports, { key: "ArrowRight" });
    fireEvent.keyDown(combo("Search years"), { key: "ArrowLeft" });

    expect(document.activeElement).toBe(sports);
    expect(highlightedText(sports)).toBe("Hockey");
  });

  // -------------------------------------------------------------------------
  // The Maestro tripwire
  // -------------------------------------------------------------------------

  it("leaves every row's visible text exactly the display name", () => {
    // ~105 flows target these rows by text. This is what says the work added
    // no suffix, no aria-label and no second text handle to a data row.
    state.items = YEARS;
    render(column({ title: "Years" }));

    expect(options().map((o) => o.textContent)).toEqual(["2024", "2023"]);
    for (const option of options()) {
      expect(option.tagName).toBe("BUTTON");
      expect(option.getAttribute("aria-label")).toBeNull();
    }
  });

  it("gives each option a DOM id (the aria-activedescendant target) but never the listbox", () => {
    // Was: "options have no id". Options now carry an id; maestro-web reports
    // `node.id || node.ariaLabel`, so the LISTBOX must stay id-less or its
    // aria-label (the column title) stops being a flow handle (NEO-313).
    state.items = YEARS;
    render(column({ title: "Years" }));

    const ids = options().map((o) => o.getAttribute("id"));
    expect(ids.every((id) => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      screen.getByRole("listbox", { name: "Years" }).getAttribute("id"),
    ).toBeNull();
  });
});
