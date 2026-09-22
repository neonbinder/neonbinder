/**
 * NEO-237 (D17) — `ManufacturerSelector` pins the "All Brands" view entry,
 * whose accessible name carries the YEAR's own value ("All Brands — every
 * set in 1995"). `EntitySelector.pinned.test.tsx` covers the generic pinned-
 * entry mechanics this file does not repeat; this file pins the one thing
 * only the real caller can prove: the year-specific aria-label text and that
 * a selection is reported through `onManufacturerSelect` as the sentinel.
 *
 * Also (Jason, 2026-09-21): the column's order is All Brands, then the
 * year's Unknown row (`metadata.isBrandUnknown`, never its name), then every
 * brand in the usual order. Unknown is a data row — selectable by id and
 * matched by the search box — not a second pinned entry.
 */

import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getSelectorOptions: "getSelectorOptions",
    },
  },
}));

const state: { year: unknown; manufacturers: unknown } = {
  year: { _id: "y1995", value: "1995" },
  manufacturers: [{ _id: "topps", value: "Topps" }],
};

vi.mock("convex/react", () => ({
  useQuery: (query: unknown) =>
    query === "getSelectorOptionById" ? state.year : state.manufacturers,
}));

import ManufacturerSelector from "./ManufacturerSelector";
import { ALL_BRANDS_VIEW } from "./all-brands-view";

function renderColumn(props: {
  selectedManufacturerId?: string | null;
  onManufacturerSelect?: (id: string) => void;
}) {
  return render(
    <ManufacturerSelector
      yearId={"y1995" as never}
      selectedManufacturerId={(props.selectedManufacturerId ?? null) as never}
      onManufacturerSelect={props.onManufacturerSelect ?? vi.fn()}
      expanded={true}
      setExpanded={vi.fn()}
    />,
  );
}

describe("ManufacturerSelector — the pinned All Brands view (NEO-237)", () => {
  beforeEach(() => {
    state.year = { _id: "y1995", value: "1995" };
    state.manufacturers = [{ _id: "topps", value: "Topps" }];
  });

  it("labels the pinned entry with the YEAR's own value", () => {
    renderColumn({});
    expect(
      screen.getByRole("option", { name: "All Brands — every set in 1995" }),
    ).not.toBeNull();
  });

  it("falls back to generic wording while the year row has not loaded yet", () => {
    state.year = undefined;
    renderColumn({});
    expect(
      screen.getByRole("option", { name: "All Brands — every set in this year" }),
    ).not.toBeNull();
  });

  it("reports a selection of the pinned entry as the ALL_BRANDS_VIEW sentinel", () => {
    const onManufacturerSelect = vi.fn();
    renderColumn({ onManufacturerSelect });
    fireEvent.click(screen.getByText("All Brands"));
    expect(onManufacturerSelect).toHaveBeenCalledWith(ALL_BRANDS_VIEW);
  });

  it("is aria-selected when the sentinel is the current selection", () => {
    renderColumn({ selectedManufacturerId: ALL_BRANDS_VIEW });
    const option = screen.getByRole("option", {
      name: "All Brands — every set in 1995",
    });
    expect(option.getAttribute("aria-selected")).toBe("true");
  });

  it("still renders every real manufacturer row alongside the pinned view", () => {
    renderColumn({});
    expect(screen.getByText("Topps")).not.toBeNull();
  });
});

/** The option rows' visible names, in DOM order. */
function optionNames(): string[] {
  return screen
    .getAllByRole("option")
    .map((o) => o.querySelector("span")?.textContent ?? "");
}

describe("ManufacturerSelector — All Brands, then Unknown, then the brands (NEO-237, Jason 2026-09-21)", () => {
  beforeEach(() => {
    state.year = { _id: "y1995", value: "1995" };
  });

  it("puts the flagged row second, straight after the pinned view, whatever its name or creation order", () => {
    state.manufacturers = [
      { _id: "topps", value: "Topps" },
      { _id: "fleer", value: "Fleer" },
      // Flagged AND named so it would otherwise sort last.
      { _id: "unk", value: "Zzz Unsorted", metadata: { isBrandUnknown: true } },
      { _id: "bandai", value: "Bandai" },
    ];
    renderColumn({});
    expect(optionNames()).toEqual([
      "All Brands",
      "Zzz Unsorted",
      "Bandai",
      "Fleer",
      "Topps",
    ]);
  });

  it("leads by the flag, not the name: an unflagged row called 'Unknown' sorts with the brands", () => {
    state.manufacturers = [
      { _id: "topps", value: "Topps" },
      { _id: "named-unknown", value: "Unknown" },
      { _id: "flagged", value: "Unknown", metadata: { isBrandUnknown: true } },
      { _id: "bandai", value: "Bandai" },
    ];
    renderColumn({});
    const names = optionNames();
    expect(names[0]).toBe("All Brands");
    expect(names[1]).toBe("Unknown");
    // The merely-named row stays in name order among the brands.
    expect(names.slice(2)).toEqual(["Bandai", "Topps", "Unknown"]);
    // And the one in second place IS the flagged row.
    const onManufacturerSelect = vi.fn();
    cleanup();
    renderColumn({ onManufacturerSelect });
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(onManufacturerSelect).toHaveBeenCalledWith("flagged");
  });

  it("a year with no flagged row is unchanged: the brands in name order under the view", () => {
    state.manufacturers = [
      { _id: "topps", value: "Topps" },
      { _id: "bandai", value: "Bandai" },
      { _id: "fleer", value: "Fleer", metadata: { setNamePrefix: "Fleer" } },
    ];
    renderColumn({});
    expect(optionNames()).toEqual(["All Brands", "Bandai", "Fleer", "Topps"]);
  });

  it("the flagged row is a real data row: clicking it reports its document id", () => {
    state.manufacturers = [
      { _id: "topps", value: "Topps" },
      { _id: "unk", value: "Unknown", metadata: { isBrandUnknown: true } },
    ];
    const onManufacturerSelect = vi.fn();
    renderColumn({ onManufacturerSelect });
    fireEvent.click(screen.getByText("Unknown"));
    expect(onManufacturerSelect).toHaveBeenCalledWith("unk");
  });

  it("the search box filters the flagged row like any other, and never the pinned view", () => {
    // Nine data rows so the search box renders (threshold > 8).
    state.manufacturers = [
      { _id: "unk", value: "Unknown", metadata: { isBrandUnknown: true } },
      ...["Bandai", "Bowman", "Donruss", "Fleer", "Leaf", "Pinnacle", "Score", "Topps"].map(
        (value) => ({ _id: value.toLowerCase(), value }),
      ),
    ];
    renderColumn({});
    expect(optionNames()[1]).toBe("Unknown");

    const search = screen.getByLabelText("Search manufacturers");
    fireEvent.change(search, { target: { value: "unk" } });
    expect(optionNames()).toEqual(["All Brands", "Unknown"]);

    fireEvent.change(search, { target: { value: "opps" } });
    expect(optionNames()).toEqual(["All Brands", "Topps"]);
  });
});
