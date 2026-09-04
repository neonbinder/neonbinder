/**
 * NEO-71-74 regression coverage — BaseMappingForm cancel-recovery fix.
 *
 * Bug (user-reported): clicking Cancel on the BaseSetPicker modal previously
 * called `setPickerOpen(false); onClose();` with zero recovery UI. Because
 * the parent (`components/modules/SetSelector.tsx`) doesn't change this
 * component's React `key` on cancel, the SAME instance persists — and its
 * internal `triggered` ref (a `useRef(false)` guarding the auto-sync
 * `useEffect`) stays permanently tripped, so the component silently renders
 * nothing on every future visit. The parent's "Re-map Base" button doesn't
 * save the day either, since it's gated on `baseHasMapping`
 * (platformData.sportlots being set) — never true for a cancelled picker.
 *
 * The fix reuses the existing terminal "message panel + Retry/Close" pattern
 * (previously only used for error/no-data states) for the cancel case too:
 * the picker's `onClose` now sets a message instead of calling the parent's
 * `onClose` prop, and Retry (which re-runs the idempotent `doSync`) is now
 * shown unconditionally instead of only for error messages.
 *
 * This file locks in:
 *   1. autoOpen=true + fetchRawOptions resolving with SL options → the
 *      picker (BaseSetPicker) renders on mount.
 *   2. Clicking Cancel on the picker shows a message panel with /cancelled/i
 *      text and does NOT call the parent's onClose prop (the actual bug).
 *   3. From the cancelled state, clicking Retry re-runs fetchRawOptions (a
 *      second call) and reopens the picker — the core regression test
 *      proving the dead end is fixed.
 *   4. From the cancelled state, clicking Close DOES call the parent's
 *      onClose prop.
 *   5. The pre-existing "no SL options, BSC auto-take" success path and the
 *      "no data on either platform" fallback path(s) still terminate in a
 *      message panel (unchanged behavior, guarding against regressions from
 *      the Retry-button change).
 *
 * --- Mocking strategy (mirrors EntityColumn.ensure-sync.test.tsx, which
 * also combines useAction + useMutation + useQuery) ---
 * convex/react's useAction/useMutation/useQuery are module-mocked, routed by
 * the (string-mocked) action/mutation/query reference so fetchRawOptions,
 * setVariantTypePlatformData, and getAncestorChain resolve/return
 * independently-controlled fixtures per test.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    setReconciliation: {
      fetchRawOptions: "fetchRawOptions",
    },
    selectorOptions: {
      setVariantTypePlatformData: "setVariantTypePlatformData",
      getAncestorChain: "getAncestorChain",
      getSelectorOptionById: "getSelectorOptionById",
      getSlotCardCounts: "getSlotCardCounts",
    },
  },
}));

const mockFetchRawOptions = vi.fn();
const mockSetPlatformData = vi.fn();
let currentChain: unknown;
// NEO-219: remap-only subscriptions — the variantType row (for `baseVersion`
// and the current labels) and the per-slot card counts behind the impact line.
let currentRow: unknown;
let currentCounts: unknown;

vi.mock("convex/react", () => ({
  useAction: (ref: string) =>
    ref === "fetchRawOptions" ? mockFetchRawOptions : vi.fn(),
  useMutation: (ref: string) =>
    ref === "setVariantTypePlatformData" ? mockSetPlatformData : vi.fn(),
  useQuery: (ref: string) => {
    if (ref === "getAncestorChain") return currentChain;
    if (ref === "getSelectorOptionById") return currentRow;
    if (ref === "getSlotCardCounts") return currentCounts;
    return undefined;
  },
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import BaseMappingForm from "./BaseMappingForm";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const VARIANT_TYPE_ID = "variant-type-id-1" as unknown as Parameters<
  typeof BaseMappingForm
>[0]["variantTypeId"];

// NEO-137: the set row stores its BSC slugs as a SLOT MAP
// (`{ b0: "...", b1: "..." }`), which is what getAncestorChain returns.
//
// This fixture used to build a bare `{ bsc: "slug" }` string — the
// pre-NEO-137 shape — and the fallback test below passed because the
// production code read it back with a matching `typeof === "string"`
// narrowing. Both were stale together, so the test asserted a path that could
// never work against real data. Building the real shape here means that
// narrowing cannot come back unnoticed.
function makeChain(
  overrides: Partial<{ setBsc: string | string[] }> = {},
) {
  const slugs =
    overrides.setBsc === undefined
      ? []
      : Array.isArray(overrides.setBsc)
        ? overrides.setBsc
        : [overrides.setBsc];
  return [
    { _id: "sport-id", level: "sport", value: "Baseball" },
    { _id: "year-id", level: "year", value: "2024" },
    { _id: "mfr-id", level: "manufacturer", value: "Topps" },
    {
      _id: "set-id",
      level: "setName",
      value: "2024 Topps Chrome",
      platformData:
        slugs.length > 0
          ? { bsc: Object.fromEntries(slugs.map((s, i) => [`b${i}`, s])) }
          : {},
    },
    { _id: "vt-id", level: "variantType", value: "Base" },
  ];
}

function renderForm(
  props: Partial<Parameters<typeof BaseMappingForm>[0]> = {},
) {
  const onClose = vi.fn();
  const utils = render(
    <BaseMappingForm
      variantTypeId={VARIANT_TYPE_ID}
      autoOpen={true}
      mode="initial"
      onClose={onClose}
      {...props}
    />,
  );
  return { ...utils, onClose };
}

/**
 * Wait for the picker AND for its pre-selection effects to have run.
 *
 * `fetchRawOptions` resolves in a promise continuation outside `act()`, so the
 * render carrying the loaded option lists commits one microtask before the
 * pre-select effects do. `waitFor` can observe the new rows in that gap and a
 * click issued immediately after would read the pre-load selection. A real
 * browser flushes passive effects before it delivers the next user event; the
 * empty `act` is how a test says the same thing.
 */
