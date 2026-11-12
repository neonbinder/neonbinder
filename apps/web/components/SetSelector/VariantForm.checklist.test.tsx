/**
 * NEO-496 (C1b, coordinator decision 1) — when the variant sync opens
 * Reconcile because of the set's uploaded checklist.
 *
 * Sources = each marketplace that returned anything + the checklist when it
 * has a section to place. Two or more open Reconcile, exactly as two
 * marketplaces always have, the column's FIRST auto-sync included; a checklist
 * alone opens it too. No checklist (or nothing left in it) is exactly today's
 * single-platform store.
 *
 * Mocking mirrors `VariantForm.test.tsx`.
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
      getInsertTreeByVariantType: "getInsertTreeByVariantType",
      getBaseVariantBySet: "getBaseVariantBySet",
    },
    setParallelConversion: { getBrandSlHolders: "getBrandSlHolders" },
    baseMatchProbe: {
      getBaseSignatureForVariantType: "getBaseSignatureForVariantType",
      probeBscSets: "probeBscSets",
      probeSlFirstPage: "probeSlFirstPage",
      probeSlCount: "probeSlCount",
    },
    marketplaceWaits: { forRun: "marketplaceWaits.forRun" },
  },
}));

const mockFetchRawOptions = vi.fn();
const mockStore = vi.fn();
let variantTypeTitle = "Insert";
let savedRows: unknown[] = [];

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: vi.fn().mockResolvedValue({ status: "noBase" }), action: vi.fn() }),
  useAction: (ref: string) => (ref === "fetchRawOptions" ? mockFetchRawOptions : vi.fn()),
  useMutation: (ref: string) => (ref === "storeReconciledOptions" ? mockStore : vi.fn()),
  useQuery: (ref: string) => {
    if (ref === "getAncestorChain") {
      return [
        { _id: "sport1", level: "sport", value: "Baseball" },
        { _id: "year1", level: "year", value: "2026" },
        { _id: "mfg1", level: "manufacturer", value: "Panini" },
        { _id: "set1", level: "setName", value: "Donruss" },
        { _id: "vt1", level: "variantType", value: variantTypeTitle },
      ];
    }
    if (ref === "getBaseVariantBySet") return null;
    if (ref === "getSelectorOptions") return savedRows;
    if (ref === "getInsertTreeByVariantType") return [];
    if (ref === "getUsedInsertIdentifiersBySet") {
      return { slPlatformValues: [], bscPlatformValues: [] };
    }
    if (ref === "getBrandSlHolders") return { rows: [], truncated: false };
    return undefined;
  },
}));

import VariantForm, { fetchSourceCount } from "./VariantForm";

const VARIANT_TYPE_ID = "vt1" as unknown as Parameters<typeof VariantForm>[0]["variantTypeId"];

const BSC_BOMB = { value: "Bomb Squad", platformValue: "bomb-squad" };

function section(name: string, kind: "base" | "base-child" | "other" = "other") {
  return { sectionKey: name.toLowerCase(), name, rowCount: 10, kind };
}

function checklist(sections: ReturnType<typeof section>[]) {
  return {
    checklistId: "pc1",
    baseSectionNames: ["Base"],
    sections,
    rowLinks: [],
    matches: [],
    candidates: [],
    unmatchedSectionKeys: sections.map((s) => s.sectionKey),
  };
}

function fetchResult(opts: {
  bsc?: Array<{ value: string; platformValue: string }>;
  sections?: ReturnType<typeof section>[] | null;
  errors?: Array<{ platform: string; message: string }>;
  skippedSides?: string[];
}) {
  const bsc = opts.bsc ?? [];
  return {
    success: true,
    bscOptions: bsc,
    slOptions: [],
    autoMatched: [],
    unmatchedBsc: bsc,
    unmatchedSl: [],
    slCandidates: [],
    errors: opts.errors ?? [],
    message: "",
    ...(opts.skippedSides ? { skippedSides: opts.skippedSides } : {}),
    ...(opts.sections ? { checklist: checklist(opts.sections) } : {}),
  };
}

async function renderForm(onDone = vi.fn()) {
  render(<VariantForm variantTypeId={VARIANT_TYPE_ID} onDone={onDone} />);
  await act(async () => {});
  return { onDone };
}

const dialog = () => screen.queryByRole("dialog", { name: /^Reconcile / });

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.mockResolvedValue({ success: true, unlinked: [] });
  variantTypeTitle = "Insert";
  savedRows = [];
});

describe("fetchSourceCount", () => {
  it("counts each marketplace with rows, and a checklist with a section to place", () => {
    expect(fetchSourceCount({ bscOptions: [1], slOptions: [] })).toEqual({
      marketplaces: 1,
      checklist: false,
    });
    expect(
      fetchSourceCount({ bscOptions: [1], slOptions: [1], checklist: { sections: [1] } }),
    ).toEqual({ marketplaces: 2, checklist: true });
    expect(
      fetchSourceCount({ bscOptions: [], slOptions: [], checklist: { sections: [] } }),
    ).toEqual({ marketplaces: 0, checklist: false });
  });
});

describe("VariantForm — the checklist opens Reconcile", () => {
  it("BSC + a checklist on the FIRST auto-sync: Reconcile, nothing stored", async () => {
    mockFetchRawOptions.mockResolvedValue(
      fetchResult({ bsc: [BSC_BOMB], sections: [section("Bomb Squad")] }),
    );
    await renderForm();
    await waitFor(() => expect(dialog()).toBeTruthy());
    expect(mockFetchRawOptions).toHaveBeenCalledTimes(1);
    expect(mockStore).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Filter checklist sections")).toBeTruthy();
  });

  it("a checklist alone (no marketplace ids) opens Reconcile too", async () => {
    mockFetchRawOptions.mockResolvedValue(
      fetchResult({ sections: [section("FUTURE STARS")], skippedSides: ["bsc", "sportlots"] }),
    );
    const { onDone } = await renderForm();
    await waitFor(() => expect(dialog()).toBeTruthy());
    expect(mockStore).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a checklist with nothing left to place is no source: today's store runs", async () => {
    mockFetchRawOptions.mockResolvedValue(fetchResult({ bsc: [BSC_BOMB], sections: [] }));
    await renderForm();
    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
  });

  it("no checklist at all: exactly today's single-platform store", async () => {
    mockFetchRawOptions.mockResolvedValue(fetchResult({ bsc: [BSC_BOMB], sections: null }));
    await renderForm();
    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    expect(dialog()).toBeNull();
  });

  it("a marketplace that failed still blocks, checklist or not", async () => {
    mockFetchRawOptions.mockResolvedValue(
      fetchResult({
        bsc: [BSC_BOMB],
        sections: [section("Bomb Squad")],
        errors: [{ platform: "sportlots", message: "timeout" }],
      }),
    );
    await renderForm();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(dialog()).toBeNull();
    expect(mockStore).not.toHaveBeenCalled();
  });

  it("Save forwards each set's checklist sections to the store", async () => {
    mockFetchRawOptions.mockResolvedValue(
      fetchResult({ sections: [section("FUTURE STARS")], skippedSides: ["bsc", "sportlots"] }),
    );
    await renderForm();
    fireEvent.click(
      await screen.findByLabelText("Make its own set from checklist section: FUTURE STARS"),
    );
    await act(async () => {
      fireEvent.click(screen.getByText(/Save 1 sets/));
    });
    await waitFor(() => expect(mockStore).toHaveBeenCalledTimes(1));
    expect(mockStore.mock.calls[0][0].reconciledItems).toEqual([
      expect.objectContaining({
        value: "Future Stars",
        platformData: {},
        identityOnly: true,
        checklistSectionKeys: ["future stars"],
      }),
    ]);
  });

  it("a Parallels type opens the column on the Base's runs", async () => {
    variantTypeTitle = "Parallel";
    mockFetchRawOptions.mockResolvedValue(
      fetchResult({
        bsc: [{ value: "Red", platformValue: "red" }],
        sections: [section("Base Red", "base-child"), section("Bomb Squad")],
      }),
    );
    await renderForm();
    expect(
      await screen.findByLabelText("Make its own set from checklist section: Base Red"),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText("Make its own set from checklist section: Bomb Squad"),
    ).toBeNull();
  });
});
