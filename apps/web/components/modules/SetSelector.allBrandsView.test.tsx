/**
 * NEO-237 (D14c/D17) — `components/modules/SetSelector.tsx`'s handling of the
 * All Brands VIEW selection in the Manufacturers column: the Sets column's
 * parent becomes the YEAR (not a manufacturer row), "+ Custom" is replaced by
 * a reason line (a view has no one parent to create under), picking a set
 * back-fills the Manufacturers selection from the set's own parent, and the
 * deepest-selected-row tracking (`SetAttributesPanel`'s target,
 * `deepestSelectedId`) treats the view sentinel as "no row" — the year is what
 * it falls back to.
 *
 * NEO-294 adds the other case where the Manufacturers selection moves without
 * the operator touching that column: a set moved to a different brand. Same
 * assertion surface — which parent the Sets column is scoped to — so it lives
 * here rather than in a second copy of this harness.
 *
 * Same mocking strategy as `SetSelector.liveRegion.test.tsx`: every child
 * column is stubbed, and the stubs expose a plain button (or, here, some
 * captured props) wired to the real handler. `ResilientEntityColumn` is
 * stubbed to also render its own `level`/`parentId`/`hideCustom` as data
 * attributes so this file can assert on what the real column receives without
 * needing `ResilientEntityColumn`'s own Convex subscriptions.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
    },
  },
}));

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "getAncestorChain") return [];
    return undefined;
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("../../convex/bscFacets", () => ({
  bscSourceView: () => ({ sources: [] }),
}));

vi.mock("../SetSelector/ResilientEntityColumn", () => ({
  default: ({
    selector,
    isVisible,
    level,
    parentId,
    hideCustom,
  }: {
    selector: React.ReactNode;
    isVisible: boolean;
    level: string;
    parentId?: string;
    hideCustom?: { reason: string };
  }) =>
    isVisible ? (
      <div
        data-testid={`column-${level}`}
        data-parent-id={parentId ?? ""}
        data-hide-custom-reason={hideCustom?.reason ?? ""}
      >
        {selector}
      </div>
    ) : null,
}));

vi.mock("../SetSelector/SportSelector", () => ({
  default: ({ onSportSelect }: { onSportSelect: (v: string) => void }) => (
    <button onClick={() => onSportSelect("sport-1")}>pick-sport</button>
  ),
}));
vi.mock("../SetSelector/YearSelector", () => ({
  default: ({ onYearSelect }: { onYearSelect: (v: string) => void }) => (
    <button onClick={() => onYearSelect("year-1")}>pick-year</button>
  ),
}));
vi.mock("../SetSelector/ManufacturerSelector", () => ({
  default: ({
    onManufacturerSelect,
  }: {
    onManufacturerSelect: (v: string) => void;
  }) => (
    <>
      <button onClick={() => onManufacturerSelect("mfr-1")}>
        pick-manufacturer
      </button>
      <button onClick={() => onManufacturerSelect("__all-brands-view__")}>
        pick-all-brands-view
      </button>
    </>
  ),
}));
vi.mock("../SetSelector/SetSelector", () => ({
  default: ({
    onSetSelect,
    manufacturerId,
    yearId,
  }: {
    onSetSelect: (id: string, parentId?: string) => void;
    manufacturerId: string | null;
    yearId: string;
  }) => (
    <div data-manufacturer-id={manufacturerId ?? ""} data-year-id={yearId}>
      {/* Selecting a set from the view hands back the set's OWN parent
          (a real brand row), simulating the year-wide list item shape. */}
      <button onClick={() => onSetSelect("set-1", "mfr-from-set-parent")}>
        pick-set-with-parent
      </button>
      <button onClick={() => onSetSelect("set-2")}>pick-set-no-parent</button>
    </div>
  ),
}));
vi.mock("../SetSelector/SetVariantSelector", () => ({
  default: ({
    onVariantTypeSelect,
  }: {
    onVariantTypeSelect: (v: string) => void;
  }) => (
    <button onClick={() => onVariantTypeSelect("vt-1")}>
      pick-variant-type
    </button>
  ),
}));
vi.mock("../SetSelector/VariantSelector", () => ({
  default: () => null,
}));
vi.mock("../SetSelector/ParallelSelector", () => ({ default: () => null }));

vi.mock("../SetSelector/YearForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ManufacturerForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SetForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SetVariantForm", () => ({ default: () => null }));
vi.mock("../SetSelector/VariantForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelForm", () => ({ default: () => null }));
vi.mock("../SetSelector/CardChecklist", () => ({ default: () => null }));
vi.mock("../SetSelector/BaseMappingForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelGroupingModal", () => ({
  default: () => null,
}));
vi.mock("../SetSelector/MultiSourcePanel", () => ({ default: () => null }));
vi.mock("../SetSelector/SetAttributesPanel", () => ({
  default: ({
    selectorOptionId,
    onMoved,
  }: {
    selectorOptionId: string;
    onMoved?: (brandId: string) => void;
  }) => (
    <div>
      <span data-testid="attributes-panel-target">{selectorOptionId}</span>
      {/* NEO-294 — stands in for the move control's completed move. Kept
          OUTSIDE the target span so its label never joins that element's
          textContent, which other tests here read as the id. */}
      <button onClick={() => onMoved?.("mfr-2")}>pick-set-moved</button>
    </div>
  ),
}));
vi.mock("../SetSelector/SportForm", () => ({ SportForm: () => null }));

