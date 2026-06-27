/**
 * NEO-39 regression guard — unique per-instance field class on the custom-entry
 * input inside EntityColumn.
 *
 * ## Why this test exists
 * Maestro's web driver implements `inputText` by focusing the element, then
 * RE-FINDING it via `window.maestro.createXPathFromElement(activeElement)`.
 * That helper keys off `className` (not aria-label), so when two inputs share
 * an identical Tailwind className the XPath matches BOTH and Selenium types
 * into the FIRST one on the page — wrong column, silent data corruption.
 *
 * The fix (NEO-39): EntityColumn calls `useFieldTestClass()` and spreads the
 * result onto the custom-entry `<input>` as `mb-field-<id>-customvalue`.
 * Because `useId()` returns a stable, instance-unique value, two mounted
 * EntityColumn instances produce two different classes — each XPath resolves
 * to exactly one element.
 *
 * This test guards the fix by asserting:
 *   1. The custom-entry input carries a class matching
 *      `/\bmb-field-[A-Za-z0-9]+-customvalue\b/`.
 *   2. Two independently-mounted instances carry DIFFERENT such classes,
 *      proving the uniqueness guarantee survives future refactors.
 *
 * --- Mocking strategy (mirrors EntityColumn.custom-select.test.tsx) ---
 * convex/react and the generated api are module-mocked so the component
 * renders without a live Convex backend.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      addCustomSelectorOption: "addCustomSelectorOption",
    },
  },
}));

const mockAddCustom = vi.fn();
const mockQuery = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useAction: () => vi.fn(),
  useQuery: () => mockQuery(),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import EntityColumn from "./EntityColumn";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimum props to render a visible EntityColumn with a level (required for
 *  the "+ Custom" button to appear). */
function renderColumn() {
  return render(
    <EntityColumn
      selector={<div>selector</div>}
      renderForm={() => <div>form</div>}
      addButtonText="Sync Sports"
      isVisible={true}
      level="sport"
    />,
  );
}

/** Click "+ Custom" so the custom-entry input becomes visible. */
async function openCustomMode(
  getByText: ReturnType<typeof render>["getByText"],
) {
  await act(async () => {
    fireEvent.click(getByText("+ Custom"));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EntityColumn — unique mb-field-*-customvalue class (NEO-39)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Return undefined so the query appears "loading" — the auto-sync effect
    // guards `if (items === undefined) return`, keeping the column in idle mode
    // so the "+ Custom" button is visible. Returning [] would trigger auto-sync
    // and switch the column to "sync" mode, hiding the idle buttons.
    mockQuery.mockReturnValue(undefined);
    mockAddCustom.mockResolvedValue("some-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("custom-entry input has a class matching /\\bmb-field-[A-Za-z0-9]+-customvalue\\b/", async () => {
    const { getByText, getByPlaceholderText } = renderColumn();

    await openCustomMode(getByText);

    const input = getByPlaceholderText(
      "Enter custom value...",
    ) as HTMLInputElement;

    expect(input.className).toMatch(/\bmb-field-[A-Za-z0-9]+-customvalue\b/);
  });

  it("two separately-mounted instances produce DIFFERENT mb-field-*-customvalue classes", async () => {
    // Render first instance; open custom mode; capture its class.
    const first = render(
      <EntityColumn
        selector={<div>selector-a</div>}
        renderForm={() => <div>form-a</div>}
        addButtonText="Sync Sports"
        isVisible={true}
        level="sport"
      />,
    );

    await act(async () => {
      fireEvent.click(first.getByText("+ Custom"));
    });

    const firstInput = first.getByPlaceholderText(
      "Enter custom value...",
    ) as HTMLInputElement;

    const classPattern = /\bmb-field-[A-Za-z0-9]+-customvalue\b/;
    const firstMatch = firstInput.className.match(classPattern);
    expect(firstMatch).not.toBeNull();
    const firstUniqueClass = firstMatch![0];

    // Unmount first instance so its id is no longer in the DOM.
    first.unmount();

    // Render second instance.
    const second = render(
      <EntityColumn
        selector={<div>selector-b</div>}
        renderForm={() => <div>form-b</div>}
        addButtonText="Sync Sports"
        isVisible={true}
        level="sport"
      />,
    );

    await act(async () => {
      fireEvent.click(second.getByText("+ Custom"));
    });

    const secondInput = second.getByPlaceholderText(
      "Enter custom value...",
    ) as HTMLInputElement;

    const secondMatch = secondInput.className.match(classPattern);
    expect(secondMatch).not.toBeNull();
    const secondUniqueClass = secondMatch![0];

    expect(firstUniqueClass).not.toBe(secondUniqueClass);
  });
});
