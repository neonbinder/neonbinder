/**
 * NEO-335 — the wizard's "Card titles" step: grouping, the meters, inline
 * edits, recompute on a team change, and that nothing here blocks a save.
 *
 * Deciding lives in `card-titles.ts` (its own test); this pins what the
 * operator sees and what the wizard is told.
 */

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import type { TitleContext } from "../../convex/features/listingInputs";
import CardTitlesStep from "./CardTitlesStep";
import type { PreviewCardForTitles, TitleAnswer } from "./card-titles";
import type { TeamAnswer } from "./teams-on-cards";

afterEach(() => {
  vi.useRealTimers();
});

const LONG_SET =
  "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box";
const LONG_VARIATION =
  "Image Variation; Wearing a throwback uniform with the 1970s powder blue logo";

const CONTEXT: TitleContext = {
  sportValue: "Baseball",
  setNameValue: LONG_SET,
  inheritedFeatures: { manufacturer: "Topps", season: "2026" },
  setTeamNames: [],
  players: [
    { printed: "Shohei Ohtani", name: "Shohei Ohtani" },
    { printed: "Mike Trout", name: "Mike Trout" },
  ],
  teams: [],
};

const SHORT: TitleContext = { ...CONTEXT, setNameValue: "Chrome" };

function card(n: string, extra: Partial<PreviewCardForTitles> = {}): PreviewCardForTitles {
  return { cardNumber: n, cardName: `Card ${n}`, players: ["Shohei Ohtani"], ...extra };
}

function setup(props: {
  cards: PreviewCardForTitles[];
  titleContext?: TitleContext;
  teamAnswers?: Array<TeamAnswer | undefined>;
  answers?: Array<TitleAnswer | undefined>;
  names?: React.ComponentProps<typeof CardTitlesStep>["names"];
}) {
  const onAnswersChange = vi.fn();
  const onWizardKey = vi.fn();
  const element = (p: typeof props) => (
    // The wizard's own key handler, to prove Enter/Escape stay in the field.
    <div onKeyDown={(e) => onWizardKey(e.key)}>
      <CardTitlesStep
        cards={p.cards}
        titleContext={p.titleContext ?? CONTEXT}
        teamAnswers={p.teamAnswers}
        names={p.names}
        answers={p.answers ?? []}
        onAnswersChange={onAnswersChange}
      />
    </div>
  );
  const utils = render(element(props));
  return {
    ...utils,
    onAnswersChange,
    onWizardKey,
    rerenderWith: (next: Partial<typeof props>) => utils.rerender(element({ ...props, ...next })),
  };
}

