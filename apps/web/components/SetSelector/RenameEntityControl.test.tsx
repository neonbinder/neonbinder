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

import RenameEntityControl from "./RenameEntityControl";

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
   * NEO-334 — a variant type's title is its kind, so the server refuses a
   * rename that would change what the type is (while rows sit beneath it), a
   * second Base, and a same-word sibling. The refusal rides on a structured
   * ConvexError payload and its sentence is the operator's, not a generic.
   */
  describe("a variant-type rename refusal (NEO-334)", () => {
    const SENTENCE =
      "Not so fast — some inserts under this type still have sub-variants, and sub-variants only live under an Insert type. Move them out first, then rename.";

    /** Shaped like a ConvexError: the payload rides on `.data`. */
    const refusalOf = (data: unknown) =>
      Object.assign(new Error("[Request ID: abc] Server Error"), { data });

    async function refuse(data: unknown, value = "Promo") {
      mockRename.mockRejectedValueOnce(refusalOf(data));
      renderControl("Inserts");
      fireEvent.click(screen.getByLabelText("Rename Inserts"));
      const input = screen.getByLabelText("Edit name for Inserts");
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
      return { input, alert: await screen.findByRole("alert") };
    }

    it("renders the server's sentence verbatim, never the envelope", async () => {
      const { alert } = await refuse({ code: "VARIANT_TYPE_RENAME_REFUSED", message: SENTENCE });

      expect(alert.textContent).toBe(SENTENCE);
      expect(alert.textContent).not.toContain("Request ID");
    });

    it("the alert is a role=alert line the field points at, and the field is marked invalid", async () => {
      const { input, alert } = await refuse({
        code: "VARIANT_TYPE_RENAME_REFUSED",
        message: SENTENCE,
      });

      expect(alert.id).not.toBe("");
      expect(input.getAttribute("aria-describedby")).toBe(alert.id);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      // Still open, so the operator can retype.
      expect(screen.getByLabelText("Edit name for Inserts")).toBeTruthy();
    });

    it("the alert is a sibling of the field's wrapper, on a line of its own under the header row", async () => {
      const { input, alert } = await refuse({
        code: "VARIANT_TYPE_RENAME_REFUSED",
        message: SENTENCE,
      });

      expect(alert.className).toContain("order-last");
      expect(alert.className).toContain("basis-full");
      expect(alert.contains(input)).toBe(false);
      const fieldWrapper = input.closest("div");
      expect(fieldWrapper?.contains(alert)).toBe(false);
      expect(fieldWrapper?.parentElement).toBe(alert.parentElement);
    });

    it("a refusal with no message falls back to a plain sentence", async () => {
      const { alert } = await refuse({ code: "VARIANT_TYPE_RENAME_REFUSED" });

      expect(alert.textContent).toBe("This name can't be changed.");
    });

    it("a payload with another code is not read as a refusal", async () => {
      const { alert } = await refuse({ code: "SOMETHING_ELSE", message: SENTENCE });

      expect(alert.textContent).not.toBe(SENTENCE);
    });

    it("editing the field clears the refusal and the invalid state, without calling the server", async () => {
      const { input } = await refuse({ code: "VARIANT_TYPE_RENAME_REFUSED", message: SENTENCE });
      expect(mockRename).toHaveBeenCalledTimes(1);

      fireEvent.change(input, { target: { value: "Inserts & Autos" } });

      expect(screen.queryByRole("alert")).toBeNull();
      expect(input.getAttribute("aria-invalid")).toBeNull();
      expect(input.getAttribute("aria-describedby")).toBeNull();
      expect(mockRename).toHaveBeenCalledTimes(1);
    });

    it("a refusal on BLUR keeps the editor open in its error state", async () => {
      mockRename.mockRejectedValueOnce(
        refusalOf({ code: "VARIANT_TYPE_RENAME_REFUSED", message: SENTENCE }),
      );
      renderControl("Inserts");
      fireEvent.click(screen.getByLabelText("Rename Inserts"));
      const input = screen.getByLabelText("Edit name for Inserts");
      fireEvent.change(input, { target: { value: "Promo" } });
      fireEvent.blur(input);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(SENTENCE);
      const stillOpen = screen.getByLabelText("Edit name for Inserts");
      expect(stillOpen.getAttribute("aria-describedby")).toBe(alert.id);
      expect(screen.queryByLabelText("Rename Inserts")).toBeNull();
    });

    it("no alert and no describedby before anything is refused, and Escape clears a refusal", async () => {
      const { input } = await refuse({ code: "VARIANT_TYPE_RENAME_REFUSED", message: SENTENCE });

      fireEvent.keyDown(input, { key: "Escape" });

      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.click(screen.getByLabelText("Rename Inserts"));
      const reopened = screen.getByLabelText("Edit name for Inserts");
      expect(reopened.getAttribute("aria-describedby")).toBeNull();
      expect(reopened.getAttribute("aria-invalid")).toBeNull();
    });
  });
});
