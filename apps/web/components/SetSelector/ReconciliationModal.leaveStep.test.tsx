/**
 * NEO-339 — Save never leaves the set's own Pending sets behind silently.
 * The set-building tool asks about every unpaired set in the set's own scope
 * (BSC's listing, SportLots' prefix filter); the dialog follows the same
 * rule: Save first asks "Leave N sets unpaired?", listing them, and only a
 * deliberate "Leave them" saves. A SportLots set outside the filter (another
 * product of the brand-year) is not asked about.
 */
import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReconciliationModal, { type PlatformItem } from "./ReconciliationModal";

type InitialData = Parameters<typeof ReconciliationModal>[0]["initialData"];
const it = (value: string, platformValue: string): PlatformItem => ({ value, platformValue });

const FS_B = it("Future Stars", "fs");
const FS_S = it("2024 Topps Chrome Future Stars", "sl-fs");
const AR_B = it("Topps Chrome Authentics Relics", "b-ar");
const AR_S = it("Chrome Authentics Relics", "sl-ar");
const OTHER = it("Heritage Real One Autographs", "sl-heritage");

function renderModal(initialData: InitialData) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <ReconciliationModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      level="insert"
      setName="Topps Chrome"
      manufacturer="Topps"
      initialData={initialData}
    />,
  );
  return { onConfirm };
}

const withPending = (bsc: PlatformItem[], sl: PlatformItem[]): InitialData => ({
  autoMatched: [{ displayName: FS_B.value, bsc: FS_B, sl: FS_S, confidence: 1 }],
  unmatchedBsc: bsc,
  unmatchedSl: sl,
  slCandidates: [],
});
const save = () => screen.getByText(/^Save \d+ sets?$/);
const leaveStep = () => screen.queryByRole("dialog", { name: /unpaired\?$/ });

describe("ReconciliationModal — the set's own unpaired sets are asked about at Save (NEO-339)", () => {
  test("Save asks first, listing each set and its marketplace; nothing is saved yet", () => {
    const { onConfirm } = renderModal(withPending([AR_B], [AR_S, OTHER]));
    fireEvent.click(save());
    const step = leaveStep();
    expect(step).not.toBeNull();
    expect(within(step!).getByRole("heading", { name: "Leave 2 sets unpaired?" })).toBeTruthy();
    const list = within(step!).getByRole("group", { name: "Sets left in Pending" });
    expect(within(list).getByText("Topps Chrome Authentics Relics")).toBeTruthy();
    expect(within(list).getByText("Chrome Authentics Relics")).toBeTruthy();
    // Another product of the brand-year (outside the SportLots filter) is not asked about.
    expect(within(list).queryByText("Heritage Real One Autographs")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("Leave them saves the Ready sets, leaving the asked ones in Pending", async () => {
    const { onConfirm } = renderModal(withPending([AR_B], [AR_S]));
    fireEvent.click(save());
    fireEvent.click(screen.getByRole("button", { name: "Leave them, save 1 set" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const items = onConfirm.mock.calls[0][0].items as Array<{ value: string }>;
    expect(items.map((i) => i.value)).toEqual(["Future Stars"]);
    expect(leaveStep()).toBeNull();
  });

  test("Cancel goes back to sorting with nothing saved; Escape does the same and keeps the dialog open", async () => {
    const { onConfirm } = renderModal(withPending([AR_B], []));
    fireEvent.click(save());
    // Focus opens on Cancel (the house confirm's safe default): Enter there goes back.
    const cancel = within(leaveStep()!).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(leaveStep()).toBeNull();
    fireEvent.click(save());
    fireEvent.keyDown(leaveStep()!, { key: "Escape" });
    expect(leaveStep()).toBeNull();
    // The Reconcile dialog itself is still open.
    expect(screen.getByText(/^Save \d+ sets?$/)).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("with every set of its own placed, Save saves at once", async () => {
    const { onConfirm } = renderModal(withPending([], [OTHER]));
    fireEvent.click(save());
    expect(leaveStep()).toBeNull();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  test("SportLots twins read apart by their ids, as everywhere else in the dialog; a unique name stays bare", () => {
    const twinA = it("Chrome Update Sapphire", "378117");
    const twinB = it("Chrome Update Sapphire", "378118");
    renderModal(withPending([AR_B], [twinA, twinB]));
    fireEvent.click(save());
    const list = within(leaveStep()!).getByRole("group", { name: "Sets left in Pending" });
    const rows = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows).toEqual([
      "Topps Chrome Authentics RelicsBSC",
      "Chrome Update Sapphire (#378117)SportLots",
      "Chrome Update Sapphire (#378118)SportLots",
    ]);
  });

  test("a set made its own is not asked about", async () => {
    const { onConfirm } = renderModal(withPending([AR_B], []));
    fireEvent.click(screen.getByRole("button", { name: `Make its own set: ${AR_B.value}` }));
    fireEvent.click(save());
    expect(leaveStep()).toBeNull();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });
});
