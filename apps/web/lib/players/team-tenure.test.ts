/**
 * NEO-147 — the longest-tenure team default.
 *
 * The shape of the real data this runs against: 73 of the first 100 prod
 * players have `teamYears`, and rows like Juan Soto carry four distinct stints.
 */

import { describe, expect, it } from "vitest";
import { pickDefaultTeamYear, sortTeamYears, tenureYears } from "./team-tenure";

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

// ===========================================================================
// NEO-212 — sortTeamYears, the single career-timeline ordering shared by
// commitCardChecklistPrelude (convex/selectorOptions.ts) and enrichPlayer
// (convex/adapters/wikidata.ts). Both write players.teamYears, so a
// disagreement here would mean the same player reads back as a different
// timeline depending on which path created them.
// ===========================================================================

describe("sortTeamYears", () => {
  it("orders by fromYear ascending regardless of input order", () => {
    const rows = [
      { teamId: "c", fromYear: 2019 },
      { teamId: "a", fromYear: 2005 },
      { teamId: "b", fromYear: 2011 },
    ];
    expect(sortTeamYears(rows).map((r) => r.teamId)).toEqual(["a", "b", "c"]);
  });

  it("breaks a same-fromYear tie on the earlier toYear", () => {
    const rows = [
      { teamId: "long", fromYear: 2011, toYear: 2018 },
      { teamId: "short", fromYear: 2011, toYear: 2012 },
    ];
    expect(sortTeamYears(rows).map((r) => r.teamId)).toEqual(["short", "long"]);
  });

  it("sorts an open-ended stint LAST among stints sharing a fromYear", () => {
    // No toYear means "still there" — by definition it has not ended, so it
    // cannot sort before a stint that has.
    const rows = [
      { teamId: "open", fromYear: 2020 },
      { teamId: "closed", fromYear: 2020, toYear: 2023 },
    ];
    expect(sortTeamYears(rows).map((r) => r.teamId)).toEqual(["closed", "open"]);
  });

  it("still orders an open-ended EARLIER stint before a later closed one", () => {
    // The open-ended rule is a tie-break on fromYear only — it must never
    // override the primary ordering.
    const rows = [
      { teamId: "later", fromYear: 2015, toYear: 2018 },
      { teamId: "earlier-open", fromYear: 2001 },
    ];
    expect(sortTeamYears(rows).map((r) => r.teamId)).toEqual([
      "earlier-open",
      "later",
    ]);
  });

  it("keeps BOTH stints when a player returns to the same team — it orders, it never dedupes", () => {
    // The exact case the old teamId-keyed dedup destroyed.
    const rows = [
      { teamId: "angels", fromYear: 2016, toYear: 2019 },
      { teamId: "angels", fromYear: 2011, toYear: 2013 },
    ];
    const sorted = sortTeamYears(rows);
    expect(sorted).toHaveLength(2);
    expect(sorted.map((r) => r.fromYear)).toEqual([2011, 2016]);
  });

  it("is stable for rows that compare equal", () => {
    const rows = [
      { teamId: "first", fromYear: 2010, toYear: 2012 },
      { teamId: "second", fromYear: 2010, toYear: 2012 },
    ];
    expect(sortTeamYears(rows).map((r) => r.teamId)).toEqual(["first", "second"]);
  });

  it("does not mutate its input", () => {
    const rows = [{ teamId: "b", fromYear: 2020 }, { teamId: "a", fromYear: 2000 }];
    const sorted = sortTeamYears(rows);
    expect(rows.map((r) => r.teamId)).toEqual(["b", "a"]);
    expect(sorted).not.toBe(rows);
  });

  it("handles empty and single-element inputs", () => {
    expect(sortTeamYears([])).toEqual([]);
    expect(sortTeamYears([{ teamId: "only", fromYear: 2011 }])).toEqual([
      { teamId: "only", fromYear: 2011 },
    ]);
  });
});
