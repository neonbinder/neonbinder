/**
 * NEO-221 (D12) — `UnreviewedNameFixer`, the attention walker's answer to
 * "this card carries a typed name and links to no player or team".
 *
 * What is pinned here is the part that is easy to get wrong and invisible when
 * it is: `selectorOptions.updateCard` takes `playerIds`/`teamOnCardIds` as
 * FULL REPLACEMENTS, so a fixer that starts either list empty silently unlinks
 * whatever the card already had. Everything else — which names show, when Save
 * does nothing, how a rejected write is reported — follows from that same
 * "never lose what the row already knows" rule.
 *
 * The pickers are the REAL `PlayerPicker` / `TeamPicker`, deliberately: the
 * ids this component sends are whatever they hand back, and stubbing them
 * would test a shape nothing produces.
 *
 * --- Mocking strategy ---
 * Same as CardChecklist.test.tsx: `convex/react`'s hooks are module-mocked and
 * routed by the (string-mocked) function reference.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: { updateCard: "selectorOptions.updateCard" },
    players: {
      getManyByIds: "players.getManyByIds",
      list: "players.list",
      findOrCreate: "players.findOrCreate",
    },
    teams: {
      getManyByIds: "teams.getManyByIds",
      list: "teams.list",
      findOrCreate: "teams.findOrCreate",
    },
  },
}));

const mockUpdateCard = vi.fn();

const state: {
  players: Array<{ _id: string; name: string }>;
  teams: Array<{ _id: string; name: string }>;
} = { players: [], teams: [] };

vi.mock("convex/react", () => ({
  useQuery: (ref: string) => {
    if (ref === "players.getManyByIds" || ref === "players.list") {
      return state.players;
    }
    if (ref === "teams.getManyByIds" || ref === "teams.list") return state.teams;
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "selectorOptions.updateCard") return mockUpdateCard;
    return vi.fn();
  },
}));

import UnreviewedNameFixer from "./UnreviewedNameFixer";
import {
  AttentionSportContext,
  type CardChecklistRow,
} from "./cardAttentionRegistry";

const SPORT_ID = "sport-1" as unknown as Id<"selectorOptions">;
const CARD_ID = "card-1" as unknown as Id<"cardChecklist">;

const ALVAREZ = { _id: "player-alvarez", name: "Yordan Alvarez" };
const WITT = { _id: "player-witt", name: "Bobby Witt Jr." };
const ASTROS = { _id: "team-astros", name: "Houston Astros" };

function baseRow(overrides: Partial<CardChecklistRow> = {}): CardChecklistRow {
  return {
    _id: CARD_ID,
    cardNumber: "9",
    cardName: "Yordan Alvrez",
    platformData: { bsc: { ref: "bsc-9" } },
    pendingPlayerNames: ["Yordan Alvrez"],
    ...overrides,
  };
}

const onSaved = vi.fn();
const onSkip = vi.fn();

function renderFixer(row: CardChecklistRow = baseRow()) {
  return render(
    <AttentionSportContext.Provider value={SPORT_ID}>
      <UnreviewedNameFixer
        row={row}
        // The component derives the names it renders from the ROW, not from
        // this payload — `deriveCardAttention` builds the item's `names` from
        // the same two fields, so the row is the original and the item a
        // projection of it. Passing an empty list is what pins that.
        items={[]}
        onSaved={onSaved}
        onSkip={onSkip}
      />
    </AttentionSportContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.players = [ALVAREZ, WITT];
  state.teams = [ASTROS];
  mockUpdateCard.mockResolvedValue(null);
});

/** Pick a player through the real picker's popover, by its display name. */
function pickPlayer(name: string) {
  fireEvent.click(screen.getByLabelText("Add player"));
  fireEvent.click(screen.getByLabelText(`Add ${name}`));
}

/** Pick a team through the real picker's popover, by its display name. */
function pickTeam(name: string) {
  fireEvent.click(screen.getByLabelText("Add team"));
  fireEvent.click(screen.getByLabelText(`Add ${name}`));
}

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Save & Next/ }));
  });
}

