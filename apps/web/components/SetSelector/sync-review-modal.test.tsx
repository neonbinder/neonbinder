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

import { render, screen, fireEvent, act, within } from "@testing-library/react";
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
    ambiguityBlockedCount: 0,
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

function renderModal(
  d: SyncDiff,
  // NEO-294 — only the delete-cap cases pass anything here; everything else
  // renders the component exactly as `CardChecklist` does.
  extra: { maxDeleteSelection?: number } = {},
) {
  const onSkip = vi.fn();
  const onConfirm = vi.fn();
  render(
    <SyncReviewModal
      isOpen
      diff={d}
      setLabel="Test Set"
      onSkip={onSkip}
      onConfirm={onConfirm}
      {...extra}
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

// ---------------------------------------------------------------------------
// NEO-294 — the delete list has a ceiling, and this screen honours it
//
// `commitCardChecklistFinalize` refuses a list longer than
// `MAX_OPERATOR_DELETE_IDS`, and it refuses it in the FINALIZE phase — after
// every card chunk has already written. "Select all" used to seed the whole
// orphan array, so a large re-sync bought the operator a failed commit on top
// of a half-finished one. The cap belongs here, where the operator can see
// what it leaves behind, rather than as a server error they cannot act on.
// ---------------------------------------------------------------------------

describe("SyncReviewModal — the delete list is capped (NEO-294)", () => {
  /**
   * The cap is injected at 3 rather than built at its real size.
   *
   * `MAX_OPERATOR_DELETE_IDS` is 1,000, and proving the ceiling by rendering
   * 1,001 checkbox rows costs seconds per interaction in happy-dom — a test
   * slow enough that it times out under the suite's own parallelism, which is
   * a test nobody gets to keep. The behaviour under test is the arithmetic and
   * the copy, neither of which cares what the number is; that the DEFAULT is
   * the same constant the server throws on is a type-level fact, not a
   * runtime one (both sides import `lib/cards/commit-limits.ts`).
   */
  const CAP = 3;
  const overCapDiff = diff({
    removedUpstream: {
      fullyOrphaned: Array.from({ length: CAP + 2 }, (_, i) => ({
        id: rowId(i + 1),
        cardNumber: String(i + 1),
        cardName: `Delisted ${i + 1}`,
        sides: ["bsc"] as Array<"bsc" | "sportlots">,
      })),
      partialOrphanCount: 0,
    },
  });

  /** The bulk-select control, as it reads once the list is over the cap. */
  const CAPPED_SELECT = `Select first ${CAP} of ${CAP + 2} cards for deletion`;

  it("Select all stops at the cap and hands back exactly that many ids, from the top of the list", () => {
    const { onConfirm } = renderModal(overCapDiff, { maxDeleteSelection: CAP });
    fireEvent.click(screen.getByLabelText(CAPPED_SELECT));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));
    fireEvent.click(screen.getByLabelText(`Confirm deleting ${CAP} cards`));

    // The FIRST of the list the operator is looking at, so "run it again for
    // the rest" names rows they can find.
    expect(onConfirm.mock.calls[0][0].operatorDeleteIds).toEqual([
      rowId(1),
      rowId(2),
      rowId(3),
    ]);
  });

  it("says the limit exists and what it leaves behind, rather than truncating in silence", () => {
    renderModal(overCapDiff, { maxDeleteSelection: CAP });
    const notice = screen.getByText(
      new RegExp(`One pass can delete up to ${CAP} cards`),
    );
    // The notice is the accessible description of the per-row checkboxes too
    // (aria-describedby), so it has to explain the REFUSAL as well as the
    // bulk button — a screen-reader user who focuses a dimmed row after the
    // cap bites hears this and nothing else.
    expect(notice.textContent).toMatch(
      new RegExp(`Once ${CAP} are ticked, another tick is refused`),
    );
    // It names the real controls: the bulk button as it currently reads, and
    // Sync Sets — never "commit", which is the server's word for it.
    expect(notice.textContent).toContain(`Select first ${CAP}`);
    expect(notice.textContent).toContain("run Sync Sets again");
    expect(notice.textContent).not.toMatch(/commit/i);

    fireEvent.click(screen.getByLabelText(CAPPED_SELECT));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));
    expect(screen.getByRole("alertdialog").textContent).toMatch(
      new RegExp(
        `2 of the ${CAP + 2} cards in this list are staying — one pass can only take ${CAP}`,
      ),
    );
  });

  /**
   * THE BLOCKER (NEO-294 audit). The leftover sentence was gated on
   * `orphansOverCap` — a fact about the LIST — rather than on the cap
   * actually biting. A dealer scanning 1,247 delisted rows who deliberately
   * ticks three of them (the normal case: you read a removed-upstream list
   * and pull the handful you want gone) was told "1,244 of the 1,247 … stay
   * for now — run the sync again to clear them": an instruction to delete
   * 1,244 cards he had just chosen to keep.
   */
  it("does NOT claim the cap left rows behind when the operator chose a small selection", () => {
    renderModal(overCapDiff, { maxDeleteSelection: CAP });
    // One tick out of a long list — well under the cap, so nothing is held
    // back by anything except the operator's own judgement.
    fireEvent.click(screen.getByLabelText("Delete #1 Delisted 1"));
    fireEvent.click(screen.getByLabelText("Apply selected changes"));

    const confirm = screen.getByRole("alertdialog");
    // The confirm still says what deleting means; it must not also tell him
    // to come back and clear the rows he kept.
    expect(confirm.textContent).toMatch(/This cannot be undone/);
    expect(confirm.textContent).not.toMatch(/are staying/);
    expect(confirm.textContent).not.toMatch(/Run Sync Sets again/);
    expect(confirm.textContent).toMatch(/Delete 1 card\?/);
  });

  it("the footer counter says why ticking stopped, at the moment it stops", () => {
    renderModal(overCapDiff, { maxDeleteSelection: CAP });
    const counter = () =>
      screen
        .getAllByRole("status")
        .find((n) => /will be applied/.test(n.textContent ?? "")) as HTMLElement;

    fireEvent.click(screen.getByLabelText("Delete #1 Delisted 1"));
    expect(counter().textContent).toContain("1 card will be deleted");
    expect(counter().textContent).not.toContain("the most one pass can take");

    fireEvent.click(screen.getByLabelText(CAPPED_SELECT));
    expect(counter().textContent).toContain(
      `${CAP} cards will be deleted — the most one pass can take.`,
    );
  });

  it("refuses a tick past the cap, with aria-disabled rather than a native disable", () => {
    renderModal(overCapDiff, { maxDeleteSelection: CAP });
    fireEvent.click(screen.getByLabelText(CAPPED_SELECT));

    const overflow = screen.getByLabelText(
      `Delete #${CAP + 1} Delisted ${CAP + 1}`,
    ) as HTMLInputElement;
    // Native `disabled` would drop the row out of the tab order and take the
    // reason for the refusal with it.
    expect(overflow.getAttribute("aria-disabled")).toBe("true");
    expect(overflow.disabled).toBe(false);
    fireEvent.click(overflow);
    expect(overflow.checked).toBe(false);

    // Un-ticking is always allowed, cap or no cap — the way back out of a full
    // list must never be the thing that is blocked — and with room again the
    // overflow row goes in.
    const inside = screen.getByLabelText("Delete #1 Delisted 1") as HTMLInputElement;
    expect(inside.checked).toBe(true);
    fireEvent.click(inside);
    expect(inside.checked).toBe(false);
    fireEvent.click(overflow);
    expect(overflow.checked).toBe(true);
  });

  it("an orphan list inside the cap is unchanged: no notice, no capped label, no refusal", () => {
    renderModal(
      diff({
        removedUpstream: {
          fullyOrphaned: [
            { id: rowId(7), cardNumber: "7", cardName: "Delisted", sides: ["bsc"] },
          ],
          partialOrphanCount: 0,
        },
      }),
    );
    // No `maxDeleteSelection` passed: this is the real ceiling, and one orphan
    // is nowhere near it.
    const bulk = screen.getByLabelText("Select all 1 cards for deletion");
    expect(bulk).toBeTruthy();
    // Under the cap the visible word is still "Select all", unchanged.
    expect(bulk.textContent).toBe("Select all");
    expect(screen.queryByText(/One pass can delete up to/)).toBeNull();
    const box = screen.getByLabelText("Delete #7 Delisted") as HTMLInputElement;
    expect(box.getAttribute("aria-disabled")).toBeNull();
  });

  it("the bulk button's visible words stay true, and its accessible name contains them (WCAG 2.5.3)", () => {
    // The visible label used to stay "Select all" while the accessible name
    // became "Select the first 3 of 5 cards for deletion": the visible word
    // was false, and voice control ("click Select all") could no longer
    // reach a control whose accessible name did not contain its own label.
    renderModal(overCapDiff, { maxDeleteSelection: CAP });
    const bulk = screen.getByLabelText(CAPPED_SELECT);
    const visible = `Select first ${CAP}`;
    expect(bulk.textContent).toBe(visible);
    expect(bulk.getAttribute("aria-label")?.startsWith(visible)).toBe(true);
  });

  /*
   * NOT COVERED HERE, DELIBERATELY: the thousands separators.
   *
   * Every count in this dialog now runs through `toLocaleString`, so a capped
   * 1,247-orphan list reads "Delete 1,000 cards?" over "1,247" rather than
   * mixing "1000" and "1,247" in one dialog. Proving it needs a fixture of
   * 1,001+ rows, because the smallest number that HAS a separator is 1,000 —
   * and a four-figure happy-dom fixture in this file passes on its own and
   * times out under the suite's parallelism, which is the same reason `CAP`
   * is injected at 3 rather than built at its real size. A test nobody gets
   * to keep is worse than none; the formatting is uniform by construction
   * (one call per rendered count) rather than by assertion.
   */
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