async function waitForPickerLoaded() {
  await waitFor(() => {
    expect(screen.getByText("Select Base Set")).toBeTruthy();
  });
  await act(async () => {});
}

// Mounts with SL+BSC options present (so the picker stays open), waits for
// the picker to render, then clicks Cancel and waits for the resulting
// message panel. Used as shared setup by the cancel/retry/close tests.
async function renderMountedAndCancelled(
  props: Partial<Parameters<typeof BaseMappingForm>[0]> = {},
) {
  const rendered = renderForm(props);

  await waitFor(() => {
    expect(screen.getByText("Select Base Set")).toBeTruthy();
  });

  await act(async () => {
    fireEvent.click(screen.getByText("Cancel"));
  });

  await waitFor(() => {
    expect(screen.getByText(/cancelled/i)).toBeTruthy();
  });

  return rendered;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BaseMappingForm — cancel-recovery fix (NEO-71-74)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentChain = makeChain();
    currentRow = undefined;
    currentCounts = undefined;
    mockSetPlatformData.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the picker on mount when autoOpen=true and fetchRawOptions resolves with BSC + SL options", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "Topps", platformValue: "topps" }],
      slOptions: [{ value: "2024 Topps Chrome", platformValue: "tc2024" }],
    });

    renderForm();

    await waitFor(() => {
      expect(screen.getByText("Select Base Set")).toBeTruthy();
    });
    expect(mockFetchRawOptions).toHaveBeenCalledTimes(1);
  });

  it("shows a 'cancelled' message panel on Cancel and does NOT call the parent onClose", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "Topps", platformValue: "topps" }],
      slOptions: [{ value: "2024 Topps Chrome", platformValue: "tc2024" }],
    });

    const { onClose } = await renderMountedAndCancelled();

    expect(screen.getByText(/cancelled/i)).toBeTruthy();
    expect(screen.queryByText("Select Base Set")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Retry from the cancelled state re-runs fetchRawOptions and reopens the picker (core regression test)", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "Topps", platformValue: "topps" }],
      slOptions: [{ value: "2024 Topps Chrome", platformValue: "tc2024" }],
    });

    const { onClose } = await renderMountedAndCancelled();
    expect(mockFetchRawOptions).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText("Retry"));
    });

    await waitFor(() => {
      expect(screen.getByText("Select Base Set")).toBeTruthy();
    });
    expect(mockFetchRawOptions).toHaveBeenCalledTimes(2);
    // Still the same instance's onClose — the fix never calls it just from
    // cancelling/retrying, only from Close or a confirmed mapping.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Close from the cancelled state calls the parent onClose", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "Topps", platformValue: "topps" }],
      slOptions: [{ value: "2024 Topps Chrome", platformValue: "tc2024" }],
    });

    const { onClose } = await renderMountedAndCancelled();

    fireEvent.click(screen.getByText("Close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the picker OPEN with the BSC candidate when SL has no options, and writes nothing until Confirm (NEO-219)", async () => {
    // Before NEO-219 this branch closed the picker and stored bscOptions[0]
    // with no UI at all, so the set a Base row ended up linked to was one the
    // operator never saw.
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "2024 Topps Chrome", platformValue: "topps-chrome" }],
      slOptions: [],
    });

    const { onClose } = renderForm();

    await waitForPickerLoaded();
    // The SL side says so out loud rather than silently taking the other side.
    expect(
      screen.getByText("SportLots returned no base set for 2024 Topps Chrome"),
    ).toBeTruthy();
    expect(mockSetPlatformData).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // A BSC-only pick is a legitimate confirm.
    await act(async () => {
      fireEvent.click(
        screen.getByLabelText("BSC base candidate: 2024 Topps Chrome"),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Confirm Base Set"));
    });

    expect(mockSetPlatformData).toHaveBeenCalledWith({
      variantTypeId: VARIANT_TYPE_ID,
      platformData: { bsc: "topps-chrome" },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the SET's own BSC slug as a VISIBLE candidate row when neither platform returned options (NEO-219)", async () => {
    // Before NEO-219 this branch wrote the set slug with no UI at all.
    currentChain = makeChain({ setBsc: "2024-topps-chrome" });
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [],
      slOptions: [],
    });

    const { onClose } = renderForm();

    await waitForPickerLoaded();
    const listingRow = screen.getByLabelText(
      "BSC base candidate: 2024 Topps Chrome — set listing (BSC)",
    );
    expect(listingRow).toBeTruthy();
    // Sole candidate → pre-selected (decision 4), but still not WRITTEN.
    expect(listingRow.getAttribute("aria-selected")).toBe("true");
    expect(mockSetPlatformData).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText("Confirm Base Set"));
    });

    expect(mockSetPlatformData).toHaveBeenCalledWith({
      variantTypeId: VARIANT_TYPE_ID,
      platformData: { bsc: "2024-topps-chrome" },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT substitute the set slug for a BSC pick the operator did not make (NEO-219)", async () => {
    // The old handlePickerConfirm silently fell back to the set's BSC slug
    // whenever the picker came back without a BSC selection.
    currentChain = makeChain({ setBsc: "2024-topps-chrome" });
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "Some Other BSC Set", platformValue: "other" }],
      slOptions: [{ value: "2024 Topps Chrome", platformValue: "tc2024" }],
    });

    renderForm();

    await waitForPickerLoaded();
    // Exact set-name match on the SL side → pre-selected; BSC has two
    // candidates (the marketplace row + the set listing) so neither is.
    await act(async () => {
      fireEvent.click(screen.getByText("Confirm Base Set"));
    });

    expect(mockSetPlatformData).toHaveBeenCalledWith({
      variantTypeId: VARIANT_TYPE_ID,
      platformData: {
        sportlots: "tc2024",
        sportlotsDisplay: "2024 Topps Chrome",
      },
    });
  });

  it("shows a final 'no marketplace data found' message and writes nothing when neither platform has options and the set has no BSC slug either (unchanged fallback path)", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [],
      slOptions: [],
    });

    const { onClose } = renderForm();

    await waitFor(() => {
      expect(
        screen.getByText("No marketplace data found for this Base set."),
      ).toBeTruthy();
    });
    expect(mockSetPlatformData).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // NEO-219 — re-map mode: state the impact, and guard the write on a version
  // -------------------------------------------------------------------------

  it("states how many cards the current mapping holds, and re-labels the confirm", async () => {
    currentRow = {
      _id: "vt-id",
      level: "variantType",
      value: "Base",
      lastUpdated: 4242,
      platformData: { bsc: { b0: "old-bsc" }, sportlots: { s0: "old-sl" } },
      platformLabels: { bsc: { b0: "Old BSC Set" }, sportlots: { s0: "Old SL Set" } },
      primaryPlatformId: { bsc: "b0", sportlots: "s0" },
    };
    // `total` is the ROW's distinct card count — deliberately NOT the sum of
    // the two side maps, which double-count a card sourced from both.
    currentCounts = { bsc: { b0: 110 }, sportlots: { s0: 110 }, total: 110 };
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [],
      slOptions: [{ value: "2024 Topps Chrome", platformValue: "tc2024" }],
    });

    renderForm({ mode: "remap" });

    await waitForPickerLoaded();
    expect(
      screen.getByText(
        "110 cards are linked through the current mapping; their refs will point at the new set.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("110 through SportLots, 110 through BSC.")).toBeTruthy();
    expect(
      screen.getByText("Currently mapped: SportLots — Old SL Set · BSC — Old BSC Set"),
    ).toBeTruthy();
    expect(screen.getByText("Re-map Base Set")).toBeTruthy();
    expect(screen.queryByText("Confirm Base Set")).toBeNull();
  });

  it("sends the row's baseVersion on a re-map, and re-opens on BASE_MAPPING_STALE without writing", async () => {
    currentRow = {
      _id: "vt-id",
      level: "variantType",
      value: "Base",
      lastUpdated: 4242,
      platformData: { sportlots: { s0: "old-sl" } },
      primaryPlatformId: { sportlots: "s0" },
    };
    currentCounts = { bsc: {}, sportlots: { s0: 3 }, total: 3 };
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [],
      slOptions: [{ value: "2024 Topps Chrome", platformValue: "tc2024" }],
    });
    mockSetPlatformData.mockRejectedValueOnce({
      message: "[Request ID: xyz] Server Error",
      data: { code: "BASE_MAPPING_STALE" },
    });

    const { onClose } = renderForm({ mode: "remap" });

    await waitForPickerLoaded();
    await act(async () => {
      fireEvent.click(screen.getByText("Re-map Base Set"));
    });

    expect(mockSetPlatformData).toHaveBeenCalledWith({
      variantTypeId: VARIANT_TYPE_ID,
      platformData: {
        sportlots: "tc2024",
        sportlotsDisplay: "2024 Topps Chrome",
      },
      baseVersion: 4242,
    });
    // Refused: the picker stays open on a re-fetched (fresh) row, the fixed
    // message says so, and the raw server text never reaches the DOM.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("changed somewhere else");
    expect(alert.textContent).not.toContain("Request ID");
    expect(screen.getByText("Select Base Set")).toBeTruthy();
    expect(mockFetchRawOptions).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders neither the URL nor the raw message of a failed fetch (NEO-211 F3)", async () => {
    // `result.message` on the !success path is fetchRawOptions' OUTER-CATCH
    // string, which embeds the thrown exception — an adapter response body, a
    // marketplace URL, or a credential hint. Twin of the leak fixed in
    // VariantForm/ParallelForm; the platform name is ours, the detail stays in
    // the Convex logs.
    mockFetchRawOptions.mockResolvedValue({
      success: false,
      bscOptions: [],
      slOptions: [],
      errors: [{ platform: "sportlots", message: "boom" }],
      message:
        "Failed to fetch options: GET https://api.sportlots.com/x?key=SECRET 500",
    });

    renderForm();

    const panel = await screen.findByText(/Failed to fetch options/);
    expect(panel.textContent).toBe(
      "Failed to fetch options. SportLots failed, nothing was changed.",
    );
    expect(panel.textContent).not.toContain("sportlots.com");
    expect(panel.textContent).not.toContain("SECRET");
    expect(panel.textContent).not.toContain("boom");
  });

  it("renders our own string, not the thrown text, when the action rejects", async () => {
    // The outer catch also covers the writePlatformData calls, so the thrown
    // value is a Convex server error that can carry marketplace detail.
    mockFetchRawOptions.mockRejectedValueOnce(
      new Error("[Request ID: xyz] GET https://api.sportlots.com/x?key=SECRET 500"),
    );

    renderForm();

    const panel = await screen.findByText(/Failed to fetch options/);
    expect(panel.textContent).toBe("Failed to fetch options. Nothing was changed.");
    expect(panel.textContent).not.toContain("sportlots.com");
    expect(panel.textContent).not.toContain("SECRET");
    expect(panel.textContent).not.toContain("Request ID");
  });
});
