/**
 * NEO-462 — the one line that tells two players with the same (or a similar)
 * name apart: `b. 1990 · Dodgers 2014–19 · Brewers 2020–21 +1 more`.
 *
 * Replaces NEO-254's `career-summary.test.ts`. That module printed stints in
 * chronological order; this one ranks TEAMS by the seasons spent there, so
 * what is locked in here is mostly the ranking:
 *
 *  - seasons are INCLUSIVE and SUMMED per team, so split stints are not
 *    undercounted (three one-season Mets stints beat a 2005–06 Cubs stint);
 *  - ties go to the team reached first, then to input order;
 *  - teams known only from undated stints come last;
 *  - `careerLine` resolves a name only for a team it will SHOW, because the
 *    server's op budgets (`entityReviewQueue`) are charged on that cap.
 *
 * The format half pins the short year spans and the spoken form the
 * Possible matches panel puts in each row's accessible name.
 */

import { describe, expect, it, vi } from "vitest";
import {
  NOTHING_ON_FILE,
  PLAYER_DESCRIPTION_MAX_TEAMS,
  careerLine,
  formatCareerLine,
  formatCareerTeam,
  formatPlayerDescription,
  formatYearSpan,
  rankCareerTeams,
  speakPlayerDescription,
  type CareerLine,
} from "./player-description";

const NOW = 2026;

/** The ranked team ids, which is what most ranking assertions care about. */
function order(
  teamYears: Array<{ teamId: string; fromYear?: number; toYear?: number }>,
  currentYear = NOW,
): string[] {
  return rankCareerTeams(teamYears, currentYear).map((t) => t.teamId);
}

describe("constants", () => {
  it("names two teams and says 'Nothing on file yet' for an empty player", () => {
    // The entityReviewQueue op budgets multiply by this cap; a change here
    // changes what a review batch is charged.
    expect(PLAYER_DESCRIPTION_MAX_TEAMS).toBe(2);
    expect(NOTHING_ON_FILE).toBe("Nothing on file yet");
  });
});

// ---------------------------------------------------------------------------
// rankCareerTeams
// ---------------------------------------------------------------------------

