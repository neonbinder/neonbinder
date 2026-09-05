/**
 * NEO-239 — the checklist's SOURCE filter offers sources, and only sources.
 *
 * The filter is fed from the same `bscSourceView(row, chain).sources` list the
 * attach panel draws its chips from (see `modules/SetSelector`), so the two
 * surfaces cannot disagree about where a row's cards come from. What that fix
 * changes here is mostly SUBTRACTIVE, and the subtraction is the point:
 *
 *   • A Base variant type used to offer a "Base" chip built from its `variant`
 *     slug. No card is ever attributed to a scope slug — `resolveCardSlots`
 *     binds cards to the SOURCE facet — so pressing it filtered the checklist
 *     down to nothing. On a Base row it was also the chip that looked most
 *     like the obvious one to press.
 *   • With that gone a Base row usually has ONE source, and a one-source
 *     filter is not a filter. The whole row disappears rather than offering
 *     "All / Topps", which is a choice between a thing and itself.
 *
 * Chip ids are SLOT keys, not marketplace ids: that is what cards carry in
 * `platformData.<side>.src`, and a row can hold the same marketplace set in
 * two slots (NEO-137).
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ChecklistSourceFilter, {
  type SourceChips,
  type SourceFilter,
} from "./ChecklistSourceFilter";

const NO_FILTER: SourceFilter = { bsc: null, sportlots: null };

function renderFilter(chips: SourceChips, filter: SourceFilter = NO_FILTER) {
  const onChange = vi.fn();
  render(
    <ChecklistSourceFilter chips={chips} filter={filter} onChange={onChange} />,
  );
  return { onChange };
}

const bscRow = () =>
  screen.getByText("BSC source").parentElement as HTMLElement;

describe("ChecklistSourceFilter — BSC sources", () => {
  it("renders nothing at all when the row has ONE source", () => {
    // The Base case after NEO-239: the `variant` slug is scope and never
    // reaches this list, so what is left is a single set. Offering "All /
    // Topps" would be a choice between a thing and itself.
    renderFilter({
      bsc: { primaryId: "b1", chips: [{ id: "b1", label: "Topps" }] },
    });
    expect(screen.queryByLabelText("Filter checklist by source set")).toBeNull();
  });

  it("offers All plus one chip per source when a row draws from two sets", () => {
    // The N:M split this whole feature exists for: one NB Base row, BSC's
    // Series 1 and Series 2.
    renderFilter({
      bsc: {
        primaryId: "b1",
        chips: [
          { id: "b1", label: "Series 1" },
          { id: "b2", label: "Series 2" },
        ],
      },
    });

    const bsc = within(bscRow());
    expect(bsc.getByText("All")).toBeTruthy();
    expect(bsc.getByText("Series 1")).toBeTruthy();
    expect(bsc.getByText("Series 2")).toBeTruthy();
    // Exactly three: no chip for a scope slug, which would filter to nothing.
    expect(bsc.getAllByRole("button")).toHaveLength(3);
  });

  it("selects by SLOT key, which is what a card records as its source", () => {
    // Not the marketplace id: a row can hold the same BSC set in two slots,
    // and the per-card filter compares against `platformData.bsc.src`.
    const { onChange } = renderFilter({
      bsc: {
        primaryId: "b1",
        chips: [
          { id: "b1", label: "Series 1" },
          { id: "b2", label: "Series 2" },
        ],
      },
    });

    within(bscRow()).getByText("Series 2").click();
    expect(onChange).toHaveBeenCalledWith({ bsc: "b2", sportlots: null });
  });

  it("keeps the SportLots row independent of the BSC one", () => {
    // SL has one unit of attachment and no facets, so its list is still the
    // plain slot walk. A single BSC source must not suppress a real SL choice.
    renderFilter({
      bsc: { primaryId: "b1", chips: [{ id: "b1", label: "Topps" }] },
      sportlots: {
        primaryId: "s0",
        chips: [
          { id: "s0", label: "Topps" },
          { id: "s1", label: "Topps Update" },
        ],
      },
    });

    expect(screen.getByText("SL source")).toBeTruthy();
    expect(screen.queryByText("BSC source")).toBeNull();
  });
});
