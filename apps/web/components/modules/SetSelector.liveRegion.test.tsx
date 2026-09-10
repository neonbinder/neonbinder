/**
 * NEO-260 (a11y) — the cascade says when it opens a column.
 *
 * THE DEFECT. Choosing a sport reveals the Years column and scrolls it into
 * view, and that is the entire feedback. A screen-reader user gets nothing:
 * their focus has just been parked on the collapsed card of the column they
 * were in, so there is not even a focus change to infer the reveal from. Six
 * columns deep they are navigating a page that silently grows underneath them.
 *
 * WHAT IS PINNED HERE. One polite live region naming the DEEPEST revealed
 * column, that changes only when a column is actually revealed — the text is
 * derived, never stored, so a re-render for any other reason writes the same
 * string, React skips the DOM write and nothing is announced. "Terse and not
 * chatty" is a property of the string, and that is what these tests check.
 *
 * MOCKING. Same strategy as SetSelector.baseMapping.test.tsx: the seven columns
 * each hold their own Convex subscriptions and none of that is under test, so
 * every child is stubbed. The stubs that matter expose one button per level
 * wired to the REAL select handler the real column would call.
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

/** An Insert variant type: non-terminal, so it reveals columns 6 and 7. */
const INSERT_ROW = {
  _id: "vt-insert",
  value: "Insert",
  metadata: {},
  platformData: {},
};

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (args === "skip") return undefined;
    if (ref === "getSelectorOptionById") {
      const id = (args as { id: string } | undefined)?.id;
      return id === "vt-insert" ? INSERT_ROW : undefined;
    }
    if (ref === "getAncestorChain") return [];
    return undefined;
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

vi.mock("../../convex/bscFacets", () => ({
  bscSourceView: () => ({ sources: [] }),
}));

// Columns render their selector unconditionally, so a stub below can drive any
// level without the column's own visibility gate getting in the way.
vi.mock("../SetSelector/ResilientEntityColumn", () => ({
  default: ({ selector }: { selector: React.ReactNode }) => (
    <div>{selector}</div>
  ),
}));

// One "pick-<level>" button per level, wired to the REAL select handler the
// real column would call. Each factory is inlined: `vi.mock` is hoisted above
// any helper this file declares, so a shared `picker()` would not exist yet.
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
    <button onClick={() => onManufacturerSelect("mfr-1")}>
      pick-manufacturer
    </button>
  ),
}));
vi.mock("../SetSelector/SetSelector", () => ({
  default: ({ onSetSelect }: { onSetSelect: (v: string) => void }) => (
    <button onClick={() => onSetSelect("set-1")}>pick-set</button>
  ),
}));
vi.mock("../SetSelector/SetVariantSelector", () => ({
  default: ({
    onVariantTypeSelect,
  }: {
    onVariantTypeSelect: (v: string) => void;
  }) => (
    <button onClick={() => onVariantTypeSelect("vt-insert")}>
      pick-variant-type
    </button>
  ),
}));
vi.mock("../SetSelector/VariantSelector", () => ({
  default: ({ onVariantSelect }: { onVariantSelect: (v: string) => void }) => (
    <button onClick={() => onVariantSelect("variant-1")}>pick-variant</button>
  ),
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
vi.mock("../SetSelector/VariantMetadataEditor", () => ({
  default: () => null,
}));
vi.mock("../SetSelector/ParallelGroupingModal", () => ({
  default: () => null,
}));
vi.mock("../SetSelector/MultiSourcePanel", () => ({ default: () => null }));
vi.mock("../SetSelector/SetAttributesPanel", () => ({ default: () => null }));
vi.mock("../SetSelector/SportForm", () => ({ SportForm: () => null }));

import SetSelector from "./SetSelector";

const pick = (label: string) =>
  fireEvent.click(screen.getByText(`pick-${label}`));

/** The polite region itself, found the way an assistive technology finds it. */
function liveRegion(): HTMLElement {
  const regions = screen
    .getAllByRole("status")
    .filter((el) => el.className.includes("sr-only"));
  expect(regions).toHaveLength(1);
  return regions[0];
}

describe("SetSelector — new-column announcement (NEO-260)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts on the only column that is open", () => {
    render(<SetSelector />);

    // Present from the first paint, which is precisely why it is not announced:
    // a live region reports CHANGES, and this text was there when it mounted.
    expect(liveRegion().textContent).toBe("Sports column opened");
  });

  it("names the column a selection just revealed", () => {
    render(<SetSelector />);

    pick("sport");
    expect(liveRegion().textContent).toBe("Years column opened");

    pick("year");
    expect(liveRegion().textContent).toBe("Manufacturers column opened");

    pick("manufacturer");
    expect(liveRegion().textContent).toBe("Sets column opened");

    pick("set");
    expect(liveRegion().textContent).toBe("Variant Types column opened");
  });

  it("uses the variant column's own heading, which is the variant type's plural", () => {
    render(<SetSelector />);
    pick("sport");
    pick("year");
    pick("manufacturer");
    pick("set");
    pick("variant-type");

    // The column's <h2> reads "Inserts" for an Insert variant type, and the
    // announcement has to be the words the operator will then hear in it.
    expect(liveRegion().textContent).toBe("Inserts column opened");
  });

  it("names only the DEEPEST column, never the whole open chain", () => {
    // Reading the cascade back from the top on every step is what makes a live
    // region unusable; one selection can only reveal one column.
    render(<SetSelector />);
    pick("sport");
    pick("year");

    const text = liveRegion().textContent ?? "";
    expect(text).toBe("Manufacturers column opened");
    expect(text).not.toContain("Sports");
    expect(text).not.toContain("Years column");
  });

  it("says nothing new when a re-render reveals nothing", () => {
    const { rerender } = render(<SetSelector />);
    pick("sport");
    const before = liveRegion().textContent;

    rerender(<SetSelector />);

    // Identical text ⇒ React writes nothing ⇒ no announcement. This is the
    // whole anti-chatter mechanism; there is no dedupe state behind it.
    expect(liveRegion().textContent).toBe(before);
  });

  it("is polite and costs the layout nothing", () => {
    render(<SetSelector />);
    const region = liveRegion();

    // role="status" implies aria-live="polite": worth saying, never
    // interrupting.
    expect(region.getAttribute("role")).toBe("status");
    // `sr-only` is position:absolute, so it is not a flex item of the page's
    // column stack. Height above the cascade pushes fold-sensitive controls off
    // the 1024x629 headless viewport (NEO-47, NEO-155).
    expect(region.className).toContain("sr-only");
  });

  it("cannot be confused with a bare column heading by a flow", () => {
    // Maestro matches `text:` as a FULL-STRING regex, and ~105 flows wait on
    // headings like "Years". A full sentence can never satisfy one of those.
    render(<SetSelector />);
    pick("sport");

    expect(liveRegion().textContent).not.toBe("Years");
    expect(liveRegion().textContent).toMatch(/ column opened$/);
  });
});
