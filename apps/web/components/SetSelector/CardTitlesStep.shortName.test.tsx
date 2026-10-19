/**
 * NEO-335 title rules — the Card titles step's "Shorter set name for titles"
 * field, and the rendered-row cap.
 *
 * What the field decides (who shows, what the titles become) is pinned in
 * `card-titles.test.tsx`; this pins what the operator sees, the keys, and
 * what the wizard is told.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TitleContext } from "../../convex/features/listingInputs";
import CardTitlesStep, { TITLE_ROWS_SHOWN } from "./CardTitlesStep";
import type { PreviewCardForTitles } from "./card-titles";

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
  players: [{ printed: "Shohei Ohtani", name: "Shohei Ohtani" }],
  teams: [],
};

const LABEL = "Shorter set name for titles";
const LEAD =
  "This set's name runs long. Give it a shorter one for titles, and every card here uses it.";

function card(n: string, extra: Partial<PreviewCardForTitles> = {}): PreviewCardForTitles {
  return { cardNumber: n, cardName: `Card ${n}`, players: ["Shohei Ohtani"], ...extra };
}

function setup(props: {
  cards: PreviewCardForTitles[];
  titleContext?: TitleContext;
  shortName?: string;
  withCallback?: boolean;
  headingId?: string;
}) {
  const onShortNameChange = vi.fn();
  const onWizardKey = vi.fn();
  const utils = render(
    <div onKeyDown={(e) => onWizardKey(e.key)}>
      <CardTitlesStep
        cards={props.cards}
        titleContext={props.titleContext ?? CONTEXT}
        answers={[]}
        onAnswersChange={vi.fn()}
        shortName={props.shortName}
        onShortNameChange={props.withCallback === false ? undefined : onShortNameChange}
        headingId={props.headingId}
      />
    </div>,
  );
  return { ...utils, onShortNameChange, onWizardKey };
}

const titleFields = () =>
  screen.queryAllByRole("textbox").filter((el) => el.getAttribute("aria-label")?.startsWith("Title for"));

describe("CardTitlesStep — the short-name field shows only when it can help", () => {
  test("titles trimmed and no stored short name: the field, its lead and the suggestion", () => {
    setup({ cards: [card("1")] });
    expect(screen.getByRole("heading", { name: LEAD })).toBeTruthy();
    const field = screen.getByRole("textbox", { name: LABEL }) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("Topps Chrome");
    expect(screen.getByText("Suggested: Topps Chrome")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use suggestion" })).toBeTruthy();
  });

  test("a short name already stored: no field (and its titles already use it)", () => {
    const { container } = setup({
      cards: [card("1")],
      titleContext: { ...CONTEXT, listingShortName: "Topps Sapphire" },
    });
    expect(screen.queryByRole("textbox", { name: LABEL })).toBeNull();
    expect(container.textContent).toBe("");
  });

  test("only a variation on the step: no field", () => {
    setup({
      cards: [card("1", { cardVariation: LONG_VARIATION })],
      titleContext: { ...CONTEXT, setNameValue: "Chrome" },
    });
    expect(screen.queryByRole("textbox", { name: LABEL })).toBeNull();
    expect(screen.getByRole("heading", { name: "Variation's too long to list. Trim it to 65." }))
      .toBeTruthy();
  });

  test("no callback from the wizard: no field", () => {
    setup({ cards: [card("1")], withCallback: false });
    expect(screen.queryByRole("textbox", { name: LABEL })).toBeNull();
  });
});

describe("CardTitlesStep — typing recomputes every title live", () => {
  test("the list empties as titles fit; the field stays", () => {
    setup({ cards: [card("1"), card("2")] });
    expect(titleFields()).toHaveLength(2);
    const field = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(field, { target: { value: "Topps Sapphire" } });
    expect(titleFields()).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Trimmed to fit. Keep it, or make it yours." }))
      .toBeNull();
    // Still there, and still holding what was typed.
    expect((screen.getByRole("textbox", { name: LABEL }) as HTMLInputElement).value).toBe(
      "Topps Sapphire",
    );
    expect(screen.getByText("Every title fits now.")).toBeTruthy();
  });

  test("a name that still cuts a card keeps that card, titled with it, and counts it", () => {
    setup({ cards: [card("1"), card("2", { players: ["Shohei Ohtani", "Shohei Ohtani"] })] });
    const field = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(field, {
      target: { value: "Topps Chrome Update Series Sapphire Edition Platinum" },
    });
    const left = titleFields() as HTMLTextAreaElement[];
    expect(left).toHaveLength(1);
    // Titled with the short name, which is cut from its end before any player
    // is (NEO-339).
    expect(left[0].value).toBe(
      "2026 Topps Chrome Update Series Sapphire Shohei Ohtani & Shohei Ohtani #2",
    );
    expect(screen.getByText("1 title still trimmed.")).toBeTruthy();
  });

  test("a refused name shows the server's sentence and changes no title", () => {
    setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(field, { target: { value: "Topps​Sapphire" } });
    expect(screen.getByText("A short name cannot contain zero-width or invisible characters."))
      .toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(titleFields()).toHaveLength(1);
  });

  test("the field is capped at the server's 60", () => {
    setup({ cards: [card("1")] });
    expect(screen.getByRole("textbox", { name: LABEL }).getAttribute("maxlength")).toBe("60");
  });
});

describe("CardTitlesStep — 'Use suggestion'", () => {
  test("fills the field, tells the wizard at once, empties the list, hands focus to the field", () => {
    const { onShortNameChange } = setup({ cards: [card("1")] });
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    const field = screen.getByRole("textbox", { name: LABEL }) as HTMLInputElement;
    expect(field.value).toBe("Topps Chrome");
    expect(onShortNameChange).toHaveBeenLastCalledWith("Topps Chrome");
    expect(titleFields()).toHaveLength(0);
    // The button is gone (the field holds the suggestion); focus did not drop.
    expect(screen.queryByRole("button", { name: "Use suggestion" })).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  test("a draft the wizard kept comes back when the step remounts", () => {
    setup({ cards: [card("1")], shortName: "Topps Sapphire" });
    expect((screen.getByRole("textbox", { name: LABEL }) as HTMLInputElement).value).toBe(
      "Topps Sapphire",
    );
    expect(titleFields()).toHaveLength(0);
  });
});

describe("CardTitlesStep — the short name's keys stay local", () => {
  test("Enter settles in place and never reaches the wizard", () => {
    const { onShortNameChange, onWizardKey } = setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(field, { target: { value: "Topps Sapphire" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onShortNameChange).toHaveBeenLastCalledWith("Topps Sapphire");
    expect(onWizardKey).not.toHaveBeenCalled();
  });

  test("Escape undoes since focus in place; with nothing to undo it is the wizard's", () => {
    const { onWizardKey } = setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: LABEL }) as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Topps Sapphire" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("");
    expect(onWizardKey).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onWizardKey).toHaveBeenCalledWith("Escape");
  });

  test("settles a beat after typing, blank as undefined, and on unmount", () => {
    vi.useFakeTimers();
    const { onShortNameChange, unmount } = setup({ cards: [card("1")] });
    const field = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(field, { target: { value: "  Topps Sapphire " } });
    expect(onShortNameChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onShortNameChange).toHaveBeenLastCalledWith("Topps Sapphire");
    fireEvent.change(field, { target: { value: "  " } });
    unmount();
    expect(onShortNameChange).toHaveBeenLastCalledWith(undefined);
  });

  test("described by the suggestion and its status line; the wizard's heading lands here when no list is left", () => {
    setup({ cards: [card("1")], headingId: "titles-lead" });
    const field = screen.getByRole("textbox", { name: LABEL });
    const ids = (field.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain(
      "Suggested: Topps Chrome",
    );
    expect(document.getElementById("titles-lead")?.textContent).toBe(
      "Trimmed to fit. Keep it, or make it yours.",
    );
    fireEvent.change(field, { target: { value: "Topps Sapphire" } });
    expect(document.getElementById("titles-lead")?.textContent).toBe(LEAD);
  });
});

describe("CardTitlesStep — a long list is capped", () => {
  test(`draws ${TITLE_ROWS_SHOWN} title rows and counts the rest`, () => {
    const cards = Array.from({ length: TITLE_ROWS_SHOWN + 12 }, (_, i) => card(String(i + 1)));
    setup({ cards, withCallback: false });
    expect(titleFields()).toHaveLength(TITLE_ROWS_SHOWN);
    expect(screen.getByText("And 12 more, kept as trimmed.")).toBeTruthy();
  });

  test("no count line when everything fits under the cap", () => {
    setup({ cards: [card("1")], withCallback: false });
    expect(screen.queryByText(/kept as trimmed/)).toBeNull();
  });
});

describe("CardTitlesStep — an operator's own title survives the short name", () => {
  test("the row stays with its own title and a note; 'Use generated title' drops it and refocuses the short name", () => {
    setup({ cards: [card("1"), card("2")] });
    const own = screen.getByRole("textbox", { name: "Title for #1 Card 1" });
    fireEvent.change(own, { target: { value: "My Ohtani title #1" } });
    const shortField = screen.getByRole("textbox", { name: LABEL });
    fireEvent.change(shortField, { target: { value: "Topps Sapphire" } });

    // Card 2 (untouched) left the list; card 1 (theirs) stayed.
    expect(titleFields().map((f) => f.getAttribute("aria-label"))).toEqual([
      "Title for #1 Card 1",
    ]);
    const kept = screen.getByRole("textbox", { name: "Title for #1 Card 1" }) as HTMLTextAreaElement;
    expect(kept.value).toBe("My Ohtani title #1");
    const noteIds = (kept.getAttribute("aria-describedby") ?? "").split(" ");
    expect(noteIds.map((id) => document.getElementById(id)?.textContent)).toContain(
      "Now fits as generated.",
    );
    // Not counted as still trimmed.
    expect(screen.getByText("Every title fits now.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Use generated title for #1 Card 1" }));
    expect(titleFields()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: LABEL }));
  });
});
