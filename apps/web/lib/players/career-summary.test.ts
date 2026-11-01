/**
 * NEO-254 — the one-line career the review wizard uses to tell two players
 * with the same name apart.
 *
 * What is locked in here is the arithmetic behind "+N more". The server
 * builder reads only as many team documents as it will name, so the count of
 * unseen stints arrives separately from the list — and if those two ever
 * disagree the operator is shown a truncated career that reads as a complete
 * one, which is the exact failure the panel exists to prevent.
 */

import { describe, expect, it } from "vitest";
import {
  CAREER_SUMMARY_MAX_TEAMS,
  formatCareerSummary,
} from "./career-summary";

const gwynn = [
  { teamName: "Padres", fromYear: 1982, toYear: 2001 },
];

describe("formatCareerSummary", () => {
  it("renders one stint as team then years", () => {
    expect(formatCareerSummary(gwynn)).toBe("Padres 1982–2001");
  });

  it("renders an open-ended stint as present rather than leaving it dangling", () => {
    expect(formatCareerSummary([{ teamName: "Angels", fromYear: 2011 }])).toBe(
      "Angels 2011–present",
    );
  });

  it("joins several stints in the order given, without re-sorting them", () => {
    // Deliberately NOT chronological: the caller sorts (`sortTeamYears`), and
    // a formatter that quietly re-sorted would hide a caller that forgot to.
    expect(
      formatCareerSummary([
        { teamName: "Mariners", fromYear: 2009, toYear: 2010 },
        { teamName: "Reds", fromYear: 2000, toYear: 2008 },
      ]),
    ).toBe("Mariners 2009–2010 · Reds 2000–2008");
  });

  it("keeps two stints at one franchise separate", () => {
    // Traded away and re-signed is real history, and the gap is exactly the
    // kind of detail that settles which of two same-named men is on a card.
    expect(
      formatCareerSummary([
        { teamName: "Reds", fromYear: 1990, toYear: 1993 },
        { teamName: "Reds", fromYear: 1997, toYear: 1999 },
      ]),
    ).toBe("Reds 1990–1993 · Reds 1997–1999");
  });

  it("names at most CAREER_SUMMARY_MAX_TEAMS stints and counts the rest", () => {
    const stints = Array.from({ length: 6 }, (_, i) => ({
      teamName: `Team ${i}`,
      fromYear: 1990 + i,
      toYear: 1990 + i,
    }));
    const summary = formatCareerSummary(stints);
    expect(summary).toContain("Team 0 1990–1990");
    expect(summary).toContain(`Team ${CAREER_SUMMARY_MAX_TEAMS - 1}`);
    expect(summary).not.toContain(`Team ${CAREER_SUMMARY_MAX_TEAMS}`);
    expect(summary.endsWith(`+${6 - CAREER_SUMMARY_MAX_TEAMS} more`)).toBe(true);
  });

  it("adds `extra` to the overflow count, for stints the caller never read", () => {
    // The server builder's case: it resolved three team names and knows there
    // are four more it deliberately did not look up.
    expect(
      formatCareerSummary(
        [
          { teamName: "Padres", fromYear: 1982, toYear: 1990 },
          { teamName: "Yankees", fromYear: 1991, toYear: 1994 },
          { teamName: "Reds", fromYear: 1995, toYear: 1998 },
        ],
        { extra: 4 },
      ),
    ).toBe("Padres 1982–1990 · Yankees 1991–1994 · Reds 1995–1998 +4 more");
  });

  it("counts trimmed and unread stints together in one +N", () => {
    expect(
      formatCareerSummary(
        [
          { teamName: "A", fromYear: 1990 },
          { teamName: "B", fromYear: 1991 },
        ],
        { maxTeams: 1, extra: 3 },
      ),
    ).toBe("A 1990–present +4 more");
  });

  it("returns empty for a player with no recorded stints", () => {
    // The caller says what an empty career means, in its own voice — a
    // formatter that invented "No career on file" would put copy somewhere
    // nobody would think to look for it.
    expect(formatCareerSummary([])).toBe("");
  });

  it("returns empty rather than a bare +N when nothing is nameable", () => {
    expect(formatCareerSummary([], { extra: 5 })).toBe("");
  });

  it("floors maxTeams at one, so a summary always names something", () => {
    expect(
      formatCareerSummary(
        [
          { teamName: "Padres", fromYear: 1982 },
          { teamName: "Yankees", fromYear: 1990 },
        ],
        { maxTeams: 0 },
      ),
    ).toBe("Padres 1982–present +1 more");
  });
});
