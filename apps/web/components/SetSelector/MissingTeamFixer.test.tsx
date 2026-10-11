/**
 * `MissingTeamFixer` — what the chips say, what is preselected, and where
 * focus lands.
 *
 * NEO-236: a chip names its team by the FULL name ("San Diego Padres", never
 * "Padres"). NEO-330 moved that composition to the server — the suggestion
 * carries a ready `label`, era-labelled when the sport holds the name more
 * than once — because the client was composing Location + Name a SECOND time
 * over a name the server had already composed ("San Diego San Diego Padres").
 *
 * NEO-330, the Jimmie Foxx shape (2025 Topps Welcome to the Club: 3X MVP):
 * four "Philadelphia Athletics" rows, none covering 2025; Foxx has no 2025
 * stint, so the server offers his whole career; BSC says "Philadelphia
 * Athletics". The fixer used to preselect the whole career and focus Save, so
 * one Enter wrote four teams. Pinned below: a career fallback is never
 * preselected, BSC's claim arrives as era-labelled NB rows to pick from, a
 * set-year stint BSC contradicts is surfaced rather than preselected, and
 * focus never lands on a Save that would write something unconfirmed.
 *
 * The picker's own behaviour lives in `TeamPicker.test.tsx`; it is stubbed
 * here to show its value, so this file tests one thing.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    cardChecklist: {
      suggestedTeamsForCard: "cardChecklist.suggestedTeamsForCard",
      confirmCardNoTeam: "cardChecklist.confirmCardNoTeam",
    },
    selectorOptions: { updateCard: "selectorOptions.updateCard" },
    players: { getManyByIds: "players.getManyByIds" },
    teams: { erasByNameAndSport: "teams.erasByNameAndSport" },
  },
}));

type Suggestion = {
  teamId: string;
  name: string;
  label: string;
  source: "career";
  playerName: string;
  inSetYear: boolean;
};

type Era = {
  _id: string;
  name: string;
  location?: string;
  yearsActive?: { from: number; to?: number };
  label: string;
};

/** What `suggestedTeamsForCard` resolves to. `undefined` = not resolved yet. */
let suggestions: Suggestion[] | undefined;
/** `teams.erasByNameAndSport` by name. A name missing here is still loading. */
let erasByName: Record<string, Era[]>;
/** Every args object the era lookup was asked with, `"skip"` included. */
let eraLookups: unknown[];
const mockUpdateCard = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "cardChecklist.suggestedTeamsForCard") return suggestions;
    if (ref === "teams.erasByNameAndSport") {
      eraLookups.push(args);
      if (args === "skip") return undefined;
      return erasByName[(args as { name: string }).name];
    }
    return undefined;
  },
  useMutation: (ref: string) =>
    ref === "selectorOptions.updateCard" ? mockUpdateCard : vi.fn(),
}));

/** The picker owns its own test file — see the note above. */
vi.mock("./TeamPicker", () => ({
  default: ({ value }: { value: string[] }) => (
    <div data-testid="team-picker-stub">
      <button type="button">Pick teams</button>
      <span data-testid="picker-value">{value.join(",")}</span>
    </div>
  ),
}));

import MissingTeamFixer, { careerHeading, marketplaceHeading } from "./MissingTeamFixer";
import { AttentionSportContext } from "./cardAttentionRegistry";

const CARD_ID = "card-1" as unknown as Id<"cardChecklist">;
const SPORT_ID = "sport-baseball" as unknown as Id<"selectorOptions">;

function renderFixer(
  rowOverrides: { bscTeamName?: string; cardNumber?: string; cardName?: string } = {},
  opts: { sportId?: Id<"selectorOptions"> | null } = {},
) {
  const sportId = opts.sportId === null ? undefined : (opts.sportId ?? SPORT_ID);
  return render(
    <AttentionSportContext.Provider value={sportId}>
      <MissingTeamFixer
        row={{
          _id: CARD_ID,
          cardNumber: "327",
          cardName: "Fernando Tatis Jr.",
          ...rowOverrides,
        }}
        items={[]}
        onSaved={vi.fn()}
        onSkip={vi.fn()}
      />
    </AttentionSportContext.Provider>,
  );
}

function suggestion(overrides: Partial<Suggestion> & { teamId: string; name: string }): Suggestion {
  return {
    label: overrides.name,
    source: "career",
    playerName: "Someone",
    inSetYear: true,
    ...overrides,
  };
}

