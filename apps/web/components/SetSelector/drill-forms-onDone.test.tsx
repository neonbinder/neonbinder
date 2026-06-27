/**
 * NEO-47 regression guard — drill form onDone call-through
 *
 * These tests lock in the fix from commit dc32ec6: the five drill forms now call
 * onDone when the marketplace sync returns ZERO options (success: false,
 * optionsCount/totalSets: 0), not only when success: true.  The previous
 * behaviour hard-blocked the column — the operator could not add a custom entry
 * because onDone was never called after an empty-but-non-throwing sync.
 *
 * Three branches under test for each form:
 *   A. empty result (the bug fix)  → onDone IS called
 *   B. successful result           → onDone IS called (unchanged)
 *   C. thrown exception            → onDone is NOT called; error message shown
 *
 * SetForm (totalSets: 0) is tested separately to cover the different result
 * shape it uses (syncSetsAcrossManufacturers returns totalSets, not optionsCount).
 *
 * --- Mocking strategy ---
 *
 * convex/react is mocked at the module level so:
 *   • useAction  returns a jest fn whose resolved value we control per test
 *   • useQuery   returns a minimal object so the guard in each useEffect fires
 *
 * The convex generated api is mocked as a plain object — the action reference
 * values are only used as useAction keys and are compared by identity; the
 * mock intercepts useAction before it can touch the real Convex runtime.
 *
 * NeonButton is rendered through @radix-ui/themes Button which renders a real
 * <button> in happy-dom, so no additional mocking is needed for it.
 *
 * All forms auto-fire doSync on mount (triggered ref prevents double-fire), so
 * simply rendering + awaiting the next async tick is sufficient to assert on
 * onDone without any user interaction.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports that resolve these paths
// ---------------------------------------------------------------------------

// Convex generated api — we only need the shape to satisfy import; no real
// values are used because useAction is fully mocked below.
vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      fetchAggregatedOptions: "fetchAggregatedOptions",
      syncSetsAcrossManufacturers: "syncSetsAcrossManufacturers",
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
    },
  },
}));

// convex/react — intercepted so no Convex runtime is needed in happy-dom
// useAction and useQuery are replaced with controlled fakes.  Each describe
// block reconfigures mockAction and mockQuery before rendering.
const mockAction = vi.fn();
const mockQuery = vi.fn();

vi.mock("convex/react", () => ({
  useAction: () => mockAction,
  useQuery: () => mockQuery(),
}));

// ---------------------------------------------------------------------------
// Components under test — imported AFTER the mocks are declared above
// ---------------------------------------------------------------------------

import { SportForm } from "./SportForm";
import YearForm from "./YearForm";
import SetForm from "./SetForm";

// ---------------------------------------------------------------------------
// Shared sport option fixture (used by YearForm)
// ---------------------------------------------------------------------------

const SPORT_OPTION = {
  _id: "sport-id-111" as const,
  value: "Baseball",
  level: "sport",
};

// Minimal ancestor chain for forms that use getAncestorChain
const ANCESTOR_CHAIN = [
  { _id: "sport-id-111", value: "Baseball", level: "sport" },
  { _id: "year-id-222", value: "2024", level: "year" },
];

// ---------------------------------------------------------------------------
// SportForm tests (no query, fires immediately on mount)
// ---------------------------------------------------------------------------

describe("SportForm — onDone call-through", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // SportForm does not call useQuery; return undefined is safe
    mockQuery.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call onDone when sync resolves with empty optionsCount (the bug fix)", async () => {
    const onDone = vi.fn();
    mockAction.mockResolvedValue({
      success: false,
      message: "No sport options returned from any marketplace",
      optionsCount: 0,
    });

    await act(async () => {
      render(<SportForm onDone={onDone} />);
    });

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledOnce();
    });
  });

  it("should call onDone when sync resolves with success: true", async () => {
    const onDone = vi.fn();
    mockAction.mockResolvedValue({
      success: true,
      message: "Synced 5 sport options",
      optionsCount: 5,
    });

    await act(async () => {
      render(<SportForm onDone={onDone} />);
    });

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledOnce();
    });
  });

  it("should NOT call onDone and should show an Error message when sync throws", async () => {
    const onDone = vi.fn();
    mockAction.mockRejectedValue(new Error("Network failure"));

    await act(async () => {
      render(<SportForm onDone={onDone} />);
    });

    // Give the async error path time to settle
    await waitFor(() => {
      expect(screen.getByText(/Error: Network failure/)).toBeTruthy();
    });

    expect(onDone).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// YearForm tests (uses useQuery(getSelectorOptionById) to guard the effect)
// ---------------------------------------------------------------------------

describe("YearForm — onDone call-through", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call onDone when sync resolves with empty optionsCount (the bug fix)", async () => {
    const onDone = vi.fn();
    // Seed the query result so the useEffect guard fires
    mockQuery.mockReturnValue(SPORT_OPTION);
    mockAction.mockResolvedValue({
      success: false,
      message: "No year options returned from any marketplace",
      optionsCount: 0,
    });

    await act(async () => {
      render(
        <YearForm sportId={"sport-id-111" as unknown as Parameters<typeof YearForm>[0]["sportId"]} onDone={onDone} />,
      );
    });

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledOnce();
    });
  });

  it("should call onDone when sync resolves with success: true", async () => {
    const onDone = vi.fn();
    mockQuery.mockReturnValue(SPORT_OPTION);
    mockAction.mockResolvedValue({
      success: true,
      message: "Synced 4 year options",
      optionsCount: 4,
    });

    await act(async () => {
      render(
        <YearForm sportId={"sport-id-111" as unknown as Parameters<typeof YearForm>[0]["sportId"]} onDone={onDone} />,
      );
    });

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledOnce();
    });
  });

  it("should NOT call onDone and should show an Error message when sync throws", async () => {
    const onDone = vi.fn();
    mockQuery.mockReturnValue(SPORT_OPTION);
    mockAction.mockRejectedValue(new Error("BSC timeout"));

    await act(async () => {
      render(
        <YearForm sportId={"sport-id-111" as unknown as Parameters<typeof YearForm>[0]["sportId"]} onDone={onDone} />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Error: BSC timeout/)).toBeTruthy();
    });

    expect(onDone).not.toHaveBeenCalled();
  });

  it("should NOT fire sync when sportOption query returns undefined (data not yet loaded)", async () => {
    const onDone = vi.fn();
    // Simulates the initial render tick before Convex delivers data
    mockQuery.mockReturnValue(undefined);
    mockAction.mockResolvedValue({ success: true, message: "", optionsCount: 0 });

    await act(async () => {
      render(
        <YearForm sportId={"sport-id-111" as unknown as Parameters<typeof YearForm>[0]["sportId"]} onDone={onDone} />,
      );
    });

    // doSync guard: `if (sportOption && !triggered.current)` — skips when undefined
    expect(mockAction).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SetForm tests — uses totalSets (different result shape from the other forms)
// ---------------------------------------------------------------------------

describe("SetForm — onDone call-through (totalSets shape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call onDone when syncSets resolves with totalSets: 0 (the bug fix)", async () => {
    const onDone = vi.fn();
    // SetForm reads yearId from ancestorChain; provide a chain with sport + year
    mockQuery.mockReturnValue(ANCESTOR_CHAIN);
    mockAction.mockResolvedValue({
      success: false,
      message: "No sets found for Baseball 2024",
      totalSets: 0,
    });

    await act(async () => {
      render(
        <SetForm manufacturerId={"manufacturer-id-333" as unknown as Parameters<typeof SetForm>[0]["manufacturerId"]} onDone={onDone} />,
      );
    });

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledOnce();
    });
  });

  it("should call onDone when syncSets resolves with success: true", async () => {
    const onDone = vi.fn();
    mockQuery.mockReturnValue(ANCESTOR_CHAIN);
    mockAction.mockResolvedValue({
      success: true,
      message: "Synced 12 sets",
      totalSets: 12,
    });

    await act(async () => {
      render(
        <SetForm manufacturerId={"manufacturer-id-333" as unknown as Parameters<typeof SetForm>[0]["manufacturerId"]} onDone={onDone} />,
      );
    });

    await waitFor(() => {
      expect(onDone).toHaveBeenCalledOnce();
    });
  });

  it("should NOT call onDone and should show an Error message when syncSets throws", async () => {
    const onDone = vi.fn();
    mockQuery.mockReturnValue(ANCESTOR_CHAIN);
    mockAction.mockRejectedValue(new Error("BSC API error"));

    await act(async () => {
      render(
        <SetForm manufacturerId={"manufacturer-id-333" as unknown as Parameters<typeof SetForm>[0]["manufacturerId"]} onDone={onDone} />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Error: BSC API error/)).toBeTruthy();
    });

    expect(onDone).not.toHaveBeenCalled();
  });

  it("should NOT fire sync when ancestor chain returns undefined (data not yet loaded)", async () => {
    const onDone = vi.fn();
    // yearId is derived from ancestorChain; undefined chain means yearId is undefined
    mockQuery.mockReturnValue(undefined);
    mockAction.mockResolvedValue({ success: true, message: "", totalSets: 0 });

    await act(async () => {
      render(
        <SetForm manufacturerId={"manufacturer-id-333" as unknown as Parameters<typeof SetForm>[0]["manufacturerId"]} onDone={onDone} />,
      );
    });

    // doSync guard: `if (!yearId) return` — yearId undefined because chain undefined
    expect(mockAction).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
