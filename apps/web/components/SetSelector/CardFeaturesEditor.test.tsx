/**
 * NEO-71–74 regression coverage — CardFeaturesEditor write-once feature
 * snapshots.
 *
 * This session deleted the `getAncestorChain` query, the `inheritedByKey`
 * computation, and the "Revert to inherited" button from this component.
 * `cardFeatures` (the `cardChecklist` row's own `features` map) is now
 * already the complete resolved snapshot — computed once via copy-down at
 * card-creation time — so the editor reads `cardFeatures[key]` directly with
 * no fallback. This file locks in:
 *
 *   1. A card's own `features[key]` renders directly.
 *   2. Blank means blank — no inherited fallback is substituted when a key
 *      is absent from `cardFeatures`.
 *   3. There is no "revert to inherited" affordance anywhere in the
 *      rendered output.
 *   4. Editing a text/select feature calls `setCardFeature({
 *      cardChecklistId, key, value })`.
 *   5. The boolean "Rookie Card" row is bound to the typed `cardIsRookie`
 *      column (not the features map) and calls `updateCard({ id, isRookie })`.
 *   6. `applicableSports` filtering still works from the `ancestorSport` prop.
 *   7. There is no "missing"/required warning treatment anywhere — none of
 *      these fields are actually required (the old amber border/⚠ icon
 *      were removed this session).
 *
 * --- Mocking strategy (mirrors SetAttributesPanel.test.tsx) ---
 * convex/react's useMutation is module-mocked, routed by the (string-mocked)
 * mutation reference so setCardFeature and updateCard resolve to distinct
 * spies. This component does not call useQuery.
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
      setCardFeature: "setCardFeature",
      updateCard: "updateCard",
    },
  },
}));

const mockSetCardFeature = vi.fn();
const mockUpdateCard = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: (mutation: string) => {
    if (mutation === "setCardFeature") return mockSetCardFeature;
    if (mutation === "updateCard") return mockUpdateCard;
    return vi.fn();
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import CardFeaturesEditor from "./CardFeaturesEditor";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const CARD_CHECKLIST_ID = "card-checklist-id-1" as unknown as Parameters<
  typeof CardFeaturesEditor
>[0]["cardChecklistId"];

function renderEditor(
  props: Partial<Parameters<typeof CardFeaturesEditor>[0]> = {},
) {
  const utils = render(
    <CardFeaturesEditor
      cardChecklistId={CARD_CHECKLIST_ID}
      cardFeatures={{}}
      ancestorSport="Baseball"
      cardIsRookie={false}
      {...props}
    />,
  );
  // The editor is collapsed by default — expand it so the rows are visible.
  fireEvent.click(utils.getByLabelText("Show features editor"));
  return utils;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CardFeaturesEditor — write-once feature snapshot reads (NEO-71-74)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetCardFeature.mockResolvedValue(undefined);
    mockUpdateCard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the card's own features[key] directly", () => {
    renderEditor({
      cardFeatures: { signedBy: "Mike Trout", isRelic: "true" },
    });

    expect(
      (screen.getByLabelText("Value for Signed By") as HTMLInputElement).value,
    ).toBe("Mike Trout");
    // Memorabilia Relic is a "checkbox" feature (true/false string in the
    // features map), rendered as a toggle-pill button — assert
    // aria-pressed, not a checkbox's .checked (it's not an <input> anymore).
    expect(
      screen.getByLabelText("Value for Memorabilia Relic").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
  });

  it("renders blank when a key is absent from cardFeatures — no inherited fallback, no missing warning", () => {
    renderEditor({ cardFeatures: {} });

    const signedByInput = screen.getByLabelText(
      "Value for Signed By",
    ) as HTMLInputElement;
    expect(signedByInput.value).toBe("");
    // None of these fields are required — a blank value must never show
    // the (now-removed) missing-feature warning affordance.
    expect(screen.queryByLabelText("Missing required feature")).toBeNull();
    expect(screen.queryByText("⚠")).toBeNull();
  });

  it("renders blank when cardFeatures is undefined entirely", () => {
    renderEditor({ cardFeatures: undefined });

    const signedByInput = screen.getByLabelText(
      "Value for Signed By",
    ) as HTMLInputElement;
    expect(signedByInput.value).toBe("");
  });

  it("never renders a 'revert to inherited' affordance", () => {
    renderEditor({ cardFeatures: { signedBy: "Mike Trout" } });

    expect(screen.queryByText(/revert/i)).toBeNull();
    expect(screen.queryByLabelText(/revert/i)).toBeNull();
    expect(screen.queryByText(/inherited/i)).toBeNull();
  });

  it("calls setCardFeature({ cardChecklistId, key, value }) when a text feature is edited", async () => {
    renderEditor({ cardFeatures: { signedBy: "" } });

    const signedByInput = screen.getByLabelText(
      "Value for Signed By",
    ) as HTMLInputElement;

    await act(async () => {
      signedByInput.focus();
      fireEvent.focus(signedByInput);
      signedByInput.value = "Mike Trout";
      fireEvent.input(signedByInput, { target: { value: "Mike Trout" } });
      signedByInput.blur();
      fireEvent.blur(signedByInput);
    });

    await waitFor(() => {
      expect(mockSetCardFeature).toHaveBeenCalledWith({
        cardChecklistId: CARD_CHECKLIST_ID,
        key: "signedBy",
        value: "Mike Trout",
      });
    });
  });

  it("Rookie Card checkbox reflects cardIsRookie and calls updateCard({ id, isRookie }) on toggle, bypassing the features map", async () => {
    renderEditor({ cardFeatures: { isRookie: "ignored-value" }, cardIsRookie: false });

    const checkbox = screen.getByLabelText(
      "Value for Rookie Card",
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      expect(mockUpdateCard).toHaveBeenCalledWith({
        id: CARD_CHECKLIST_ID,
        isRookie: true,
      });
    });
    // The boolean row never touches setCardFeature.
    expect(mockSetCardFeature).not.toHaveBeenCalled();
  });

  it("hides League when ancestorSport is a non stick-and-ball sport (Pokemon)", () => {
    renderEditor({ cardFeatures: {}, ancestorSport: "Pokemon" });

    expect(screen.queryByLabelText("Feature League")).toBeNull();
  });

  it("shows League when ancestorSport is a stick-and-ball sport (Baseball)", () => {
    renderEditor({ cardFeatures: {}, ancestorSport: "Baseball" });

    expect(screen.getByLabelText("Feature League")).toBeTruthy();
  });
});
