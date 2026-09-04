/**
 * NEO-211 (plan B) — the partial-failure guard at the Sub-Variants column.
 *
 * Same bug, same shape, different level: see `VariantForm.test.tsx` for the full
 * account of why a `success: true` result carrying a per-platform error must not
 * reach the store. This file exists because the two forms carry SEPARATE copies
 * of the branch (and separate `SYNC_FAILED_PREFIX` strings, so Maestro can tell
 * a variant failure from a parallel one), and a fix applied to one and not the
 * other is exactly the kind of divergence that ships.
 *
 * First component tests for this file.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    setReconciliation: {
      fetchRawOptions: "fetchRawOptions",
      storeReconciledOptions: "storeReconciledOptions",
    },
    selectorOptions: {
      getAncestorChain: "getAncestorChain",
      getUsedInsertIdentifiersBySet: "getUsedInsertIdentifiersBySet",
      getSelectorOptions: "getSelectorOptions",
    },
  },
}));

const mockFetchRawOptions = vi.fn();
const mockStore = vi.fn();

vi.mock("convex/react", () => ({
  useAction: (ref: string) =>
    ref === "fetchRawOptions" ? mockFetchRawOptions : vi.fn(),
  useMutation: (ref: string) =>
    ref === "storeReconciledOptions" ? mockStore : vi.fn(),
  useQuery: (ref: string) => {
    if (ref === "getAncestorChain") return CHAIN;
    if (ref === "getSelectorOptions") return [];
    if (ref === "getUsedInsertIdentifiersBySet")
      return { slPlatformValues: [], bscPlatformValues: [] };
    return undefined;
  },
}));

import ParallelForm from "./ParallelForm";

const CHAIN = [
  { _id: "sport1", level: "sport", value: "Hockey" },
  { _id: "year1", level: "year", value: "1972-73" },
  { _id: "mfg1", level: "manufacturer", value: "Topps" },
  { _id: "set1", level: "setName", value: "Topps" },
  { _id: "vt1", level: "variantType", value: "Insert" },
];

const INSERT_ID = "ins1" as unknown as Parameters<
  typeof ParallelForm
>[0]["insertId"];

function bscOnly(errors: Array<{ platform: string; message: string }> = []) {
  return {
    success: true,
    bscOptions: [{ value: "Gold", platformValue: "gold" }],
    slOptions: [],
    autoMatched: [],
    unmatchedBsc: [],
    unmatchedSl: [],
    slCandidates: [],
    errors,
    message: "BSC: 1, SL: 0",
  };
}

async function renderForm(onDone = vi.fn()) {
  const result = render(<ParallelForm insertId={INSERT_ID} onDone={onDone} />);
  await act(async () => {});
  return { ...result, onDone };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.mockResolvedValue({ success: true, unlinked: [] });
});

describe("ParallelForm — single-platform store (NEO-211 plan B)", () => {
  it("stores, with BOTH sides covered, when the empty side succeeded empty", async () => {
    mockFetchRawOptions.mockResolvedValue(bscOnly());
    const { onDone } = await renderForm();

    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    const args = mockStore.mock.calls[0][0];
    expect(args.level).toBe("parallel");
    expect(args.coveredSides).toEqual(["bsc", "sportlots"]);
    // NEO-211 F1: the empty side arrives as [] — "asked, returned nothing".
    expect(args.returnedIds).toEqual({ bsc: ["gold"], sportlots: [] });
    expect(onDone).toHaveBeenCalled();
  });

  it("writes NOTHING when the empty side errored, and keeps Retry reachable", async () => {
    mockFetchRawOptions.mockResolvedValue(
      bscOnly([{ platform: "sportlots", message: "socket hang up" }]),
    );
    const { onDone } = await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sync failed: could not load parallels");
    expect(alert.textContent).toContain("SportLots failed, nothing was changed.");
    expect(alert.textContent).not.toContain("socket hang up");
    expect(mockStore).not.toHaveBeenCalled();
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("ParallelForm — reconciliation confirm (NEO-211 F1)", () => {
  const BSC_A = { value: "Gold", platformValue: "bsc-gold" };
  const SL_A = { value: "Gold", platformValue: "sl-gold" };
  const BSC_B = { value: "Silver", platformValue: "bsc-silver" };
  const SL_B = { value: "Silver", platformValue: "sl-silver" };

  it("sends the fetch's id universe, not the operator's confirmed rows", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [BSC_A, BSC_B],
      slOptions: [SL_A, SL_B],
      autoMatched: [
        { displayName: "Gold", bsc: BSC_A, sl: SL_A, confidence: 0.9 },
        { displayName: "Silver", bsc: BSC_B, sl: SL_B, confidence: 0.9 },
      ],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
      errors: [],
      message: "BSC: 2, SL: 2",
    });
    await renderForm();

    fireEvent.click(await screen.findByLabelText("Remove set Gold"));
    await act(async () => {
      fireEvent.click(screen.getByText(/Save 1 sets/));
    });

    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    const args = mockStore.mock.calls[0][0];
    expect(args.reconciledItems).toHaveLength(1);
    // The disbanded row's ids are still in returnedIds, so the store cannot
    // read its absence from reconciledItems as "delisted".
    expect(args.returnedIds).toEqual({
      bsc: ["bsc-gold", "bsc-silver"],
      sportlots: ["sl-gold", "sl-silver"],
    });
  });
});

describe("ParallelForm — failed save (NEO-211)", () => {
  it("surfaces our own error in the dialog and keeps it open for a retry", async () => {
    mockFetchRawOptions.mockResolvedValue({
      success: true,
      bscOptions: [{ value: "Gold", platformValue: "bsc-gold" }],
      slOptions: [{ value: "Gold", platformValue: "sl-gold" }],
      autoMatched: [
        {
          displayName: "Gold",
          bsc: { value: "Gold", platformValue: "bsc-gold" },
          sl: { value: "Gold", platformValue: "sl-gold" },
          confidence: 0.9,
        },
      ],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
      errors: [],
      message: "BSC: 1, SL: 1",
    });
    mockStore.mockRejectedValueOnce(new Error("[Request ID: xyz] cap exceeded"));
    await renderForm();

    await act(async () => {
      fireEvent.click(await screen.findByText(/Save 1 sets/));
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Couldn't save these sets. Nothing was changed — press Save to try again, or Cancel to close.",
    );
    expect(alert.textContent).not.toContain("Request ID");
    expect(screen.getByText(/Save 1 sets/)).toBeTruthy();
  });
});

describe("ParallelForm — both adapters empty (NEO-211)", () => {
  it("keeps the alert and Retry mounted instead of closing the panel", async () => {
    // Same fix as VariantForm: this branch used to call onDone(), unmounting
    // the form and destroying the very alert it had just set.
    mockFetchRawOptions.mockResolvedValue({
      ...bscOnly([
        { platform: "bsc", message: "503" },
        { platform: "sportlots", message: "socket hang up" },
      ]),
      bscOptions: [],
    });
    const { onDone } = await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Sync failed: could not load parallels");
    expect(alert.textContent).toContain(
      "BuySportsCards and SportLots failed, nothing was changed.",
    );
    expect(alert.textContent).not.toContain("socket hang up");
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    expect(mockStore).not.toHaveBeenCalled();
  });
});

describe("ParallelForm — failed fetch copy (NEO-211 F3)", () => {
  it("renders neither the URL nor the raw message", async () => {
    mockFetchRawOptions.mockResolvedValue({
      ...bscOnly([{ platform: "bsc", message: "boom" }]),
      success: false,
      bscOptions: [],
      message:
        "Failed to fetch options: GET https://api.buysportscards.com/x?token=SECRET 500",
    });
    await renderForm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("buysportscards.com");
    expect(alert.textContent).not.toContain("SECRET");
    expect(alert.textContent).toBe(
      "Sync failed: could not load parallels. BuySportsCards failed, nothing was changed.",
    );
  });
});

describe("ParallelForm — unlink notice (NEO-211 plan D)", () => {
  it("names the level correctly — sub-variants, not sets", async () => {
    mockFetchRawOptions.mockResolvedValue(bscOnly());
    mockStore.mockResolvedValue({
      success: true,
      unlinked: [{ id: "row1", value: "Gold", side: "sportlots" }],
    });
    await renderForm();

    const notice = await screen.findByText(/No longer listed on SportLots/);
    expect(notice.textContent).toContain("1 sub-variant");
    expect(notice.textContent).toContain("Gold");
  });
});
