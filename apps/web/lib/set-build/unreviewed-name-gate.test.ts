import { describe, expect, test } from "vitest";
import {
  NOTHING_TO_CHANGE,
  unlinkedNames,
  unreviewedNameGate,
  unreviewedNameSidesOpen,
  unreviewedNameWrite,
} from "./unreviewed-name-gate";

describe("unreviewedNameGate — UnreviewedNameFixer's Save gate, shared with the tool (NEO-339)", () => {
  test("a side with typed names must gain a link: says which side is still open", () => {
    const row = { pendingPlayerNames: ["Mike Trot"], pendingTeamNames: ["Angles"] };
    const onlyTeam = unreviewedNameGate(row, { playerIds: [], teamIds: ["t1"] });
    expect(onlyTeam).toMatchObject({ clearsCard: false, playerSideOpen: true, teamSideOpen: false, canSave: false });
    expect(onlyTeam.refusal).toBe("Link a player to clear this card.");
    expect(unreviewedNameGate(row, { playerIds: [], teamIds: [] }).refusal).toBe(
      "Link a player and a team to clear this card.",
    );
    expect(unreviewedNameGate(row, { playerIds: ["p1"], teamIds: ["t1"] })).toMatchObject({ canSave: true, refusal: null });
  });

  test("a card that already has teams owes no team link for a leftover typed team name", () => {
    const row = { teamOnCardIds: ["t1"], pendingTeamNames: ["Angles"], pendingPlayerNames: ["Mike Trot"] };
    expect(unlinkedNames(row)).toEqual({ players: ["Mike Trot"], teams: [] });
    expect(unreviewedNameGate(row, { playerIds: ["p1"], teamIds: [] })).toMatchObject({ teamSideOpen: false, clearsCard: true });
  });

  test("a write that changes nothing is refused", () => {
    const row = { playerIds: ["p1"], teamOnCardIds: ["t1"] };
    const gate = unreviewedNameGate(row, { playerIds: ["p1"], teamIds: ["t1"] });
    expect(gate).toMatchObject({ idsChanged: false, retiresNames: false, canSave: false, refusal: NOTHING_TO_CHANGE });
  });

  test("unchanged ids still save when a linked side retires a leftover typed name", () => {
    const row = { playerIds: ["p1"], teamOnCardIds: ["t1"], pendingPlayerNames: ["M. Trout"] };
    expect(unreviewedNameGate(row, { playerIds: ["p1"], teamIds: ["t1"] })).toMatchObject({
      idsChanged: false,
      retiresNames: true,
      canSave: true,
    });
  });

  test("order matters for the change test (full replacement lists)", () => {
    const row = { playerIds: ["p1", "p2"] };
    expect(unreviewedNameGate(row, { playerIds: ["p2", "p1"], teamIds: [] }).idsChanged).toBe(true);
  });

  test("the counts form refuses before any create, with the same sentence", () => {
    const row = { pendingPlayerNames: ["Mike Trot"] };
    expect(unreviewedNameSidesOpen(row, { players: 0, teams: 1 })).toBe("Link a player to clear this card.");
    expect(unreviewedNameSidesOpen(row, { players: 1, teams: 0 })).toBeNull();
  });
});

describe("unreviewedNameWrite — each side's names retired only when that side gains a link", () => {
  test("a linked side clears its names; the other side's names go back unchanged", () => {
    const row = { pendingPlayerNames: ["Mike Trot"], pendingTeamNames: ["Angles"] };
    expect(unreviewedNameWrite(row, { playerIds: [], teamIds: ["t1"] })).toEqual({
      playerIds: [],
      teamOnCardIds: ["t1"],
      pendingPlayerNames: ["Mike Trot"],
      pendingTeamNames: [],
    });
    expect(unreviewedNameWrite(row, { playerIds: ["p1"], teamIds: ["t1"] })).toEqual({
      playerIds: ["p1"],
      teamOnCardIds: ["t1"],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
  });

  test("read off the ROW: a card with linked teams keeps its stored typed team names when no team is sent", () => {
    const row = { teamOnCardIds: ["t1"], pendingTeamNames: ["Angles"] };
    expect(unreviewedNameWrite(row, { playerIds: ["p1"], teamIds: [] }).pendingTeamNames).toEqual(["Angles"]);
  });
});
