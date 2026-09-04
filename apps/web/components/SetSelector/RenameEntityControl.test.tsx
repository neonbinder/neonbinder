/**
 * NEO-96: coverage for the inline rename control.
 *
 * `selectorOptions.value` was write-once before this — set at insert and never
 * patched anywhere — so nothing in the product could rename a sport, year,
 * manufacturer, set or variant. These lock in the interaction contract and, in
 * particular, that a rejected rename (the sibling-collision case) SURFACES
 * rather than being swallowed.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: { selectorOptions: { renameSelectorOption: "selectorOptions.renameSelectorOption" } },
}));

const mockRename = vi.fn();
vi.mock("convex/react", () => ({
  useMutation: (ref: string) =>
    ref === "selectorOptions.renameSelectorOption" ? mockRename : vi.fn(),
}));

import RenameEntityControl, { canRenameSelectorRow } from "./RenameEntityControl";

const ID = "selopt-1" as unknown as Id<"selectorOptions">;

function renderControl(currentValue = "Baseball") {
  return render(<RenameEntityControl id={ID} currentValue={currentValue} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRename.mockResolvedValue({ success: true, message: "Renamed" });
});
afterEach(() => vi.restoreAllMocks());

describe("RenameEntityControl", () => {
  it("starts collapsed, showing only a rename affordance", () => {
    renderControl();
    expect(screen.getByLabelText("Rename Baseball")).toBeTruthy();
    expect(screen.queryByLabelText("Edit name for Baseball")).toBeNull();
  });

  // Opens EMPTY, with the current value as the placeholder — not pre-filled.
  // Pre-filling put the caret mid-text on click, so a backspace-based clear
  // left an un-erased tail behind and the rename committed a mangled name
  // (see the note in RenameEntityControl). Empty-on-open removes the caret
  // from the problem; an empty submit is treated as cancel, so the existing
  // name is never lost by accident.
  it("opens an empty input placeheld by the current value", () => {
    renderControl();
    fireEvent.click(screen.getByLabelText("Rename Baseball"));
    const input = screen.getByLabelText("Edit name for Baseball") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Baseball");
  });

  it("commits on Enter with the trimmed value", async () => {
    renderControl();
    fireEvent.click(screen.getByLabelText("Rename Baseball"));
    const input = screen.getByLabelText("Edit name for Baseball");
    fireEvent.change(input, { target: { value: "  MLB Baseball  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(mockRename).toHaveBeenCalledWith({ id: ID, value: "MLB Baseball" }),
    );
  });

  it("reverts on Escape without calling the mutation", () => {
    renderControl();
    fireEvent.click(screen.getByLabelText("Rename Baseball"));
    const input = screen.getByLabelText("Edit name for Baseball");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(mockRename).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Rename Baseball")).toBeTruthy();
  });

  it("does not call the mutation when the value is unchanged", async () => {
    renderControl();
    fireEvent.click(screen.getByLabelText("Rename Baseball"));
    const input = screen.getByLabelText("Edit name for Baseball");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByLabelText("Rename Baseball")).toBeTruthy());
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("does not call the mutation for an empty value", async () => {
    renderControl();
    fireEvent.click(screen.getByLabelText("Rename Baseball"));
    const input = screen.getByLabelText("Edit name for Baseball");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByLabelText("Rename Baseball")).toBeTruthy());
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("surfaces a rejected rename instead of swallowing it, and stays open", async () => {
    // The sibling-collision case: the user needs to see WHY it didn't take.
    mockRename.mockRejectedValueOnce(new Error('Another sport here is already called "Football"'));
    renderControl();
    fireEvent.click(screen.getByLabelText("Rename Baseball"));
    const input = screen.getByLabelText("Edit name for Baseball");
    fireEvent.change(input, { target: { value: "Football" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("already called");
    expect(screen.getByLabelText("Edit name for Baseball")).toBeTruthy();
  });

  /**
   * NEO-211 (plan F). A non-custom `variantType`'s value is code, not a label:
   * `SetSelector` finds the Base variant by the literal string "Base", and the
   * BSC checklist fetch derives its `variant` facet straight from this display
   * value — so "Insert", "Parallel" and "Promo" are load-bearing too. The server
   * refuses the rename; this asserts the refusal REACHES the operator with the
   * server's own explanation rather than a generic "Rename failed".
   */
  it("renders the server's variantType refusal, not a generic failure", async () => {
    // Shaped like a ConvexError: the payload rides on `.data`, and `.message`
    // on the thrown object is the serialized envelope, not the human sentence.
    const refusal = Object.assign(
      new Error("[Request ID: abc] Server Error"),
      {
        data: {
          code: "VARIANT_TYPE_RENAME_REFUSED",
          message:
            'The variant type name "Base" can\'t be changed — it drives Base detection and the BSC checklist fetch.',
        },
      },
    );
    mockRename.mockRejectedValueOnce(refusal);
    renderControl("Base");
    fireEvent.click(screen.getByLabelText("Rename Base"));
    const input = screen.getByLabelText("Edit name for Base");
    fireEvent.change(input, { target: { value: "Basic" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("drives Base detection");
    expect(alert.textContent).not.toContain("Request ID");
  });
});

/**
 * The render-time half of plan F. The refusal above is the guarantee; this is
 * the affordance — a pencil that always errors is a worse answer than no pencil.
 * Both exist deliberately: a stale bundle or a second tab still cannot get the
 * write through.
 */
describe("canRenameSelectorRow", () => {
  it("refuses a synced variantType row", () => {
    expect(canRenameSelectorRow({ level: "variantType", isCustom: false })).toBe(false);
    // `isCustom` absent is the same statement as false on these rows.
    expect(canRenameSelectorRow({ level: "variantType" })).toBe(false);
  });

  it("allows a CUSTOM variantType — it was never one of the magic strings", () => {
    expect(canRenameSelectorRow({ level: "variantType", isCustom: true })).toBe(true);
  });

  it("allows every other level, custom or not", () => {
    for (const level of ["sport", "year", "manufacturer", "setName", "insert", "parallel"]) {
      expect(canRenameSelectorRow({ level })).toBe(true);
      expect(canRenameSelectorRow({ level, isCustom: true })).toBe(true);
    }
  });
});
