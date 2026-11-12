/**
 * NEO-496 (C1b) — the checklist column's auto-match MERGE, pinned from the
 * cases where a section must NOT be attached.
 *
 * Added by the adversarial pass: planted breaks in the target resolution
 * (take the first of several owners; join a held id; join a set whose saved
 * links are unknown) stayed green against ReconciliationModal.checklist.test.
 * A match whose target is ambiguous, held, or unreadable leaves the section
 * in Pending for the operator (product rule 8 spirit: never give a tie to the
 * first candidate).
 */

import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReconciliationModal, {
  type PlatformItem,
  type ReconcileChecklist,
  type ReconcileChecklistSection,
} from "./ReconciliationModal";
import type { Id } from "../../convex/_generated/dataModel";

type Props = Parameters<typeof ReconciliationModal>[0];

const rowId = (id: string) => id as unknown as Id<"selectorOptions">;

const RED: ReconcileChecklistSection = {
  sectionKey: "base red",
  name: "Base Red",
  rowCount: 10,
  kind: "other",
};

const checklistOf = (
  matches: ReconcileChecklist["matches"],
  extra: Partial<ReconcileChecklist> = {},
): ReconcileChecklist => ({ sections: [RED], matches, scope: "other", rowLinks: [], ...extra });

const BSC_RED: PlatformItem = { value: "Red", platformValue: "red" };

function renderModal(extra: Partial<Props>) {
  const onConfirm = vi.fn().mockResolvedValue(undefined);
  render(
    <ReconciliationModal
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      level="insert"
      initialData={{ autoMatched: [], unmatchedBsc: [], unmatchedSl: [], slCandidates: [] }}
      {...extra}
    />,
  );
  return { onConfirm };
}

const stillPending = () =>
  expect(screen.getByLabelText("Make its own set from checklist section: Base Red")).toBeTruthy();

const noSectionOnAnySet = () =>
  expect(screen.queryByLabelText(/^Remove checklist section Base Red from /)).toBeNull();

describe("ReconciliationModal — a checklist match that must not attach", () => {
  test("an item target held by two saved sets (a tie) leaves the section in Pending", () => {
    renderModal({
      existingRows: [
        { existingId: rowId("r1"), value: "Red A", platformData: { bsc: "red" } },
        { existingId: rowId("r2"), value: "Red B", platformData: { bsc: "red" } },
      ],
      checklist: checklistOf(
        [{ sectionKey: RED.sectionKey, target: { kind: "item", side: "bsc", platformValue: "red" }, confidence: 1 }],
        { rowLinks: [{ rowId: rowId("r1"), sections: [] }, { rowId: rowId("r2"), sections: [] }] },
      ),
    });
    noSectionOnAnySet();
    stillPending();
  });

  test("a pair target held by two saved sets (a tie) leaves the section in Pending", () => {
    renderModal({
      existingRows: [
        { existingId: rowId("r1"), value: "Red A", platformData: { bsc: "red", sportlots: "77" } },
        { existingId: rowId("r2"), value: "Red B", platformData: { bsc: "red", sportlots: "77" } },
      ],
      checklist: checklistOf(
        [{ sectionKey: RED.sectionKey, target: { kind: "pair", bsc: "red", sportlots: "77" }, confidence: 1 }],
        { rowLinks: [{ rowId: rowId("r1"), sections: [] }, { rowId: rowId("r2"), sections: [] }] },
      ),
    });
    noSectionOnAnySet();
    stillPending();
  });

  test("a row target seeded twice (a tie) leaves the section in Pending", () => {
    renderModal({
      existingRows: [
        { existingId: rowId("r1"), value: "Red A", platformData: { bsc: "red" } },
        { existingId: rowId("r1"), value: "Red A", platformData: { bsc: "red" } },
      ],
      checklist: checklistOf(
        [{ sectionKey: RED.sectionKey, target: { kind: "row", rowId: rowId("r1") }, confidence: 1 }],
        { rowLinks: [{ rowId: rowId("r1"), sections: [] }] },
      ),
    });
    noSectionOnAnySet();
    stillPending();
  });

  test("an item target another part of the set holds stays in Pending even when a saved set here carries it too", () => {
    renderModal({
      existingRows: [{ existingId: rowId("r1"), value: "Red", platformData: { bsc: "red" } }],
      heldElsewhere: {
        rows: [{ key: "other", name: "Elsewhere Red", bsc: ["red"], sportlots: [] }],
        summary: "held",
        toggleLabel: "Show held",
      },
      checklist: checklistOf(
        [{ sectionKey: RED.sectionKey, target: { kind: "item", side: "bsc", platformValue: "red" }, confidence: 1 }],
        { rowLinks: [{ rowId: rowId("r1"), sections: [] }] },
      ),
    });
    noSectionOnAnySet();
    stillPending();
  });

  test("a row target whose saved links did not load takes no section, and Save sends none", async () => {
    const { onConfirm } = renderModal({
      existingRows: [{ existingId: rowId("r1"), value: "Red", platformData: { bsc: "red" } }],
      // No `rowLinks`: this row's links are unknown.
      checklist: {
        sections: [RED],
        matches: [{ sectionKey: RED.sectionKey, target: { kind: "row", rowId: rowId("r1") }, confidence: 1 }],
        scope: "other",
      },
    });
    noSectionOnAnySet();
    stillPending();
    fireEvent.click(screen.getByText(/^Save \d+ sets?$/));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0].items[0].checklistSectionKeys).toBeUndefined();
  });

  test("control: the same row target with exactly one owner attaches", () => {
    renderModal({
      existingRows: [{ existingId: rowId("r1"), value: "Red", platformData: { bsc: "red" } }],
      checklist: checklistOf(
        [{ sectionKey: RED.sectionKey, target: { kind: "row", rowId: rowId("r1") }, confidence: 1 }],
        { rowLinks: [{ rowId: rowId("r1"), sections: [] }] },
      ),
    });
    expect(screen.getByLabelText("Remove checklist section Base Red from Red")).toBeTruthy();
  });
});
