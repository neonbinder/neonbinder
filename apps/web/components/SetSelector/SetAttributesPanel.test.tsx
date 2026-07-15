/**
 * NEO-71–74 regression coverage — SetAttributesPanel write-once feature
 * snapshots.
 *
 * This redesign made every `selectorOptions` row's `features` map a
 * COMPLETE, self-contained snapshot computed once at row-creation time (see
 * `convex/features/deriveCardFeatures.ts`). There is deliberately no
 * client-side ancestor-walk/inheritance computation left in the panel — it
 * reads `row.features[key]` directly. This file locks in:
 *
 *   1. Feature values render directly from `row.features[key]` — no
 *      "Inherited from X" text anywhere (that UI was deleted this session).
 *   2. The `applicable` filter honors the new `applicableAtLevels` field:
 *      `cardType`/`parallelName` (both scoped to
 *      ["variantType","insert","parallel"]) are absent at
 *      sport/year/manufacturer/setName and present at
 *      variantType/insert/parallel.
 *   3. `applicableSports` filtering still works (League hidden for Pokemon).
 *   4. Editing a feature calls `setSelectorOptionFeature(selectorOptionId,
 *      key, value)` and shows a "Saved {label}" toast — no "propagated to N
 *      cards" language (that no longer exists; propagation was removed).
 *   5. There is no "missing"/required warning treatment anywhere — none of
 *      these fields are actually required, so a blank row renders exactly
 *      like a filled-in one (the old amber border/⚠ icon/"N missing" badge
 *      were removed this session).
 *
 * releaseDate/totalCardCount/block used to live in a separate `setMetadata`
 * object editable only at the setName level (a since-removed `setSetMetadata`
 * mutation). They're now plain features like everything else — this file no
 * longer mocks that mutation at all.
 *
 * --- Mocking strategy (mirrors EntityColumn.field-class.test.tsx /
 * drill-forms-onDone.test.tsx) ---
 * convex/react's useQuery/useMutation are module-mocked. useQuery is routed
 * by the (string-mocked) query reference so getSelectorOptionById and
 * getAncestorChain can return independently-controlled fixtures per test.
 * useMutation is routed the same way so setSelectorOptionFeature resolves to
 * a spy.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      setSelectorOptionFeature: "setSelectorOptionFeature",
    },
  },
}));

const mockSetSelectorOptionFeature = vi.fn();

let currentRow: unknown;
let currentChain: unknown;

vi.mock("convex/react", () => ({
  useQuery: (query: string) => {
    if (query === "getSelectorOptionById") return currentRow;
    if (query === "getAncestorChain") return currentChain;
    return undefined;
  },
  useMutation: (mutation: string) => {
    if (mutation === "setSelectorOptionFeature")
      return mockSetSelectorOptionFeature;
    return vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import SetAttributesPanel from "./SetAttributesPanel";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SELECTOR_OPTION_ID = "selector-option-id-1" as unknown as Parameters<
  typeof SetAttributesPanel
>[0]["selectorOptionId"];

function makeRow(overrides: Partial<{
  level: string;
  value: string;
  features: Record<string, string>;
}> = {}) {
  return {
    _id: SELECTOR_OPTION_ID,
    level: "setName",
    value: "2024 Topps Chrome",
    features: {},
    ...overrides,
  };
}

function makeChain(sport = "Baseball") {
  return [
    { _id: "sport-id", value: sport, level: "sport" },
    { _id: "year-id", value: "2024", level: "year" },
    { _id: "mfr-id", value: "Topps", level: "manufacturer" },
    { _id: "set-id", value: "2024 Topps Chrome", level: "setName" },
  ];
}

function renderPanel() {
  return render(
    <SetAttributesPanel
      selectorOptionId={SELECTOR_OPTION_ID}
      defaultCollapsed={false}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SetAttributesPanel — write-once feature snapshot reads (NEO-71-74)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSelectorOptionFeature.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a row's own features[key] directly, with no 'Inherited' text anywhere", () => {
    currentRow = makeRow({
      level: "setName",
      features: { league: "MLB", era: "Modern (1980-Now)", manufacturer: "Topps" },
    });
    currentChain = makeChain("Baseball");

    renderPanel();

    // League select shows the row's own value.
    const leagueSelect = screen.getByLabelText(
      "Value for League",
    ) as HTMLSelectElement;
    expect(leagueSelect.value).toBe("MLB");

    const eraSelect = screen.getByLabelText("Value for Era") as HTMLSelectElement;
    expect(eraSelect.value).toBe("Modern (1980-Now)");

    // The deleted inheritance-hint UI must never appear.
    expect(screen.queryByText(/Inherited/i)).toBeNull();
  });

  it("does NOT render Card Type or Parallel/Variety rows at sport/year/manufacturer/setName levels", () => {
    for (const level of ["sport", "year", "manufacturer", "setName"]) {
      currentRow = makeRow({ level, value: `node-${level}`, features: {} });
      currentChain = makeChain("Baseball");

      const { unmount } = renderPanel();

      expect(screen.queryByLabelText("Set feature Card Type")).toBeNull();
      expect(screen.queryByLabelText("Set feature Parallel/Variety")).toBeNull();

      unmount();
    }
  });

  it("DOES render Card Type and Parallel/Variety rows at variantType/insert/parallel levels", () => {
    for (const level of ["variantType", "insert", "parallel"]) {
      currentRow = makeRow({
        level,
        value: `node-${level}`,
        features: { cardType: "Base", parallelName: "Gold" },
      });
      currentChain = makeChain("Baseball");

      const { unmount } = renderPanel();

      expect(screen.getByLabelText("Set feature Card Type")).toBeTruthy();
      expect(screen.getByLabelText("Set feature Parallel/Variety")).toBeTruthy();
      expect(
        (screen.getByLabelText("Value for Card Type") as HTMLInputElement).value,
      ).toBe("Base");
      expect(
        (screen.getByLabelText("Value for Parallel/Variety") as HTMLInputElement)
          .value,
      ).toBe("Gold");

      unmount();
    }
  });

  it("hides League for a non stick-and-ball sport (Pokemon) via applicableSports + ancestorSport", () => {
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Pokemon");

    renderPanel();

    expect(screen.queryByLabelText("Set feature League")).toBeNull();
    // Era has no applicableSports restriction — still shows for Pokemon.
    expect(screen.getByLabelText("Set feature Era")).toBeTruthy();
  });

  it("shows League for a stick-and-ball sport (Baseball)", () => {
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    renderPanel();

    expect(screen.getByLabelText("Set feature League")).toBeTruthy();
  });

  it("calls setSelectorOptionFeature(selectorOptionId, key, value) and shows a 'Saved {label}' toast on edit, without any propagation language", async () => {
    currentRow = makeRow({
      level: "setName",
      features: { signedBy: "" },
    });
    currentChain = makeChain("Baseball");

    renderPanel();

    const signedByInput = screen.getByLabelText(
      "Value for Signed By",
    ) as HTMLInputElement;

    await act(async () => {
      // Real focus() + synthetic focus (sets both document.activeElement and
      // the hook's internal focusedRef — see useReactiveField.test.tsx).
      signedByInput.focus();
      fireEvent.focus(signedByInput);
      signedByInput.value = "Mike Trout";
      fireEvent.input(signedByInput, { target: { value: "Mike Trout" } });
      signedByInput.blur();
      fireEvent.blur(signedByInput);
    });

    await waitFor(() => {
      expect(mockSetSelectorOptionFeature).toHaveBeenCalledWith({
        selectorOptionId: SELECTOR_OPTION_ID,
        key: "signedBy",
        value: "Mike Trout",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Saved Signed By")).toBeTruthy();
    });

    // The old propagation-count toast copy must never appear.
    expect(screen.queryByText(/propagated/i)).toBeNull();
    expect(screen.queryByText(/updated \d+ cards/i)).toBeNull();
  });

  it("never shows a missing-count badge or amber warning, even with every field blank", () => {
    // None of these fields are required — a totally blank row (nothing set
    // at all) must render with no "N missing" badge and no amber/⚠
    // treatment on any row, collapsed or expanded.
    currentRow = makeRow({ level: "setName", features: {} });
    currentChain = makeChain("Baseball");

    const { unmount } = render(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed={true}
      />,
    );
    expect(screen.queryByText(/\d+ missing/i)).toBeNull();
    unmount();

    render(
      <SetAttributesPanel
        selectorOptionId={SELECTOR_OPTION_ID}
        defaultCollapsed={false}
      />,
    );
    expect(screen.queryByText(/\d+ missing/i)).toBeNull();
    expect(screen.queryByLabelText("Missing required feature")).toBeNull();
    expect(screen.queryByText("⚠")).toBeNull();
  });
});
