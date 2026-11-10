/**
 * NEO-478 — the wizard's "Checklist says otherwise" step: each card's group,
 * its two buttons (aria-pressed), the blocked-Next hint, and the Enter focus
 * walk. The wizard that hosts it (and holds Next) is covered by its own tests.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import ChecklistConflictStep, {
  CHECKLIST_NEXT_BLOCKED,
  CHECKLIST_STEP_HEADING,
  KEEP_MARKETPLACE_LABEL,
  USE_CHECKLIST_LABEL,
  checklistStepLead,
  disagreementLabel,
  type ChecklistConflictRow,
} from "./ChecklistConflictStep";
import type { ChecklistChoice } from "./checklist-conflict";

const rows: ChecklistConflictRow[] = [
  {
    index: 2,
    cardNumber: "60",
    cardName: "Rhett Lowder",
    conflict: {
      players: { marketplace: ["Rhett Lowder"], checklist: ["Rhett Loder"] },
      teams: { marketplace: ["Reds"], checklist: ["Cincinnati Reds"] },
    },
  },
  {
    index: 5,
    cardNumber: "61",
    cardName: "Team Card",
    conflict: { teams: { marketplace: [], checklist: ["Kansas City Royals"] } },
  },
];

function renderStep(
  over: Partial<React.ComponentProps<typeof ChecklistConflictStep>> = {},
) {
  const onChoose = vi.fn();
  const onAllAnswered = vi.fn();
  const utils = render(
    <>
      <ChecklistConflictStep
        rows={rows}
        choices={{}}
        onChoose={onChoose}
        onAllAnswered={onAllAnswered}
        headingId="h"
        hintId="hint"
        {...over}
      />
      <button type="button">Next</button>
    </>,
  );
  return { onChoose, onAllAnswered, ...utils };
}

const group = (n: string) => screen.getByRole("group", { name: disagreementLabel(n) });
const keep = (n: string) => within(group(n)).getByRole("button", { name: KEEP_MARKETPLACE_LABEL });
const use = (n: string) => within(group(n)).getByRole("button", { name: USE_CHECKLIST_LABEL });

describe("ChecklistConflictStep", () => {
  it("names the step and each card's group with the contract's exact wording", () => {
    renderStep();
    expect(screen.getByRole("heading", { name: "Checklist says otherwise" })).toBeTruthy();
    expect(CHECKLIST_STEP_HEADING).toBe("Checklist says otherwise");
    expect(group("60")).toBeTruthy();
    expect(group("61")).toBeTruthy();
    expect(KEEP_MARKETPLACE_LABEL).toBe("Keep the marketplace's");
    expect(USE_CHECKLIST_LABEL).toBe("Use the checklist's");
  });

  it("shows both sides, with 'Nobody listed' / 'No team listed' for an empty side", () => {
    renderStep();
    expect(within(group("60")).getByText("Rhett Loder")).toBeTruthy();
    expect(within(group("60")).getByText("Cincinnati Reds")).toBeTruthy();
    expect(within(group("61")).getByText("No team listed")).toBeTruthy();
    // Card 61 has only a teams disagreement: no Players row.
    expect(within(group("61")).queryByText("Players")).toBeNull();
  });

  it("pre-picks nothing: every button starts unpressed and each card says it needs a pick", () => {
    renderStep();
    for (const n of ["60", "61"]) {
      expect(keep(n).getAttribute("aria-pressed")).toBe("false");
      expect(use(n).getAttribute("aria-pressed")).toBe("false");
    }
    expect(screen.getAllByText("Needs a pick")).toHaveLength(2);
  });

  it("reports the preview index, not the row position, when a side is clicked", () => {
    const { onChoose } = renderStep();
    fireEvent.click(use("61"));
    expect(onChoose).toHaveBeenCalledWith(5, "checklist");
    fireEvent.click(keep("60"));
    expect(onChoose).toHaveBeenLastCalledWith(2, "marketplace");
  });

  it("marks only the picked side as pressed", () => {
    renderStep({ choices: { 2: "checklist" } });
    expect(use("60").getAttribute("aria-pressed")).toBe("true");
    expect(keep("60").getAttribute("aria-pressed")).toBe("false");
    expect(within(group("60")).queryByText("Needs a pick")).toBeNull();
    expect(within(group("61")).getByText("Needs a pick")).toBeTruthy();
  });

  it("holds the blocked hint back until asked, then names what to do while cards are open", () => {
    const { rerender } = renderStep();
    const hint = () => document.getElementById("hint")!;
    expect(hint().textContent).toBe("");
    rerender(
      <ChecklistConflictStep
        rows={rows}
        choices={{ 2: "checklist" }}
        onChoose={vi.fn()}
        headingId="h"
        hintId="hint"
        showBlockedHint
      />,
    );
    expect(hint().textContent).toBe(CHECKLIST_NEXT_BLOCKED);
    expect(hint().getAttribute("role")).toBe("status");
  });

  it("drops the blocked hint once every card is answered", () => {
    renderStep({
      choices: { 2: "checklist", 5: "marketplace" } as Record<number, ChecklistChoice>,
      showBlockedHint: true,
    });
    expect(document.getElementById("hint")!.textContent).toBe("");
  });

  it("Enter on a pick moves focus to the next card still waiting", () => {
    const { onChoose, onAllAnswered } = renderStep();
    keep("60").focus();
    fireEvent.keyDown(keep("60"), { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith(2, "marketplace");
    expect(document.activeElement).toBe(keep("61"));
    expect(onAllAnswered).not.toHaveBeenCalled();
  });

  it("Enter on the last open card hands focus on instead of walking", () => {
    const { onChoose, onAllAnswered } = renderStep({ choices: { 2: "checklist" } });
    fireEvent.keyDown(use("61"), { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith(5, "checklist");
    expect(onAllAnswered).toHaveBeenCalledTimes(1);
  });

  it("Enter picks once: the keydown is consumed so the button's click does not pick twice", () => {
    const { onChoose } = renderStep();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    keep("60").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("ignores a held (repeating) Enter", () => {
    const { onChoose } = renderStep();
    fireEvent.keyDown(keep("60"), { key: "Enter", repeat: true });
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("a disabled step picks nothing and says so with aria-disabled", () => {
    const { onChoose } = renderStep({ disabled: true });
    fireEvent.click(keep("60"));
    fireEvent.keyDown(use("60"), { key: "Enter" });
    expect(onChoose).not.toHaveBeenCalled();
    expect(keep("60").getAttribute("aria-disabled")).toBe("true");
  });

  it("hands the first unanswered card's marketplace button to firstOpenRef", () => {
    const ref = React.createRef<HTMLButtonElement>();
    renderStep({ choices: { 2: "checklist" }, firstOpenRef: ref });
    expect(ref.current).toBe(keep("61"));
  });

  it("the lead says one card or N cards", () => {
    expect(checklistStepLead(1)).toMatch(/this card/);
    expect(checklistStepLead(3)).toMatch(/3 cards/);
  });
});
