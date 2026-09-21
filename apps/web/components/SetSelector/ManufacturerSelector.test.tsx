/**
 * NEO-237 (D17) — `ManufacturerSelector` pins the "All Brands" view entry,
 * whose accessible name carries the YEAR's own value ("All Brands — every
 * set in 1995"). `EntitySelector.pinned.test.tsx` covers the generic pinned-
 * entry mechanics this file does not repeat; this file pins the one thing
 * only the real caller can prove: the year-specific aria-label text and that
 * a selection is reported through `onManufacturerSelect` as the sentinel.
 */

import { render, screen, fireEvent } from "@testing-library/react";
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
