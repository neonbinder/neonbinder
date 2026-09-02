/**
 * NEO-203 phase C — `SyncReviewModal`, the content-diff review.
 *
 * The load-bearing property of this screen is what it does when the operator
 * does NOT read it: nothing. Every substantive change starts unchecked, every
 * delete starts unchecked, and Escape advances the pipeline applying nothing.
 * So the seeding and bucketing helpers are tested directly (they ARE the
 * safety rule), and the rendered dialog is driven for the four behaviours that
 * can lose an operator work: the formatting bulk-accept, the delete confirm,
 * Escape's forward-skip, and the shape of the payload handed back.
 *
 * Nothing here mocks Convex — the component is pure props in, result out. That
 * is deliberate: `CardChecklist` owns the wiring and has its own file.
 */

import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import SyncReviewModal, {
  groupDiffCards,
  needsSyncReview,
  seedCheckedFields,
  type SyncDiff,
  type SyncDiffCard,
  type SyncDiffField,
} from "./sync-review-modal";

const rowId = (n: number) => `row_${n}` as Id<"cardChecklist">;

function field(over: Partial<SyncDiffField> = {}): SyncDiffField {
  return {
    name: "cardName",
    tier: 2,
    oldValue: "Before",
    newValue: "After",
    source: "bsc",
    foldEqual: false,
    ...over,
  };
}

function diffCard(over: Partial<SyncDiffCard> = {}): SyncDiffCard {
  return {
    index: 0,
    cardNumber: "1",
    cardName: "Card One",
    bucket: "contentChanges",
    existingId: rowId(1),
    baseVersion: 1000,
    fields: [field()],
    ...over,
  };
}

