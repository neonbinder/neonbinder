/**
 * NEO-211 phase C — `SelectorSyncReviewModal`, the marketplace-renamed-this review.
 *
 * The load-bearing property, exactly as in `sync-review-modal.test.tsx`: what
 * this screen does when the operator does NOT read it. Nothing. Not a rename,
 * and not a decline either — a decline is still a write
 * (`declinedUpstreamLabels`), so a dialog that pre-picked one would be writing
 * on being looked at.
 *
 * The seeding, the bulk-action scoping and the payload builder are therefore
 * tested directly (they ARE the safety rule), and the rendered dialog is driven
 * for the behaviours that can lose an operator work: the per-side toggle's
 * third resting state, the two scoped bulk actions, Escape, and the shape of
 * the payload handed back.
 *
 * Nothing here mocks Convex — the component is props in, result out.
 * `EntityColumn` owns the query and the mutation and has its own file.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import SelectorSyncReviewModal, {
  acceptFormattingOnly,
  buildDecisions,
  choiceKey,
  clearDeclines,
  countFoldEqualSides,
  declineUndecided,
  seedChoices,
  summariseChoices,
  type ChoiceMap,
  type SelectorSyncSuggestion,
} from "./SelectorSyncReviewModal";

const id = (n: number) => `selopt_${n}` as Id<"selectorOptions">;

function suggestion(
  over: Partial<SelectorSyncSuggestion> = {},
): SelectorSyncSuggestion {
  return {
    existingId: id(1),
    currentValue: "TCG",
    baseVersion: 1000,
    suggestions: [{ side: "bsc", label: "Topps", foldEqual: false }],
    ...over,
  };
}

// The ticket's own worked example: NB renamed the set to "TCG", BSC still says
// "Topps", and SportLots says something different again.
const BOTH_SIDES = suggestion({
  suggestions: [
    { side: "bsc", label: "Topps", foldEqual: false },
    { side: "sportlots", label: "Topps Chewing Gum", foldEqual: false },
  ],
});

// ---------------------------------------------------------------------------
// Seeding — the safety property
// ---------------------------------------------------------------------------

describe("seedChoices", () => {
  it("selects NOTHING for a substantive rename", () => {
    // "TCG" → "Topps" is a different word. An operator who closes this dialog
    // without reading it must end up with zero renames applied, full stop.
    expect(seedChoices([BOTH_SIDES])).toEqual({});
  });

  it("pre-Accepts a fold-equal side — a reformatting, not a rename", () => {
    // NEO-203's tier-3 rule, reused: same word under case/whitespace/accent
    // folding, so accepting it is not a decision about our catalogue.
    const seeded = seedChoices([
      suggestion({
        currentValue: "topps  ",
        suggestions: [{ side: "bsc", label: "Topps", foldEqual: true }],
      }),
    ]);
    expect(seeded[choiceKey("selopt_1", "bsc")]).toBe("accept");
  });

  it("never pre-selects a DECLINE — that is a write too", () => {
    const seeded = seedChoices([BOTH_SIDES]);
    expect(Object.values(seeded)).not.toContain("decline");
  });
});

// ---------------------------------------------------------------------------
// Bulk actions — the scoping is the safety, not the convenience
// ---------------------------------------------------------------------------

describe("bulk actions", () => {
  it("'Keep all mine' touches only the UNDECIDED, never an explicit take", () => {
    const rows = [BOTH_SIDES];
    const withAccept: ChoiceMap = { [choiceKey("selopt_1", "bsc")]: "accept" };
    const next = declineUndecided(rows, withAccept);
    // Silently reversing a rename the operator just chose would be worse than
    // making them click twice.
    expect(next[choiceKey("selopt_1", "bsc")]).toBe("accept");
    expect(next[choiceKey("selopt_1", "sportlots")]).toBe("decline");
  });

  it("'Undo that' is its undo, and keeps the accepts", () => {
    const cleared = clearDeclines({
      [choiceKey("selopt_1", "bsc")]: "accept",
      [choiceKey("selopt_1", "sportlots")]: "decline",
    });
    expect(cleared).toEqual({ [choiceKey("selopt_1", "bsc")]: "accept" });
  });

  it("the formatting bulk accepts fold-equal sides ONLY", () => {
    // There is deliberately no blanket "Accept all": a rename is not inert the
    // way a decline is, and a batch of unreviewed substantive renames is the
    // safety property failing for the action hardest to notice went wrong.
    const rows = [
      suggestion({
        existingId: id(1),
        suggestions: [
          { side: "bsc", label: "Topps", foldEqual: true },
          { side: "sportlots", label: "Topps Chewing Gum", foldEqual: false },
        ],
      }),
    ];
    expect(countFoldEqualSides(rows)).toBe(1);
    const next = acceptFormattingOnly(rows, {});
    expect(next[choiceKey("selopt_1", "bsc")]).toBe("accept");
    expect(next[choiceKey("selopt_1", "sportlots")]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

describe("buildDecisions", () => {
  it("emits nothing at all for an undecided side", () => {
    // Undecided has to stay undecided across sessions, or "I'll look at this
    // tomorrow" silently becomes "I said no".
    expect(buildDecisions([BOTH_SIDES], {})).toEqual([]);
  });

  it("carries each side's own action, and the row's live baseVersion", () => {
    const decisions = buildDecisions([BOTH_SIDES], {
      [choiceKey("selopt_1", "bsc")]: "accept",
      [choiceKey("selopt_1", "sportlots")]: "decline",
    });
    expect(decisions).toEqual([
      { existingId: id(1), baseVersion: 1000, side: "bsc", action: "accept" },
      {
        existingId: id(1),
        baseVersion: 1000,
        side: "sportlots",
        action: "decline",
      },
    ]);
  });

  it("ignores a choice for a side this row has no suggestion on", () => {
    const decisions = buildDecisions([suggestion()], {
      [choiceKey("selopt_1", "sportlots")]: "accept",
    });
    expect(decisions).toEqual([]);
  });

  it("counts decisions, not rows, in the footer summary", () => {
    const summary = summariseChoices([BOTH_SIDES], {
      [choiceKey("selopt_1", "bsc")]: "accept",
    });
    expect(summary).toEqual({ accepting: 1, declining: 0, undecided: 1 });
  });
});

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

function renderModal(rows: SelectorSyncSuggestion[] = [BOTH_SIDES]) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <SelectorSyncReviewModal
      isOpen
      level="setName"
      columnLabel="Sets"
      suggestions={rows}
      onClose={onClose}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onClose };
}

function sideRow(label: string) {
  // Each side's take/keep pair is disambiguated by its aria-label, exactly as
  // the E2E author will have to do when a column shows more than one row.
  // Labels lead with the visible words ("Take it —" / "Keep mine —") so the
  // accessible name still contains the button's own visible text (WCAG 2.5.3).
  return {
    accept: screen.getByLabelText(
      `Take it — rename "TCG" to "${label}" (from ${label === "Topps" ? "BSC" : "SportLots"})`,
    ),
    decline: screen.getByLabelText(
      `Keep mine — keep "TCG"; stop suggesting ${
        label === "Topps" ? "BSC" : "SportLots"
      }'s "${label}"`,
    ),
  };
}

describe("SelectorSyncReviewModal — the dialog", () => {
  it("titles itself for the column, and says what happens to YOUR name", () => {
    // NEO-239 copy pass. The old explainer ended "NeonBinder owns these names
    // — nothing changes unless you accept a suggestion here", which stated a
    // rule about the system rather than what the operator's data does. The
    // replacement is pinned here because both halves are load-bearing: the
    // title is an E2E anchor, and the second sentence is the whole reassurance
    // that opening this dialog has not already changed anything.
    renderModal();
    expect(screen.getByText("Name Check — Sets")).toBeTruthy();
    expect(
      screen.getByText(
        /A marketplace calls 1 of your sets something else\. Yours stays — unless you take theirs\./,
      ),
    ).toBeTruthy();
    // The retired sentence must not come back with a reword.
    expect(screen.queryByText(/owns these names/)).toBeNull();
  });

  it("pluralises the explainer on more than one row", () => {
    renderModal([
      BOTH_SIDES,
      suggestion({ existingId: id(2), currentValue: "Score" }),
    ]);
    expect(
      screen.getByText(
        /A marketplace calls 2 of your sets something else\. Yours stay — unless you take theirs\./,
      ),
    ).toBeTruthy();
  });

  it("names the marketplace as the one doing the calling, in STRAIGHT quotes", () => {
    // The E2E asserts this exact string, and the quotes are the fragile part:
    // typographic quotes here would render U+201C/U+201D and a YAML assertion
    // typed with "…" would silently never match.
    renderModal();
    expect(screen.getByText('BSC calls it "Topps"')).toBeTruthy();
    expect(
      screen.getByText('SportLots calls it "Topps Chewing Gum"'),
    ).toBeTruthy();
  });

  it("opens with Apply disabled — nothing decided, nothing to send", () => {
    renderModal();
    expect(
      screen.getByLabelText("Apply decisions").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("accepting one side and declining the other is a normal outcome", () => {
    // Not a three-way radiogroup: BSC catching up to our spelling while
    // SportLots does not is the expected shape, not a conflict.
    const { onConfirm } = renderModal();
    fireEvent.click(sideRow("Topps").accept);
    fireEvent.click(sideRow("Topps Chewing Gum").decline);
    fireEvent.click(screen.getByLabelText("Apply decisions"));

    expect(onConfirm).toHaveBeenCalledWith({
      decisions: [
        { existingId: id(1), baseVersion: 1000, side: "bsc", action: "accept" },
        {
          existingId: id(1),
          baseVersion: 1000,
          side: "sportlots",
          action: "decline",
        },
      ],
    });
  });

  it("cycles accept -> decline -> off for one side, and Apply reflects only the final state", () => {
    const { onConfirm } = renderModal();
    const { accept, decline } = sideRow("Topps");

    fireEvent.click(accept);
    expect(accept.getAttribute("aria-pressed")).toBe("true");
    expect(decline.getAttribute("aria-pressed")).toBe("false");

    // Clicking Decline while Accept is pressed must SWITCH, not accumulate —
    // a side is one choice, never both at once.
    fireEvent.click(decline);
    expect(accept.getAttribute("aria-pressed")).toBe("false");
    expect(decline.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("0 to take · 1 to keep")).toBeTruthy();

    // Pressing the now-pressed Decline again returns to the resting,
    // undecided third state.
    fireEvent.click(decline);
    expect(accept.getAttribute("aria-pressed")).toBe("false");
    expect(decline.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("0 to take · 0 to keep")).toBeTruthy();

    // Nothing decided on this side; the OTHER side (SportLots) is still
    // untouched from its seeded undecided state, so Apply stays disabled.
    expect(
      screen.getByLabelText("Apply decisions").hasAttribute("disabled"),
    ).toBe(true);

    fireEvent.click(accept);
    fireEvent.click(screen.getByLabelText("Apply decisions"));
    expect(onConfirm).toHaveBeenCalledWith({
      decisions: [
        { existingId: id(1), baseVersion: 1000, side: "bsc", action: "accept" },
      ],
    });
  });

  it("pressing the pressed button again returns that side to undecided", () => {
    renderModal();
    const { accept } = sideRow("Topps");
    fireEvent.click(accept);
    expect(accept.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(accept);
    expect(accept.getAttribute("aria-pressed")).toBe("false");
    // Back to the resting state, so Apply has nothing to send.
    expect(
      screen.getByLabelText("Apply decisions").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("counts the pending decisions in a live region", () => {
    renderModal();
    fireEvent.click(sideRow("Topps").accept);
    expect(
      screen.getByText("1 to take · 0 to keep").getAttribute("role"),
    ).toBe("status");
  });

  it("Escape closes and confirms nothing", () => {
    // Nothing was decided, so there is nothing to lose by leaving — and there
    // is deliberately no confirm-before-Escape guard.
    const { onClose, onConfirm } = renderModal();
    fireEvent.click(sideRow("Topps").accept);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("offers the formatting bulk only when there is a fold-equal side", () => {
    renderModal();
    expect(screen.queryByText(/Take all style-only/)).toBeNull();
  });

  it("'Keep all mine' reports how many sides it is about to decline", () => {
    renderModal();
    const bulk = screen.getByText("Keep all mine (2)");
    fireEvent.click(bulk);
    // Once nothing is undecided, the button becomes its own undo.
    expect(screen.getByText("Undo that")).toBeTruthy();
    expect(screen.getByText("0 to take · 2 to keep")).toBeTruthy();
  });

  it("says so rather than closing when the live list empties out", () => {
    // The affordance never opens this at zero, so this is another admin (or a
    // bulk decline) resolving the last row while the dialog is open.
    renderModal([]);
    expect(screen.getByText("All caught up — nothing left to review.")).toBeTruthy();
  });
});