/** Every toggle chip, in DOM order. */
const chips = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"));
const pressed = () => chips().filter((b) => b.getAttribute("aria-pressed") === "true");
const saveButton = () => screen.getByRole("button", { name: /Save & Next/ });

// ── The Foxx fixtures ───────────────────────────────────────────────────────

const PHA_AL = "team-pha-1901";
const ATHLETICS_ERAS: Era[] = [
  { _id: "team-pha-1871", name: "Athletics", location: "Philadelphia", yearsActive: { from: 1871, to: 1875 }, label: "Philadelphia Athletics · 1871–1875" },
  { _id: "team-pha-1876", name: "Athletics", location: "Philadelphia", yearsActive: { from: 1876, to: 1876 }, label: "Philadelphia Athletics · 1876–1876" },
  { _id: "team-pha-1882", name: "Athletics", location: "Philadelphia", yearsActive: { from: 1882, to: 1890 }, label: "Philadelphia Athletics · 1882–1890" },
  { _id: PHA_AL, name: "Athletics", location: "Philadelphia", yearsActive: { from: 1901, to: 1954 }, label: "Philadelphia Athletics · 1901–1954" },
];

/** No stint in 2025, so the server offered the whole career — `inSetYear: false`. */
function foxxCareerFallback(): Suggestion[] {
  return [
    suggestion({ teamId: PHA_AL, name: "Philadelphia Athletics", label: "Philadelphia Athletics · 1901–1954", playerName: "Jimmie Foxx", inSetYear: false }),
    suggestion({ teamId: "team-red-sox", name: "Boston Red Sox", playerName: "Jimmie Foxx", inSetYear: false }),
    suggestion({ teamId: "team-cubs", name: "Chicago Cubs", playerName: "Jimmie Foxx", inSetYear: false }),
    suggestion({ teamId: "team-phillies", name: "Philadelphia Phillies", playerName: "Jimmie Foxx", inSetYear: false }),
  ];
}

const FOXX_ROW = { cardNumber: "34", cardName: "Jimmie Foxx" };

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateCard.mockResolvedValue(null);
  suggestions = [];
  erasByName = {};
  eraLookups = [];
});

