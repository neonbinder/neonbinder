/**
 * NEO-224 — a column's filter result is SAID, not only drawn.
 *
 * Typing in a column's search box narrows its listbox silently: a sighted
 * operator sees two rows left, a screen-reader user hears nothing. Each open
 * column therefore carries one always-mounted, sr-only `role="status"` beside
 * its combobox, which says "N matches" / "1 match" / "No matches" once the
 * typing pauses (~400ms), and "Showing all" the moment Escape clears the box.
 *
 * Pinned here: the debounce (one announcement per word, not per keystroke),
 * Escape's immediacy, that a pick says nothing, that pinned entries count
 * only when they match, and that the region is a sibling of the combobox, so
 * it is per column and costs no layout.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: { selectorOptions: { getSelectorOptions: "getSelectorOptions" } },
}));

const state: { items: unknown } = { items: [] };

vi.mock("convex/react", () => ({
  useQuery: () => state.items,
}));

import EntitySelector, {
  FILTER_ANNOUNCE_DELAY_MS,
  displayByValue,
  filterMatchText,
} from "./EntitySelector";
import type { PinnedEntry, SelectorItem } from "./EntitySelector";

const YEARS = [
  { _id: "y2024", value: "2024" },
  { _id: "y2000", value: "2000" },
  { _id: "y1999", value: "1999" },
  { _id: "y1995", value: "1995" },
  { _id: "y1980", value: "1980" },
];

const ALL_BRANDS: PinnedEntry[] = [
  { id: "__all__", name: "All Brands", ariaLabel: "All Brands — every set in 1995" },
];

function column(
  props: { pinned?: PinnedEntry[]; onSelect?: (id: string) => void; title?: string } = {},
) {
  return (
    <EntitySelector
      title={props.title ?? "Years"}
      query={"getSelectorOptions" as never}
      queryArgs={{ level: "year" } as never}
      selectedId={null}
      onSelect={props.onSelect ?? vi.fn()}
      expanded={true}
      setExpanded={vi.fn()}
      getDisplayName={displayByValue as (i: SelectorItem) => string}
      selectedColor="bg-blue-100"
      pinnedEntries={props.pinned}
    />
  );
}

const combo = () => screen.getByRole("combobox") as HTMLInputElement;
const region = () => {
  const regions = screen.getAllByRole("status");
  expect(regions).toHaveLength(1);
  return regions[0];
};
const type = (value: string) => fireEvent.change(combo(), { target: { value } });
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  state.items = YEARS;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("filterMatchText", () => {
  it.each([
    [0, "No matches"],
    [1, "1 match"],
    [2, "2 matches"],
    [40, "40 matches"],
  ])("%i → %s", (count, text) => {
    expect(filterMatchText(count)).toBe(text);
  });
});

describe("EntitySelector — the filter's polite region (NEO-224)", () => {
  it("is always mounted, sr-only, a sibling of the combobox, and silent until something is typed", () => {
    render(column());
    const r = region();
    expect(r.className).toContain("sr-only");
    expect(r.textContent).toBe("");
    expect(r.parentElement).toBe(combo().parentElement);
    // No implicit aria-live override: role="status" is polite by itself.
    expect(r.getAttribute("aria-live")).toBeNull();
  });

  it("says the count once the typing pauses, not before", () => {
    render(column());
    type("199");
    expect(region().textContent).toBe("");

    wait(FILTER_ANNOUNCE_DELAY_MS - 1);
    expect(region().textContent).toBe("");
    wait(1);
    expect(region().textContent).toBe("2 matches");
  });

  it("debounces a word typed at speed into ONE announcement, of the final count", () => {
    render(column());
    type("1");
    wait(150);
    type("19");
    wait(150);
    type("199");
    wait(150);
    type("1999");
    expect(region().textContent).toBe("");

    wait(FILTER_ANNOUNCE_DELAY_MS);
    expect(region().textContent).toBe("1 match");
  });

  it("says No matches when nothing is left", () => {
    render(column());
    type("zzz");
    wait(FILTER_ANNOUNCE_DELAY_MS);
    expect(region().textContent).toBe("No matches");
  });

  it("Escape clearing the box says Showing all at once, with no wait", () => {
    render(column());
    type("199");
    wait(FILTER_ANNOUNCE_DELAY_MS);
    expect(region().textContent).toBe("2 matches");

    fireEvent.keyDown(combo(), { key: "Escape" });

    expect(combo().value).toBe("");
    expect(region().textContent).toBe("Showing all");
    // ...and nothing later overwrites it.
    wait(FILTER_ANNOUNCE_DELAY_MS * 2);
    expect(region().textContent).toBe("Showing all");
  });

  it("Escape cancels a count still waiting to be said", () => {
    render(column());
    type("199");
    wait(100);
    fireEvent.keyDown(combo(), { key: "Escape" });
    wait(FILTER_ANNOUNCE_DELAY_MS * 2);
    expect(region().textContent).toBe("Showing all");
  });

  it("a box emptied by Backspace says Showing all after the pause", () => {
    render(column());
    type("199");
    wait(FILTER_ANNOUNCE_DELAY_MS);
    type("");
    expect(region().textContent).toBe("2 matches");
    wait(FILTER_ANNOUNCE_DELAY_MS);
    expect(region().textContent).toBe("Showing all");
  });

  it("a pick says nothing here, and no count arrives late", () => {
    const onSelect = vi.fn();
    render(column({ onSelect }));
    type("199");
    wait(100);

    fireEvent.keyDown(combo(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("y1999");
    wait(FILTER_ANNOUNCE_DELAY_MS * 2);
    expect(region().textContent).toBe("");
  });

  it("counts a pinned entry only when its name matches, though it is always listed", () => {
    state.items = [
      { _id: "b1", value: "Topps" },
      { _id: "b2", value: "Topps Chrome" },
      { _id: "b3", value: "Panini" },
    ];
    render(column({ pinned: ALL_BRANDS, title: "Manufacturers" }));

    type("topps");
    wait(FILTER_ANNOUNCE_DELAY_MS);
    expect(region().textContent).toBe("2 matches");

    type("all");
    wait(FILTER_ANNOUNCE_DELAY_MS);
    expect(region().textContent).toBe("1 match");
  });

  it("says nothing while the rows are still loading, then the count once they land", () => {
    state.items = undefined;
    const { rerender } = render(column());
    type("199");
    wait(FILTER_ANNOUNCE_DELAY_MS);
    expect(region().textContent).toBe("");

    state.items = YEARS;
    rerender(column());
    wait(FILTER_ANNOUNCE_DELAY_MS);
    expect(region().textContent).toBe("2 matches");
  });
});