import SetSelector from "./SetSelector";

const pick = (label: string) =>
  fireEvent.click(screen.getByText(`pick-${label}`));

describe("SetSelector — the All Brands VIEW (NEO-237)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function openThroughToManufacturer() {
    render(<SetSelector />);
    pick("sport");
    pick("year");
  }

  it("selecting the pinned view opens the Sets column parented on the YEAR, not a manufacturer", () => {
    openThroughToManufacturer();
    pick("all-brands-view");

    const setsColumn = screen.getByTestId("column-setName");
    expect(setsColumn.getAttribute("data-parent-id")).toBe("year-1");
  });

  it("an ordinary manufacturer selection still parents Sets on the manufacturer row", () => {
    openThroughToManufacturer();
    pick("manufacturer");

    const setsColumn = screen.getByTestId("column-setName");
    expect(setsColumn.getAttribute("data-parent-id")).toBe("mfr-1");
  });

  it("hideCustom carries the reason line only in the view", () => {
    openThroughToManufacturer();
    pick("all-brands-view");

    expect(
      screen.getByTestId("column-setName").getAttribute("data-hide-custom-reason"),
    ).toBe("Pick a brand to add a set");
  });

  it("an ordinary manufacturer selection sends no hideCustom reason", () => {
    openThroughToManufacturer();
    pick("manufacturer");

    expect(
      screen.getByTestId("column-setName").getAttribute("data-hide-custom-reason"),
    ).toBe("");
  });

  it("picking a set from the view back-fills the manufacturer from the item's parentId", () => {
    openThroughToManufacturer();
    pick("all-brands-view");
    pick("set-with-parent");

    // The Manufacturers column re-renders with the back-filled row id as its
    // parent, so a downstream Sets fetch under that brand is now scoped to it.
    const setsColumn = screen.getByTestId("column-setName");
    expect(setsColumn.getAttribute("data-parent-id")).toBe(
      "mfr-from-set-parent",
    );
  });

  it("picking a set from the view with NO parentId leaves the view selection alone", () => {
    openThroughToManufacturer();
    pick("all-brands-view");
    pick("set-no-parent");

    // No back-fill signal was given, so the Sets column parent is still the
    // year (the view itself), not thrown away.
    const setsColumn = screen.getByTestId("column-setName");
    expect(setsColumn.getAttribute("data-parent-id")).toBe("year-1");
  });

  it("the deepest-selected-row target treats the view sentinel as no row, falling back to the year", () => {
    openThroughToManufacturer();
    pick("all-brands-view");

    // SetAttributesPanel is only rendered once `deepestSelectedId` is set;
    // with the view selected and nothing chosen beneath it, that id is the
    // YEAR row, never the sentinel string.
    expect(screen.getByTestId("attributes-panel-target").textContent).toBe(
      "year-1",
    );
  });

  it("the live region still announces the Sets column when the view is what opened it", () => {
    openThroughToManufacturer();
    pick("all-brands-view");

    const region = screen
      .getAllByRole("status")
      .find((el) => el.className.includes("sr-only"))!;
    expect(region.textContent).toBe("Sets column opened");
  });
});

/**
 * NEO-294 — a set moved to another brand must not vanish from the open Sets
 * column.
 *
 * The Sets column is scoped to the manufacturer row the operator selected.
 * Re-parenting the set server-side therefore drops it out of that column's
 * query while everything below it — the variant types, the checklist, the
 * attributes panel — carries on working, because those key on the set's id
 * and a re-parent does not change it. The column follows the set instead.
 */
describe("SetSelector — a moved set keeps its place (NEO-294)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function selectASetUnderABrand() {
    render(<SetSelector />);
    pick("sport");
    pick("year");
    pick("manufacturer");
    pick("set-with-parent");
  }

  it("re-points the Manufacturers column at the destination brand", () => {
    selectASetUnderABrand();
    expect(screen.getByTestId("column-setName").getAttribute("data-parent-id"))
      .toBe("mfr-1");

    pick("set-moved");

    // The Sets column now queries under the brand the set landed in, so the
    // row is still listed — and the operator can SEE it under its new brand,
    // which the toast alone never proves.
    expect(screen.getByTestId("column-setName").getAttribute("data-parent-id"))
      .toBe("mfr-2");
  });

  it("keeps the moved set selected — nothing was deleted, so nothing is cleared", () => {
    selectASetUnderABrand();
    // The Variant Types column is only visible while a set is selected, and
    // the attributes panel is still pointed at the same row.
    pick("set-moved");

    expect(screen.getByTestId("column-variantType")).toBeTruthy();
    expect(screen.getByTestId("attributes-panel-target").textContent).toContain(
      "set-1",
    );
  });
});
