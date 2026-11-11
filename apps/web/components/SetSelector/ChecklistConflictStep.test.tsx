/**
 * NEO-478 — the wizard's "Checklist says otherwise" step: each card's required
 * radio group inside a plain list item, its two radios (roving tabindex, arrow
 * keys), the always-mounted status line (picks counted, the blocked-Next hint
 * winning on a press), and the Enter focus walk. The wizard that hosts it (and
 * holds Next) is covered by its own tests.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import ChecklistConflictStep, {
  BULK_ANSWER_LABEL,
  CHECKLIST_NEXT_BLOCKED,
  CHECKLIST_STEP_HEADING,
  KEEP_MARKETPLACE_ALL_LABEL,
  KEEP_MARKETPLACE_LABEL,
  USE_CHECKLIST_ALL_LABEL,
  USE_CHECKLIST_LABEL,
  checklistPickedText,
  checklistStepLead,
  differingRuns,
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

const group = (n: string) => screen.getByRole("radiogroup", { name: disagreementLabel(n) });
const keep = (n: string) => within(group(n)).getByRole("radio", { name: KEEP_MARKETPLACE_LABEL });
const use = (n: string) => within(group(n)).getByRole("radio", { name: USE_CHECKLIST_LABEL });
const hint = () => document.getElementById("hint")!;

/** The step as the wizard renders it, with its own answers held, for walks. */
function Hosted({ blocked = 0 }: { blocked?: number }) {
  const [choices, setChoices] = React.useState<Record<number, ChecklistChoice>>({});
  return (
    <ChecklistConflictStep
      rows={rows}
      choices={choices}
      onChoose={(index, choice) => setChoices((prev) => ({ ...prev, [index]: choice }))}
      headingId="h"
      hintId="hint"
      showBlockedHint={blocked}
    />
  );
}

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

  it("pre-picks nothing: every radio starts unchecked and each card says it needs a pick", () => {
    renderStep();
    for (const n of ["60", "61"]) {
      expect(keep(n).getAttribute("aria-checked")).toBe("false");
      expect(use(n).getAttribute("aria-checked")).toBe("false");
      expect(group(n).getAttribute("aria-required")).toBe("true");
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

  it("marks only the picked side as checked", () => {
    renderStep({ choices: { 2: "checklist" } });
    expect(use("60").getAttribute("aria-checked")).toBe("true");
    expect(keep("60").getAttribute("aria-checked")).toBe("false");
    expect(within(group("60")).queryByText("Needs a pick")).toBeNull();
    expect(within(group("61")).getByText("Needs a pick")).toBeTruthy();
  });

  it("holds the blocked hint back until asked, then names what to do while cards are open", () => {
    const { rerender } = renderStep();
    expect(hint().textContent).toBe("");
    expect(hint().getAttribute("role")).toBe("status");
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
    expect(hint().textContent).toBe("");
  });

  it("after each pick the status line counts the picks, and says all answered on the last", () => {
    render(<Hosted />);
    expect(hint().textContent).toBe("");
    fireEvent.click(use("60"));
    expect(hint().textContent).toBe("Picked 1 of 2 cards.");
    // Changing an answer is still a pick, and still one card of two.
    fireEvent.click(keep("60"));
    expect(hint().textContent).toBe("Picked 1 of 2 cards.");
    fireEvent.click(use("61"));
    expect(hint().textContent).toBe("Picked 2 of 2 cards. All answered — hit Next!");
    expect(checklistPickedText(1, 1)).toBe("Picked 1 of 1 card. All answered — hit Next!");
  });

  it("a blocked Next press wins the status line; the next pick takes it back; a second press says it again", () => {
    const { rerender } = render(<Hosted blocked={0} />);
    fireEvent.click(use("60"));
    expect(hint().textContent).toBe("Picked 1 of 2 cards.");
    rerender(<Hosted blocked={1} />);
    expect(hint().textContent).toBe(CHECKLIST_NEXT_BLOCKED);
    // A pick after the press: the count again (the card is still open, so
    // the press is not forgotten, just answered).
    fireEvent.click(keep("60"));
    expect(hint().textContent).toBe("Picked 1 of 2 cards.");
    rerender(<Hosted blocked={2} />);
    expect(hint().textContent).toBe(CHECKLIST_NEXT_BLOCKED);
    // The last pick: all answered, the hint no longer applies.
    fireEvent.click(keep("61"));
    expect(hint().textContent).toBe("Picked 2 of 2 cards. All answered — hit Next!");
  });

  it("is a plain list: each item holds the card's radio group, never a role of its own", () => {
    renderStep();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.getAttribute("role")).toBeNull();
      expect(item.getAttribute("aria-label")).toBeNull();
    }
    expect(items[0].contains(group("60"))).toBe(true);
    expect(items[1].contains(group("61"))).toBe(true);
  });

  it("names a picked radio exactly by its label: the check sits beside it", () => {
    renderStep({ choices: { 5: "checklist" } });
    expect(within(group("61")).getByRole("radio", { name: USE_CHECKLIST_LABEL, checked: true })).toBe(
      use("61"),
    );
  });

  it("titles each side with a paragraph, never a term with no definition", () => {
    renderStep();
    const g = group("60");
    expect(within(g).getByText("Marketplace").tagName).toBe("P");
    expect(within(g).getByText("Your checklist").tagName).toBe("P");
    for (const dl of Array.from(g.querySelectorAll("dl"))) {
      expect(dl.querySelectorAll("dt").length).toBe(dl.querySelectorAll("dd").length);
    }
  });

  it("does not dim the column turned down", () => {
    renderStep({ choices: { 2: "checklist" } });
    expect(group("60").querySelector(".opacity-70")).toBeNull();
  });

  it("roving tabindex: one Tab stop per card, on the picked radio, else on Keep the marketplace's", () => {
    renderStep({ choices: { 2: "checklist" } });
    expect(use("60").tabIndex).toBe(0);
    expect(keep("60").tabIndex).toBe(-1);
    expect(keep("61").tabIndex).toBe(0);
    expect(use("61").tabIndex).toBe(-1);
  });

  it("arrow keys move between the two radios and pick, wrapping", () => {
    render(<Hosted />);
    act(() => {
      keep("60").focus();
    });
    fireEvent.keyDown(keep("60"), { key: "ArrowRight" });
    expect(use("60").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(use("60"));
    fireEvent.keyDown(use("60"), { key: "ArrowDown" });
    expect(keep("60").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(keep("60"));
    fireEvent.keyDown(keep("60"), { key: "ArrowLeft" });
    expect(use("60").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(use("60"), { key: "ArrowUp" });
    expect(keep("60").getAttribute("aria-checked")).toBe("true");
    // Arrows stay inside the card: the next card is untouched.
    expect(keep("61").getAttribute("aria-checked")).toBe("false");
    expect(hint().textContent).toBe("Picked 1 of 2 cards.");
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
    fireEvent.keyDown(keep("60"), { key: "ArrowRight" });
    expect(onChoose).not.toHaveBeenCalled();
    expect(hint().textContent).toBe("");
    expect(keep("60").getAttribute("aria-disabled")).toBe("true");
  });

  it("hands the first unanswered card's marketplace radio to firstOpenRef", () => {
    const ref = React.createRef<HTMLButtonElement>();
    renderStep({ choices: { 2: "checklist" }, firstOpenRef: ref });
    expect(ref.current).toBe(keep("61"));
  });

  it("heads each card with its number alone, never one side's name", () => {
    renderStep();
    const heading = group("60").querySelector("p")!;
    expect(heading.textContent).toContain("#60");
    expect(heading.textContent).not.toContain("Rhett Lowder");
    // The group's name is unchanged.
    expect(group("60").getAttribute("aria-label")).toBe("Disagreement on #60");
  });

  it("labels one player 'Player' and several 'Players', like Team / Teams", () => {
    render(
      <ChecklistConflictStep
        rows={[
          {
            index: 0,
            cardNumber: "11",
            cardName: "League Leaders",
            conflict: {
              players: { marketplace: ["Alonso"], checklist: ["Alonso", "Schwarber"] },
            },
          },
        ]}
        choices={{}}
        onChoose={vi.fn()}
        headingId="h"
        hintId="hint"
      />,
    );
    const terms = Array.from(group("11").querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(terms).toEqual(["Player", "Players"]);
  });

  it("marks the characters that differ on both sides, with an underline as well as a tint", () => {
    render(
      <ChecklistConflictStep
        rows={[
          {
            index: 0,
            cardNumber: "2",
            cardName: "Trevor Burgess",
            conflict: { players: { marketplace: ["Trevor Burgess"], checklist: ["Trevor Bugress"] } },
          },
        ]}
        choices={{}}
        onChoose={vi.fn()}
        headingId="h"
        hintId="hint"
      />,
    );
    const marks = Array.from(group("2").querySelectorAll("[data-name-differs]"));
    expect(marks.map((m) => m.textContent)).toEqual(["r", "r"]);
    for (const mark of marks) expect(mark.className).toContain("underline");
    // Each name still reads whole.
    const dds = Array.from(group("2").querySelectorAll("dd")).map((dd) => dd.textContent);
    expect(dds).toEqual(["Trevor Burgess", "Trevor Bugress"]);
  });

  it("differingRuns marks only what the other name lacks, and leaves unrelated names plain", () => {
    const { a, b } = differingRuns("Trevor Burgess", "Trevor Bugress");
    expect(a.map((r) => r.text).join("")).toBe("Trevor Burgess");
    expect(b.map((r) => r.text).join("")).toBe("Trevor Bugress");
    expect(a.filter((r) => r.differs).map((r) => r.text)).toEqual(["r"]);
    expect(b.filter((r) => r.differs).map((r) => r.text)).toEqual(["r"]);
    expect(differingRuns("Rhett Lowder", "Rhett Loder").a.filter((r) => r.differs)).toEqual([
      { text: "w", differs: true },
    ]);
    expect(differingRuns("Rhett Lowder", "Rhett Loder").b).toEqual([
      { text: "Rhett Loder", differs: false },
    ]);
    // Different names, not a misread: no marks.
    expect(differingRuns("Mike Trout", "Shohei Ohtani").a).toEqual([
      { text: "Mike Trout", differs: false },
    ]);
    expect(differingRuns("Reds", "Cincinnati Reds").b).toEqual([
      { text: "Cincinnati Reds", differs: false },
    ]);
    expect(differingRuns("Same", "Same").a).toEqual([{ text: "Same", differs: false }]);
  });

  it("marks the picked column with the selection edge and a neutral tint, not a ring", () => {
    renderStep({ choices: { 2: "checklist" } });
    const column = use("60").closest("div.flex-col")!;
    expect(column.className).toContain("shadow-[inset_4px_0_0_var(--color-selection)]");
    expect(column.className).toContain("bg-list-hover-raised");
    expect(column.className).not.toContain("inset_0_0_0_2px");
    const other = keep("60").closest("div.flex-col")!;
    expect(other.className).not.toContain("--color-selection");
  });

  describe("bulk answers (S5)", () => {
    const bulk = () => screen.getByRole("group", { name: BULK_ANSWER_LABEL });

    it("answers every card with one press, then each card can be changed on its own", () => {
      render(<Hosted />);
      fireEvent.click(within(bulk()).getByRole("button", { name: KEEP_MARKETPLACE_ALL_LABEL }));
      expect(keep("60").getAttribute("aria-checked")).toBe("true");
      expect(keep("61").getAttribute("aria-checked")).toBe("true");
      expect(hint().textContent).toBe("Picked 2 of 2 cards. All answered — hit Next!");
      fireEvent.click(use("61"));
      expect(use("61").getAttribute("aria-checked")).toBe("true");
      expect(keep("60").getAttribute("aria-checked")).toBe("true");
      fireEvent.click(within(bulk()).getByRole("button", { name: USE_CHECKLIST_ALL_LABEL }));
      expect(use("60").getAttribute("aria-checked")).toBe("true");
      expect(use("61").getAttribute("aria-checked")).toBe("true");
    });

    it("is reachable by keyboard: plain buttons in the Tab order, outside the cards", () => {
      renderStep();
      const keepAll = within(bulk()).getByRole("button", { name: KEEP_MARKETPLACE_ALL_LABEL });
      const useAll = within(bulk()).getByRole("button", { name: USE_CHECKLIST_ALL_LABEL });
      expect(keepAll.tabIndex).toBe(0);
      expect(useAll.tabIndex).toBe(0);
      for (const item of screen.getAllByRole("listitem")) {
        expect(item.contains(keepAll)).toBe(false);
      }
      // The radios' names stay exactly their labels.
      expect(KEEP_MARKETPLACE_ALL_LABEL).toBe("Keep the marketplace's on all");
      expect(USE_CHECKLIST_ALL_LABEL).toBe("Use the checklist's on all");
    });

    it("reports only the cards whose answer changes", () => {
      const { onChoose } = renderStep({ choices: { 2: "checklist" } });
      fireEvent.click(within(bulk()).getByRole("button", { name: USE_CHECKLIST_ALL_LABEL }));
      expect(onChoose).toHaveBeenCalledTimes(1);
      expect(onChoose).toHaveBeenCalledWith(5, "checklist");
    });

    it("a disabled step answers nothing in bulk", () => {
      const { onChoose } = renderStep({ disabled: true });
      fireEvent.click(within(bulk()).getByRole("button", { name: KEEP_MARKETPLACE_ALL_LABEL }));
      expect(onChoose).not.toHaveBeenCalled();
    });

    it("is not offered for a single card", () => {
      renderStep({ rows: [rows[0]] });
      expect(screen.queryByRole("group", { name: BULK_ANSWER_LABEL })).toBeNull();
    });
  });

  it("the lead says one card or N cards", () => {
    expect(checklistStepLead(1)).toMatch(/this card/);
    expect(checklistStepLead(3)).toMatch(/3 cards/);
  });
});
