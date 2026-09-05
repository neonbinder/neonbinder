/**
 * NEO-236 — `MissingTeamFixer` renders suggested teams by their FULL name.
 *
 * `teams.name` is the nickname now ("Padres") and the place lives in
 * `teams.location` ("San Diego"). This fixer is the screen where an operator
 * decides which team is on a card, so a chip reading "Cardinals" — with no way
 * to tell St. Louis from Arizona — would be the split actively making the
 * product worse. The chip, and the provenance sentence a screen reader hears,
 * both carry the composed name.
 *
 * The suggestion payload (`cardChecklist.suggestedTeamsForCard`) carries only a
 * denormalised `name`, so the location comes from the team rows themselves via
 * `teams.getManyByIds`. Until those resolve the suggestion's own name stands in
 * — which for an unsplit row IS the full name, so the common case never
 * flickers. Both states are pinned below.
 *
 * The picker's own behaviour (including its Location + Name create form) lives
 * in `TeamPicker.test.tsx`; it is stubbed here so this file tests one thing.
 */

import { render, screen, waitFor } from "@testing-library/react";
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
    teams: { getManyByIds: "teams.getManyByIds" },
  },
}));

type Suggestion = {
  teamId: string;
  name: string;
  source: "career";
  playerName: string;
};

let suggestions: Suggestion[];
/** What `teams.getManyByIds` resolves to. `undefined` = not resolved yet. */
let teamRows: Array<{ _id: string; name: string; location?: string }> | undefined;

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "cardChecklist.suggestedTeamsForCard") return suggestions;
    if (ref === "teams.getManyByIds") return args === "skip" ? undefined : teamRows;
    if (ref === "players.getManyByIds") return undefined;
    return undefined;
  },
  useMutation: () => vi.fn(),
}));

/** The picker owns its own test file — see the note above. */
vi.mock("./TeamPicker", () => ({
  default: () => <div data-testid="team-picker-stub" />,
}));

import MissingTeamFixer from "./MissingTeamFixer";

const CARD_ID = "card-1" as unknown as Id<"cardChecklist">;

function renderFixer(rowOverrides: { bscTeamName?: string } = {}) {
  return render(
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
    />,
  );
}

describe("MissingTeamFixer — NEO-236 team names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    suggestions = [];
    teamRows = undefined;
  });

  it("labels a split team's chip with its composed full name", async () => {
    suggestions = [
      {
        teamId: "team-1",
        name: "Padres",
        source: "career",
        playerName: "Fernando Tatis Jr.",
      },
    ];
    teamRows = [{ _id: "team-1", name: "Padres", location: "San Diego" }];

    renderFixer();

    await waitFor(() => {
      expect(
        screen.getByLabelText(
          "San Diego Padres (from Fernando Tatis Jr.'s career)",
        ),
      ).toBeTruthy();
    });
    expect(screen.getByText("San Diego Padres")).toBeTruthy();
  });

  it("falls back to the suggestion's own name until the team rows resolve", () => {
    suggestions = [
      {
        teamId: "team-1",
        name: "Nippon-Ham Fighters",
        source: "career",
        playerName: "Shohei Ohtani",
      },
    ];
    teamRows = undefined;

    renderFixer();

    // A row with no location composes to exactly its name, so this is also the
    // steady state for every college side, national team and Orix Buffaloes.
    expect(screen.getByText("Nippon-Ham Fighters")).toBeTruthy();
  });

  it("still collapses two players who share a team into one chip after composing", async () => {
    suggestions = [
      {
        teamId: "team-1",
        name: "Padres",
        source: "career",
        playerName: "Fernando Tatis Jr.",
      },
      {
        teamId: "team-1",
        name: "Padres",
        source: "career",
        playerName: "Manny Machado",
      },
    ];
    teamRows = [{ _id: "team-1", name: "Padres", location: "San Diego" }];

    renderFixer();

    await waitFor(() => {
      expect(
        screen.getByLabelText(
          "San Diego Padres (from Fernando Tatis Jr. and Manny Machado's career)",
        ),
      ).toBeTruthy();
    });
    expect(screen.getAllByText("San Diego Padres")).toHaveLength(1);
  });
});

/**
 * NEO-236 security review — the marketplace's own answer, kept as a hint.
 *
 * `applyBscTeamResolution` no longer creates a team from BSC's string; it
 * links or leaves. Discarding the string with it left the operator on a card
 * with no team and no indication of which team it was meant to be — we had the
 * answer and threw it away on the way to not trusting it. The fix keeps it on
 * the row as `bscTeamName` and shows it here.
 */
describe("MissingTeamFixer — the marketplace hint (NEO-236)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    suggestions = [];
    teamRows = undefined;
  });

  it("shows the marketplace's team name when the card carries one", () => {
    renderFixer({ bscTeamName: "New York Yankees" });

    expect(screen.getByText("Marketplace says:")).toBeTruthy();
    expect(screen.getByText("New York Yankees")).toBeTruthy();
  });

  it("shows nothing at all when the card carries no hint", () => {
    renderFixer();

    expect(screen.queryByText("Marketplace says:")).toBeNull();
  });

  /**
   * The hint is a CLAIM, not a suggestion. The chips above the picker are
   * acceptable with one keystroke; this deliberately is not — creating a team
   * takes a reviewed Location + Name, and a clickable marketplace string is
   * exactly the shortcut NEO-236 removed. It is also plain text rather than an
   * anchor or a `title`, the same rule the card number and name follow: a
   * marketplace string is untrusted content on an admin screen.
   */
  it("renders the hint as inert text — never a button, link or title", () => {
    const { container } = renderFixer({ bscTeamName: "New York Yankees" });

    const hint = screen.getByText("New York Yankees");
    expect(hint.closest("button")).toBeNull();
    expect(hint.closest("a")).toBeNull();
    expect(hint.getAttribute("title")).toBeNull();
    // And it did not become one of the acceptable suggestion chips.
    expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(0);
  });
});
