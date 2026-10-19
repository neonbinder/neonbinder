/**
 * NEO-339 — `MissingPlayerFixer`, the attention walker's answer to "this card
 * links to no player": link who is on it, or record that nobody is.
 *
 * The picker is the REAL `PlayerPicker`, as in UnreviewedNameFixer.test.tsx:
 * the ids this component sends are whatever it hands back.
 *
 * --- Mocking strategy ---
 * `convex/react`'s hooks are module-mocked and routed by the (string-mocked)
 * function reference, as every fixer test here does.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
// The real class, not a mock: `userFacingMessage` narrows on `instanceof`.
import { ConvexError } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: { updateCard: "selectorOptions.updateCard" },
    cardChecklist: {
      confirmCardNoPlayer: "cardChecklist.confirmCardNoPlayer",
      confirmCardNoTeam: "cardChecklist.confirmCardNoTeam",
      suggestedTeamsForCard: "cardChecklist.suggestedTeamsForCard",
    },
    players: {
      getManyByIds: "players.getManyByIds",
      list: "players.list",
      findOrCreate: "players.findOrCreate",
    },
    teams: {
      getManyByIds: "teams.getManyByIds",
      pickerCandidates: "teams.pickerCandidates",
      findOrCreate: "teams.findOrCreate",
      erasByNameAndSport: "teams.erasByNameAndSport",
    },
  },
}));

const mockUpdateCard = vi.fn();
const mockConfirmNoPlayer = vi.fn();
const teamLookups: unknown[] = [];

const state: {
  players: Array<{ _id: string; name: string }>;
  teams: Array<{ _id: string; name: string; location?: string }>;
} = { players: [], teams: [] };

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "players.getManyByIds" || ref === "players.list") return state.players;
    if (ref === "teams.getManyByIds") {
      teamLookups.push(args);
      return args === "skip" ? undefined : state.teams;
    }
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "selectorOptions.updateCard") return mockUpdateCard;
    if (ref === "cardChecklist.confirmCardNoPlayer") return mockConfirmNoPlayer;
    return vi.fn();
  },
}));

import MissingPlayerFixer from "./MissingPlayerFixer";
import { AttentionSportContext, type CardChecklistRow } from "./cardAttentionRegistry";
import { MAX_CARD_PLAYERS } from "./card-attention";

const SPORT_ID = "sport-1" as unknown as Id<"selectorOptions">;
const CARD_ID = "card-1" as unknown as Id<"cardChecklist">;

const ICHIRO = { _id: "player-ichiro", name: "Ichiro Suzuki" };
const GRIFFEY = { _id: "player-griffey", name: "Ken Griffey Jr." };
const MARINERS = { _id: "team-mariners", location: "Seattle", name: "Mariners" };

function baseRow(overrides: Partial<CardChecklistRow> = {}): CardChecklistRow {
  return {
    _id: CARD_ID,
    cardNumber: "660",
    cardName: "Ichiro",
    platformData: { sportlots: { ref: "sl-660" } },
    teamOnCardIds: [MARINERS._id as Id<"teams">],
    ...overrides,
  };
}

const onSaved = vi.fn();
const onSkip = vi.fn();

function renderFixer(row: CardChecklistRow = baseRow()) {
  return render(
    <AttentionSportContext.Provider value={{ sportId: SPORT_ID }}>
      <MissingPlayerFixer row={row} items={[{ kind: "missingPlayer" }]} onSaved={onSaved} onSkip={onSkip} />
    </AttentionSportContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  teamLookups.length = 0;
  state.players = [ICHIRO, GRIFFEY];
  state.teams = [MARINERS];
  mockUpdateCard.mockResolvedValue(null);
  mockConfirmNoPlayer.mockResolvedValue({ confirmed: true, stamped: true });
});

function pickPlayer(name: string) {
  fireEvent.click(screen.getByLabelText("Add player"));
  // Typed, so a long pool's matches are not cut off by the list's own limit.
  fireEvent.change(screen.getByLabelText("Search players"), { target: { value: name } });
  fireEvent.click(screen.getByLabelText(`Add ${name}`));
}

const saveButton = () => screen.getByRole("button", { name: /Save & Next/ });
const noPlayerButton = () => screen.getByRole("button", { name: "No player on this card" });

describe("MissingPlayerFixer — what it shows", () => {
  it("names the card, and the team it carries as the clue", () => {
    renderFixer();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("#660 Ichiro");
    expect(screen.getByText("Team: Seattle Mariners")).toBeTruthy();
    expect(teamLookups).toContainEqual({ ids: [MARINERS._id] });
    expect(screen.getByText("No player is linked to this card yet. Add who’s on it, or say there’s nobody.")).toBeTruthy();
  });

  it("says when the card has no team either, and does not look one up", () => {
    renderFixer(baseRow({ teamOnCardIds: [] }));
    expect(screen.getByText("No team on this card yet.")).toBeTruthy();
    expect(teamLookups.every((a) => a === "skip")).toBe(true);
  });

  it("shows a typed team name as typed, never 'no team'", () => {
    renderFixer(baseRow({ teamOnCardIds: [], pendingTeamNames: ["Mariners"] }));
    expect(screen.getByText("Team: Mariners")).toBeTruthy();
  });

  it("starts with nothing picked: Save is aria-disabled and says what it needs", async () => {
    renderFixer();
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Pick at least one player, or record that this card has none.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("focuses the picker's trigger on mount", async () => {
    renderFixer();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Add player")));
  });
});

describe("MissingPlayerFixer — linking a player", () => {
  it("saves the picked players as the card's whole list, and reports the card answered", async () => {
    renderFixer();
    pickPlayer("Ichiro Suzuki");
    expect(screen.getByText(/^Saves 1 player on this card\. (Ctrl|Cmd)\+Enter saves from anywhere\.$/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    // `playerIds` only: the teams the card carries are not this question's.
    expect(mockUpdateCard).toHaveBeenCalledWith({ id: CARD_ID, playerIds: [ICHIRO._id] });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Enter saves from anywhere, the picker's trigger included", async () => {
    renderFixer();
    pickPlayer("Ken Griffey Jr.");
    fireEvent.keyDown(screen.getByLabelText("Add player"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(mockUpdateCard).toHaveBeenCalledWith({ id: CARD_ID, playerIds: [GRIFFEY._id] }));
  });

  it("plain Enter on a button is the button's own, never a save", async () => {
    renderFixer();
    pickPlayer("Ken Griffey Jr.");
    fireEvent.keyDown(screen.getByLabelText("Add player"), { key: "Enter" });
    await act(async () => {});
    expect(mockUpdateCard).not.toHaveBeenCalled();
  });

  it("a refused write shows the server's sentence and does not advance", async () => {
    mockUpdateCard.mockRejectedValueOnce(new ConvexError("That player is in another sport."));
    renderFixer();
    pickPlayer("Ichiro Suzuki");
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(screen.getByRole("alert").textContent).toBe("That player is in another sport.");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it(`refuses an addition past ${MAX_CARD_PLAYERS} players rather than trimming`, async () => {
    state.players = Array.from({ length: MAX_CARD_PLAYERS + 1 }, (_, i) => ({ _id: `p-${i}`, name: `Player ${i}` }));
    renderFixer();
    for (let i = 0; i < MAX_CARD_PLAYERS; i++) pickPlayer(`Player ${i}`);
    expect(screen.getByRole("status").textContent).toContain(`That is the limit of ${MAX_CARD_PLAYERS} players on one card.`);
    // The popover may no longer offer the 21st; if it does, picking it changes nothing.
    fireEvent.click(screen.getByLabelText("Add player"));
    fireEvent.change(screen.getByLabelText("Search players"), { target: { value: `Player ${MAX_CARD_PLAYERS}` } });
    const extra = screen.queryByLabelText(`Add Player ${MAX_CARD_PLAYERS}`);
    if (extra) fireEvent.click(extra);
    await act(async () => {
      fireEvent.click(saveButton());
    });
    const sent = mockUpdateCard.mock.calls[0][0] as { playerIds: string[] };
    expect(sent.playerIds).toHaveLength(MAX_CARD_PLAYERS);
  });
});

describe("MissingPlayerFixer — No player on this card", () => {
  it("records it through confirmCardNoPlayer with the card alone, and advances", async () => {
    renderFixer();
    await act(async () => {
      fireEvent.click(noPlayerButton());
    });
    expect(mockConfirmNoPlayer).toHaveBeenCalledWith({ cardId: CARD_ID });
    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("an already-recorded card (stamped: false) still advances", async () => {
    mockConfirmNoPlayer.mockResolvedValueOnce({ confirmed: true, stamped: false });
    renderFixer();
    await act(async () => {
      fireEvent.click(noPlayerButton());
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("a refusal (the card names a player now) says so and does NOT advance", async () => {
    mockConfirmNoPlayer.mockResolvedValueOnce({ confirmed: false, stamped: false });
    renderFixer();
    await act(async () => {
      fireEvent.click(noPlayerButton());
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "This card has a player now, or it is no longer on this checklist — nothing to confirm. Skip it, or close and re-open to see the current state.",
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("is never natively disabled while a request is in flight (focus stays on it)", async () => {
    let resolve: (v: { confirmed: boolean; stamped: boolean }) => void = () => {};
    mockConfirmNoPlayer.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderFixer();
    await act(async () => {
      fireEvent.click(noPlayerButton());
    });
    expect(noPlayerButton().hasAttribute("disabled")).toBe(false);
    expect(noPlayerButton().getAttribute("aria-disabled")).toBe("true");
    // A second press while busy sends nothing more.
    fireEvent.click(noPlayerButton());
    expect(mockConfirmNoPlayer).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ confirmed: true, stamped: true }));
  });
});