describe("MissingTeamFixer — chip labels (NEO-236, NEO-330)", () => {
  it("shows the server's full-name label and says whose career it came from", () => {
    suggestions = [
      suggestion({ teamId: "team-1", name: "San Diego Padres", playerName: "Fernando Tatis Jr." }),
    ];
    renderFixer();

    expect(screen.getByLabelText("San Diego Padres (from Fernando Tatis Jr.'s career)")).toBeTruthy();
    // Composed once, on the server — never "San Diego San Diego Padres".
    expect(screen.getByText("San Diego Padres")).toBeTruthy();
  });

  it("collapses two players who share a team into one chip", () => {
    suggestions = [
      suggestion({ teamId: "team-1", name: "San Diego Padres", playerName: "Fernando Tatis Jr." }),
      suggestion({ teamId: "team-1", name: "San Diego Padres", playerName: "Manny Machado" }),
    ];
    renderFixer();

    expect(
      screen.getByLabelText("San Diego Padres (from Fernando Tatis Jr. and Manny Machado's career)"),
    ).toBeTruthy();
    expect(screen.getAllByText("San Diego Padres")).toHaveLength(1);
  });

  it("era-labels a shared name the way the server sent it", () => {
    suggestions = foxxCareerFallback();
    renderFixer(FOXX_ROW);

    expect(
      screen.getByLabelText("Philadelphia Athletics · 1901–1954 (from Jimmie Foxx's career)"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Boston Red Sox (from Jimmie Foxx's career)")).toBeTruthy();
  });
});

describe("MissingTeamFixer — what is preselected, and where focus lands (NEO-330)", () => {
  it("preselects a set-year stint and lands focus on Save", async () => {
    suggestions = [suggestion({ teamId: "team-1", name: "San Diego Padres", playerName: "Fernando Tatis Jr." })];
    renderFixer();

    expect(pressed()).toHaveLength(1);
    expect(screen.getByText("Suggested from career history — Enter accepts these")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(saveButton()));
  });

  it("the Foxx shape: a career fallback is never preselected, and focus is not on Save", async () => {
    suggestions = foxxCareerFallback();
    renderFixer(FOXX_ROW);

    expect(chips()).toHaveLength(4);
    expect(pressed()).toHaveLength(0);
    expect(screen.getByTestId("picker-value").textContent).toBe("");
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("From career history, but none from this card’s year — pick the one on the card"),
    ).toBeTruthy();
    // Focus goes to the first chip, where Enter or Space picks it — never to a
    // Save that one Enter would turn into four teams.
    await waitFor(() => expect(document.activeElement).toBe(chips()[0]));
    expect(document.activeElement).not.toBe(saveButton());
  });

  it("Enter in the panel with nothing picked writes nothing", async () => {
    suggestions = foxxCareerFallback();
    renderFixer(FOXX_ROW);

    fireEvent.keyDown(screen.getByText("Jimmie Foxx"), { key: "Enter" });
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("with no chips at all, focus goes to the picker", async () => {
    suggestions = [];
    renderFixer();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pick teams" })),
    );
  });
});

describe("MissingTeamFixer — BSC's claim as NB's eras (NEO-330)", () => {
  it("offers every row under BSC's name, era-labelled, none preselected, in a labelled list", async () => {
    suggestions = foxxCareerFallback();
    erasByName["Philadelphia Athletics"] = ATHLETICS_ERAS;
    renderFixer({ ...FOXX_ROW, bscTeamName: "Philadelphia Athletics" });

    // Looked up by BSC's name in the SET's sport.
    expect(eraLookups).toContainEqual({ name: "Philadelphia Athletics", sportId: SPORT_ID });

    const heading = "BSC lists “Philadelphia Athletics” — 4 teams by that name, pick the one on the card";
    const bscList = screen.getByRole("list", { name: heading });
    const options = within(bscList).getAllByRole("button");
    expect(options.map((b) => b.textContent)).toEqual([
      "Philadelphia Athletics · 1871–1875",
      "Philadelphia Athletics · 1876–1876",
      "Philadelphia Athletics · 1882–1890",
      // The era Foxx played in says so — that is what tells the four apart.
      "Philadelphia Athletics · 1901–1954 (Jimmie Foxx's career)",
    ]);
    expect(options.every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);

    // The 1901–1954 row is not repeated in the career list: one chip per team.
    const careerList = screen.getByRole("list", {
      name: "From career history, but none from this card’s year — pick the one on the card",
    });
    expect(within(careerList).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Boston Red Sox",
      "Chicago Cubs",
      "Philadelphia Phillies",
    ]);

    // The plain "Marketplace says" line is replaced by the choices.
    expect(screen.queryByText("Marketplace says:")).toBeNull();
    // Focus lands on the first era, not on Save.
    await waitFor(() => expect(document.activeElement).toBe(options[0]));
  });

  it("one click on an era, then Save, writes exactly that row", async () => {
    suggestions = foxxCareerFallback();
    erasByName["Philadelphia Athletics"] = ATHLETICS_ERAS;
    renderFixer({ ...FOXX_ROW, bscTeamName: "Philadelphia Athletics" });

    fireEvent.click(screen.getByRole("button", { name: /1901–1954/ }));
    expect(pressed().map((b) => b.textContent)).toEqual([
      "Philadelphia Athletics · 1901–1954 (Jimmie Foxx's career)",
    ]);
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(mockUpdateCard).toHaveBeenCalledWith({ id: CARD_ID, teamOnCardIds: [PHA_AL] }),
    );
  });

  it("a set-year stint BSC contradicts is surfaced, not preselected", async () => {
    // 1937 card: Foxx's stint is the Red Sox; BSC says Athletics.
    suggestions = [
      suggestion({ teamId: "team-red-sox", name: "Boston Red Sox", playerName: "Jimmie Foxx", inSetYear: true }),
    ];
    erasByName["Philadelphia Athletics"] = ATHLETICS_ERAS;
    renderFixer({ ...FOXX_ROW, bscTeamName: "Philadelphia Athletics" });

    expect(pressed()).toHaveLength(0);
    expect(
      screen.getByText("From career history, but BSC lists a different team — pick the one on the card"),
    ).toBeTruthy();
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(chips()[0]));
  });

  it("a set-year stint that IS one of BSC's eras is preselected there, and Enter accepts it", async () => {
    // 1930 card: the stint is the 1901–1954 Athletics, which BSC also names.
    suggestions = [
      suggestion({ teamId: PHA_AL, name: "Philadelphia Athletics", label: "Philadelphia Athletics · 1901–1954", playerName: "Jimmie Foxx", inSetYear: true }),
    ];
    erasByName["Philadelphia Athletics"] = ATHLETICS_ERAS;
    renderFixer({ ...FOXX_ROW, bscTeamName: "Philadelphia Athletics" });

    expect(pressed().map((b) => b.textContent)).toEqual([
      "Philadelphia Athletics · 1901–1954 (Jimmie Foxx's career)",
    ]);
    expect(
      screen.getByText("BSC lists “Philadelphia Athletics” and career history agrees — Enter accepts it"),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(saveButton()));
  });

  it("one row under BSC's name is offered, not assumed", () => {
    suggestions = [];
    erasByName["Winnipeg Jets"] = [
      { _id: "team-jets-2011", name: "Jets", location: "Winnipeg", yearsActive: { from: 2011 }, label: "Winnipeg Jets · 2011–present" },
    ];
    renderFixer({ bscTeamName: "Winnipeg Jets" });

    const list = screen.getByRole("list", {
      name: "BSC lists “Winnipeg Jets” — pick it if it’s the team on the card",
    });
    expect(within(list).getByRole("button").getAttribute("aria-pressed")).toBe("false");
  });
});

