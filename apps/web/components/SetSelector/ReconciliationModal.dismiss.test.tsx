/**
 * NEO-220 — you cannot lose a reconciliation session by accident.
 *
 * This dialog was the worst offender of the four: a real reconcile is twenty
 * minutes of dragging, nothing is written until Save, and the backdrop closed
 * it on a single stray click with no warning and no way back. It also had no
 * `role="dialog"`, no accessible name and no keydown handler at all, so Escape
 * did nothing and assistive tech read the whole thing as an anonymous div.
 *
 * Both halves are pinned here: the discard guard, and the keyboard/ARIA
 * contract the guard hangs off.
 */

import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import ReconciliationModal, { type PlatformItem } from "./ReconciliationModal";

const BSC_S1: PlatformItem = {
  value: "Dugout Collection Artist's Proofs Series 1",
  platformValue: "dcap-series-1",
};
const SL_COMBINED: PlatformItem = {
  value: "Dugout Collection Artists Proofs",
  platformValue: "884412",
};

type InitialData = Parameters<typeof ReconciliationModal>[0]["initialData"];

const allPending = (): InitialData => ({
  autoMatched: [],
  unmatchedBsc: [BSC_S1],
  unmatchedSl: [SL_COMBINED],
  slCandidates: [],
});

type ExistingRows = Parameters<typeof ReconciliationModal>[0]["existingRows"];

function renderModal(
  initialData: InitialData = allPending(),
  existingRows?: ExistingRows,
) {
  const onClose = vi.fn();
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <ReconciliationModal
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      level="insert"
      initialData={initialData}
      existingRows={existingRows}
    />,
  );
  return { onClose, onConfirm };
}

const reconcileDialog = () =>
  screen.getByRole("dialog", { name: /Reconcile/ });

/** Pair the one BSC item with the one SL item — one promoted set. */
function promotePair() {
  fireEvent.click(screen.getByText(BSC_S1.value));
  fireEvent.click(screen.getByText(SL_COMBINED.value));
}

describe("ReconciliationModal — dialog contract", () => {
  test("announces itself as a named modal dialog", () => {
    renderModal();
    const dialog = reconcileDialog();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  test("focus opens inside the dialog", () => {
    renderModal();
    expect(document.activeElement).toBe(reconcileDialog());
  });
});

describe("ReconciliationModal — discard guard", () => {
  test("Escape on an untouched session closes immediately", () => {
    const { onClose } = renderModal();

    fireEvent.keyDown(reconcileDialog(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
  });

  test("a backdrop click on an untouched session closes immediately", () => {
    const { onClose } = renderModal();

    fireEvent.click(reconcileDialog());

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Cancel on an untouched session closes immediately", () => {
    const { onClose } = renderModal();

    fireEvent.click(screen.getByText("Cancel"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Escape after promoting a set asks first, and names the count", () => {
    const { onClose } = renderModal();
    promotePair();

    fireEvent.keyDown(reconcileDialog(), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Discard 1 set change?" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Discard 1 set change" }),
    ).toBeTruthy();
  });

  /**
   * The path that motivated the whole guard: the panel is a small island in a
   * large backdrop, and everything outside it used to be a discard button.
   */
  test("a backdrop click after an edit asks first", () => {
    const { onClose } = renderModal();
    promotePair();

    fireEvent.click(reconcileDialog());

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Discard 1 set change" }),
    ).toBeTruthy();
  });

  /**
   * A restored set that gets renamed is the case a plain counter would miss
   * entirely: the Ready column looked identical before and after, and the
   * modal's own `saveCount` never moved.
   */
  test("renaming a restored set counts as one edit", () => {
    renderModal(
      { autoMatched: [], unmatchedBsc: [], unmatchedSl: [], slCandidates: [] },
      [{ value: "Artist's Proofs", platformData: { bsc: "dcap-series-1" } }],
    );
    // Opening on a restored set is not itself an edit.
    fireEvent.keyDown(reconcileDialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();

    const title = screen.getByLabelText(
      "NeonBinder set name for Artist's Proofs",
    ) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Artist's Proofs S1" } });
    fireEvent.blur(title);

    fireEvent.click(screen.getByText("Cancel"));

    expect(
      screen.getByRole("button", { name: "Discard 1 set change" }),
    ).toBeTruthy();
  });

  test("sums a rename and a detach on the same restored set", () => {
    renderModal(
      {
        autoMatched: [],
        unmatchedBsc: [BSC_S1],
        unmatchedSl: [SL_COMBINED],
        slCandidates: [],
      },
      [
        {
          value: "Artist's Proofs",
          platformData: {
            bsc: BSC_S1.platformValue,
            sportlots: SL_COMBINED.platformValue,
          },
        },
      ],
    );
    const title = screen.getByLabelText(
      "NeonBinder set name for Artist's Proofs",
    ) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Artist's Proofs S1" } });
    fireEvent.blur(title);
    fireEvent.click(
      screen.getByLabelText(
        `Remove ${SL_COMBINED.value} from Artist's Proofs S1`,
      ),
    );

    fireEvent.click(screen.getByText("Cancel"));

    expect(
      screen.getByRole("button", { name: "Discard 2 set changes" }),
    ).toBeTruthy();
  });

  test("Cancel on the confirm keeps both the session and the dialog", () => {
    const { onClose } = renderModal();
    promotePair();
    fireEvent.click(screen.getByText("Cancel"));

    const confirm = screen.getByRole("dialog", { name: /Discard/ });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
    // The promoted set survived — the confirm never touched the reducer.
    expect(screen.getByText(/Save 1 sets/)).toBeTruthy();
  });

  test("confirming the discard closes the modal", () => {
    const { onClose } = renderModal();
    promotePair();
    fireEvent.keyDown(reconcileDialog(), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Discard 1 set change" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ReconciliationModal — Escape inside inputs", () => {
  test("Escape in the BSC filter clears it and does not close", () => {
    const { onClose } = renderModal();
    const filter = screen.getByLabelText("Filter BSC items") as HTMLInputElement;
    fireEvent.change(filter, { target: { value: "dugout" } });
    expect(filter.value).toBe("dugout");

    fireEvent.keyDown(filter, { key: "Escape" });

    expect(filter.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
  });

  /**
   * The title field already reverted on Escape; what it did not do was stop
   * the key, so abandoning one rename discarded every set on the screen.
   */
  test("Escape in a set title reverts it and does not close", () => {
    const { onClose } = renderModal();
    promotePair();
    const title = screen.getByLabelText(
      `NeonBinder set name for ${BSC_S1.value}`,
    ) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Half-typed name" } });

    fireEvent.keyDown(title, { key: "Escape" });

    expect(title.value).toBe(BSC_S1.value);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /Discard/ })).toBeNull();
  });
});
