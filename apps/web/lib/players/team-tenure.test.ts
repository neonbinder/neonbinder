/**
 * NEO-147 — the longest-tenure team default.
 *
 * The shape of the real data this runs against: 73 of the first 100 prod
 * players have `teamYears`, and rows like Juan Soto carry four distinct stints.
 */

import { describe, expect, it } from "vitest";
import { pickDefaultTeamYear, tenureYears } from "./team-tenure";

const NOW = 2026;

describe("tenureYears", () => {
  it("measures a closed stint", () => {
    expect(tenureYears({ teamId: "a", fromYear: 2010, toYear: 2018 }, NOW)).toBe(8);
  });

  it("counts an open stint through the current year", () => {
    expect(tenureYears({ teamId: "a", fromYear: 2020 }, NOW)).toBe(6);
  });

  it("treats a single season as a zero-length span", () => {
    expect(tenureYears({ teamId: "a", fromYear: 2015, toYear: 2015 }, NOW)).toBe(0);
  });
});

describe("pickDefaultTeamYear", () => {
  it("returns null when the player has no career data", () => {
    // 27 of the first 100 prod players. The designer treats this as "fall
    // through to manual colors", not as an error.
    expect(pickDefaultTeamYear(undefined, NOW)).toBeNull();
    expect(pickDefaultTeamYear([], NOW)).toBeNull();
  });

  it("picks the longest stint", () => {
    const best = pickDefaultTeamYear(
      [
        { teamId: "short", fromYear: 2019, toYear: 2021 },
        { teamId: "long", fromYear: 2005, toYear: 2017 },
        { teamId: "middling", fromYear: 2017, toYear: 2019 },
      ],
      NOW,
    );
    expect(best!.teamId).toBe("long");
  });

  it("breaks a tie on recency", () => {
    const best = pickDefaultTeamYear(
      [
        { teamId: "older", fromYear: 2000, toYear: 2005 },
        { teamId: "newer", fromYear: 2015, toYear: 2020 },
      ],
      NOW,
    );
    expect(best!.teamId).toBe("newer");
  });

  it("prefers an ongoing stint over a finished one of equal length", () => {
    const best = pickDefaultTeamYear(
      [
        { teamId: "finished", fromYear: 2014, toYear: 2020 },
        { teamId: "current", fromYear: 2020 },
      ],
      NOW,
    );
    expect(best!.teamId).toBe("current");
  });

  it("handles a single stint", () => {
    const best = pickDefaultTeamYear([{ teamId: "only", fromYear: 2011 }], NOW);
    expect(best!.teamId).toBe("only");
  });

  it("does not depend on the order the stints are stored in", () => {
    const stints = [
      { teamId: "a", fromYear: 2001, toYear: 2004 },
      { teamId: "b", fromYear: 2004, toYear: 2015 },
      { teamId: "c", fromYear: 2015, toYear: 2018 },
    ];
    const forward = pickDefaultTeamYear(stints, NOW);
    const reversed = pickDefaultTeamYear([...stints].reverse(), NOW);
    expect(forward!.teamId).toBe("b");
    expect(reversed!.teamId).toBe("b");
  });
});
