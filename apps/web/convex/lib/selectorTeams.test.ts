/**
 * NEO-277 — the pure set-level team rules, branch by branch. The database
 * tests in selectorOptions.setSelectorOptionTeams.test.ts prove the WIRING;
 * this file pins the DECISIONS so a rewording of one writer cannot quietly
 * change what "follows" means for the other two.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  cardTeamFollowVerdict,
  defaultTeamOnCardIds,
  inheritedTeamIds,
  sameTeamSet,
  teamFollowVerdict,
} from "./selectorTeams";

const A = "team_a" as Id<"teams">;
const B = "team_b" as Id<"teams">;
const C = "team_c" as Id<"teams">;

describe("inheritedTeamIds", () => {
  test("copies a non-empty list and yields undefined for empty, absent or no parent", () => {
    const parent = { teamIds: [A, B] };
    const copy = inheritedTeamIds(parent);
    expect(copy).toEqual([A, B]);
    expect(copy).not.toBe(parent.teamIds);
    expect(inheritedTeamIds({ teamIds: [] })).toBeUndefined();
    expect(inheritedTeamIds({})).toBeUndefined();
    expect(inheritedTeamIds(null)).toBeUndefined();
    expect(inheritedTeamIds(undefined)).toBeUndefined();
  });
});

describe("sameTeamSet", () => {
  test("is order-insensitive and treats absent as empty", () => {
    expect(sameTeamSet([A, B], [B, A])).toBe(true);
    expect(sameTeamSet([A], [A, B])).toBe(false);
    expect(sameTeamSet(undefined, [])).toBe(true);
    expect(sameTeamSet(undefined, [A])).toBe(false);
  });
});

describe("teamFollowVerdict", () => {
  test("unchanged / follow / stay", () => {
    expect(teamFollowVerdict([C], [A], [C])).toBe("unchanged");
    expect(teamFollowVerdict(undefined, [A], [C])).toBe("follow");
    expect(teamFollowVerdict([], [A], [C])).toBe("follow");
    expect(teamFollowVerdict([A], [A], [C])).toBe("follow");
    expect(teamFollowVerdict([A, B], [B, A], [C])).toBe("follow");
    expect(teamFollowVerdict([B], [A], [C])).toBe("stay");
    // Previous empty: only an empty row follows.
    expect(teamFollowVerdict([B], [], [C])).toBe("stay");
    expect(teamFollowVerdict(undefined, [], [C])).toBe("follow");
  });
});

describe("cardTeamFollowVerdict", () => {
  test("a confirmed-teamless card stays even though it is empty", () => {
    expect(
      cardTeamFollowVerdict({ teamNoneConfirmedAt: 1 }, [A], [C]),
    ).toBe("stay");
  });
  test("a card carrying an unresolved team name stays", () => {
    expect(
      cardTeamFollowVerdict({ pendingTeamNames: ["Bulls"] }, [A], [C]),
    ).toBe("stay");
  });
  test("otherwise the node rule applies", () => {
    expect(cardTeamFollowVerdict({}, [A], [C])).toBe("follow");
    expect(cardTeamFollowVerdict({ teamOnCardIds: [A] }, [A], [C])).toBe("follow");
    expect(cardTeamFollowVerdict({ teamOnCardIds: [B] }, [A], [C])).toBe("stay");
    expect(cardTeamFollowVerdict({ teamOnCardIds: [C] }, [A], [C])).toBe("unchanged");
  });
});

describe("defaultTeamOnCardIds", () => {
  test("the card's own ids win, and are copied", () => {
    const own = [B];
    const out = defaultTeamOnCardIds({ teamOnCardIds: own }, { teamIds: [A] });
    expect(out).toEqual({ ids: [B], defaulted: false });
    expect(out.ids).not.toBe(own);
  });
  test("a pending name is the card's own answer: no default", () => {
    expect(
      defaultTeamOnCardIds({ pendingTeamNames: ["Bulls"] }, { teamIds: [A] }),
    ).toEqual({ ids: undefined, defaulted: false });
  });
  test("an empty card under a leaf with a team is born with it", () => {
    expect(defaultTeamOnCardIds({}, { teamIds: [A] })).toEqual({
      ids: [A],
      defaulted: true,
    });
    expect(defaultTeamOnCardIds({ teamOnCardIds: [] }, { teamIds: [A] })).toEqual({
      ids: [A],
      defaulted: true,
    });
  });
  test("no leaf team: nothing", () => {
    expect(defaultTeamOnCardIds({}, { teamIds: [] })).toEqual({
      ids: undefined,
      defaulted: false,
    });
    expect(defaultTeamOnCardIds({}, null)).toEqual({ ids: undefined, defaulted: false });
  });
});
