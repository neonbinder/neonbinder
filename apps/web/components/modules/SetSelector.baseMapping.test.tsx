/**
 * NEO-255 — the Base mapping panel's Close is honest, and there is a way back in.
 *
 * THE BUG (diagnosed in a real browser on a set whose Base carries a BSC id and
 * no SportLots one): `baseHasMapping` counts the SportLots slot ONLY, so on
 * that row it is false forever. The panel was rendered whenever
 * `!baseHasMapping`, and the recovery panel's Close only cleared
 * `baseMappingOpen` — a piece of state that row was never gated on. So Close
 * did nothing: the picker auto-opened on every visit, and cancelling it left a
 * ~100px recovery panel the operator could not dismiss, eating the scroll slack
 * the controls below it needed.
 *
 * What this file locks in, all from the PARENT's side (the gating lives in
 * `components/modules/SetSelector.tsx`, not in BaseMappingForm):
 *   1. An unmapped Base still auto-prompts on selection, in `initial` mode.
 *   2. Close hides the panel and leaves a "Map Base Set" button in its place —
 *      the way back in, since the row will never satisfy `baseHasMapping`.
 *   3. Re-opening from that button is still a FIRST-TIME mapping (`initial`),
 *      not a `remap`: mode follows the row, not the button. A `remap` dialog
 *      would show "N cards are linked" impact copy for a mapping that does not
 *      exist.
 *   4. Changing the variant-type selection re-arms the prompt, so the
 *      dismissal reads as "not right now" rather than "never".
 *   5. A MAPPED Base is unchanged: no panel, a secondary "Re-map Base" button,
 *      and that button opens the dialog in `remap` mode.
 *   6. WCAG 2.4.3: the click that unmounts the panel lands focus on the button
 *      that replaced it — and never takes focus off an operator already
 *      holding it elsewhere.
 *
 * --- Mocking strategy ---
 * The page is a 7-column cascade whose children each hold their own Convex
 * subscriptions, and none of that is under test here. Every child module is
 * replaced with a stub, so only SetSelector's own gating renders:
 *   • ResilientEntityColumn renders its `selector` unconditionally, which lets
 *     a test drive the variant-type column without walking sport → set first.
 *   • SetVariantSelector exposes one button per fixture row, wired to the real
 *     `onVariantTypeSelect` — the same handler the real column calls.
 *   • BaseMappingForm reports the `mode` it was handed and offers a Close that
 *     calls the real `onClose` prop. The picker/message-panel behaviour inside
 *     it is covered by components/SetSelector/BaseMappingForm.test.tsx.
 * `useQuery` is routed by reference string and answers `getSelectorOptionById`
 * from a fixture table keyed by id, so `baseHasMapping` is computed by the real
 * `slotIds` against a real slot map.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fixture rows — read through the REAL platformSlots/baseRole helpers
// ---------------------------------------------------------------------------

/**
 * The row from the bug report: a Base with a BSC id and NO SportLots id, so
 * `baseHasMapping` is false and stays false however many times the panel is
 * opened. This is the only row shape that can reach the stuck state.
 */
const BASE_UNMAPPED = {
  _id: "vt-base",
  value: "Base",
  metadata: { isBase: true },
  platformData: { bsc: { b0: "topps-206" } },
};

/** A Base that IS mapped on SportLots — the pre-NEO-255 happy path. */
const BASE_MAPPED = {
  _id: "vt-base-mapped",
  value: "Base",
  metadata: { isBase: true },
  platformData: { sportlots: { s0: "884412" } },
};

/** A non-Base variant type: selecting it takes the whole block off screen. */
const INSERT_ROW = {
  _id: "vt-insert",
  value: "Insert",
  metadata: {},
  platformData: {},
};

const ROWS: Record<string, unknown> = {
  "vt-base": BASE_UNMAPPED,
  "vt-base-mapped": BASE_MAPPED,
  "vt-insert": INSERT_ROW,
};

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

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
    if (ref === "getSelectorOptionById") {
      const id = (args as { id: string } | undefined)?.id;
      return id ? ROWS[id] : undefined;
    }
    if (ref === "getAncestorChain") return [];
    return undefined;
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

// The BSC source view is only reached through the card-checklist chips, which
// are not under test; an empty source list keeps the memo off the fixtures.
vi.mock("../../convex/bscFacets", () => ({
  bscSourceView: () => ({ sources: [] }),
}));

// Columns render their selector unconditionally so a test can reach the
// variant-type column without drilling the four levels above it.
vi.mock("../SetSelector/ResilientEntityColumn", () => ({
  default: ({ selector }: { selector: React.ReactNode }) => <div>{selector}</div>,
}));

