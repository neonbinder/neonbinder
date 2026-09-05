/**
 * NEO-220 — you cannot lose a grouping session by accident.
 *
 * This modal is pure drag: nothing is written until Save, the backdrop closed
 * it on one stray click, and Escape was handled on `window` — so it fired
 * wherever focus happened to be, including inside any dialog rendered over the
 * top of it. Both paths threw away every pending move without asking.
 *
 * First component tests for this file; the reducer's own diff (`computeDiff`)
 * is exercised through the footer count, which is the same number the confirm
 * now shows.
 */

import { describe, expect, test, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getInsertTreeByVariantType: "getInsertTreeByVariantType",
      applyParallelGroupings: "applyParallelGroupings",
    },
  },
}));

const mockApply = vi.fn().mockResolvedValue(undefined);
let tree: unknown = undefined;

vi.mock("convex/react", () => ({
  useMutation: () => mockApply,
  useQuery: (ref: string) =>
    ref === "getInsertTreeByVariantType" ? tree : undefined,
}));

import ParallelGroupingModal from "./ParallelGroupingModal";

const VARIANT_TYPE_ID = "vt1" as Id<"selectorOptions">;

/**
 * One insert with one parallel under it. Deliberately a single ungrouped
 * insert, so `detectGroupings` has nothing to suggest and the modal opens with
 * a genuinely empty diff — a tree with suggestions opens dirty on purpose, and
 * that is a different test.
 */
function oneParallel() {
  return [
    {
      insert: { _id: "i1", value: "Refractor" },
      parallels: [{ _id: "p1", value: "Gold" }],
    },
  ];
}

function renderModal() {
  const onClose = vi.fn();
  render(
    <ParallelGroupingModal
      isOpen
      onClose={onClose}
      variantTypeId={VARIANT_TYPE_ID}
    />,
  );
  return { onClose };
}

/** The overlay that now owns Escape — focused on open, `tabIndex={-1}`. */
const overlay = () =>
  screen.getByText("Group Parallels").closest('[tabindex="-1"]') as HTMLElement;

/** Demote the one parallel to top level: exactly one pending move. */
function demoteTheParallel() {
  fireEvent.click(screen.getByLabelText("Remove Gold from parallels"));
}

beforeEach(() => {
  tree = oneParallel();
  mockApply.mockClear();
});

describe("ParallelGroupingModal — keyboard entry point", () => {
  /**
   * The window listener this replaced fired wherever focus was, which is why
   * it had to go: the discard confirm is a sibling in the same portal, and a
   * window listener would have closed the session behind it on the same key.
   */
  test("focus opens on the dialog container, so Escape lands inside", () => {
    renderModal();
    expect(document.activeElement).toBe(overlay());
  });

  test("Escape on the root closes an untouched session", () => {
    const { onClose } = renderModal();

    fireEvent.keyDown(overlay(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
  });
});

describe("ParallelGroupingModal — discard guard", () => {
  test("a backdrop click on an untouched session closes immediately", () => {
    const { onClose } = renderModal();

    fireEvent.click(overlay());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Cancel on an untouched session closes immediately", () => {
    const { onClose } = renderModal();

    fireEvent.click(screen.getByText("Cancel"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape after a move asks first, and names the count", () => {
    const { onClose } = renderModal();
    demoteTheParallel();
    // The footer and the confirm read the same number.
    expect(screen.getByText("Save 1 change")).toBeTruthy();

    fireEvent.keyDown(overlay(), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Discard 1 pending move?" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Discard 1 pending move" }),
    ).toBeTruthy();
  });

  test("a backdrop click after a move asks first", () => {
    const { onClose } = renderModal();
    demoteTheParallel();

    fireEvent.click(overlay());

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Discard 1 pending move" }),
    ).toBeTruthy();
  });

  test("Cancel on the confirm keeps both the moves and the dialog", () => {
    const { onClose } = renderModal();
    demoteTheParallel();
    fireEvent.click(screen.getByText("Cancel"));

    const confirm = screen.getByRole("dialog", { name: /Discard/ });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
    // The move survived — the confirm never touched the reducer.
    expect(screen.getByText("Save 1 change")).toBeTruthy();
  });

  test("confirming the discard closes the modal", () => {
    const { onClose } = renderModal();
    demoteTheParallel();
    fireEvent.keyDown(overlay(), { key: "Escape" });

    fireEvent.click(
      screen.getByRole("button", { name: "Discard 1 pending move" }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockApply).not.toHaveBeenCalled();
  });
});
