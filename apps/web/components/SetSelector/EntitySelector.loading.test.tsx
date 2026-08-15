/**
 * NEO-167 — the column heading must survive an in-flight read.
 *
 * ## Why this test exists
 *
 * `EntitySelector` used to return `<div>Loading {title}...</div>` while
 * `getSelectorOptions` was in flight, which removed the column's identity text
 * from the DOM for the duration. Maestro matches a selector as a FULL-STRING
 * regex, so `visible: "Variant Types"` cannot match "Loading variant types…" —
 * every flow asserting on a column heading failed outright on a slow read even
 * though the app was working correctly (CI run 31839119469).
 *
 * ## The invariant, and why it has two halves
 *
 * The heading is absent in two distinct situations, and the fix must change
 * exactly one of them:
 *
 *   1. **Column not open** — `EntityColumn` returns `null` on `!isVisible`.
 *      Flows depend on this: the drill utils use heading visibility to detect
 *      that a selection opened the NEXT column, via
 *      `when: notVisible: "<Level>"` guards that prevent a second tap from
 *      re-toggling and deselecting the row. If the heading ever rendered while
 *      the column was closed, those guards would be permanently false and the
 *      drill would silently stop progressing — a dead branch, not a loud
 *      failure, which is why it is pinned here rather than left to review.
 *
 *   2. **Column open, read in flight** — the heading must now be present.
 *
 * Both halves are asserted below. A future refactor that hoists the heading
 * above the `isVisible` gate would satisfy (2) and break (1); only testing
 * both catches that.
 */

import { render } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      getSelectorSyncStatus: "getSelectorSyncStatus",
      addCustomSelectorOption: "addCustomSelectorOption",
      ensureSelectorOptions: "ensureSelectorOptions",
    },
  },
}));

const mockQuery = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvex: () => ({ connectionState: () => null }),
  useQuery: () => mockQuery(),
}));

import EntitySelector from "./EntitySelector";
import EntityColumn from "./EntityColumn";

type Item = { _id: string; value: string };

function renderSelector() {
  return render(
    <EntitySelector
      title="Variant Types"
      query={"getSelectorOptions" as never}
      queryArgs={{ level: "variantType" } as never}
      selectedId={undefined}
      onSelect={vi.fn()}
      expanded={true}
      setExpanded={vi.fn()}
      getDisplayName={(i: Item) => i.value}
      selectedColor="bg-blue-500"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EntitySelector — heading survives an in-flight read (NEO-167)", () => {
  it("renders the heading while the read is still loading", () => {
    mockQuery.mockReturnValue(undefined); // subscription hasn't delivered yet

    const { getByRole } = renderSelector();

    // The exact thing Maestro asserts on. Before NEO-167 this was absent and
    // the DOM held only "Loading variant types...".
    expect(
      getByRole("heading", { name: "Variant Types" }),
    ).toBeTruthy();
  });

  it("marks the loading column busy and shows a skeleton, not a bare string", () => {
    mockQuery.mockReturnValue(undefined);

    const { container, getByRole } = renderSelector();

    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    // Announced to assistive tech, since the visible text no longer says so.
    const skeleton = getByRole("status", { name: /loading variant types/i });
    expect(skeleton).toBeTruthy();
    expect(skeleton.children.length).toBeGreaterThan(0);

    // The skeleton must not animate. An infinite CSS animation on this admin
    // screen is a standing risk to Maestro's coordinate taps (cf. NEO-85), and
    // it buys nothing the aria-label does not already convey. Pinned so a
    // future "add a nice shimmer" reintroduces it deliberately, not casually.
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });

  it("keeps the same heading once the data lands", () => {
    mockQuery.mockReturnValue([{ _id: "vt1", value: "Base" }]);

    const { getByRole, getByText, container } = renderSelector();

    // Same accessible heading in both states — that stability is the point:
    // an assertion on it can no longer flip false purely on read latency.
    expect(getByRole("heading", { name: "Variant Types" })).toBeTruthy();
    expect(getByText("Base")).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });

  it("does NOT leak the heading when the column is closed", () => {
    // Half (1) of the invariant. `isVisible: false` must render nothing at
    // all, or every `notVisible: "<Level>"` drill guard goes permanently false
    // and the drill utils stop advancing without ever failing loudly.
    mockQuery.mockReturnValue(undefined);

    const { container, queryByText } = render(
      <EntityColumn
        selector={<EntitySelector
          title="Variant Types"
          query={"getSelectorOptions" as never}
          queryArgs={{ level: "variantType" } as never}
          selectedId={undefined}
          onSelect={vi.fn()}
          expanded={true}
          setExpanded={vi.fn()}
          getDisplayName={(i: Item) => i.value}
          selectedColor="bg-blue-500"
        />}
        renderForm={() => <div>form</div>}
        addButtonText="Sync Variant Types"
        isVisible={false}
        level="variantType"
      />,
    );

    expect(container.textContent).toBe("");
    expect(queryByText("Variant Types")).toBeNull();
  });
});
