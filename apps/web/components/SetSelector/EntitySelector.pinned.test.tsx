/**
 * NEO-237 (D17) — `EntitySelector`'s `pinnedEntries`: a view entry (like "All
 * Brands") pinned to the top of the column's listbox, selected by a client
 * sentinel id rather than a document id.
 *
 * Companion to `EntitySelector.listbox.test.tsx` (the general listbox/combobox
 * contract this file leans on rather than re-proves) and
 * `ManufacturerSelector.test.tsx` (the real caller's own pinned entry). Pins:
 * present even with zero data rows, never hides behind the search filter but
 * IS matched by it (NEO-224: typing "all" highlights it), carries its
 * `aria-label`, is reachable by the arrow highlight, and `onSelect` is called
 * with the sentinel id on click.
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
import type { PinnedEntry, SelectorItem } from "./EntitySelector";

const ALL_BRANDS_VIEW = "__all_brands_view__";

const PINNED: PinnedEntry[] = [
  {
    id: ALL_BRANDS_VIEW,
    name: "All Brands",
    ariaLabel: "All Brands — every set in 1995",
    description: "Every set in 1995",
  },
];

const MANUFACTURERS = [
  { _id: "topps", value: "Topps" },
  { _id: "panini", value: "Panini" },
];

function column(props: {
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  pinnedEntries?: PinnedEntry[];
}) {
  return (
    <EntitySelector
      title="Manufacturers"
      query={"getSelectorOptions" as never}
      queryArgs={{ level: "manufacturer" } as never}
      selectedId={props.selectedId ?? null}
      onSelect={props.onSelect ?? vi.fn()}
      expanded={true}
      setExpanded={vi.fn()}
      getDisplayName={displayByValue as (i: SelectorItem) => string}
      selectedColor="bg-green-100"
      pinnedEntries={props.pinnedEntries ?? PINNED}
    />
  );
}

const options = () => screen.getAllByRole("option");
const optionNamed = (name: string) =>
  options().find((o) => o.textContent?.startsWith(name))!;
const highlighted = (box: HTMLElement) =>
  document.getElementById(box.getAttribute("aria-activedescendant") ?? "");

describe("EntitySelector pinned entries (NEO-237 D17)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = MANUFACTURERS;
  });

  it("renders even with zero data rows", () => {
    state.items = [];
    render(column({}));

    const list = screen.getByRole("listbox", { name: "Manufacturers" });
    const opts = within(list).getAllByRole("option");
    expect(opts).toHaveLength(1);
    expect(opts[0].textContent).toContain("All Brands");
  });

  it("sits first, ahead of every data row", () => {
    render(column({}));
    const names = options().map((o) => o.textContent);
    expect(names[0]).toContain("All Brands");
  });

  it("carries its full aria-label, distinct from the visible name alone", () => {
    render(column({}));
    expect(
      screen.getByRole("option", { name: "All Brands — every set in 1995" }),
    ).not.toBeNull();
  });

  it("shows the search box however few data rows there are, pinned entry included", () => {
    // Was: "does NOT count toward the showSearch threshold (> 8 data rows)".
    // The threshold is gone (NEO-224): every open column renders its combobox,
    // so a column of one pinned entry plus two brands has one too.
    render(column({}));
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.getByPlaceholderText("Search manufacturers...")).not.toBeNull();
  });

  it("is never hidden by the search filter", () => {
    // Force the search box to render, then type something that matches no
    // brand at all — the pinned entry must still be there.
    state.items = Array.from({ length: 9 }, (_, i) => ({
      _id: `m${i}`,
      value: `Brand ${i}`,
    }));
    render(column({}));
    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: "zzz-no-match" } });

    expect(screen.queryByText("All Brands")).not.toBeNull();
    expect(screen.queryByText(/^Brand \d$/)).toBeNull();
  });

  it("is the first highlight, and Down from it reaches the first data row", () => {
    // Was: "participates in the roving tabindex — Down from it reaches the
    // first data row".
    render(column({}));
    const box = screen.getByRole("combobox");
    expect(highlighted(box)).toBe(optionNamed("All Brands"));
    expect(optionNamed("All Brands").tabIndex).toBe(-1);

    fireEvent.keyDown(box, { key: "ArrowDown" });
    // Data rows sort alphabetically: Panini, Topps.
    expect(highlighted(box)).toBe(optionNamed("Panini"));
  });

  it("typing 'all' highlights it, and Enter selects it by its sentinel id", () => {
    // Was: "typeahead can land on it by its first letters".
    const onSelect = vi.fn();
    render(column({ onSelect }));
    const box = screen.getByRole("combobox");

    fireEvent.change(box, { target: { value: "all" } });

    expect(highlighted(box)).toBe(optionNamed("All Brands"));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(ALL_BRANDS_VIEW);
  });

  it("keeps the pinned entry listed but unhighlighted when nothing matches, and Enter does nothing", () => {
    const onSelect = vi.fn();
    render(column({ onSelect }));
    const box = screen.getByRole("combobox");

    fireEvent.change(box, { target: { value: "zzz" } });

    expect(options()).toHaveLength(1);
    expect(box.getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("calling onSelect fires with the sentinel id, not a document id", () => {
    const onSelect = vi.fn();
    render(column({ onSelect }));
    fireEvent.click(optionNamed("All Brands"));
    expect(onSelect).toHaveBeenCalledWith(ALL_BRANDS_VIEW);
  });

  it("is aria-selected when the sentinel is the current selection", () => {
    render(column({ selectedId: ALL_BRANDS_VIEW }));
    expect(optionNamed("All Brands").getAttribute("aria-selected")).toBe("true");
    expect(optionNamed("Topps").getAttribute("aria-selected")).toBe("false");
  });
});