describe("rankCareerTeams", () => {
  it("returns [] for no career at all", () => {
    expect(rankCareerTeams(undefined, NOW)).toEqual([]);
    expect(rankCareerTeams([], NOW)).toEqual([]);
  });

  it("puts the team with more seasons first, whatever the input order", () => {
    expect(
      order([
        { teamId: "brewers", fromYear: 2020, toYear: 2021 },
        { teamId: "dodgers", fromYear: 2014, toYear: 2019 },
      ]),
    ).toEqual(["dodgers", "brewers"]);
  });

  it("counts seasons inclusively: 2005–06 is two, a single season is one", () => {
    const [cubs] = rankCareerTeams([{ teamId: "cubs", fromYear: 2005, toYear: 2006 }], NOW);
    expect(cubs.totalYears).toBe(2);
    const [mets] = rankCareerTeams([{ teamId: "mets", fromYear: 2001, toYear: 2001 }], NOW);
    expect(mets.totalYears).toBe(1);
  });

  it("sums split stints, so three one-season Mets stints outrank a 2005–06 Cubs stint", () => {
    // The case `tenureYears` (to - from) gets wrong: it scores each Mets
    // season 0, total 0, and the Cubs' 1 wins. Three seasons beat two.
    const ranked = rankCareerTeams(
      [
        { teamId: "mets", fromYear: 2001, toYear: 2001 },
        { teamId: "mets", fromYear: 2003, toYear: 2003 },
        { teamId: "cubs", fromYear: 2005, toYear: 2006 },
        { teamId: "mets", fromYear: 2008, toYear: 2008 },
      ],
      NOW,
    );
    expect(ranked.map((t) => [t.teamId, t.totalYears])).toEqual([
      ["mets", 3],
      ["cubs", 2],
    ]);
    // The stints stay separate: the gaps are what tell two same-named men apart.
    expect(ranked[0].spans).toEqual([
      { fromYear: 2001, toYear: 2001 },
      { fromYear: 2003, toYear: 2003 },
      { fromYear: 2008, toYear: 2008 },
    ]);
  });

  it("groups one team's stints even when other teams sit between them", () => {
    // Mariners, Reds, Mariners: 4 + 4 seasons in Seattle against 6 in
    // Cincinnati. Ranked per stint the Reds would win.
    const ranked = rankCareerTeams(
      [
        { teamId: "mariners", fromYear: 2005, toYear: 2008 },
        { teamId: "reds", fromYear: 2009, toYear: 2014 },
        { teamId: "mariners", fromYear: 2015, toYear: 2018 },
      ],
      NOW,
    );
    expect(ranked.map((t) => [t.teamId, t.totalYears])).toEqual([
      ["mariners", 8],
      ["reds", 6],
    ]);
    expect(ranked).toHaveLength(2);
  });

  it("orders one team's spans chronologically however they were stored", () => {
    const [team] = rankCareerTeams(
      [
        { teamId: "mariners", fromYear: 2016, toYear: 2019 },
        { teamId: "mariners", fromYear: 2009, toYear: 2012 },
      ],
      NOW,
    );
    expect(team.spans).toEqual([
      { fromYear: 2009, toYear: 2012 },
      { fromYear: 2016, toYear: 2019 },
    ]);
    expect(team.firstYear).toBe(2009);
  });

  it("breaks a tie on seasons by the team reached first", () => {
    expect(
      order([
        { teamId: "later", fromYear: 2010, toYear: 2012 },
        { teamId: "earlier", fromYear: 2000, toYear: 2002 },
      ]),
    ).toEqual(["earlier", "later"]);
  });

  it("breaks a tie on seasons AND first year by input order", () => {
    expect(
      order([
        { teamId: "first", fromYear: 2010, toYear: 2012 },
        { teamId: "second", fromYear: 2010, toYear: 2012 },
      ]),
    ).toEqual(["first", "second"]);
    expect(
      order([
        { teamId: "second", fromYear: 2010, toYear: 2012 },
        { teamId: "first", fromYear: 2010, toYear: 2012 },
      ]),
    ).toEqual(["second", "first"]);
  });

  it("puts undated-only teams last, in input order, with no first year", () => {
    const ranked = rankCareerTeams(
      [
        { teamId: "wisconsin" },
        { teamId: "brewers", fromYear: 2020, toYear: 2020 },
        { teamId: "madison" },
      ],
      NOW,
    );
    expect(ranked.map((t) => t.teamId)).toEqual(["brewers", "wisconsin", "madison"]);
    expect(ranked[1]).toEqual({ teamId: "wisconsin", spans: [], totalYears: 0 });
    expect("firstYear" in ranked[1]).toBe(false);
  });

  it("ranks a team with dated AND undated stints by its dated spans alone", () => {
    // The undated stint adds no years and no position: 2 seasons, first in
    // 2015, so it loses to 3 seasons elsewhere and its spans hold only the
    // dated stint.
    const ranked = rankCareerTeams(
      [
        { teamId: "mixed" },
        { teamId: "mixed", fromYear: 2015, toYear: 2016 },
        { teamId: "longer", fromYear: 2017, toYear: 2019 },
      ],
      NOW,
    );
    expect(ranked.map((t) => t.teamId)).toEqual(["longer", "mixed"]);
    expect(ranked[1]).toEqual({
      teamId: "mixed",
      spans: [{ fromYear: 2015, toYear: 2016 }],
      totalYears: 2,
      firstYear: 2015,
    });
  });

  it("counts an open stint through the current year", () => {
    const ranked = rankCareerTeams(
      [
        { teamId: "closed", fromYear: 2000, toYear: 2004 }, // 5
        { teamId: "open", fromYear: 2021 }, // 2021..2026 = 6
      ],
      NOW,
    );
    expect(ranked.map((t) => [t.teamId, t.totalYears])).toEqual([
      ["open", 6],
      ["closed", 5],
    ]);
    // The same row a year earlier: 5 v 5, tie → earliest first year.
    expect(order([
      { teamId: "closed", fromYear: 2000, toYear: 2004 },
      { teamId: "open", fromYear: 2021 },
    ], 2025)).toEqual(["closed", "open"]);
    // The span keeps no invented end year.
    expect(ranked[0].spans).toEqual([{ fromYear: 2021 }]);
  });

  it("counts bad data (an end before the start) as one season, never negative", () => {
    const [bad] = rankCareerTeams([{ teamId: "bad", fromYear: 2010, toYear: 2005 }], NOW);
    expect(bad.totalYears).toBe(1);
    // An open stint starting after the current year is bad data the same way.
    const [future] = rankCareerTeams([{ teamId: "future", fromYear: 2030 }], NOW);
    expect(future.totalYears).toBe(1);
  });

  it("does not let a bad-data stint subtract from a real one at the same team", () => {
    const ranked = rankCareerTeams(
      [
        { teamId: "a", fromYear: 2000, toYear: 2002 }, // 3
        { teamId: "a", fromYear: 2010, toYear: 2001 }, // bad → 1
        { teamId: "b", fromYear: 1990, toYear: 1993 }, // 4
      ],
      NOW,
    );
    // a: 3 + 1 = 4 (first 2000); b: 4 (first 1990). Tied, so b leads.
    expect(ranked.map((t) => [t.teamId, t.totalYears])).toEqual([
      ["b", 4],
      ["a", 4],
    ]);
  });

  it("never mutates its input", () => {
    const input = [
      { teamId: "b", fromYear: 2016, toYear: 2019 },
      { teamId: "a", fromYear: 2009 },
      { teamId: "b", fromYear: 2009, toYear: 2012 },
    ];
    const snapshot = structuredClone(input);
    rankCareerTeams(input, NOW);
    expect(input).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// careerLine
// ---------------------------------------------------------------------------

describe("careerLine", () => {
  const ranked = rankCareerTeams(
    [
      { teamId: "dodgers", fromYear: 2014, toYear: 2019 },
      { teamId: "brewers", fromYear: 2020, toYear: 2021 },
      { teamId: "padres", fromYear: 2022, toYear: 2022 },
      { teamId: "college" },
    ],
    NOW,
  );
  const names: Record<string, string> = {
    dodgers: "Dodgers",
    brewers: "Brewers",
    padres: "Padres",
    college: "Wisconsin",
  };

  it("is undefined for a player with no stints", () => {
    const teamName = vi.fn();
    expect(careerLine([], teamName)).toBeUndefined();
    expect(teamName).not.toHaveBeenCalled();
  });

  it("shows the first two ranked teams, named, and counts the rest", () => {
    expect(careerLine(ranked, (id) => names[id])).toEqual({
      teams: [
        { name: "Dodgers", spans: [{ fromYear: 2014, toYear: 2019 }] },
        { name: "Brewers", spans: [{ fromYear: 2020, toYear: 2021 }] },
      ],
      moreTeams: 2,
    });
  });

  it("calls teamName ONLY for the teams it shows", () => {
    // The server reads one team document per call; the op budget is charged
    // on the cap, so an unshown team must cost nothing.
    const teamName = vi.fn((id: string) => names[id]);
    careerLine(ranked, teamName);
    expect(teamName.mock.calls.map(([id]) => id)).toEqual(["dodgers", "brewers"]);
  });

  it("reports moreTeams 0 when every team fits", () => {
    const line = careerLine(ranked.slice(0, 1), (id) => names[id]);
    expect(line).toEqual({
      teams: [{ name: "Dodgers", spans: [{ fromYear: 2014, toYear: 2019 }] }],
      moreTeams: 0,
    });
  });

  it("honours a caller's cap, flooring zero, negatives and fractions to at least one", () => {
    expect(careerLine(ranked, (id) => names[id], 3)!.teams).toHaveLength(3);
    for (const cap of [0, -5, 0.5]) {
      const line = careerLine(ranked, (id) => names[id], cap)!;
      expect(line.teams.map((t) => t.name)).toEqual(["Dodgers"]);
      expect(line.moreTeams).toBe(3);
    }
    expect(careerLine(ranked, (id) => names[id], 2.9)!.teams).toHaveLength(2);
  });

  it("names an undated-only team with no spans", () => {
    const college = rankCareerTeams([{ teamId: "college" }], NOW);
    expect(careerLine(college, (id) => names[id])).toEqual({
      teams: [{ name: "Wisconsin", spans: [] }],
      moreTeams: 0,
    });
  });

  it("copies the spans, so editing the line cannot reach the ranking", () => {
    const line = careerLine(ranked, (id) => names[id])!;
    line.teams[0].spans[0].fromYear = 1900;
    expect(ranked[0].spans[0].fromYear).toBe(2014);
  });
});

// ---------------------------------------------------------------------------
// formatYearSpan
// ---------------------------------------------------------------------------

describe("formatYearSpan", () => {
  it.each([
    [{ fromYear: 2014, toYear: 2019 }, "2014–19"],
    [{ fromYear: 2000, toYear: 2009 }, "2000–09"],
    [{ fromYear: 2001, toYear: 2002 }, "2001–02"],
    [{ fromYear: 1900, toYear: 1999 }, "1900–99"],
    [{ fromYear: 1890, toYear: 1894 }, "1890–94"],
  ])("shortens the end year inside one century: %o → %s", (span, text) => {
    expect(formatYearSpan(span)).toBe(text);
  });

  it.each([
    [{ fromYear: 1999, toYear: 2000 }, "1999–2000"],
    [{ fromYear: 1998, toYear: 2004 }, "1998–2004"],
    [{ fromYear: 1899, toYear: 1901 }, "1899–1901"],
  ])("prints both years in full across a century: %o → %s", (span, text) => {
    expect(formatYearSpan(span)).toBe(text);
  });

  it("prints an open stint as –present", () => {
    expect(formatYearSpan({ fromYear: 2024 })).toBe("2024–present");
  });

  it("prints a single season as one year", () => {
    expect(formatYearSpan({ fromYear: 2019, toYear: 2019 })).toBe("2019");
  });

  it("prints bad data (end before start) in full rather than a misleading short form", () => {
    // `2010–05` would read as a real five-year span.
    expect(formatYearSpan({ fromYear: 2010, toYear: 2005 })).toBe("2010–2005");
    expect(formatYearSpan({ fromYear: 2001, toYear: 1999 })).toBe("2001–1999");
  });
});

// ---------------------------------------------------------------------------
// formatCareerTeam / formatCareerLine
// ---------------------------------------------------------------------------

describe("formatCareerTeam", () => {
  it("prints a team and its years", () => {
    expect(formatCareerTeam({ name: "Dodgers", spans: [{ fromYear: 2014, toYear: 2019 }] })).toBe(
      "Dodgers 2014–19",
    );
  });

  it("keeps repeat stints as separate spans, comma-joined, in order", () => {
    expect(
      formatCareerTeam({
        name: "Mariners",
        spans: [
          { fromYear: 2009, toYear: 2012 },
          { fromYear: 2016, toYear: 2019 },
        ],
      }),
    ).toBe("Mariners 2009–12, 2016–19");
  });

  it("prints an undated-only team as the bare name", () => {
    expect(formatCareerTeam({ name: "Wisconsin", spans: [] })).toBe("Wisconsin");
  });
});

describe("formatCareerLine", () => {
  const line: CareerLine = {
    teams: [
      { name: "Dodgers", spans: [{ fromYear: 2014, toYear: 2019 }] },
      { name: "Brewers", spans: [{ fromYear: 2020, toYear: 2021 }] },
    ],
    moreTeams: 1,
  };

  it("joins teams with a middle dot and counts the rest", () => {
    expect(formatCareerLine(line)).toBe("Dodgers 2014–19 · Brewers 2020–21 +1 more");
  });

  it("drops the +N more when nothing is left over", () => {
    expect(formatCareerLine({ ...line, moreTeams: 0 })).toBe("Dodgers 2014–19 · Brewers 2020–21");
  });

  it("is empty for no line or a line with no teams", () => {
    expect(formatCareerLine(undefined)).toBe("");
    expect(formatCareerLine({ teams: [], moreTeams: 0 })).toBe("");
  });

  it("formats the server's shape end to end: rank, name, print", () => {
    const ranked = rankCareerTeams(
      [
        { teamId: "brewers", fromYear: 2020, toYear: 2021 },
        { teamId: "mariners", fromYear: 2009, toYear: 2012 },
        { teamId: "rays", fromYear: 2013, toYear: 2013 },
        { teamId: "mariners", fromYear: 2016, toYear: 2019 },
      ],
      NOW,
    );
    const names: Record<string, string> = {
      brewers: "Brewers",
      mariners: "Mariners",
      rays: "Rays",
    };
    expect(formatCareerLine(careerLine(ranked, (id) => names[id]))).toBe(
      "Mariners 2009–12, 2016–19 · Brewers 2020–21 +1 more",
    );
  });
});

// ---------------------------------------------------------------------------
// formatPlayerDescription / speakPlayerDescription
// ---------------------------------------------------------------------------

const WALKER: CareerLine = {
  teams: [
    { name: "Dodgers", spans: [{ fromYear: 2014, toYear: 2019 }] },
    { name: "Brewers", spans: [{ fromYear: 2020, toYear: 2021 }] },
  ],
  moreTeams: 1,
};

const REPEAT: CareerLine = {
  teams: [
    {
      name: "Mariners",
      spans: [
        { fromYear: 2009, toYear: 2012 },
        { fromYear: 2016, toYear: 2019 },
      ],
    },
    { name: "Wisconsin", spans: [] },
  ],
  moreTeams: 0,
};

describe("formatPlayerDescription", () => {
  it("leads with the birth year, then the career", () => {
    expect(formatPlayerDescription({ birthYear: 1990, career: WALKER })).toBe(
      "b. 1990 · Dodgers 2014–19 · Brewers 2020–21 +1 more",
    );
  });

  it("prints the birth year alone when there is no career", () => {
    expect(formatPlayerDescription({ birthYear: 1990 })).toBe("b. 1990");
    expect(formatPlayerDescription({ birthYear: 1990, career: "" })).toBe("b. 1990");
  });

  it("prints the career alone when there is no birth year", () => {
    expect(formatPlayerDescription({ career: REPEAT })).toBe(
      "Mariners 2009–12, 2016–19 · Wisconsin",
    );
  });

  it("is empty when there is nothing to say (the caller prints NOTHING_ON_FILE)", () => {
    expect(formatPlayerDescription({})).toBe("");
    expect(formatPlayerDescription({ career: { teams: [], moreTeams: 0 } })).toBe("");
  });

  it("passes a pre-formatted career string through verbatim", () => {
    // The stored `careerSummary` on a review candidate is already a line.
    expect(
      formatPlayerDescription({ birthYear: 1867, career: "Phillies 1890–94" }),
    ).toBe("b. 1867 · Phillies 1890–94");
  });

  it("keeps a birth year of 0 rather than treating it as absent", () => {
    // Out of range for a real player, but the check is `!== undefined`, not
    // truthiness; pinned so a refactor to `if (birthYear)` is noticed.
    expect(formatPlayerDescription({ birthYear: 0 })).toBe("b. 0");
  });
});

describe("speakPlayerDescription", () => {
  it("uses commas for dots and 'plus N more' for '+N more'", () => {
    expect(speakPlayerDescription({ birthYear: 1990, career: WALKER })).toBe(
      "b. 1990, Dodgers 2014–19, Brewers 2020–21, plus 1 more",
    );
  });

  it("joins repeat stints at one team with 'and', so team boundaries stay audible", () => {
    expect(speakPlayerDescription({ career: REPEAT })).toBe(
      "Mariners 2009–12 and 2016–19, Wisconsin",
    );
  });

  it("speaks the birth year alone", () => {
    expect(speakPlayerDescription({ birthYear: 1990 })).toBe("b. 1990");
  });

  it("is empty when there is nothing to say", () => {
    expect(speakPlayerDescription({})).toBe("");
    expect(speakPlayerDescription({ career: { teams: [], moreTeams: 0 } })).toBe("");
  });

  it("never says 'plus N more' with nothing before it", () => {
    expect(speakPlayerDescription({ career: { teams: [], moreTeams: 3 } })).toBe("");
  });
});