describe("SyncReviewModal — the match-quality status line", () => {
  it("says nothing at all when ambiguity cost no card a match", () => {
    // CI round 2: the count used to be of ambiguous KEYS, and a variant fanned
    // out across two marketplace series has plenty of those in perfectly
    // healthy data — the 1996 Score re-sync claimed "110 match keys are held
    // by more than one card, so those cards are treated as new" directly above
    // "0 new". Silence is the truthful rendering of "nothing happened".
    renderModal(
      diff({
        cards: [
          diffCard({ bucket: "formattingOnly", fields: [field({ foldEqual: true })] }),
        ],
        ambiguityBlockedCount: 0,
      }),
    );
    expect(screen.queryByText(/treated as new/)).toBeNull();
    expect(screen.queryByText(/match key/)).toBeNull();
    expect(screen.queryByText(/could not be matched/)).toBeNull();
    expect(screen.queryByText(/saved as new rows/)).toBeNull();
  });

  it("counts CARDS, not keys, when ambiguity really did block matches", () => {
    renderModal(diff({ cards: [diffCard()], ambiguityBlockedCount: 2 }));
    expect(
      screen.getByText(
        /2 cards could not be matched to an existing card .* they will be saved as new rows rather than guessed at\./,
      ),
    ).toBeTruthy();
  });

  it("reads as singular for one card", () => {
    renderModal(diff({ cards: [diffCard()], ambiguityBlockedCount: 1 }));
    expect(
      screen.getByText(
        /1 card could not be matched .* it will be saved as a new row rather than guessed at\./,
      ),
    ).toBeTruthy();
  });

  it("still reports collision inserts on their own", () => {
    renderModal(
      diff({
        cards: [diffCard()],
        collisionInsertCount: 3,
        ambiguityBlockedCount: 0,
      }),
    );
    expect(
      screen.getByText(/3 cards will be saved as new rows because another card/),
    ).toBeTruthy();
    expect(screen.queryByText(/could not be matched/)).toBeNull();
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

/**
 * NEO-220 — skipping with selections on screen asks first.
 *
 * Escape here stays a FORWARD skip; what changes is that it no longer discards
 * the operator's ticks in silence. The number is `acceptedFieldCount +
 * selectedDeleteIds.length` — the selection as it stands, INCLUDING the
 * fold-equal fields that arrive pre-ticked, because skipping drops those too.
 */
describe("SyncReviewModal — skip guard", () => {
  const reviewDialog = () =>
    screen.getByRole("dialog", { name: /Review upstream changes|Test Set/ });

  const tickTheField = () =>
    fireEvent.click(
      screen.getByLabelText(
        "Apply Card name to #1 Card One: Before becomes After",
      ),
    );

  it("skips straight through when nothing is selected", () => {
    const { onSkip } = renderModal(diff({ cards: [diffCard()] }));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Skip anyway" })).toBeNull();
  });

  it("Escape with a ticked change asks first, and names the count", () => {
    const { onSkip } = renderModal(diff({ cards: [diffCard()] }));
    tickTheField();

    fireEvent.keyDown(reviewDialog(), { key: "Escape" });

    expect(onSkip).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", {
        name: "1 selection not applied — skip anyway?",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip anyway" })).toBeTruthy();
  });

  it("the footer's Skip changes goes through the same guard", () => {
    const { onSkip } = renderModal(diff({ cards: [diffCard()] }));
    tickTheField();

    fireEvent.click(screen.getByLabelText("Skip reviewing changes and continue"));

    expect(onSkip).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Skip anyway" })).toBeTruthy();
  });

  /**
   * The reformatting fields arrive pre-ticked. Nobody chose them, but skipping
   * still drops them, so the count is about what does not get applied rather
   * than about who ticked it.
   */
  it("counts the pre-ticked reformatting fields too", () => {
    const { onSkip } = renderModal(
      diff({
        cards: [
          diffCard({
            bucket: "formattingOnly",
            fields: [
              field({
                oldValue: "Jose Ramirez",
                newValue: "José Ramírez",
                foldEqual: true,
              }),
            ],
          }),
        ],
      }),
    );

    fireEvent.keyDown(reviewDialog(), { key: "Escape" });

    expect(onSkip).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", {
        name: "1 selection not applied — skip anyway?",
      }),
    ).toBeTruthy();
  });

  it("counts ticked deletions alongside ticked fields", () => {
    renderModal(
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
    tickTheField();
    fireEvent.click(screen.getByLabelText("Delete #7 Gone"));

    fireEvent.keyDown(reviewDialog(), { key: "Escape" });

    expect(
      screen.getByRole("dialog", {
        name: "2 selections not applied — skip anyway?",
      }),
    ).toBeTruthy();
  });

  it("Cancel on the guard keeps the review and the ticks", () => {
    const { onSkip, onConfirm } = renderModal(diff({ cards: [diffCard()] }));
    tickTheField();
    fireEvent.keyDown(reviewDialog(), { key: "Escape" });

    const guard = screen.getByRole("dialog", { name: /skip anyway/ });
    fireEvent.click(within(guard).getByRole("button", { name: "Cancel" }));

    expect(onSkip).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Skip anyway" })).toBeNull();
    const box = screen.getByLabelText(
      "Apply Card name to #1 Card One: Before becomes After",
    ) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it("confirming the guard skips", () => {
    const { onSkip, onConfirm } = renderModal(diff({ cards: [diffCard()] }));
    tickTheField();
    fireEvent.keyDown(reviewDialog(), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Skip anyway" }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