describe("UnreviewedNameFixer — what it shows", () => {
  it("names the card and the names that link to nothing", () => {
    renderFixer(
      baseRow({
        pendingPlayerNames: ["Yordan Alvrez"],
        pendingTeamNames: ["Astross"],
      }),
    );

    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#9 Yordan Alvrez",
    );
    const names = screen.getByRole("list", {
      name: "Typed on this card, not linked yet",
    });
    expect(names.textContent).toContain("Yordan Alvrez");
    expect(names.textContent).toContain("Astross");
  });

  /**
   * The team half of the rule: a card that already carries real
   * `teamOnCardIds` is LINKED, and a leftover typed name on it is not an open
   * question. Showing it would ask the operator to answer something they
   * already have.
   */
  it("leaves a typed team name out when the card already has a linked team", () => {
    renderFixer(
      baseRow({
        pendingTeamNames: ["Astross"],
        teamOnCardIds: [ASTROS._id as Id<"teams">],
      }),
    );

    const names = screen.getByRole("list", {
      name: "Typed on this card, not linked yet",
    });
    expect(names.textContent).not.toContain("Astross");
    expect(names.textContent).toContain("Yordan Alvrez");
  });

  /**
   * Not a `<button>`, and not focusable: these tokens are the PROBLEM, not an
   * option. `MissingTeamFixer`'s chips toggle; nothing here does, and a
   * pressable-looking thing that does nothing is the bug this pins.
   */
  it("renders the names as inert list items, not controls", () => {
    renderFixer();

    const names = screen.getByRole("list", {
      name: "Typed on this card, not linked yet",
    });
    expect(names.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("UnreviewedNameFixer — linking", () => {
  it("links the picked player and reports the card answered", async () => {
    renderFixer();

    pickPlayer("Yordan Alvarez");
    await save();

    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      playerIds: [ALVAREZ._id],
      teamOnCardIds: [],
      // The side that gained a link retires its typed names in the same write.
      pendingPlayerNames: [],
      // Nothing typed on the team side, so nothing to keep.
      pendingTeamNames: [],
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  /**
   * The full-replacement trap. A card can carry BOTH a resolved player and an
   * unlinked name (the commit resolved one of two names). Seeding the picker
   * empty and saving would unlink the resolved one to answer the other.
   */
  it("keeps the links the card already had", async () => {
    renderFixer(
      baseRow({
        playerIds: [WITT._id as Id<"players">],
        teamOnCardIds: [ASTROS._id as Id<"teams">],
      }),
    );

    pickPlayer("Yordan Alvarez");
    await save();

    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      playerIds: [WITT._id, ALVAREZ._id],
      teamOnCardIds: [ASTROS._id],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
  });

  it("answers a player and a team in one write", async () => {
    renderFixer(baseRow({ pendingTeamNames: ["Astross"] }));

    pickPlayer("Yordan Alvarez");
    pickTeam("Houston Astros");
    await save();

    expect(mockUpdateCard).toHaveBeenCalledTimes(1);
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      playerIds: [ALVAREZ._id],
      teamOnCardIds: [ASTROS._id],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
  });

  /**
   * The half-answer. `onSaved()` tells the walker the card is done and moves
   * past it — so a save that leaves the card badged is the worst outcome
   * available: the operator is told they finished, the walker never returns,
   * and the badge is still in the grid. A card with an unlinked player name
   * AND an unlinked team name is one click away from exactly that.
   */
  it("will not save while a typed side still has no link", async () => {
    renderFixer(
      baseRow({
        pendingPlayerNames: ["Yordan Alvrez"],
        pendingTeamNames: ["Astross"],
      }),
    );

    const saveButton = screen.getByRole("button", { name: /Save & Next/ });
    expect(saveButton.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Link a player and a team to clear this card."))
      .toBeTruthy();

    pickTeam("Houston Astros");

    // Half answered: the team is linked, the player name is still the reason
    // this card is flagged, and the hint now names only what is left.
    expect(saveButton.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Link a player to clear this card.")).toBeTruthy();
    await save();
    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    pickPlayer("Yordan Alvarez");
    expect(saveButton.getAttribute("aria-disabled")).toBeNull();
    await save();
    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      playerIds: [ALVAREZ._id],
      teamOnCardIds: [ASTROS._id],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  /**
   * The one shape where Save is worth pressing with the pickers untouched: a
   * card that reached commit with a RESOLVED player and a leftover typed name.
   * The link is already right; the name is stale, and saving retires it.
   */
  it("offers the save that only retires a stale name", async () => {
    renderFixer(baseRow({ playerIds: [ALVAREZ._id as Id<"players">] }));

    expect(
      screen.getByRole("button", { name: /Save & Next/ }).getAttribute("aria-disabled"),
    ).toBeNull();
    await save();

    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: CARD_ID,
      playerIds: [ALVAREZ._id],
      teamOnCardIds: [],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
  });

  it("saves from Enter anywhere in the panel", async () => {
    renderFixer();
    pickPlayer("Yordan Alvarez");

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("heading", { level: 3 }), {
        key: "Enter",
      });
    });

    expect(mockUpdateCard).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  /**
   * Saving the row back to itself would report the card as answered while
   * leaving it in exactly the state that flagged it: the walker advances, the
   * badge stays, and the operator has no way to tell.
   */
  it("does nothing until a link actually changes", async () => {
    renderFixer();

    expect(
      screen.getByRole("button", { name: /Save & Next/ }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByText("Link a player to clear this card.")).toBeTruthy();
    await save();
    expect(mockUpdateCard).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    pickPlayer("Yordan Alvarez");
    expect(
      screen.getByRole("button", { name: /Save & Next/ }).getAttribute("aria-disabled"),
    ).toBeNull();
  });
});

describe("UnreviewedNameFixer — when the write fails", () => {
  it("announces the failure and does NOT count the card as answered", async () => {
    mockUpdateCard.mockRejectedValue(new Error("Card is no longer on this checklist"));
    renderFixer();

    pickPlayer("Yordan Alvarez");
    await save();

    expect(screen.getByRole("alert").textContent).toContain(
      "Card is no longer on this checklist",
    );
    // Advancing on a refusal would report a card as answered when nothing was
    // written — the same rule MissingTeamFixer's "no team" branch follows.
    expect(onSaved).not.toHaveBeenCalled();
    // And the operator's picks are still there to retry with.
    expect(screen.getByLabelText("Player: Yordan Alvarez")).toBeTruthy();
  });
});
