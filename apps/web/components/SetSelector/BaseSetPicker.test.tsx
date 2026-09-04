/**
 * NEO-219 — the Base picker's scoring table and its keyboard contract.
 *
 * Two things went wrong here before, and both were silent:
 *
 *   1. **Scoring.** An exact MANUFACTURER match scored 1000 — the same tier as
 *      an exact set name — so under set "Topps Chrome" the bare "Topps" row
 *      outranked "Topps Chrome" itself, and the pre-select handed it to an
 *      operator whose reflex is to confirm. And the pre-select threshold was
 *      795, which swept in the generic "Base"/"Base Set" rows.
 *   2. **Enter.** The dialog listened on `window`, so Enter pressed ANYWHERE —
 *      including in the search box, mid-filter — confirmed whatever happened to
 *      be pre-selected.
 *
 * So the rules this file locks in are: pre-select only an EXACT name match
 * (>= 950); keep the "likely match" pill at 795 so the generic rows still say
 * what they are (`sets-base.yaml` asserts the pill) without being chosen for
 * anybody; Enter confirms only from a focused option; Escape closes.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import BaseSetPicker, {
  EXACT_MANUFACTURER_SCORE,
  LIKELY_MATCH_SCORE,
  preselectScore,
  scoreBaseSetMatch,
} from "./BaseSetPicker";

const SET = "Topps Chrome";
const MFR = "Topps";

type PickerProps = React.ComponentProps<typeof BaseSetPicker>;

function renderPicker(overrides: Partial<PickerProps> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const utils = render(
    <BaseSetPicker
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      slOptions={[]}
      bscOptions={[]}
      setName={SET}
      manufacturer={MFR}
      loading={false}
      {...overrides}
    />,
  );
  return { ...utils, onConfirm, onClose };
}

/** More than 8 SL options is what makes the search box render. */
function manySlOptions(): Array<{ value: string; platformValue: string }> {
  return [
    { value: SET, platformValue: "tc" },
    { value: "Base", platformValue: "generic-base" },
    ...Array.from({ length: 8 }, (_, i) => ({
      value: `Filler Set ${i}`,
      platformValue: `f${i}`,
    })),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure scoring table
// ---------------------------------------------------------------------------

describe("scoreBaseSetMatch / preselectScore (NEO-219)", () => {
  it("ranks an exact set name above everything, and a bare manufacturer below the generic rows", () => {
    const exactSet = scoreBaseSetMatch(SET, SET, MFR);
    const genericBaseSet = scoreBaseSetMatch("Base Set", SET, MFR);
    const genericBase = scoreBaseSetMatch("Base", SET, MFR);
    const bareManufacturer = scoreBaseSetMatch(MFR, SET, MFR);

    expect(exactSet).toBe(1000);
    expect(bareManufacturer).toBe(EXACT_MANUFACTURER_SCORE);
    // The whole point of decision 7: "Topps" must not outrank "Topps Chrome",
    // and must sit below a row that at least claims to be a base set.
    expect(bareManufacturer).toBeLessThan(genericBase);
    expect(genericBase).toBeLessThan(genericBaseSet);
    expect(genericBaseSet).toBeLessThan(exactSet);
  });

  it("scores the manufacturer-prefix-stripped exact match at the pre-select floor", () => {
    expect(scoreBaseSetMatch("Opening Day", "Topps Opening Day", "Topps")).toBe(950);
    expect(preselectScore(950)).toBe(true);
  });

  it("pre-selects only exact matches, while the pill still covers the generic rows", () => {
    expect(preselectScore(scoreBaseSetMatch(SET, SET, MFR))).toBe(true);
    expect(preselectScore(scoreBaseSetMatch("Base Set", SET, MFR))).toBe(false);
    expect(preselectScore(scoreBaseSetMatch("Base", SET, MFR))).toBe(false);
    expect(preselectScore(scoreBaseSetMatch(MFR, SET, MFR))).toBe(false);
    // ...but "likely match" still renders for both generic rows.
    expect(scoreBaseSetMatch("Base Set", SET, MFR)).toBeGreaterThanOrEqual(
      LIKELY_MATCH_SCORE,
    );
    expect(scoreBaseSetMatch("Base", SET, MFR)).toBeGreaterThanOrEqual(
      LIKELY_MATCH_SCORE,
    );
  });
});

// ---------------------------------------------------------------------------
// Pre-selection
// ---------------------------------------------------------------------------

describe("BaseSetPicker — pre-selection (NEO-219)", () => {
  it("pre-selects the exact set name and leaves the generic 'Base' row alone", async () => {
    renderPicker({
      slOptions: [
        { value: "Base", platformValue: "generic-base" },
        { value: SET, platformValue: "tc" },
      ],
    });

    await waitFor(() => {
      expect(
        screen
          .getByLabelText(`SportLots base candidate: ${SET}`)
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
    expect(
      screen
        .getByLabelText("SportLots base candidate: Base")
        .getAttribute("aria-selected"),
    ).toBe("false");
    // The generic row still SAYS it is a likely match — sets-base.yaml asserts
    // that pill — it is just not chosen for anybody.
    expect(screen.getAllByText("likely match").length).toBeGreaterThan(0);
  });

  it("does NOT pre-select a lone BSC option that is not an exact name match", async () => {
    const { onConfirm } = renderPicker({
      bscOptions: [{ value: "Some Other BSC Set", platformValue: "other" }],
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("BSC base candidate: Some Other BSC Set"),
      ).toBeTruthy();
    });
    expect(
      screen
        .getByLabelText("BSC base candidate: Some Other BSC Set")
        .getAttribute("aria-selected"),
    ).toBe("false");
    // Nothing picked → Confirm is inert, and the reason is in the footer.
    expect(
      screen.getByText("Pick a SportLots or BSC set to continue."),
    ).toBeTruthy();
    expect(
      screen.getByText("Confirm Base Set").closest("button")?.disabled,
    ).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("pre-selects the set-listing row only when it is the SOLE BSC candidate", async () => {
    const { rerender } = renderPicker({
      setListing: { value: SET, platformValue: "topps-chrome-slug" },
    });

    const listingLabel = `BSC base candidate: ${SET} — set listing (BSC)`;
    await waitFor(() => {
      expect(screen.getByLabelText(listingLabel).getAttribute("aria-selected")).toBe(
        "true",
      );
    });

    await act(async () => {
      rerender(
        <BaseSetPicker
          isOpen
          onClose={vi.fn()}
          onConfirm={vi.fn().mockResolvedValue(undefined)}
          slOptions={[]}
          bscOptions={[{ value: "Some Other BSC Set", platformValue: "other" }]}
          setListing={{ value: SET, platformValue: "topps-chrome-slug" }}
          setName={SET}
          manufacturer={MFR}
          loading={false}
        />,
      );
    });

    expect(screen.getByLabelText(listingLabel).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("says so when SportLots returned nothing, and still allows a BSC-only confirm", async () => {
    const { onConfirm } = renderPicker({
      bscOptions: [{ value: "Some Other BSC Set", platformValue: "other" }],
    });

    expect(
      screen.getByText(`SportLots returned no base set for ${SET}`),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        screen.getByLabelText("BSC base candidate: Some Other BSC Set"),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Confirm Base Set"));
    });

    expect(onConfirm).toHaveBeenCalledWith({
      sl: undefined,
      bsc: { value: "Some Other BSC Set", platformValue: "other" },
    });
  });
});

// ---------------------------------------------------------------------------
// Keyboard contract
// ---------------------------------------------------------------------------

describe("BaseSetPicker — keyboard contract (NEO-219)", () => {
  it("Enter in the SEARCH BOX moves focus to the first result and confirms NOTHING", async () => {
    const { onConfirm } = renderPicker({ slOptions: manySlOptions() });

    const search = screen.getByPlaceholderText("Search SportLots sets...");
    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      `SportLots base candidate: ${SET}`,
    );
  });

  it("Enter on a FOCUSED option selects it and confirms", async () => {
    const { onConfirm } = renderPicker({
      slOptions: [
        { value: SET, platformValue: "tc" },
        { value: "Base", platformValue: "generic-base" },
      ],
    });

    const genericRow = screen.getByLabelText("SportLots base candidate: Base");
    await act(async () => {
      genericRow.focus();
      fireEvent.keyDown(genericRow, { key: "Enter" });
    });

    // The pre-selected exact match is NOT what gets written — the focused row is.
    expect(onConfirm).toHaveBeenCalledWith({
      sl: { value: "Base", platformValue: "generic-base" },
      bsc: undefined,
    });
  });

  it("Space selects a focused option without confirming, and Arrow keys move focus", async () => {
    const { onConfirm } = renderPicker({
      slOptions: [
        { value: SET, platformValue: "tc" },
        { value: "Base", platformValue: "generic-base" },
      ],
    });

    const first = screen.getByLabelText(`SportLots base candidate: ${SET}`);
    await act(async () => {
      first.focus();
      fireEvent.keyDown(first, { key: "ArrowDown" });
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "SportLots base candidate: Base",
    );

    await act(async () => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: " " });
    });
    expect(
      screen
        .getByLabelText("SportLots base candidate: Base")
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape closes the dialog", async () => {
    const { onClose } = renderPicker({
      slOptions: [{ value: SET, platformValue: "tc" }],
    });

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is a labelled modal dialog with listbox option rows", () => {
    renderPicker({
      slOptions: [{ value: SET, platformValue: "tc" }],
      bscOptions: [{ value: "Some Other BSC Set", platformValue: "other" }],
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "Select Base Set" })).toBeTruthy();
    expect(screen.getAllByRole("listbox").length).toBe(2);
    expect(screen.getAllByRole("option").length).toBe(2);
  });

  it("keeps the confirm label constant in initial mode and renames it for a re-map", async () => {
    const { rerender } = renderPicker({
      slOptions: [{ value: SET, platformValue: "tc" }],
    });
    expect(screen.getByText("Confirm Base Set")).toBeTruthy();

    await act(async () => {
      rerender(
        <BaseSetPicker
          isOpen
          onClose={vi.fn()}
          onConfirm={vi.fn().mockResolvedValue(undefined)}
          slOptions={[{ value: SET, platformValue: "tc" }]}
          bscOptions={[]}
          setName={SET}
          manufacturer={MFR}
          loading={false}
          mode="remap"
          remapNotice={{ totalCards: 7, slCards: 7, bscCards: 0 }}
        />,
      );
    });

    expect(screen.getByText("Re-map Base Set")).toBeTruthy();
    expect(
      screen.getByText(
        "7 cards are linked through the current mapping; their refs will point at the new set.",
      ),
    ).toBeTruthy();
    // One side only → no per-side breakdown to invent.
    expect(screen.queryByText(/through SportLots,/)).toBeNull();
  });
});
