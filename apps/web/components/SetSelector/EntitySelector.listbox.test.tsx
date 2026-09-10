/**
 * NEO-260 — the set-selector columns are listboxes, and the arrows work.
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
 * ~105 Maestro flows target these rows by their VISIBLE TEXT. The role, the
 * roving `tabindex` and `aria-selected` are attribute-only additions: the row's
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
/** The single tab stop of a column — a roving tabindex has exactly one. */
const tabStops = (root: HTMLElement = document.body) =>
  Array.from(root.querySelectorAll('[role="option"]')).filter(
    (o) => (o as HTMLElement).tabIndex === 0,
  );

describe("EntitySelector — listbox semantics (NEO-260)", () => {
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
  // Roving tabindex — the column is ONE tab stop
  // -------------------------------------------------------------------------

  it("is a single tab stop, not one per row", () => {
    render(column({}));

    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0].textContent).toBe("Baseball");
    // Every other row is reachable by arrow, never by Tab.
    expect(
      options()
        .slice(1)
        .every((o) => o.tabIndex === -1),
    ).toBe(true);
  });

  it("puts the tab stop on the chosen row, so Tab lands on the selection", () => {
    render(column({ selectedId: "football" }));

    expect(tabStops()[0].textContent).toBe("Football");
  });

  it("moves the tab stop to follow focus, however focus got there", () => {
    render(column({}));
    fireEvent.focus(optionNamed("Hockey"));

    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0].textContent).toBe("Hockey");
  });

  // -------------------------------------------------------------------------
  // Arrow / Home / End
  // -------------------------------------------------------------------------

  it("Down and Up move one row at a time", () => {
    render(column({}));
    const baseball = optionNamed("Baseball");
    baseball.focus();

    fireEvent.keyDown(baseball, { key: "ArrowDown" });
    expect(document.activeElement).toBe(optionNamed("Basketball"));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(optionNamed("Football"));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(optionNamed("Basketball"));
  });

  it("stops at the ends instead of wrapping", () => {
    // Wrapping silently re-enters the list from the other side, which reads as
    // a dropped keypress. The APG's default for a listbox is to stop.
    render(column({}));
    const first = optionNamed("Baseball");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);

    const last = optionNamed("Hockey");
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(document.activeElement).toBe(last);
  });

  it("Home and End jump to the ends", () => {
    render(column({}));
    const middle = optionNamed("Football");
    middle.focus();

    fireEvent.keyDown(middle, { key: "End" });
    expect(document.activeElement).toBe(optionNamed("Hockey"));

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(optionNamed("Baseball"));
  });

  it("cancels the keys it handles, so the page does not also scroll", () => {
    render(column({}));
    const baseball = optionNamed("Baseball");
    baseball.focus();

    const notPrevented = fireEvent.keyDown(baseball, {
      key: "ArrowDown",
      cancelable: true,
    });
    expect(notPrevented).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Typeahead
  // -------------------------------------------------------------------------

  it("jumps to a row by typing its first letters", () => {
    // The columns with eight or fewer rows render no search box at all, so
    // typeahead is the only way to reach a row by name in them.
    render(column({}));
    const baseball = optionNamed("Baseball");
    baseball.focus();

    fireEvent.keyDown(baseball, { key: "f" });
    expect(document.activeElement).toBe(optionNamed("Football"));
  });

  it("accumulates letters, so 'bas' + 'k' passes Baseball", () => {
    render(column({}));
    const start = optionNamed("Hockey");
    start.focus();

    for (const key of ["b", "a", "s", "k"]) {
      fireEvent.keyDown(document.activeElement!, { key });
    }
    expect(document.activeElement).toBe(optionNamed("Basketball"));
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
    // Neither swallowed as typeahead nor turned into a select: intercepting
    // keydown would either double-fire or break the native contract.
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(baseball);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores keys held with a modifier, which belong to the browser", () => {
    render(column({}));
    const baseball = optionNamed("Baseball");
    baseball.focus();

    fireEvent.keyDown(baseball, { key: "ArrowDown", metaKey: true });
    expect(document.activeElement).toBe(baseball);
  });

  // -------------------------------------------------------------------------
  // Enter still selects — the existing activateOnEnter path
  // -------------------------------------------------------------------------

  it("Enter on the row the arrows landed on selects it", () => {
    const onSelect = vi.fn();
    render(column({ onSelect }));
    const baseball = optionNamed("Baseball");
    baseball.focus();

    fireEvent.keyDown(baseball, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("basketball");
  });

  // -------------------------------------------------------------------------
  // Left / Right across the cascade
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
    // One column: there is nowhere to go, and the key is left to the browser.
    const only = optionNamed("Baseball");
    only.focus();
    const notPrevented = fireEvent.keyDown(only, {
      key: "ArrowRight",
      cancelable: true,
    });
    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(only);
  });

  it("Right enters the next column at its own tab stop, Left comes back", () => {
    // Both columns read the same mocked query, so the second one holds the same
    // rows; what matters is that it is a DIFFERENT listbox.
    const { container } = twoColumns();
    const [sports, years] = Array.from(
      container.querySelectorAll<HTMLElement>('[role="listbox"]'),
    );
    const start = within(sports).getAllByRole("option")[2];
    start.focus();

    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(years.contains(document.activeElement)).toBe(true);
    // Its own roving stop, not row 3 of the previous column.
    expect(tabStops(years)[0]).toBe(document.activeElement);

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(sports.contains(document.activeElement)).toBe(true);
  });

  it("remembers where you were in a column you arrow back into", () => {
    const { container } = twoColumns();
    const [sports, years] = Array.from(
      container.querySelectorAll<HTMLElement>('[role="listbox"]'),
    );
    const hockey = within(sports).getAllByRole("option")[3];
    hockey.focus();

    fireEvent.keyDown(hockey, { key: "ArrowRight" });
    expect(years.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });

    expect(document.activeElement).toBe(hockey);
  });

  // -------------------------------------------------------------------------
  // The Maestro tripwire
  // -------------------------------------------------------------------------

  it("leaves every row's visible text exactly the display name", () => {
    // ~105 flows target these rows by text. The listbox work is attribute-only
    // — role, tabindex, aria-selected — and this is what says so.
    state.items = YEARS;
    render(column({ title: "Years" }));

    expect(options().map((o) => o.textContent)).toEqual(["2024", "2023"]);
    for (const option of options()) {
      expect(option.tagName).toBe("BUTTON");
      // Maestro's resource-id is `node.id || node.ariaLabel`: an id here would
      // shadow the text handle, and a row aria-label would invent a second one.
      expect(option.getAttribute("id")).toBeNull();
      expect(option.getAttribute("aria-label")).toBeNull();
    }
  });
});
