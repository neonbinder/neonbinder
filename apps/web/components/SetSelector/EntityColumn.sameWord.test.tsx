/**
 * NEO-334 — "+ Custom" at the variant type: singular and plural are ONE word
 * for a variant type's title (Jason, 2026-10-10).
 *
 * Typing "Promos" beside "Promo" (or "Inserts" beside "Insert") is refused
 * inline, in the server's own sentence, before any round-trip: no cross-parent
 * lookup, no confirm, no mutation, no selection. The exact-name case still
 * selects the existing row (a navigation, not a write). The rule is the
 * variant type's alone: every other level keeps its exact-name rule.
 *
 * Mocking mirrors EntityColumn.custom-select.test.tsx.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GenericId } from "convex/values";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sameWordSiblingMessage } from "../../convex/variantRole";

type OptionId = GenericId<"selectorOptions">;

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getSelectorOptions: "getSelectorOptions",
      addCustomSelectorOption: "addCustomSelectorOption",
      getAncestorChain: "getAncestorChain",
      findSelectorOptionElsewhere: "findSelectorOptionElsewhere",
    },
  },
}));

const mockAddCustom = vi.fn();
const mockQuery = vi.fn();
const mockFindElsewhere = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => mockAddCustom,
  useAction: () => vi.fn(),
  useConvex: () => ({ query: (...args: unknown[]) => mockFindElsewhere(...args) }),
  useQuery: (ref: string) =>
    ref === "getAncestorChain" ? undefined : mockQuery(),
}));

import EntityColumn from "./EntityColumn";

const PROMO = { _id: "vt-promo" as unknown as OptionId, value: "Promo" };
const INSERT = { _id: "vt-insert" as unknown as OptionId, value: "Insert" };

async function submitCustomValue(
  level: "variantType" | "insert",
  typed: string,
  onSelectExisting?: (id: OptionId) => void,
) {
  await act(async () => {
    render(
      <EntityColumn
        selector={<div>selector</div>}
        renderForm={() => <div>form</div>}
        addButtonText="Sync"
        isVisible={true}
        level={level}
        parentId={"parent-id" as unknown as OptionId}
        onSelectExisting={onSelectExisting}
      />,
    );
  });
  await act(async () => {
    fireEvent.click(screen.getByText("+ Custom"));
  });
  const input = screen.getByPlaceholderText("Enter custom value...") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: typed } });
  });
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
}

describe("EntityColumn — '+ Custom' at the variant type: one word, one row (NEO-334)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReturnValue([PROMO, INSERT]);
    mockAddCustom.mockResolvedValue("newly-created-id");
    mockFindElsewhere.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["Promos", "Promo"],
    ["  PROMOS ", "Promo"],
    ["Inserts", "Insert"],
  ])(
    "typing %j beside %j is refused inline with the server's sentence, and nothing happens",
    async (typed, existing) => {
      const onSelectExisting = vi.fn();
      await submitCustomValue("variantType", typed, onSelectExisting);

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toBe(sameWordSiblingMessage(existing)),
      );
      expect(mockAddCustom).not.toHaveBeenCalled();
      expect(mockFindElsewhere).not.toHaveBeenCalled();
      expect(onSelectExisting).not.toHaveBeenCalled();
      // No confirm step opened.
      expect(screen.queryByText("Create")).toBeNull();
    },
  );

  it("the exact title (any case) is still a navigation to the existing row, not a refusal", async () => {
    const onSelectExisting = vi.fn();

    await submitCustomValue("variantType", "insert", onSelectExisting);

    await waitFor(() => expect(onSelectExisting).toHaveBeenCalledWith("vt-insert"));
    expect(screen.queryByText(sameWordSiblingMessage("Insert"))).toBeNull();
    expect(mockAddCustom).not.toHaveBeenCalled();
  });

  it("a different word goes on to the confirm", async () => {
    await submitCustomValue("variantType", "Promotion");

    await waitFor(() => expect(screen.getByText("Create")).toBeTruthy());
    expect(screen.queryByText(sameWordSiblingMessage("Promo"))).toBeNull();
  });

  it("every other level keeps the exact-name rule: 'Promos' beside 'Promo' at the insert level goes on to the confirm", async () => {
    await submitCustomValue("insert", "Promos");

    await waitFor(() => expect(screen.getByText("Create")).toBeTruthy());
    expect(screen.queryByText(sameWordSiblingMessage("Promo"))).toBeNull();
  });

  it.each([
    ["CUSTOM_VALUE_INVALID", { code: "CUSTOM_VALUE_INVALID", reason: "The server's reason." }],
    ["VARIANT_TYPE_RENAME_REFUSED", { code: "VARIANT_TYPE_RENAME_REFUSED", message: "The server's reason." }],
  ])("a server refusal coded %s reads as one inline sentence under the field", async (_code, data) => {
    mockAddCustom.mockRejectedValueOnce(Object.assign(new Error("[Request ID: x] Server Error"), { data }));
    await submitCustomValue("variantType", "Holiday");
    await waitFor(() => expect(screen.getByText("Create")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("Create"));
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("The server's reason."),
    );
    expect(screen.queryByText(/Request ID/)).toBeNull();
  });
});
