import { describe, expect, it } from "vitest";
import {
  PUBLISHED_CHECKLIST_MAX_NAME,
  PUBLISHED_CHECKLIST_MAX_ROWS,
  parsePublishedChecklist,
  splitDelimited,
} from "./parse-published-checklist";

describe("parsePublishedChecklist — the published line format", () => {
  it("reads number, player and team, dropping the bracketed note", () => {
    const out = parsePublishedChecklist("60 Rhett Lowder - Cincinnati Reds (Future Stars)");
    expect(out.format).toBe("lines");
    expect(out.skipped).toEqual([]);
    expect(out.rows).toEqual([
      { number: "60", players: ["Rhett Lowder"], teams: ["Cincinnati Reds"] },
    ]);
  });

  it("splits several players on a slash and keeps no team when none is given", () => {
    const out = parsePublishedChecklist("11 Alonso/Schwarber/Soto (League Leaders)");
    expect(out.rows).toEqual([
      { number: "11", players: ["Alonso", "Schwarber", "Soto"], teams: [] },
    ]);
  });

  it("splits the players of a spaced slash list", () => {
    const out = parsePublishedChecklist("12 A / B / C (League Leaders)");
    expect(out.rows[0].players).toEqual(["A", "B", "C"]);
  });

  it("reads a Team Card as a team row with no player", () => {
    const out = parsePublishedChecklist("34 Team Card - Kansas City Royals");
    expect(out.rows).toEqual([{ number: "34", players: [], teams: ["Kansas City Royals"] }]);
  });

  it("drops RC markers whether bare or bracketed, but keeps a name that merely contains rc", () => {
    const out = parsePublishedChecklist(
      ["5 Jackson Holliday RC - Baltimore Orioles", "6 Marcus Arcos (RC) - Chicago Cubs"].join("\n"),
    );
    expect(out.rows.map((r) => r.players)).toEqual([["Jackson Holliday"], ["Marcus Arcos"]]);
  });

  it("keeps a hyphenated name whole and takes the team after the spaced dash", () => {
    const out = parsePublishedChecklist("7 Ryu Hyun-jin - Toronto Blue Jays");
    expect(out.rows[0]).toEqual({
      number: "7",
      players: ["Ryu Hyun-jin"],
      teams: ["Toronto Blue Jays"],
    });
  });

  it("accepts prefixed and hash-led card numbers", () => {
    const out = parsePublishedChecklist("BDC-12 Some Player - Team A\n#45 Other Player - Team B");
    expect(out.rows.map((r) => r.number)).toEqual(["BDC-12", "45"]);
  });

  it("keeps two rows with the same number (a number is never assumed unique)", () => {
    const out = parsePublishedChecklist("10 A Player - Team A\n10 B Player - Team B");
    expect(out.rows).toHaveLength(2);
  });

  it("lists every unparsable line in skipped with its 1-based line number and a reason", () => {
    const out = parsePublishedChecklist(
      ["60 Rhett Lowder - Cincinnati Reds", "", "Header words here", "61", "62 Ok Player"].join("\n"),
    );
    expect(out.rows.map((r) => r.number)).toEqual(["60", "62"]);
    expect(out.skipped).toEqual([
      { line: 3, text: "Header words here", reason: expect.any(String) },
      { line: 4, text: "61", reason: expect.any(String) },
    ]);
    for (const s of out.skipped) expect(s.reason.length).toBeGreaterThan(0);
  });

  it("returns nothing for blank input", () => {
    expect(parsePublishedChecklist("  \n\n")).toEqual({ rows: [], skipped: [], format: "lines" });
  });

  it("reads CRLF and a leading BOM", () => {
    const out = parsePublishedChecklist("﻿1 A Player - Team A\r\n2 B Player - Team B");
    expect(out.rows.map((r) => r.number)).toEqual(["1", "2"]);
  });
});

describe("parsePublishedChecklist — CSV and TSV with a header", () => {
  it("finds columns by header name in any order and detects csv", () => {
    const out = parsePublishedChecklist("Team,Card Number,Player\nCincinnati Reds,60,Rhett Lowder");
    expect(out.format).toBe("csv");
    expect(out.rows).toEqual([
      { number: "60", players: ["Rhett Lowder"], teams: ["Cincinnati Reds"] },
    ]);
  });

  it("detects tsv and accepts alternate spellings (Card No., Names, Club)", () => {
    const out = parsePublishedChecklist("Card No.\tNames\tClub\n9\tA Guy\tBoston Red Sox");
    expect(out.format).toBe("tsv");
    expect(out.rows[0]).toEqual({ number: "9", players: ["A Guy"], teams: ["Boston Red Sox"] });
  });

  it("splits a cell on slash and semicolon, and honours quoted commas", () => {
    const out = parsePublishedChecklist(
      '#,Player,Team\n3,"Alonso; Schwarber/Soto","Team, One / Team Two"',
    );
    expect(out.rows[0].players).toEqual(["Alonso", "Schwarber", "Soto"]);
    expect(out.rows[0].teams).toEqual(["Team, One", "Team Two"]);
  });

  it("does not treat a comma-bearing first line without a number header as csv", () => {
    const out = parsePublishedChecklist("Name,Team\nA,B");
    expect(out.format).toBe("lines");
  });

  it("skips a data row with an unreadable or missing number, with a reason", () => {
    const out = parsePublishedChecklist("Number,Player\nxx,A Guy\n,B Guy\n4,C Guy");
    expect(out.rows.map((r) => r.number)).toEqual(["4"]);
    expect(out.skipped.map((s) => s.line)).toEqual([2, 3]);
    expect(out.skipped[0].reason).not.toBe(out.skipped[1].reason);
  });

  it("skips a row with a number but no player or team", () => {
    const out = parsePublishedChecklist("Number,Player,Team\n8,,");
    expect(out.rows).toEqual([]);
    expect(out.skipped).toHaveLength(1);
  });

  it("splitDelimited unescapes doubled quotes", () => {
    expect(splitDelimited('a,"b ""c"" d",e', ",")).toEqual(["a", 'b "c" d', "e"]);
  });
});

describe("parsePublishedChecklist — caps", () => {
  it("skips a row whose player name is over the limit", () => {
    const long = "x".repeat(PUBLISHED_CHECKLIST_MAX_NAME + 1);
    const out = parsePublishedChecklist(`1 ${long} - Team A\n2 Fine - Team B`);
    expect(out.rows.map((r) => r.number)).toEqual(["2"]);
    expect(out.skipped[0]).toMatchObject({ line: 1 });
  });

  it("keeps the first 2,000 rows and lists the rest as skipped", () => {
    const text = Array.from({ length: PUBLISHED_CHECKLIST_MAX_ROWS + 3 }, (_, i) => `${i + 1} P${i} - T`).join("\n");
    const out = parsePublishedChecklist(text);
    expect(out.rows).toHaveLength(PUBLISHED_CHECKLIST_MAX_ROWS);
    expect(out.skipped).toHaveLength(3);
    expect(out.skipped[0].line).toBe(PUBLISHED_CHECKLIST_MAX_ROWS + 1);
  });
});