describe("CardTitlesStep — what is on screen", () => {
  test("renders nothing when no new card needs a look", () => {
    const { container } = setup({ cards: [card("1")], titleContext: SHORT });
    expect(container.textContent).toBe("");
  });

  test("the two approved leads, each with its own fields and meters", () => {
    setup({
      cards: [card("1"), card("2", { cardVariation: LONG_VARIATION })],
    });
    expect(screen.getByRole("heading", { name: "Variation's too long to list. Trim it to 65." }))
      .toBeTruthy();
    expect(screen.getByRole("heading", { name: "Trimmed to fit. Keep it, or make it yours." }))
      .toBeTruthy();

    const variation = screen.getByRole("textbox", { name: "Variation for #2 Card 2" });
    expect((variation as HTMLInputElement).value).toBe(LONG_VARIATION);
    expect(screen.getByText(`${LONG_VARIATION.length}/65`)).toBeTruthy();

    const title = screen.getByRole("textbox", { name: "Title for #1 Card 1" }) as HTMLInputElement;
    expect(title.value).toMatch(/#1 RC$|#1$/);
    expect(screen.getAllByText(`${title.value.length}/80`).length).toBeGreaterThan(0);
  });

  test("identical drops share one line with a count; each card's own name sits under its field", () => {
    setup({ cards: [card("1"), card("2", { players: ["Mike Trout"] })] });
    const shared = screen.getByText(/^Left out to fit: Collectors Box/);
    expect(shared.textContent).toContain("(2 cards)");
    expect(shared.textContent).not.toMatch(/Ohtani|Trout/);
    expect(screen.getByText("Left out to fit: Shohei Ohtani")).toBeTruthy();
    expect(screen.getByText("Left out to fit: Mike Trout")).toBeTruthy();
  });

  test("two rows the same words would name get distinct field names", () => {
    setup({ cards: [card("7"), card("7")] });
    expect(screen.getByRole("textbox", { name: "Title for #7 Card 7, card 1 of 2" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Title for #7 Card 7, card 2 of 2" })).toBeTruthy();
  });
});

describe("CardTitlesStep — inline edit", () => {
  test("typing makes the title theirs: meter follows, 'Use trimmed title' appears, blur tells the wizard", () => {
    const { onAnswersChange } = setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" });
    fireEvent.change(field, { target: { value: "2026 Topps Chrome Ohtani #1 RC" } });
    expect(screen.getByText("30/80")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use trimmed title for #1 Card 1" })).toBeTruthy();
    fireEvent.blur(field);
    expect(onAnswersChange).toHaveBeenLastCalledWith([{ listingTitle: "2026 Topps Chrome Ohtani #1 RC" }]);
  });

  test("'Use trimmed title' puts the generated title back", () => {
    const { onAnswersChange } = setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" }) as HTMLInputElement;
    const generated = field.value;
    fireEvent.change(field, { target: { value: "Mine #1" } });
    fireEvent.blur(field);
    fireEvent.click(screen.getByRole("button", { name: "Use trimmed title for #1 Card 1" }));
    expect(field.value).toBe(generated);
    fireEvent.blur(field);
    expect(onAnswersChange).toHaveBeenLastCalledWith([undefined]);
  });

  test("past the cap: 'Too long to list as-is.' as a polite status, never an alert", () => {
    setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" });
    fireEvent.change(field, { target: { value: "t".repeat(84) } });
    expect(screen.getByRole("status").textContent).toBe("Too long to list as-is.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("84/80")).toBeTruthy();
  });

  test("Enter settles in place and never reaches the wizard", () => {
    const { onAnswersChange, onWizardKey } = setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" });
    fireEvent.change(field, { target: { value: "Mine #1" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onAnswersChange).toHaveBeenLastCalledWith([{ listingTitle: "Mine #1" }]);
    expect(onWizardKey).not.toHaveBeenCalled();
  });

  test("Escape undoes what was typed since focus, in place; with nothing to undo it is the wizard's", () => {
    const { onWizardKey } = setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" }) as HTMLInputElement;
    const generated = field.value;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Mine #1" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe(generated);
    expect(onWizardKey).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: "Escape" });
    expect(onWizardKey).toHaveBeenCalledWith("Escape");
  });

  test("an edit settles on its own a beat after typing stops, and on unmount", () => {
    vi.useFakeTimers();
    const { onAnswersChange, unmount } = setup({ cards: [card("1"), card("2")] });
    const first = screen.getByRole("textbox", { name: "Title for #1 Card 1" });
    fireEvent.change(first, { target: { value: "Mine #1" } });
    expect(onAnswersChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onAnswersChange).toHaveBeenLastCalledWith([{ listingTitle: "Mine #1" }, undefined]);

    const second = screen.getByRole("textbox", { name: "Title for #2 Card 2" });
    fireEvent.change(second, { target: { value: "Mine #2" } });
    unmount();
    expect(onAnswersChange).toHaveBeenLastCalledWith([
      { listingTitle: "Mine #1" },
      { listingTitle: "Mine #2" },
    ]);
  });

  test("a title is one line: a pasted newline becomes a space", () => {
    setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "2026 Topps\n  Chrome #1" } });
    expect(field.value).toBe("2026 Topps Chrome #1");
  });

  test("a variation trimmed in place answers every card that prints it", () => {
    const { onAnswersChange } = setup({
      cards: [
        card("1", { cardVariation: LONG_VARIATION }),
        card("2", { cardVariation: LONG_VARIATION }),
      ],
      titleContext: SHORT,
    });
    const field = screen.getByRole("textbox", { name: "Variation for #1 Card 1 and 1 more card" });
    fireEvent.change(field, { target: { value: "Throwback uniform" } });
    expect(screen.getByText("17/65")).toBeTruthy();
    fireEvent.blur(field);
    expect(onAnswersChange).toHaveBeenLastCalledWith([
      { cardVariation: "Throwback uniform" },
      { cardVariation: "Throwback uniform" },
    ]);
    const list = screen.getByRole("list", { name: "Cards for #1 Card 1 and 1 more card" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("CardTitlesStep — recomputed from the team answers", () => {
  test("an untouched row follows a team answer; an edited one keeps the operator's words", () => {
    const teamId = "t1" as Id<"teams">;
    const names = { teamNameById: new Map([[teamId, "Los Angeles Dodgers"]]) };
    const { rerenderWith } = setup({ cards: [card("1"), card("2")], names });
    expect(screen.queryByText(/Los Angeles Dodgers/)).toBeNull();

    const second = screen.getByRole("textbox", { name: "Title for #2 Card 2" });
    fireEvent.change(second, { target: { value: "Mine #2" } });

    rerenderWith({ teamAnswers: [{ teamIds: [teamId] }, { teamIds: [teamId] }] });
    expect(screen.getAllByText(/Left out to fit: Shohei Ohtani, Los Angeles Dodgers/)).toHaveLength(2);
    expect(
      (screen.getByRole("textbox", { name: "Title for #2 Card 2" }) as HTMLInputElement).value,
    ).toBe("Mine #2");
  });
});

describe("CardTitlesStep — never blocks", () => {
  test("nothing on the step is a button that saves, disables or gates anything", () => {
    setup({ cards: [card("1"), card("2", { cardVariation: LONG_VARIATION })] });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" });
    fireEvent.change(field, { target: { value: "t".repeat(90) } });
    const buttons = screen.queryAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Use trimmed title"]);
    expect(document.querySelector("[disabled]")).toBeNull();
  });
});
