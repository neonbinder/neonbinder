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
    { printed: "Aaron Judge", name: "Aaron Judge" },
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
  headingId?: string;
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
        headingId={p.headingId}
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
    const teamId = "t1" as Id<"teams">;
    setup({
      // Aaron Judge, not Mike Trout: a name of 10 characters or fewer leaves
      // room for "Anniversary" (the card number goes before a set word, Jason
      // 2026-10-19), so the two cards would no longer lose the same words.
      cards: [card("1"), card("2", { players: ["Aaron Judge"] })],
      // A team that does not fit is the card's OWN loss; the set words the
      // core gave up are shared.
      names: { teamNameById: new Map([[teamId, "Los Angeles Dodgers"]]) },
      teamAnswers: [{ teamIds: [teamId] }, undefined],
    });
    const shared = screen.getByText(/^Left out to fit: Anniversary Collectors Box/);
    expect(shared.textContent).toContain("(2 cards)");
    expect(shared.textContent).not.toMatch(/Ohtani|Judge|Dodgers/);
    expect(screen.getByText("Left out to fit: Los Angeles Dodgers")).toBeTruthy();
    // NEO-339: the set words go before a player's, so both names are in.
    const first = screen.getByRole("textbox", { name: "Title for #1 Card 1" }) as HTMLInputElement;
    const second = screen.getByRole("textbox", { name: "Title for #2 Card 2" }) as HTMLInputElement;
    expect(first.value).toContain("Shohei Ohtani #1");
    expect(second.value).toContain("Aaron Judge #2");
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
    expect(screen.getAllByText("Left out to fit: Los Angeles Dodgers")).toHaveLength(2);
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

describe("CardTitlesStep — accessibility wiring", () => {
  test("'Use trimmed title' hands focus to its field instead of dropping it on <body>", () => {
    setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" });
    fireEvent.change(field, { target: { value: "Mine #1" } });
    const reset = screen.getByRole("button", { name: "Use trimmed title for #1 Card 1" });
    reset.focus();
    fireEvent.click(reset);
    expect(screen.queryByRole("button", { name: "Use trimmed title for #1 Card 1" })).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  test("'Use trimmed title' clears the 24px target floor", () => {
    setup({ cards: [card("1")] });
    fireEvent.change(screen.getByRole("textbox", { name: "Title for #1 Card 1" }), {
      target: { value: "Mine #1" },
    });
    const reset = screen.getByRole("button", { name: "Use trimmed title for #1 Card 1" });
    expect(reset.className).toContain("leading-4");
    expect(reset.className).toContain("py-1");
  });

  test("headingId lands on the titles lead when there are titles, for the wizard's Next", () => {
    setup({
      cards: [card("1"), card("2", { cardVariation: LONG_VARIATION })],
      headingId: "titles-lead",
    });
    expect(document.getElementById("titles-lead")?.textContent).toBe(
      "Trimmed to fit. Keep it, or make it yours.",
    );
  });

  test("headingId lands on the variation lead when only variations are on the step", () => {
    setup({
      cards: [card("2", { cardVariation: LONG_VARIATION })],
      titleContext: SHORT,
      headingId: "titles-lead",
    });
    expect(document.getElementById("titles-lead")?.textContent).toBe(
      "Variation's too long to list. Trim it to 65.",
    );
  });

  test("each field is described by its own 'Left out to fit' line and its meter", () => {
    const teamId = "t1" as Id<"teams">;
    setup({
      cards: [card("1")],
      names: { teamNameById: new Map([[teamId, "Los Angeles Dodgers"]]) },
      teamAnswers: [{ teamIds: [teamId] }],
    });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" });
    const ids = (field.getAttribute("aria-describedby") ?? "").split(" ");
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toContain("Left out to fit: Los Angeles Dodgers");
    expect(texts.some((t) => /\/80/.test(t ?? ""))).toBe(true);
    // The over-cap status joins only once the title is over.
    fireEvent.change(field, { target: { value: "t".repeat(84) } });
    const after = (field.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(after).toContain("Too long to list as-is.");
  });

  test("a group of cards is described by the drop they share; its <li> stays a list item", () => {
    setup({ cards: [card("1"), card("2", { players: ["Aaron Judge"] })] });
    const group = screen.getByRole("group");
    const line = document.getElementById(group.getAttribute("aria-describedby")!);
    expect(line?.textContent).toMatch(/^Left out to fit: Anniversary Collectors Box/);
    expect(group.tagName).toBe("DIV");
    expect(group.parentElement?.tagName).toBe("LI");
    expect(within(group).getAllByRole("textbox")).toHaveLength(2);
  });
});

describe("CardTitlesStep — the meter is neutral until past the cap", () => {
  test("a title near 80 shows a plain N/80, with no 'may clip' band", () => {
    setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: "Title for #1 Card 1" }) as HTMLTextAreaElement;
    expect(field.value.length).toBeGreaterThanOrEqual(70);
    const meter = screen.getByText(`${field.value.length}/80`);
    expect(meter.parentElement?.className).toContain("text-gray-400");
    expect(screen.queryByText(/may clip/)).toBeNull();
  });

  test("past 80 it turns the over colour and says by how much", () => {
    setup({ cards: [card("1")] });
    fireEvent.change(screen.getByRole("textbox", { name: "Title for #1 Card 1" }), {
      target: { value: "t".repeat(84) },
    });
    const meter = screen.getByText("84/80");
    expect(meter.parentElement?.className).toContain("text-[#FF2EB3]");
    expect(screen.getByText("4 over")).toBeTruthy();
  });
});
