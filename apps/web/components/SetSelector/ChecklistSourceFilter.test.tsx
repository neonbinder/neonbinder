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

describe("ChecklistSourceFilter — chips that share a label (NEO-325)", () => {
  it("a label two chips share wears its (#id); a unique label stays bare", () => {
    renderFilter({
      sportlots: {
        primaryId: "s0",
        chips: [
          { id: "s0", label: "Anime" },
          { id: "s1", label: "Anime" },
          { id: "s2", label: "Solo" },
        ],
      },
    });

    const chips = within(
      screen.getByText("SL source").parentElement as HTMLElement,
    ).getAllByRole("button");
    const names = chips.map((c) => c.textContent);
    expect(names).toContain("Solo");
    const anime = names.filter((n) => n?.startsWith("Anime"));
    expect(anime).toHaveLength(2);
    for (const name of anime) expect(name).toMatch(/^Anime \(#.+\)$/);
    expect(new Set(anime).size).toBe(2);
  });

  it("no shared label, no suffix anywhere", () => {
    renderFilter({
      bsc: {
        primaryId: "b0",
        chips: [
          { id: "b0", label: "Series 1" },
          { id: "b1", label: "Series 2" },
        ],
      },
    });

    expect(screen.queryByText(/\(#/)).toBeNull();
  });

  it("the fold is case- and space-insensitive: 'anime ' and 'Anime' are shared", () => {
    renderFilter({
      sportlots: {
        primaryId: "s0",
        chips: [
          { id: "s0", label: "anime " },
          { id: "s1", label: "Anime" },
        ],
      },
    });

    expect(screen.getAllByText(/\(#/).length).toBeGreaterThanOrEqual(2);
  });

  it("the suffix does not change which chip is the filter's value", () => {
    const { onChange } = renderFilter({
      sportlots: {
        primaryId: "s0",
        chips: [
          { id: "s0", label: "Anime" },
          { id: "s1", label: "Anime" },
        ],
      },
    });
    const chips = within(
      screen.getByText("SL source").parentElement as HTMLElement,
    ).getAllByRole("button");
    const second = chips.find((c) => c.textContent?.startsWith("Anime") && c !== chips[1])!;
    second.click();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onChange.mock.calls[0][0])).not.toContain("#");
  });
});

describe("ChecklistSourceFilter — twin chips show the marketplace id, not the slot key (NEO-325)", () => {
  const slChips = () =>
    within(screen.getByText("SL source").parentElement as HTMLElement)
      .getAllByRole("button")
      .map((c) => c.textContent);

  it("two same-label chips wear the id in their slot, never the slot key", () => {
    renderFilter({
      sportlots: {
        primaryId: "s0",
        chips: [
          { id: "s0", label: "Anime", platformId: "378117" },
          { id: "s1", label: "Anime", platformId: "378118" },
        ],
      },
    });

    const names = slChips();
    expect(names).toContain("Anime (#378117)");
    expect(names).toContain("Anime (#378118)");
    expect(names.join(" ")).not.toMatch(/#s\d/);
  });

  it("the same marketplace id in two slots still tells the chips apart by their slot key", () => {
    // One marketplace set held in two slots (NEO-137): both wear the same id,
    // so they read alike, but each is still its own chip with its own value.
    const { onChange } = renderFilter({
      sportlots: {
        primaryId: "s0",
        chips: [
          { id: "s0", label: "Anime", platformId: "378117" },
          { id: "s1", label: "Anime", platformId: "378117" },
        ],
      },
    });
    const chips = within(
      screen.getByText("SL source").parentElement as HTMLElement,
    ).getAllByRole("button");

    expect(chips.filter((c) => c.textContent?.startsWith("Anime"))).toHaveLength(2);
    chips[chips.length - 1].click();
    expect(JSON.stringify(onChange.mock.calls[0][0])).toContain("s1");
  });

  it("a chip with no platformId falls back to its slot key, as it always did", () => {
    renderFilter({
      sportlots: {
        primaryId: "s0",
        chips: [
          { id: "s0", label: "Anime" },
          { id: "s1", label: "Anime" },
        ],
      },
    });

    expect(slChips()).toEqual(expect.arrayContaining(["Anime (#s0)", "Anime (#s1)"]));
  });

  it("a unique label stays bare even when it carries a platformId", () => {
    renderFilter({
      bsc: {
        primaryId: "b0",
        chips: [
          { id: "b0", label: "Series 1", platformId: "series-1" },
          { id: "b1", label: "Series 2", platformId: "series-2" },
        ],
      },
    });

    expect(screen.queryByText(/\(#/)).toBeNull();
  });
});