/**
 * NEO-236 security review — the marketplace's own answer, kept as a hint when
 * it names no team we hold.
 *
 * `applyBscTeamResolution` no longer creates a team from BSC's string; it
 * links or leaves. Discarding the string with it left the operator on a card
 * with no team and no indication of which team it was meant to be. When the
 * name resolves to no NB row there is nothing to offer as a chip, so it stays
 * a line of text to read.
 */
describe("MissingTeamFixer — the marketplace hint (NEO-236)", () => {
  it("shows BSC's name as text when it names no team we hold", () => {
    erasByName["New York Yankees"] = [];
    renderFixer({ bscTeamName: "New York Yankees" });

    expect(screen.getByText("Marketplace says:")).toBeTruthy();
    expect(screen.getByText("New York Yankees")).toBeTruthy();
  });

  it("shows it as text when there is no sport to look it up in", () => {
    renderFixer({ bscTeamName: "New York Yankees" }, { sportId: null });

    expect(eraLookups.every((args) => args === "skip")).toBe(true);
    expect(screen.getByText("Marketplace says:")).toBeTruthy();
  });

  it("shows neither the hint nor chips while the era lookup is in flight", () => {
    renderFixer({ bscTeamName: "New York Yankees" });

    expect(screen.queryByText("Marketplace says:")).toBeNull();
    expect(chips()).toHaveLength(0);
  });

  it("shows nothing at all when the card carries no hint", () => {
    renderFixer();

    expect(screen.queryByText("Marketplace says:")).toBeNull();
    expect(eraLookups.every((args) => args === "skip")).toBe(true);
  });

  /**
   * The hint is a CLAIM. A name that resolves to no NB row is never a button,
   * link or title: creating a team takes a reviewed Location + Name, and a
   * clickable marketplace string is exactly the shortcut NEO-236 removed. A
   * marketplace string is untrusted content on an admin screen.
   */
  it("renders the hint as inert text — never a button, link or title", () => {
    erasByName["New York Yankees"] = [];
    renderFixer({ bscTeamName: "New York Yankees" });

    const hint = screen.getByText("New York Yankees");
    expect(hint.closest("button")).toBeNull();
    expect(hint.closest("a")).toBeNull();
    expect(hint.getAttribute("title")).toBeNull();
    expect(chips()).toHaveLength(0);
  });
});

describe("MissingTeamFixer — heading copy (NEO-330)", () => {
  it("marketplaceHeading", () => {
    expect(marketplaceHeading("Philadelphia Athletics", 4, false)).toBe(
      "BSC lists “Philadelphia Athletics” — 4 teams by that name, pick the one on the card",
    );
    expect(marketplaceHeading("Winnipeg Jets", 1, false)).toBe(
      "BSC lists “Winnipeg Jets” — pick it if it’s the team on the card",
    );
    expect(marketplaceHeading("Philadelphia Athletics", 4, true)).toBe(
      "BSC lists “Philadelphia Athletics” and career history agrees — Enter accepts it",
    );
  });

  it("careerHeading", () => {
    expect(careerHeading(true, false)).toBe("Suggested from career history — Enter accepts these");
    expect(careerHeading(true, true)).toBe(
      "From career history, but BSC lists a different team — pick the one on the card",
    );
    expect(careerHeading(false, false)).toBe(
      "From career history, but none from this card’s year — pick the one on the card",
    );
  });
});