function diff(over: Partial<SyncDiff> = {}): SyncDiff {
  return {
    cards: [],
    removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 },
    conflicts: [],
    collisionInsertCount: 0,
    ambiguousMatchCount: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Seeding — the safety property
// ---------------------------------------------------------------------------

describe("seedCheckedFields", () => {
  it("pre-accepts a fold-equal (reformatting) change", () => {
    const seeded = seedCheckedFields([
      diffCard({
        fields: [
          field({ oldValue: "Jose Ramirez", newValue: "José Ramírez", foldEqual: true }),
        ],
      }),
    ]);
    expect(seeded["0#cardName"]).toBe(true);
  });

  it("leaves a substantive change unchecked", () => {
    const seeded = seedCheckedFields([
      diffCard({
        fields: [
          field({ oldValue: "Mike Yastrzemski", newValue: "Carl Yastrzemski" }),
        ],
      }),
    ]);
    expect(seeded["0#cardName"]).toBe(false);
  });

  it("leaves EVERY trust-critical (tier 1) substantive change unchecked", () => {
    const seeded = seedCheckedFields([
      diffCard({
        fields: [
          field({ name: "playerIds", tier: 1 }),
          field({ name: "teamOnCardIds", tier: 1 }),
          field({ name: "isRookie", tier: 1 }),
          field({ name: "isRelic", tier: 1 }),
          field({ name: "autographType", tier: 1 }),
          field({ name: "printRun", tier: 1 }),
          field({ name: "cardVariation", tier: 1 }),
        ],
      }),
    ]);
    expect(Object.values(seeded).every((v) => v === false)).toBe(true);
  });

  it("pre-accepts a tier-1 change that only reformats — the fold overrides the tier", () => {
    // The spec's tier-3 overlay: a re-accented player name is still the same
    // player, so bulk-accepting it is safe even though `playerIds` is the most
    // trust-critical field on the card.
    const seeded = seedCheckedFields([
      diffCard({
        fields: [
          field({
            name: "playerIds",
            tier: 1,
            oldValue: "Jose Ramirez",
            newValue: "José Ramírez",
            foldEqual: true,
          }),
        ],
      }),
    ]);
    expect(seeded["0#playerIds"]).toBe(true);
  });

  it("keys by card index, so two cards changing the same field stay independent", () => {
    const seeded = seedCheckedFields([
      diffCard({ index: 0, fields: [field({ foldEqual: true })] }),
      diffCard({ index: 1, fields: [field({ foldEqual: false })] }),
    ]);
    expect(seeded).toEqual({ "0#cardName": true, "1#cardName": false });
  });
});

describe("groupDiffCards", () => {
  it("splits the four buckets", () => {
    const groups = groupDiffCards([
      diffCard({ index: 0, bucket: "contentChanges" }),
      diffCard({ index: 1, bucket: "formattingOnly" }),
      diffCard({ index: 2, bucket: "identical", fields: [] }),
      diffCard({ index: 3, bucket: "new", fields: [] }),
      diffCard({ index: 4, bucket: "formattingOnly" }),
    ]);
    expect(groups.contentChanges.map((c) => c.index)).toEqual([0]);
    expect(groups.formattingOnly.map((c) => c.index)).toEqual([1, 4]);
    expect(groups.identicalCount).toBe(1);
    expect(groups.newCount).toBe(1);
  });
});

describe("needsSyncReview", () => {
  it("is false when nothing changed and nothing was orphaned", () => {
    expect(
      needsSyncReview(
        diff({
          cards: [
            diffCard({ bucket: "identical", fields: [] }),
            diffCard({ index: 1, bucket: "new", fields: [] }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is true for a changed card, an orphan, or a conflict", () => {
    expect(needsSyncReview(diff({ cards: [diffCard()] }))).toBe(true);
    expect(
      needsSyncReview(diff({ cards: [diffCard({ bucket: "formattingOnly" })] })),
    ).toBe(true);
    expect(
      needsSyncReview(
        diff({
          removedUpstream: {
            fullyOrphaned: [
              { id: rowId(9), cardNumber: "9", cardName: "Gone", sides: ["bsc"] },
            ],
            partialOrphanCount: 0,
          },
        }),
      ),
    ).toBe(true);
    expect(
      needsSyncReview(
        diff({
          conflicts: [
            {
              index: 0,
              cardNumber: "1",
              cardName: "Contested",
              bsc: { rowId: rowId(1), cardNumber: "1", cardName: "A" },
              sportlots: { rowId: rowId(2), cardNumber: "2", cardName: "B" },
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

function renderModal(d: SyncDiff) {
  const onSkip = vi.fn();
  const onConfirm = vi.fn();
  render(
    <SyncReviewModal
      isOpen
      diff={d}
      setLabel="Test Set"
      onSkip={onSkip}
      onConfirm={onConfirm}
    />,
  );
  return { onSkip, onConfirm };
}

describe("SyncReviewModal — content changes", () => {
  it("hands back only the fields the operator ticked, with the row's baseVersion", () => {
    const { onConfirm } = renderModal(
      diff({
        cards: [
          diffCard({
            index: 3,
            baseVersion: 4242,
            fields: [
              field({ name: "cardName" }),
              field({ name: "isRookie", tier: 1 }),
            ],
          }),
        ],
      }),
    );

    fireEvent.click(
      screen.getByLabelText(/^Apply Card name to #1 Card One/),
    );
    fireEvent.click(screen.getByLabelText("Apply selected changes"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      applyFieldsByIndex: { 3: ["cardName"] },
      baseVersionByIndex: { 3: 4242 },
      operatorDeleteIds: [],
      heldBackIndices: [],
    });
  });

  it("sends no decision at all for a card the operator left alone", () => {
    const { onConfirm } = renderModal(diff({ cards: [diffCard()] }));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));
    // Absent, not `[]` — the wire stays byte-identical to an unreviewed
    // commit, which is what keeps the server's fail-closed default honest.
    expect(onConfirm.mock.calls[0][0].applyFieldsByIndex).toEqual({});
    expect(onConfirm.mock.calls[0][0].baseVersionByIndex).toEqual({});
  });

  it("renders the old and new values and the source badge", () => {
    renderModal(
      diff({
        cards: [
          diffCard({
            fields: [
              field({
                oldValue: "Mike Yastrzemski",
                newValue: "Carl Yastrzemski",
                source: "sportlots",
              }),
            ],
          }),
        ],
      }),
    );
    expect(screen.getByText("Mike Yastrzemski")).toBeTruthy();
    expect(screen.getByText("Carl Yastrzemski")).toBeTruthy();
    expect(screen.getByText("via SportLots")).toBeTruthy();
    // Tier 1 is the only thing that gets the "needs review" flag.
    expect(screen.queryByText("needs review")).toBeNull();
  });
});

describe("SyncReviewModal — formatting-only bulk accept", () => {
  const formattingDiff = diff({
    cards: [
      diffCard({
        index: 0,
        bucket: "formattingOnly",
        fields: [field({ foldEqual: true })],
      }),
      diffCard({
        index: 1,
        bucket: "formattingOnly",
        fields: [field({ foldEqual: true })],
      }),
    ],
  });

  it("collapses the group and pre-accepts every change in it", () => {
    const { onConfirm } = renderModal(formattingDiff);
    expect(
      screen
        .getByLabelText(/Expand formatting-only changes/)
        .getAttribute("aria-expanded"),
    ).toBe("false");
    // The header button reads as the action AVAILABLE, and with everything
    // already accepted that action is to skip them.
    expect(screen.getByLabelText("Skip all formatting changes")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Apply selected changes"));
    expect(onConfirm.mock.calls[0][0].applyFieldsByIndex).toEqual({
      0: ["cardName"],
      1: ["cardName"],
    });
  });

  it("the header button drops the whole group and then restores it", () => {
    const { onConfirm } = renderModal(formattingDiff);
    fireEvent.click(screen.getByLabelText("Skip all formatting changes"));
    fireEvent.click(screen.getByLabelText("Accept all formatting changes"));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));
    expect(onConfirm.mock.calls[0][0].applyFieldsByIndex).toEqual({
      0: ["cardName"],
      1: ["cardName"],
    });
  });

  it("skipping the group leaves nothing to apply", () => {
    const { onConfirm } = renderModal(formattingDiff);
    fireEvent.click(screen.getByLabelText("Skip all formatting changes"));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));
    expect(onConfirm.mock.calls[0][0].applyFieldsByIndex).toEqual({});
  });
});

describe("SyncReviewModal — removed upstream", () => {
  const orphanDiff = diff({
    removedUpstream: {
      fullyOrphaned: [
        { id: rowId(7), cardNumber: "7", cardName: "Delisted", sides: ["bsc"] },
        {
          id: rowId(8),
          cardNumber: "8",
          cardName: "Also gone",
          sides: ["bsc", "sportlots"],
        },
      ],
      partialOrphanCount: 3,
    },
  });

  it("defaults every delete checkbox to unchecked", () => {
    renderModal(orphanDiff);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.length).toBe(2);
    expect(boxes.every((b) => !b.checked)).toBe(true);
  });

  it("applies with no deletes and no confirm when nothing is ticked", () => {
    const { onConfirm } = renderModal(orphanDiff);
    fireEvent.click(screen.getByLabelText("Apply selected changes"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onConfirm.mock.calls[0][0].operatorDeleteIds).toEqual([]);
  });

  it("requires one confirm before deleting, and starts that confirm on Cancel", async () => {
    const { onConfirm } = renderModal(orphanDiff);
    fireEvent.click(screen.getByLabelText("Delete #7 Delisted"));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));

    // Nothing has been handed back yet — the confirm is a real gate.
    expect(onConfirm).not.toHaveBeenCalled();
    const confirmDialog = screen.getByRole("alertdialog");
    expect(confirmDialog).toBeTruthy();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(document.activeElement).toBe(
      screen.getByLabelText("Cancel deleting cards"),
    );

    fireEvent.click(screen.getByLabelText("Confirm deleting 1 cards"));
    expect(onConfirm.mock.calls[0][0].operatorDeleteIds).toEqual([rowId(7)]);
  });

  it("Escape inside the confirm backs out of the confirm ONLY", () => {
    const { onSkip, onConfirm } = renderModal(orphanDiff);
    fireEvent.click(screen.getByLabelText("Delete #7 Delisted"));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    // The review is still open and nothing was decided for the pipeline.
    expect(onSkip).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Apply selected changes")).toBeTruthy();
  });

  it("bulk select covers the fully-orphaned list only, and clears again", () => {
    const { onConfirm } = renderModal(orphanDiff);
    fireEvent.click(screen.getByLabelText("Select all 2 cards for deletion"));
    fireEvent.click(screen.getByLabelText("Clear every delete selection"));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));
    expect(onConfirm.mock.calls[0][0].operatorDeleteIds).toEqual([]);
  });

  it("reports the partial orphans without offering to delete them", () => {
    renderModal(orphanDiff);
    expect(
      screen.getByText(/3 further row/).textContent,
    ).toMatch(/still live on at least one marketplace/);
  });
});

describe("SyncReviewModal — cross-side conflicts", () => {
  const conflictDiff = diff({
    conflicts: [
      {
        index: 5,
        cardNumber: "1",
        cardName: "Contested",
        bsc: { rowId: rowId(1), cardNumber: "1", cardName: "Row A" },
        sportlots: { rowId: rowId(2), cardNumber: "2", cardName: "Row B" },
      },
    ],
  });

  it("offers a real radiogroup and reports the card as held back", () => {
    const { onConfirm } = renderModal(conflictDiff);
    const group = screen.getByRole("radiogroup");
    expect(group).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);

    fireEvent.click(screen.getByLabelText(/^BSC row —/));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));

    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      heldBackIndices: [5],
      conflictResolutions: [{ index: 5, cardNumber: "1", choice: "bsc" }],
    });
  });

  it("arrow keys move the selection, APG-style, and wrap", () => {
    renderModal(conflictDiff);
    const group = screen.getByRole("radiogroup");
    // Default is "Treat as new" (the last option); one step right wraps to the
    // first.
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(
      screen.getByLabelText(/^BSC row —/).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(
      screen.getByLabelText(/^Treat as new —/).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("SyncReviewModal — Escape is a forward skip", () => {
  it("calls onSkip, not a cancel, and never onConfirm", () => {
    const { onSkip, onConfirm } = renderModal(
      diff({
        cards: [diffCard()],
        removedUpstream: {
          fullyOrphaned: [
            { id: rowId(7), cardNumber: "7", cardName: "Gone", sides: ["bsc"] },
          ],
          partialOrphanCount: 0,
        },
      }),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("the footer's skip control says what it actually does", () => {
    const { onSkip } = renderModal(diff({ cards: [diffCard()] }));
    // NOT "Cancel": the paired cards are still saved. Only this screen's
    // content changes and deletions are skipped.
    const skip = screen.getByLabelText(
      "Skip reviewing changes and continue",
    );
    expect(skip.textContent).toBe("Skip changes");
    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
