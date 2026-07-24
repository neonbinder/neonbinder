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
    },
  },
}));

const mockFetchRawOptions = vi.fn();
const mockSetPlatformData = vi.fn();
let currentChain: unknown;

vi.mock("convex/react", () => ({
  useAction: (ref: string) =>
    ref === "fetchRawOptions" ? mockFetchRawOptions : vi.fn(),
  useMutation: (ref: string) =>
    ref === "setVariantTypePlatformData" ? mockSetPlatformData : vi.fn(),
  useQuery: (ref: string) =>
    ref === "getAncestorChain" ? currentChain : undefined,
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

function makeChain(
  overrides: Partial<{ setBsc: string | string[] }> = {},
) {
  return [
    { _id: "sport-id", level: "sport", value: "Baseball" },
    { _id: "year-id", level: "year", value: "2024" },
    { _id: "mfr-id", level: "manufacturer", value: "Topps" },
    {
      _id: "set-id",
      level: "setName",
      value: "2024 Topps Chrome",
      platformData:
        overrides.setBsc !== undefined ? { bsc: overrides.setBsc } : {},
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
      onClose={onClose}
      {...props}
    />,
  );
  return { ...utils, onClose };
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

  it("auto-takes the BSC option and shows a message panel when SL has no options (unchanged success path)", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "Topps", platformValue: "topps" }],
      slOptions: [],
    });

    const { onClose } = renderForm();

    await waitFor(() => {
      expect(mockSetPlatformData).toHaveBeenCalledWith({
        variantTypeId: VARIANT_TYPE_ID,
        platformData: { bsc: "topps" },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Stored Base mapping: Topps")).toBeTruthy();
    });
    expect(screen.queryByText("Select Base Set")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    // Retry is now unconditional, even on this success message.
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("falls back to the set's BSC slug and shows a message panel when neither platform has options but the set has a stored BSC slug (unchanged fallback path)", async () => {
    currentChain = makeChain({ setBsc: "2024-topps-chrome" });
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [],
      slOptions: [],
    });

    const { onClose } = renderForm();

    await waitFor(() => {
      expect(mockSetPlatformData).toHaveBeenCalledWith({
        variantTypeId: VARIANT_TYPE_ID,
        platformData: { bsc: "2024-topps-chrome" },
      });
    });

    await waitFor(() => {
      expect(
        screen.getByText("Stored Base mapping (fallback to set slug)"),
      ).toBeTruthy();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
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
});