vi.mock("../SetSelector/SetVariantSelector", () => ({
  default: ({
    onVariantTypeSelect,
  }: {
    onVariantTypeSelect: (id: string) => void;
  }) => (
    <div>
      {Object.keys(ROWS).map((id) => (
        <button key={id} onClick={() => onVariantTypeSelect(id)}>
          {`select-${id}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../SetSelector/BaseMappingForm", () => ({
  default: ({ mode, onClose }: { mode: string; onClose: () => void }) => (
    <div>
      <span>{`base-mapping-panel mode=${mode}`}</span>
      <button onClick={onClose}>panel-close</button>
    </div>
  ),
}));

// Everything else on the page renders nothing: an inline factory per module,
// because vi.mock is hoisted above any shared helper a test file declares.

vi.mock("../SetSelector/SportSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/YearSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/ManufacturerSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/SetSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/VariantSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelSelector", () => ({ default: () => null }));
vi.mock("../SetSelector/YearForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ManufacturerForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SetForm", () => ({ default: () => null }));
vi.mock("../SetSelector/SetVariantForm", () => ({ default: () => null }));
vi.mock("../SetSelector/VariantForm", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelForm", () => ({ default: () => null }));
vi.mock("../SetSelector/CardChecklist", () => ({ default: () => null }));
vi.mock("../SetSelector/VariantMetadataEditor", () => ({ default: () => null }));
vi.mock("../SetSelector/ParallelGroupingModal", () => ({ default: () => null }));
vi.mock("../SetSelector/MultiSourcePanel", () => ({ default: () => null }));
vi.mock("../SetSelector/SetAttributesPanel", () => ({ default: () => null }));
vi.mock("../SetSelector/SportForm", () => ({ SportForm: () => null }));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import SetSelector from "./SetSelector";

const selectVariantType = (id: string) =>
  fireEvent.click(screen.getByText(`select-${id}`));

const panelMode = () =>
  screen.queryByText(/^base-mapping-panel mode=/)?.textContent ?? null;

describe("SetSelector — Base mapping panel gating (NEO-255)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-prompts an unmapped Base in initial mode", () => {
    render(<SetSelector />);
    selectVariantType("vt-base");

    expect(panelMode()).toBe("base-mapping-panel mode=initial");
    expect(screen.queryByText("Map Base Set")).toBeNull();
  });

  it("Close hides the panel and leaves the way back in", () => {
    render(<SetSelector />);
    selectVariantType("vt-base");
    fireEvent.click(screen.getByText("panel-close"));

    // The actual bug: the row can never satisfy `baseHasMapping`, so before
    // this fix the panel simply re-rendered and Close read as broken.
    expect(panelMode()).toBeNull();
    expect(screen.getByText("Map Base Set")).toBeTruthy();
    // "Re-map Base" would be a lie about a row that holds no mapping.
    expect(screen.queryByText("Re-map Base")).toBeNull();
  });

  it("parks focus on the button that replaced the panel", () => {
    render(<SetSelector />);
    selectVariantType("vt-base");
    // fireEvent.click does not move focus, so this is the real starting point:
    // the browser has nowhere to put focus once the panel unmounts.
    expect(document.activeElement).toBe(document.body);

    fireEvent.click(screen.getByText("panel-close"));

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Map Base Set" }),
    );
  });

  it("does not steal focus the operator is already holding", () => {
    render(<SetSelector />);
    selectVariantType("vt-base");
    // A control OUTSIDE the swapped subtree, so it survives the unmount.
    const held = screen.getByText("select-vt-insert");
    held.focus();

    fireEvent.click(screen.getByText("panel-close"));

    expect(screen.getByRole("button", { name: "Map Base Set" })).toBeTruthy();
    expect(document.activeElement).toBe(held);
  });

  it("re-opening from that button is still a first-time mapping", () => {
    render(<SetSelector />);
    selectVariantType("vt-base");
    fireEvent.click(screen.getByText("panel-close"));
    fireEvent.click(screen.getByText("Map Base Set"));

    expect(panelMode()).toBe("base-mapping-panel mode=initial");
    expect(screen.queryByText("Map Base Set")).toBeNull();
  });

  it("changing the variant-type selection re-arms the auto-open", () => {
    render(<SetSelector />);
    selectVariantType("vt-base");
    fireEvent.click(screen.getByText("panel-close"));
    expect(panelMode()).toBeNull();

    // Base is terminal, so a non-Base selection takes the whole block away.
    selectVariantType("vt-insert");
    expect(panelMode()).toBeNull();
    expect(screen.queryByText("Map Base Set")).toBeNull();

    // Back on Base the question is asked again — the dismissal said "not right
    // now", not "never".
    selectVariantType("vt-base");
    expect(panelMode()).toBe("base-mapping-panel mode=initial");
  });

  it("leaves a mapped Base on the Re-map path", () => {
    render(<SetSelector />);
    selectVariantType("vt-base-mapped");

    expect(panelMode()).toBeNull();
    expect(screen.getByText("Re-map Base")).toBeTruthy();

    fireEvent.click(screen.getByText("Re-map Base"));
    expect(panelMode()).toBe("base-mapping-panel mode=remap");
  });
});
