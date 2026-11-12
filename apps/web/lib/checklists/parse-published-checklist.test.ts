import { describe, expect, it } from "vitest";
import { NO_TEAM_AND_A_TEAM } from "./no-team";
import {
  LOOKS_LIKE_A_COUNT,
  NO_NUMBER,
  filterRowsBySubsets,
  PUBLISHED_CHECKLIST_MAX_LINE,
  PUBLISHED_CHECKLIST_MAX_NAME,
  PUBLISHED_CHECKLIST_MAX_ROWS,
  PUBLISHED_CHECKLIST_MAX_TEXT,
  LOOKS_LIKE_A_TITLE,
  parsePublishedChecklist,
  splitDelimited,
  ABOVE_THE_HEADER,
  NOT_IN_A_SECTION,
  NOT_READ_PAST_HERE,
  ONE_CELL_ONLY,
  PUBLISHED_CHECKLIST_MAX_TOTAL_ROWS,
  TOO_MANY_COLUMNS,
  capLeafRows,
  headingText,
  parsePublishedChecklistCells,
  pastFileLimit,
  pastLimit,
  type ChecklistCellRecord,
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

describe("parsePublishedChecklist — a title line is not a card", () => {
  it("skips a line led by a season as a title, whatever the separator", () => {
    const out = parsePublishedChecklist(
      [
        "1995-96 Fort Worth Fire team set",
        "2024/25 Topps Chrome",
        "1999–2000 Upper Deck",
        "1 Scott Allen - Fort Worth Fire",
      ].join("\n"),
    );
    expect(out.rows.map((r) => r.number)).toEqual(["1"]);
    expect(out.skipped).toEqual([
      { line: 1, text: "1995-96 Fort Worth Fire team set", reason: LOOKS_LIKE_A_TITLE },
      { line: 2, text: "2024/25 Topps Chrome", reason: LOOKS_LIKE_A_TITLE },
      { line: 3, text: "1999–2000 Upper Deck", reason: LOOKS_LIKE_A_TITLE },
    ]);
    expect(LOOKS_LIKE_A_TITLE).toBe("Looks like a title, not a card");
  });

  it("keeps a card number that only looks like a range or a year without a set year", () => {
    const out = parsePublishedChecklist(
      ["BDC-12 Some Player - Team A", "1995 Some Player - Team B", "1895-96 Old Timer - Team C"].join(
        "\n",
      ),
    );
    expect(out.rows.map((r) => r.number)).toEqual(["BDC-12", "1995", "1895-96"]);
    expect(out.skipped).toEqual([]);
  });

  it("skips a line whose number is the set's year, given as a number, a string or a season", () => {
    const text = "1995 Fort Worth Fire\n#1995. Fort Worth Fire\n1 Scott Allen - Fort Worth Fire";
    for (const setYear of [1995, "1995", "1995-96"]) {
      const out = parsePublishedChecklist(text, { setYear });
      expect(out.rows.map((r) => r.number)).toEqual(["1"]);
      expect(out.skipped.map((s) => [s.line, s.reason])).toEqual([
        [1, LOOKS_LIKE_A_TITLE],
        [2, LOOKS_LIKE_A_TITLE],
      ]);
    }
  });

  it("keeps another year's number, and ignores a set year it cannot read", () => {
    expect(
      parsePublishedChecklist("1996 Some Player - Team A", { setYear: 1995 }).rows,
    ).toHaveLength(1);
    for (const setYear of [null, undefined, "", "Unknown", "95", "19955"]) {
      expect(
        parsePublishedChecklist("1995 Some Player - Team A", { setYear }).rows,
      ).toHaveLength(1);
    }
  });

  it("skips a title in a CSV number column too", () => {
    const out = parsePublishedChecklist(
      "Card Number,Player,Team\n1995-96,Fort Worth Fire,\n2024,Header,Card\n7,A Guy,Team A",
      { setYear: "2024" },
    );
    expect(out.format).toBe("csv");
    expect(out.rows.map((r) => r.number)).toEqual(["7"]);
    expect(out.skipped.map((s) => [s.line, s.reason])).toEqual([
      [2, LOOKS_LIKE_A_TITLE],
      [3, LOOKS_LIKE_A_TITLE],
    ]);
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
    const out = parsePublishedChecklist("Number,Player\nBDC 12,A Guy\n,B Guy\n4,C Guy");
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
  it("skips a row naming more players or teams than one card holds (the server's caps)", () => {
    const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("/");
    const out = parsePublishedChecklist(
      [
        "#,Player,Team",
        `1,${names("P", 20)},${names("T", 8)}`,
        `2,${names("P", 21)},T`,
        `3,P,${names("T", 9)}`,
      ].join("\n"),
    );
    expect(out.rows.map((r) => [r.number, r.players.length, r.teams.length])).toEqual([["1", 20, 8]]);
    expect(out.skipped.map((s) => [s.line, s.reason])).toEqual([
      [3, "More than 20 players on one card"],
      [4, "More than 8 teams on one card"],
    ]);
  });

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

describe("parsePublishedChecklist — adversarial input", () => {
  // Before the fix, splitting on /\s+[-–—]\s+/ backtracked over a whitespace
  // run: 100k spaces took ~7 s on the main thread. Each case here must stay
  // far under that; the bound is loose so a busy CI box cannot flake it.
  const FAST_MS = 1000;
  const timed = (text: string) => {
    const started = performance.now();
    const out = parsePublishedChecklist(text);
    return { out, ms: performance.now() - started };
  };

  it("a 100k-space line between a number and a name is skipped as too long, fast", () => {
    const line = `1 A${" ".repeat(100_000)}B`;
    const { out, ms } = timed(`${line}\n2 Fine - Team B`);
    expect(ms).toBeLessThan(FAST_MS);
    expect(out.rows.map((r) => r.number)).toEqual(["2"]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({
      line: 1,
      reason: `Longer than ${PUBLISHED_CHECKLIST_MAX_LINE.toLocaleString("en-US")} characters`,
    });
    // The preview keeps only a short start of the line.
    expect(out.skipped[0].text.length).toBeLessThanOrEqual(81);
  });

  it("a line of nothing but 100k spaces is blank, fast", () => {
    const { out, ms } = timed(`${" ".repeat(100_000)}\n2 Fine - Team B`);
    expect(ms).toBeLessThan(FAST_MS);
    expect(out.rows).toHaveLength(1);
    expect(out.skipped).toEqual([]);
  });

  it("an over-long first line is skipped, not read as a header", () => {
    const first = `#,Player,Team${",".repeat(PUBLISHED_CHECKLIST_MAX_LINE)}`;
    const out = parsePublishedChecklist(`${first}\n2 Fine - Team B`);
    expect(out.format).toBe("lines");
    expect(out.skipped.map((s) => s.line)).toEqual([1]);
    expect(out.rows.map((r) => r.number)).toEqual(["2"]);
  });

  it("whitespace runs under the line cap still split the team off, fast", () => {
    const gap = " ".repeat(600);
    const { out, ms } = timed(`7 Jean-Carlos${gap}Ruiz${gap}-\t${gap}Detroit Tigers`);
    expect(ms).toBeLessThan(FAST_MS);
    expect(out.rows).toEqual([
      { number: "7", players: ["Jean-Carlos Ruiz"], teams: ["Detroit Tigers"] },
    ]);
  });

  it("a line exactly at the cap is still read", () => {
    const pad = " ".repeat(PUBLISHED_CHECKLIST_MAX_LINE - "9 A - T".length);
    const out = parsePublishedChecklist(`9 A${pad} - T`.slice(0, PUBLISHED_CHECKLIST_MAX_LINE));
    expect(out.skipped).toEqual([]);
    expect(out.rows).toHaveLength(1);
  });

  it("refuses text over the 2 MB cap without parsing any of it", () => {
    const line = "1 Rhett Lowder - Cincinnati Reds\n";
    const text = line.repeat(Math.ceil((PUBLISHED_CHECKLIST_MAX_TEXT + 1) / line.length));
    expect(text.length).toBeGreaterThan(PUBLISHED_CHECKLIST_MAX_TEXT);
    const { out, ms } = timed(text);
    expect(ms).toBeLessThan(FAST_MS);
    expect(out).toEqual({ rows: [], skipped: [], format: "lines", tooBig: true });
  });

  describe("a whole file at the size cap, one adversarial line repeated", () => {
    // A per-line cap does not bound the whole parse: lines x quadratic-per-line
    // still stalls. Before the fix, `/[\s,]+$/` in the name trim made a 2 MB
    // headered CSV of "a , , , … x" cells take ~9-31 s. Each file here fills
    // the 2 MB cap with one line just under the line cap, repeated.
    const WHOLE_FILE_MS = 2000;
    const commaRun = (length: number) => `a${" ,".repeat(Math.floor((length - 2) / 2))}x`;
    const fillToCap = (head: string, line: string) => {
      const count = Math.floor((PUBLISHED_CHECKLIST_MAX_TEXT - head.length) / (line.length + 1));
      return { text: head + Array(count).fill(line).join("\n"), count };
    };
    const parsesWholeFileFast = (head: string, line: string) => {
      expect(line.length).toBeLessThanOrEqual(PUBLISHED_CHECKLIST_MAX_LINE);
      const { text, count } = fillToCap(head, line);
      expect(text.length).toBeGreaterThan(PUBLISHED_CHECKLIST_MAX_TEXT - 2 * PUBLISHED_CHECKLIST_MAX_LINE);
      expect(text.length).toBeLessThanOrEqual(PUBLISHED_CHECKLIST_MAX_TEXT);
      const { out, ms } = timed(text);
      expect(out.tooBig).toBeUndefined();
      // Every line was read: each is a row or a skipped entry.
      expect(out.rows.length + out.skipped.length).toBe(count);
      expect(ms).toBeLessThan(WHOLE_FILE_MS);
      return out;
    };

    it("a 2 MB headered CSV whose player cell is 'a , , , … x' on every line", () => {
      const out = parsesWholeFileFast("#,Player,Team\n", `1,"${commaRun(1900)}",Royals`);
      expect(out.format).toBe("csv");
    });

    it("a 2 MB headered CSV whose team cell is 'a , , , … x' on every line", () => {
      const out = parsesWholeFileFast("#,Player,Team\n", `1,Mike Trout,"${commaRun(1900)}"`);
      expect(out.format).toBe("csv");
    });

    it("a 2 MB line-format file whose team is 'a , , , … x' on every line", () => {
      const out = parsesWholeFileFast("", `1 Mike Trout - ${commaRun(1900)}`);
      expect(out.format).toBe("lines");
    });

    it("a 2 MB line-format file whose players are 'a , , , … x' on every line", () => {
      const out = parsesWholeFileFast("", `1 ${commaRun(1900)}`);
      expect(out.format).toBe("lines");
    });

    it("a 2 MB headerless TSV whose player cell is 'a , , , … x' on every line", () => {
      const out = parsesWholeFileFast("", `1\t${commaRun(1900)}\tRoyals`);
      expect(out.format).toBe("tsv");
    });

    it("a 2 MB line-format file of long first words before a U+2028", () => {
      // `.*$` stopped at the U+2028 and retried every shorter first word.
      parsesWholeFileFast("", `1${"a".repeat(999)} ${"b".repeat(900)} c`);
    });

    it("a 2 MB headered CSV whose player cell names 900 players on every line", () => {
      // Each row was kept with its 900 names: a million strings held for the
      // preview (~2 s, mostly GC). The server's per-card caps now skip them.
      const out = parsesWholeFileFast("#,Player,Team\n", `1,${"A/".repeat(900)},${"B/".repeat(40)}`);
      expect(out.rows).toEqual([]);
      expect(out.skipped[0].reason).toBe("More than 20 players on one card");
    });

    it("a 2 MB headered CSV whose cell is a long run of quotes", () => {
      const out = parsesWholeFileFast("#,Player,Team\n", `1,${" ".repeat(900)}a${'"'.repeat(1000)},Royals`);
      expect(out.format).toBe("csv");
    });
  });

  it("a comma left at either end of a name still goes", () => {
    const out = parsePublishedChecklist('#,Player,Team\n1," , Mike Trout , , ,\t","Angels , "');
    expect(out.rows).toEqual([{ number: "1", players: ["Mike Trout"], teams: ["Angels"] }]);
  });

  it("a U+2028 inside a line no longer stops the line being read", () => {
    const out = parsePublishedChecklist("1 Mike Trout - Angels");
    expect(out.rows).toEqual([{ number: "1", players: ["Mike Trout"], teams: ["Angels"] }]);
  });

  it("a quote after a blank quoted cell still opens a quote", () => {
    expect(splitDelimited(`1,"" "a,b",c`, ",")).toEqual(["1", "a,b", "c"]);
    expect(splitDelimited(`1,x"a,b",c`, ",")).toEqual(["1", 'x"a', 'b"', "c"]);
    expect(splitDelimited(`1,"""a",c`, ",")).toEqual(["1", '"a', "c"]);
  });

  it("text exactly at the cap is read", () => {
    const head = "1 Rhett Lowder - Cincinnati Reds\n";
    const text = head + "\n".repeat(PUBLISHED_CHECKLIST_MAX_TEXT - head.length);
    expect(text.length).toBe(PUBLISHED_CHECKLIST_MAX_TEXT);
    const out = parsePublishedChecklist(text);
    expect(out.tooBig).toBeUndefined();
    expect(out.rows).toHaveLength(1);
  });
});

describe("parsePublishedChecklist — collector review B2: team separators", () => {
  it("a comma separates the team when there is no spaced dash", () => {
    const out = parsePublishedChecklist("1 Shohei Ohtani, Los Angeles Dodgers");
    expect(out.skipped).toEqual([]);
    expect(out.rows).toEqual([
      { number: "1", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"] },
    ]);
  });

  it("a comma before a name suffix is part of the name, the next one starts the team", () => {
    const out = parsePublishedChecklist("1 Ken Griffey, Jr., Seattle Mariners");
    expect(out.rows).toEqual([
      { number: "1", players: ["Ken Griffey, Jr."], teams: ["Seattle Mariners"] },
    ]);
  });

  it("three or more comma parts are a player list with no team, the note dropped", () => {
    const out = parsePublishedChecklist("11 Alonso, Schwarber, Soto (League Leaders)");
    expect(out.skipped).toEqual([]);
    expect(out.rows).toEqual([
      { number: "11", players: ["Alonso", "Schwarber", "Soto"], teams: [] },
    ]);
  });

  it("a name suffix does not count as a comma part", () => {
    const out = parsePublishedChecklist(
      ["1 Ken Griffey, Jr., Seattle Mariners", "2 Ken Griffey, Jr., Ken Griffey, Sr., Barry Bonds"].join("\n"),
    );
    expect(out.rows).toEqual([
      { number: "1", players: ["Ken Griffey, Jr."], teams: ["Seattle Mariners"] },
      { number: "2", players: ["Ken Griffey, Jr.", "Ken Griffey, Sr.", "Barry Bonds"], teams: [] },
    ]);
  });

  it("a marker-only comma part does not count either", () => {
    const out = parsePublishedChecklist("1 Shohei Ohtani, Los Angeles Dodgers, RC");
    expect(out.rows).toEqual([
      { number: "1", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"] },
    ]);
  });

  it("exactly two comma parts stay player, team", () => {
    const out = parsePublishedChecklist("27 Aaron Judge, New York Yankees");
    expect(out.rows).toEqual([
      { number: "27", players: ["Aaron Judge"], teams: ["New York Yankees"] },
    ]);
  });

  it("a spaced dash still wins over a comma", () => {
    const out = parsePublishedChecklist("3 Bobby Witt Jr. - Kansas City Royals, AL");
    expect(out.rows[0]).toEqual({
      number: "3",
      players: ["Bobby Witt Jr."],
      teams: ["Kansas City Royals, AL"],
    });
  });

  it("reads a headerless TSV by position: number, player, team", () => {
    const out = parsePublishedChecklist("1\tMike Trout\tLos Angeles Angels");
    expect(out.format).toBe("tsv");
    expect(out.skipped).toEqual([]);
    expect(out.rows).toEqual([
      { number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"] },
    ]);
  });

  it("reads a headerless CSV by position instead of skipping every line", () => {
    const out = parsePublishedChecklist(
      ["1,Mike Trout,Los Angeles Angels", "2,Shohei Ohtani,Los Angeles Dodgers"].join("\n"),
    );
    expect(out.format).toBe("csv");
    expect(out.skipped).toEqual([]);
    expect(out.rows).toEqual([
      { number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"] },
      { number: "2", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"] },
    ]);
  });

  it("a headerless file reads a title line without the delimiter as a line", () => {
    const out = parsePublishedChecklist(
      ["2024 Topps Series 1", "1,Mike Trout,Los Angeles Angels", "2,Shohei Ohtani,"].join("\n"),
      { setYear: 2024 },
    );
    expect(out.format).toBe("csv");
    expect(out.rows).toEqual([
      { number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"] },
      { number: "2", players: ["Shohei Ohtani"], teams: [] },
    ]);
    expect(out.skipped).toEqual([{ line: 1, text: "2024 Topps Series 1", reason: LOOKS_LIKE_A_TITLE }]);
  });

  it("does not read lines as positional when most carry fewer than two delimiters", () => {
    const out = parsePublishedChecklist(
      ["1 Shohei Ohtani, Los Angeles Dodgers", "2 Mike Trout, Los Angeles Angels"].join("\n"),
    );
    expect(out.format).toBe("lines");
    expect(out.rows.map((r) => r.teams)).toEqual([["Los Angeles Dodgers"], ["Los Angeles Angels"]]);
  });

  it("a run of three or more dots is a separator (dot leaders)", () => {
    const out = parsePublishedChecklist(
      ["1 Mike Trout ..... Los Angeles Angels", "2 Shohei Ohtani...Los Angeles Dodgers"].join("\n"),
    );
    expect(out.rows).toEqual([
      { number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"] },
      { number: "2", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"] },
    ]);
  });

  it("an unspaced em or en dash between words is a separator (S7)", () => {
    const out = parsePublishedChecklist(
      ["1 Mike Trout—Los Angeles Angels", "2 Shohei Ohtani–Los Angeles Dodgers"].join("\n"),
    );
    expect(out.rows).toEqual([
      { number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"] },
      { number: "2", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"] },
    ]);
  });

  it("an unspaced plain hyphen is still part of a name", () => {
    const out = parsePublishedChecklist("7 Ryu Hyun-jin - Toronto Blue Jays");
    expect(out.rows[0].players).toEqual(["Ryu Hyun-jin"]);
  });
});

describe("parsePublishedChecklist — collector review S1: hobby markers", () => {
  it("drops SP, SSP, VAR, HOF, AU, RC and 1st as whole tokens", () => {
    const out = parsePublishedChecklist(
      [
        "1 Mike Trout SP - Los Angeles Angels",
        "2 Shohei Ohtani SSP - Los Angeles Dodgers",
        "3 Aaron Judge VAR - New York Yankees",
        "4 Ken Griffey Jr. HOF - Seattle Mariners",
        "5 Paul Skenes AU - Pittsburgh Pirates",
        "6 Jackson Holliday RC 1st - Baltimore Orioles",
        "7 Spencer Strider - Atlanta Braves",
        "8 Austin Riley - Atlanta Braves",
      ].join("\n"),
    );
    expect(out.rows.map((r) => r.players)).toEqual([
      ["Mike Trout"],
      ["Shohei Ohtani"],
      ["Aaron Judge"],
      ["Ken Griffey Jr."],
      ["Paul Skenes"],
      ["Jackson Holliday"],
      ["Spencer Strider"],
      ["Austin Riley"],
    ]);
  });

  it("drops print runs /99 and #/99", () => {
    const out = parsePublishedChecklist(
      ["1 Mike Trout /99 - Los Angeles Angels", "2 Shohei Ohtani #/25 - Los Angeles Dodgers"].join("\n"),
    );
    expect(out.rows.map((r) => [r.players, r.teams])).toEqual([
      [["Mike Trout"], ["Los Angeles Angels"]],
      [["Shohei Ohtani"], ["Los Angeles Dodgers"]],
    ]);
  });

  it("a trailing ' - <marker>' segment is a note, never the team", () => {
    const out = parsePublishedChecklist(
      [
        "1 Mike Trout - Los Angeles Angels - SP",
        "2 Jackson Holliday - RC",
        "3 Paul Skenes - Pittsburgh Pirates - #/99",
      ].join("\n"),
    );
    expect(out.rows).toEqual([
      { number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"] },
      { number: "2", players: ["Jackson Holliday"], teams: [] },
      { number: "3", players: ["Paul Skenes"], teams: ["Pittsburgh Pirates"] },
    ]);
  });

  it("a trailing ', <marker>' is a note, never the team", () => {
    const out = parsePublishedChecklist("2 Jackson Holliday, RC");
    expect(out.rows).toEqual([{ number: "2", players: ["Jackson Holliday"], teams: [] }]);
  });

  it("drops markers in CSV cells too", () => {
    const out = parsePublishedChecklist("#,Player,Team\n1,Mike Trout SP /99,Los Angeles Angels");
    expect(out.rows[0]).toEqual({ number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"] });
  });

  it("drops EXCH, Exchange, UER, FBC and a lone 1/1 as whole tokens", () => {
    const out = parsePublishedChecklist(
      [
        "1 Mike Trout EXCH - Los Angeles Angels",
        "2 Shohei Ohtani Exchange - Los Angeles Dodgers",
        "3 Aaron Judge EXCHANGE - New York Yankees",
        "4 Ken Griffey Jr. UER - Seattle Mariners",
        "5 Jackson Holliday FBC - Baltimore Orioles",
        "6 Paul Skenes 1/1 - Pittsburgh Pirates",
        "7 Bobby Witt Jr. RC 1/1 EXCH - Kansas City Royals",
      ].join("\n"),
    );
    expect(out.rows.map((r) => [r.players, r.teams])).toEqual([
      [["Mike Trout"], ["Los Angeles Angels"]],
      [["Shohei Ohtani"], ["Los Angeles Dodgers"]],
      [["Aaron Judge"], ["New York Yankees"]],
      [["Ken Griffey Jr."], ["Seattle Mariners"]],
      [["Jackson Holliday"], ["Baltimore Orioles"]],
      [["Paul Skenes"], ["Pittsburgh Pirates"]],
      [["Bobby Witt Jr."], ["Kansas City Royals"]],
    ]);
  });

  it("keeps a name that merely holds those letters", () => {
    const out = parsePublishedChecklist(
      ["1 Exchanger Uerta - Fbc Club", "3 Joe exch Smith - Boston Red Sox"].join("\n"),
    );
    expect(out.rows.map((r) => r.players)).toEqual([["Exchanger Uerta"], ["Joe exch Smith"]]);
    expect(out.rows[0].teams).toEqual(["Fbc Club"]);
  });

  it("drops the new markers in a CSV's team cell too", () => {
    const out = parsePublishedChecklist("#,Player,Team\n1,Mike Trout UER,Los Angeles Angels EXCH");
    expect(out.rows[0]).toEqual({ number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"] });
  });
});

describe("parsePublishedChecklist — collector review S2: insert codes and NNO", () => {
  it("accepts letter-hyphen-letter insert numbers", () => {
    const out = parsePublishedChecklist(
      [
        "RA-MT Mike Trout - Los Angeles Angels",
        "DA-TJ Judge/Trout - New York Yankees",
        "CPA-JH Jackson Holliday - Baltimore Orioles",
      ].join("\n"),
    );
    expect(out.skipped).toEqual([]);
    expect(out.rows.map((r) => r.number)).toEqual(["RA-MT", "DA-TJ", "CPA-JH"]);
  });

  it("does not take a hyphenated name for a letter code", () => {
    const out = parsePublishedChecklist("Jean-Carlos Ruiz - Detroit Tigers");
    expect(out.rows).toEqual([]);
    expect(out.skipped[0].reason).toBe("No card number at the start");
  });

  it("keeps an NNO line as a row flagged noNumber, in lines and in CSV (PR 451 D-B)", () => {
    expect(NO_NUMBER).toBe("NNO");
    const lines = parsePublishedChecklist(
      "NNO Mike Trout - Los Angeles Angels\nnno Header Card\n#NNO. Shohei Ohtani, Los Angeles Dodgers",
    );
    expect(lines.skipped).toEqual([]);
    expect(lines.rows).toEqual([
      { number: "NNO", players: ["Mike Trout"], teams: ["Los Angeles Angels"], noNumber: true },
      // Not a person: kept with no player, like a numbered header card.
      { number: "NNO", players: [], teams: [], noNumber: true },
      { number: "NNO", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"], noNumber: true },
    ]);
    const csv = parsePublishedChecklist("#,Player,Team\nNNO,Mike Trout,Los Angeles Angels\n7,Juan Soto,New York Mets");
    expect(csv.skipped).toEqual([]);
    expect(csv.rows).toEqual([
      { number: "NNO", players: ["Mike Trout"], teams: ["Los Angeles Angels"], noNumber: true },
      { number: "7", players: ["Juan Soto"], teams: ["New York Mets"] },
    ]);
  });

  it("an NNO line with nothing after the number is still skipped for that reason", () => {
    const out = parsePublishedChecklist("NNO");
    expect(out.rows).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual(["No player or team after the number"]);
  });
});

describe("parsePublishedChecklist — collector review S3: counts and subjects that are not people", () => {
  it("skips a count line with its own reason", () => {
    expect(LOOKS_LIKE_A_COUNT).toBe("Looks like a count, not a card");
    const out = parsePublishedChecklist(["200 cards", "1 card", "330 Cards.", "1 Mike Trout - Angels"].join("\n"));
    expect(out.rows.map((r) => r.number)).toEqual(["1"]);
    expect(out.skipped.map((s) => [s.line, s.reason])).toEqual([
      [1, LOOKS_LIKE_A_COUNT],
      [2, LOOKS_LIKE_A_COUNT],
      [3, LOOKS_LIKE_A_COUNT],
    ]);
  });

  it("keeps the number of a checklist, team card, TC or team leaders row but names no player", () => {
    const out = parsePublishedChecklist(
      [
        "1 Checklist 1-100",
        "2 Kansas City Royals Team",
        "3 Royals Team Card",
        "4 Mets TC",
        "5 Team Leaders",
        "6 AL Team Leaders",
        "7 Checklist",
      ].join("\n"),
    );
    expect(out.skipped).toEqual([]);
    expect(out.rows).toEqual(
      ["1", "2", "3", "4", "5", "6", "7"].map((number) => ({ number, players: [], teams: [] })),
    );
  });

  it("a not-a-person subject keeps the team after the dash, still with no player", () => {
    const out = parsePublishedChecklist("34 Royals Team Card - Kansas City Royals");
    expect(out.rows).toEqual([{ number: "34", players: [], teams: ["Kansas City Royals"] }]);
  });

  it("a not-a-person subject in a CSV player cell keeps the row with no player", () => {
    const out = parsePublishedChecklist("#,Player,Team\n34,Mets TC,\n35,Checklist 1-100,");
    expect(out.skipped).toEqual([]);
    expect(out.rows).toEqual([
      { number: "34", players: [], teams: [] },
      { number: "35", players: [], teams: [] },
    ]);
  });

  it("a person whose name merely contains 'team' or 'checklist' is kept", () => {
    const out = parsePublishedChecklist("9 Teams Teamerson - Boston Red Sox");
    expect(out.rows[0].players).toEqual(["Teams Teamerson"]);
  });
});

describe("parsePublishedChecklist — collector review S4: & and 'and'", () => {
  it("splits players on a spaced & and 'and', but not inside a name", () => {
    const out = parsePublishedChecklist(
      ["1 Mike Trout & Shohei Ohtani - Los Angeles Angels", "2 Brett Anderson and Andy Pettitte - New York Yankees"].join(
        "\n",
      ),
    );
    expect(out.rows.map((r) => r.players)).toEqual([
      ["Mike Trout", "Shohei Ohtani"],
      ["Brett Anderson", "Andy Pettitte"],
    ]);
  });

  it("does not split a team on '&' or 'and'", () => {
    const out = parsePublishedChecklist("#,Player,Team\n1,A & B,Texas A & M");
    expect(out.rows[0]).toEqual({ number: "1", players: ["A", "B"], teams: ["Texas A & M"] });
  });
});

describe("parsePublishedChecklist — collector review S6: subsets", () => {
  const file = [
    "Card Set,Card #,Player,Team",
    "Base,1,Mike Trout,Los Angeles Angels",
    "Rookie Autographs,RA-JH,Jackson Holliday,Baltimore Orioles",
    "Base,2,Shohei Ohtani,Los Angeles Dodgers",
    ",3,Aaron Judge,New York Yankees",
  ].join("\n");

  it("carries each row's subset and the distinct subsets in file order", () => {
    const out = parsePublishedChecklist(file);
    expect(out.format).toBe("csv");
    expect(out.subsets).toEqual(["Base", "Rookie Autographs"]);
    expect(out.rows).toEqual([
      { number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"], subset: "Base" },
      {
        number: "RA-JH",
        players: ["Jackson Holliday"],
        teams: ["Baltimore Orioles"],
        subset: "Rookie Autographs",
      },
      { number: "2", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"], subset: "Base" },
      { number: "3", players: ["Aaron Judge"], teams: ["New York Yankees"] },
    ]);
  });

  it("reads 'set', 'subset' and 'insert' headers as the subset column", () => {
    for (const header of ["Set", "Subset", "Insert"]) {
      const out = parsePublishedChecklist(`${header}\tNo.\tPlayer\nBase\t1\tMike Trout`);
      expect(out.subsets).toEqual(["Base"]);
      expect(out.rows[0].subset).toBe("Base");
    }
  });

  it("has no subsets without a subset column", () => {
    expect(parsePublishedChecklist("#,Player\n1,Mike Trout").subsets).toBeUndefined();
    expect(parsePublishedChecklist("1 Mike Trout - Angels").subsets).toBeUndefined();
  });

  it("filterRowsBySubsets keeps the chosen subsets and rows with no subset", () => {
    const { rows } = parsePublishedChecklist(file);
    expect(filterRowsBySubsets(rows, ["Base"]).map((r) => r.number)).toEqual(["1", "2", "3"]);
    expect(filterRowsBySubsets(rows, ["Rookie Autographs"]).map((r) => r.number)).toEqual([
      "RA-JH",
      "3",
    ]);
    expect(filterRowsBySubsets(rows, []).map((r) => r.number)).toEqual(["3"]);
    expect(rows).toHaveLength(4);
  });
});

describe("parsePublishedChecklist — collector review S7: header spellings and trademarks", () => {
  it("reads 'Description' and 'Card Description' as the player column", () => {
    for (const header of ["Description", "Card Description"]) {
      const out = parsePublishedChecklist(`Card #,${header},Team\n1,Mike Trout,Los Angeles Angels`);
      expect(out.rows).toEqual([
        { number: "1", players: ["Mike Trout"], teams: ["Los Angeles Angels"] },
      ]);
    }
  });

  it("strips ® and ™ from team names", () => {
    const out = parsePublishedChecklist(
      ["1 Mike Trout - Los Angeles Angels®", "2 Shohei Ohtani - Los Angeles Dodgers™"].join("\n"),
    );
    expect(out.rows.map((r) => r.teams)).toEqual([["Los Angeles Angels"], ["Los Angeles Dodgers"]]);
  });
});

describe("parsePublishedChecklist — NEO-489: a team cell reading No Team", () => {
  it.each(["No Team", "no team", "NO  TEAM", "  No Team  "])(
    "reads %j in a header CSV as noTeam with no team",
    (cell) => {
      const out = parsePublishedChecklist(`#,Player,Team\n1,Mike Trout,"${cell}"`);
      expect(out.skipped).toEqual([]);
      expect(out.rows).toEqual([{ number: "1", players: ["Mike Trout"], teams: [], noTeam: true }]);
    },
  );

  it("reads No Team in a positional TSV", () => {
    const out = parsePublishedChecklist("1\tMike Trout\tNo Team\n2\tJuan Soto\tNew York Mets");
    expect(out.format).toBe("tsv");
    expect(out.rows).toEqual([
      { number: "1", players: ["Mike Trout"], teams: [], noTeam: true },
      { number: "2", players: ["Juan Soto"], teams: ["New York Mets"] },
    ]);
  });

  it("reads No Team after a spaced dash in line mode", () => {
    const out = parsePublishedChecklist("88 2014 NFLPA Rookie Premiere - No Team");
    expect(out.format).toBe("lines");
    expect(out.rows).toEqual([
      { number: "88", players: ["2014 NFLPA Rookie Premiere"], teams: [], noTeam: true },
    ]);
  });

  it("reads No Team after a comma in line mode", () => {
    const out = parsePublishedChecklist("1 Lauren Shehadi, No Team");
    expect(out.rows).toEqual([
      { number: "1", players: ["Lauren Shehadi"], teams: [], noTeam: true },
    ]);
  });

  it.each(["None", "N/A", "No team listed", "-", "\u2014", "TBD", "Unknown", "?", "n/a.", ""])(
    "does not read %j as No Team: it makes no claim",
    (cell) => {
      const out = parsePublishedChecklist(`#,Player,Team\n1,Mike Trout,"${cell}"`);
      expect(out.rows.every((r) => r.noTeam === undefined)).toBe(true);
    },
  );

  it("skips a cell holding No Team and a real team, with the shared reason", () => {
    const out = parsePublishedChecklist("#,Player,Team\n1,Mike Trout,No Team / New York Mets");
    expect(out.rows).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe(NO_TEAM_AND_A_TEAM);
  });

  it("skips No Team in one team column and a team in another", () => {
    const out = parsePublishedChecklist(
      "#,Player,Team,Team\n1,Mike Trout,No Team,New York Mets\n2,Juan Soto,New York Mets,No Team",
    );
    expect(out.rows).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual([NO_TEAM_AND_A_TEAM, NO_TEAM_AND_A_TEAM]);
  });

  it("keeps a row with a number and No Team but no player", () => {
    const out = parsePublishedChecklist("#,Player,Team\n5,,No Team");
    expect(out.skipped).toEqual([]);
    expect(out.rows).toEqual([{ number: "5", players: [], teams: [], noTeam: true }]);
  });

  it("keeps a line-mode row with a number and No Team but no player", () => {
    const out = parsePublishedChecklist("NNO - No Team");
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ number: "NNO", teams: [], noTeam: true });
  });
});

describe("parsePublishedChecklist — NEO-489: the number column is trusted, as printed", () => {
  it.each([["a"], ["PPR-DLa"], ["TBD"], ["1a"], ["1A"]])(
    "keeps %j from a header CSV number column exactly as printed",
    (num) => {
      const out = parsePublishedChecklist(`#,Player,Team\n${num},Mike Trout,Angels`);
      expect(out.skipped).toEqual([]);
      expect(out.rows.map((r) => r.number)).toEqual([num]);
    },
  );

  it("keeps a letters-only number from a positional TSV", () => {
    const out = parsePublishedChecklist("TBD\tMike Trout\tAngels\nPPR-DLa\tDerrek Lee\tCubs");
    expect(out.rows.map((r) => r.number)).toEqual(["TBD", "PPR-DLa"]);
  });

  it("keeps both 1a and 1A as two rows (case is not folded by the parser)", () => {
    const out = parsePublishedChecklist("#,Player,Team\n1a,A Player,Angels\n1A,B Player,Cubs");
    expect(out.rows.map((r) => r.number)).toEqual(["1a", "1A"]);
  });

  it("calls a two-word number unreadable", () => {
    const out = parsePublishedChecklist("#,Player,Team\nBDC 12,Mike Trout,Angels");
    expect(out.rows).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe("Card number isn't one we can read");
  });

  it.each([
    "Jean-Carlos Smith - Mets",
    "PPR-DLa Derrek Lee - Chicago Cubs",
    "a Player - Team",
  ])("still skips the free-text line %j for its number", (line) => {
    const out = parsePublishedChecklist(line);
    expect(out.rows).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe("No card number at the start");
  });
});

describe("parsePublishedChecklist — NEO-489: a whole team cell that makes no claim", () => {
  /** Every whole-cell no-claim spelling, including the audit additions. */
  const NO_CLAIM_CELLS = [
    "none",
    "None",
    "NONE",
    "n/a",
    "N/A",
    "No team listed",
    "no  team  listed",
    "-",
    "\u2014",
    "\u2013",
    "TBD",
    "Unknown",
    "?",
    "NA",
    "n/a.",
    "None.",
  ];

  it.each(NO_CLAIM_CELLS)("reads %j as no team and no claim", (cell) => {
    const out = parsePublishedChecklist(`#,Player,Team\n1,Mike Trout,"${cell}"`);
    expect(out.skipped).toEqual([]);
    expect(out.rows).toEqual([{ number: "1", players: ["Mike Trout"], teams: [] }]);
    expect(out.rows[0].noTeam).toBeUndefined();
  });

  it.each(NO_CLAIM_CELLS)("reads %j in a positional TSV team column as no team and no claim", (cell) => {
    const out = parsePublishedChecklist(`1\tMike Trout\t${cell}\n2\tJuan Soto\tNew York Mets`);
    expect(out.skipped).toEqual([]);
    expect(out.rows[0]).toEqual({ number: "1", players: ["Mike Trout"], teams: [] });
    expect(out.rows[1].teams).toEqual(["New York Mets"]);
  });

  it.each(["TBD Reds", "Unknown Soldiers", "St. Louis Cardinals"])(
    "keeps %j as a team: only the whole placeholder word makes no claim",
    (cell) => {
      const out = parsePublishedChecklist(`#,Player,Team\n1,Mike Trout,"${cell}"`);
      expect(out.rows[0].teams).toEqual([cell]);
    },
  );

  it("splits N/A no more: it is never the teams N and A", () => {
    const out = parsePublishedChecklist("1\tMike Trout\tN/A\n2\tJuan Soto\tNew York Mets");
    expect(out.rows[0].teams).toEqual([]);
  });

  it("only a WHOLE cell makes no claim: a real team beside 'None' stays a team", () => {
    const out = parsePublishedChecklist("#,Player,Team\n1,Mike Trout,Angels / None");
    expect(out.rows[0].teams).toEqual(["Angels", "None"]);
  });
});

// ── NEO-496: headers below a title, headings, spreadsheets and PDFs ─────────

describe("parsePublishedChecklist — NEO-496: the header may sit under a title", () => {
  it("finds the header within the first 20 non-blank lines and skips the lines above it", () => {
    const out = parsePublishedChecklist(
      [
        "Spreadsheet made available by Checklist Insider.",
        "",
        "CARD SET,CARD #,ATHLETE,TEAM,SEQ",
        "Bomb Squad,1,Bryce Eldridge,San Francisco Giants,",
      ].join("\n"),
    );
    expect(out.format).toBe("csv");
    expect(out.skipped).toEqual([
      { line: 1, text: "Spreadsheet made available by Checklist Insider.", reason: ABOVE_THE_HEADER },
    ]);
    expect(out.rows).toEqual([
      { number: "1", players: ["Bryce Eldridge"], teams: ["San Francisco Giants"], subset: "Bomb Squad" },
    ]);
  });

  it("does not look past the 20th non-blank line for a header", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `${i + 1} Player ${i} - Team`);
    const out = parsePublishedChecklist([...lines, "#,Player,Team", "21,Late Guy,Team"].join("\n"));
    expect(out.format).toBe("lines");
    expect(out.rows).toHaveLength(20);
  });
});

describe("parsePublishedChecklist — NEO-496: section headings", () => {
  it("reads an ALL-CAPS line as the heading of the rows below it, and a heading with no rows as a group", () => {
    const out = parsePublishedChecklist(
      [
        "BASE",
        "BASE CARDS",
        "1 Shohei Ohtani - Los Angeles Dodgers",
        "INSERT",
        "FUTURE STARS",
        "FS-1 Munetaka Murakami - Chicago White Sox",
      ].join("\n"),
    );
    expect(out.skipped).toEqual([]);
    expect(out.subsets).toEqual(["BASE CARDS", "FUTURE STARS"]);
    expect(out.groups).toEqual({ "BASE CARDS": "BASE", "FUTURE STARS": "INSERT" });
    expect(out.rows.map((r) => [r.number, r.subset])).toEqual([
      ["1", "BASE CARDS"],
      ["FS-1", "FUTURE STARS"],
    ]);
  });

  it("continues a section when its heading repeats with nothing between, and tells a later repeat apart", () => {
    const out = parsePublishedChecklist(
      [
        "INSERT",
        "FUTURE STARS",
        "FS-1 A Guy - Team A",
        "FUTURE STARS",
        "FS-2 B Guy - Team B",
        "AUTOGRAPH",
        "ROOKIE AUTOGRAPHS",
        "RA-1 C Guy - Team C",
        "FUTURE STARS",
        "FSA-1 D Guy - Team D",
        "ROOKIE AUTOGRAPHS",
        "RA-2 E Guy - Team E",
        "FUTURE STARS",
        "FSA-2 F Guy - Team F",
      ].join("\n"),
    );
    expect(out.subsets).toEqual([
      "FUTURE STARS",
      "ROOKIE AUTOGRAPHS",
      "AUTOGRAPH FUTURE STARS",
      "AUTOGRAPH ROOKIE AUTOGRAPHS",
      "AUTOGRAPH FUTURE STARS (2)",
    ]);
    expect(out.rows.map((r) => r.subset)).toEqual([
      "FUTURE STARS",
      "FUTURE STARS",
      "ROOKIE AUTOGRAPHS",
      "AUTOGRAPH FUTURE STARS",
      "AUTOGRAPH ROOKIE AUTOGRAPHS",
      "AUTOGRAPH FUTURE STARS (2)",
    ]);
  });

  it("numbers a repeat with no group heading", () => {
    const out = parsePublishedChecklist(
      ["HELIX", "1 A - T", "SHADOW ETCH", "2 B - T", "HELIX", "3 C - T"].join("\n"),
    );
    expect(out.subsets).toEqual(["HELIX", "SHADOW ETCH", "HELIX (2)"]);
    expect(out.groups).toBeUndefined();
  });

  it("reads a single-cell ALL-CAPS line in a headered CSV as a heading", () => {
    const out = parsePublishedChecklist("#,Player,Team\nFUTURE STARS\nFS-1,A Guy,Team A");
    expect(out.rows).toEqual([{ number: "FS-1", players: ["A Guy"], teams: ["Team A"], subset: "FUTURE STARS" }]);
  });

  it("a subset cell still wins over a heading, and a blank one falls back to the heading", () => {
    const out = parsePublishedChecklist(
      "Card Set,#,Player\nBONUS\nBase,1,A Guy\n,2,B Guy",
    );
    expect(out.rows.map((r) => r.subset)).toEqual(["Base", "BONUS"]);
  });

  it("headingText takes only a lone ALL-CAPS name, never a number, code, marker or lower-case line", () => {
    expect(headingText(["CLASS OF 2026 COOPERSTOWN CALLS"])).toBe("CLASS OF 2026 COOPERSTOWN CALLS");
    expect(headingText(["", "TOPPS CHROME®", ""])).toBe("TOPPS CHROME");
    for (const not of ["NNO", "RA-MT", "RC", "200 CARDS", "Rookie", "60", "A", "Base Cards"]) {
      expect(headingText([not])).toBeNull();
    }
    expect(headingText(["BASE", "CARDS"])).toBeNull();
    expect(headingText(["X".repeat(PUBLISHED_CHECKLIST_MAX_NAME + 1)])).toBeNull();
  });

  it("set mode skips rows above the first heading with a reason", () => {
    const out = parsePublishedChecklist("1 A Guy - Team\nHELIX\n2 B Guy - Team", { mode: "set" });
    expect(out.rows.map((r) => r.number)).toEqual(["2"]);
    expect(out.skipped).toEqual([{ line: 1, text: "1 A Guy - Team", reason: NOT_IN_A_SECTION }]);
  });

  it("a line-mode title is never taken for a heading", () => {
    const out = parsePublishedChecklist("2026 TOPPS CHROME\n1 A Guy - Team", { setYear: 2026 });
    expect(out.skipped.map((s) => s.reason)).toEqual([LOOKS_LIKE_A_TITLE]);
    expect(out.subsets).toBeUndefined();
  });
});

describe("parsePublishedChecklist — NEO-496: the per-leaf cap comes after the ticks", () => {
  const twoSubsets = [
    "Card Set,#,Player",
    ...Array.from({ length: 2500 }, (_, i) => `Big,${i + 1},P${i}`),
    ...Array.from({ length: 3 }, (_, i) => `Small,${i + 1},Q${i}`),
  ].join("\n");

  it("keeps every row when the file has two or more subsets, so a small one is never cut off", () => {
    const out = parsePublishedChecklist(twoSubsets);
    expect(out.rows).toHaveLength(2503);
    expect(out.skipped).toEqual([]);
    const small = capLeafRows(filterRowsBySubsets(out.rows, ["Small"]));
    expect(small).toEqual({ rows: out.rows.slice(2500), dropped: 0 });
  });

  it("capLeafRows holds the ticked rows to 2,000 and says how many it left off", () => {
    const out = parsePublishedChecklist(twoSubsets);
    const big = capLeafRows(filterRowsBySubsets(out.rows, ["Big"]));
    expect(big.rows).toHaveLength(PUBLISHED_CHECKLIST_MAX_ROWS);
    expect(big.dropped).toBe(500);
  });

  it("set mode never applies the per-leaf cap", () => {
    const text = Array.from({ length: 2005 }, (_, i) => `${i + 1} P${i} - T`).join("\n");
    const out = parsePublishedChecklist(`HELIX\n${text}`, { mode: "set" });
    expect(out.rows).toHaveLength(2005);
  });

  it("holds even a many-subset paste to the set-level total", () => {
    expect(PUBLISHED_CHECKLIST_MAX_TOTAL_ROWS).toBe(50_000);
    expect(pastLimit(2_000)).toBe("Over 2,000 cards. Untick a section to make room.");
    expect(pastLimit(2_000, false)).toBe("Over 2,000 cards. Trim the file down to this list.");
    expect(pastFileLimit(50_000)).toBe("Over 50,000 cards. Upload just this set's checklist.");
  });
});

function pdfLine(line: number, cells: string[], xs: number[], page = 1): ChecklistCellRecord {
  return { line, page, cells, xs };
}

const N = 53;
const P = 132.6;
const T = 298;

describe("parsePublishedChecklistCells — a Topps-layout PDF", () => {
  const records: ChecklistCellRecord[] = [
    pdfLine(1, ["2026 Topps Chrome Baseball Checklist"], [53]),
    pdfLine(2, ["Checklists provided by Topps reflect the intended configurations"], [53]),
    pdfLine(3, ["BASE"], [53]),
    pdfLine(4, ["BASE CARDS"], [53]),
    pdfLine(5, ["1", "Shohei Ohtani", "Los Angeles Dodgers®"], [N, P, T]),
    pdfLine(6, ["3", "Yordan Alvarez", "Houston Astros®"], [N, P, T]),
    pdfLine(7, ["INSERT"], [53]),
    pdfLine(8, ["2025 MLB COMMISSIONERS TROPHY"], [53]),
    pdfLine(9, ["CT-1", "Los Angeles Dodgers®"], [N, T]),
    pdfLine(10, ["DIAMOND MOMENTS"], [53]),
    pdfLine(11, ["DM-33", "George Bush"], [N, P]),
    pdfLine(12, ["FANATICS AUTHENTICS REDEMPTION CARDS"], [53]),
    pdfLine(13, ["Chase Utley", "Philadelphia Phillies®"], [P, T]),
    pdfLine(14, ["Vladimir Guerrero", "Angels®"], [P, T]),
    pdfLine(15, ["Rookie"], [470], 2),
    pdfLine(16, ["1", "A", "B", "C"], [N, P, T, 400], 2),
  ];
  const out = parsePublishedChecklistCells({ format: "pdf", records }, { setYear: 2026 });

  it("reads number / player / team, drops ® and ™, and names each row's section", () => {
    expect(out.format).toBe("pdf");
    expect(out.rows.slice(0, 2)).toEqual([
      { number: "1", players: ["Shohei Ohtani"], teams: ["Los Angeles Dodgers"], subset: "BASE CARDS" },
      { number: "3", players: ["Yordan Alvarez"], teams: ["Houston Astros"], subset: "BASE CARDS" },
    ]);
    expect(out.subsets).toEqual([
      "BASE CARDS",
      "2025 MLB COMMISSIONERS TROPHY",
      "DIAMOND MOMENTS",
      "FANATICS AUTHENTICS REDEMPTION CARDS",
    ]);
    expect(out.groups?.["DIAMOND MOMENTS"]).toBe("INSERT");
  });

  it("reads a two-cell line by where its second cell sits: under team is a team card", () => {
    expect(out.rows.find((r) => r.number === "CT-1")).toEqual({
      number: "CT-1",
      players: [],
      teams: ["Los Angeles Dodgers"],
      subset: "2025 MLB COMMISSIONERS TROPHY",
    });
    expect(out.rows.find((r) => r.number === "DM-33")).toEqual({
      number: "DM-33",
      players: ["George Bush"],
      teams: [],
      subset: "DIAMOND MOMENTS",
    });
  });

  it("reads a two-cell line with no number as a card printed without one (NNO)", () => {
    const nno = out.rows.filter((r) => r.noNumber);
    expect(nno).toEqual([
      {
        number: "NNO",
        players: ["Chase Utley"],
        teams: ["Philadelphia Phillies"],
        noNumber: true,
        subset: "FANATICS AUTHENTICS REDEMPTION CARDS",
      },
      {
        number: "NNO",
        players: ["Vladimir Guerrero"],
        teams: ["Angels"],
        noNumber: true,
        subset: "FANATICS AUTHENTICS REDEMPTION CARDS",
      },
    ]);
  });

  it("skips every other line with a reason, with its page", () => {
    expect(out.skipped).toEqual([
      { line: 1, page: 1, text: "2026 Topps Chrome Baseball Checklist", reason: LOOKS_LIKE_A_TITLE },
      {
        line: 2,
        page: 1,
        text: "Checklists provided by Topps reflect the intended configurations",
        reason: ONE_CELL_ONLY,
      },
      { line: 15, page: 2, text: "Rookie", reason: ONE_CELL_ONLY },
      { line: 16, page: 2, text: "1 | A | B | C", reason: TOO_MANY_COLUMNS },
    ]);
  });

  it("never reads a lone line of words as a card, even one shaped like the line format", () => {
    const lone = parsePublishedChecklistCells({
      format: "pdf",
      records: [pdfLine(1, ["HELIX"], [53]), pdfLine(2, ["60 Rhett Lowder - Cincinnati Reds"], [53])],
    });
    expect(lone.rows).toEqual([]);
    expect(lone.skipped.map((s) => s.reason)).toEqual([ONE_CELL_ONLY]);
  });

  it("lines a PDF with a header row up by the header cells' x", () => {
    const headed = parsePublishedChecklistCells({
      format: "pdf",
      records: [
        pdfLine(1, ["Card #", "Player", "Team"], [N, P, T]),
        pdfLine(2, ["5", "Los Angeles Angels"], [N, T]),
        pdfLine(3, ["6", "Mike Trout", "Los Angeles Angels"], [N, P, T]),
      ],
    });
    expect(headed.rows).toEqual([
      { number: "5", players: [], teams: ["Los Angeles Angels"] },
      { number: "6", players: ["Mike Trout"], teams: ["Los Angeles Angels"] },
    ]);
  });

  it("says where a document too long to read was cut off", () => {
    const cut = parsePublishedChecklistCells({
      format: "pdf",
      records: [pdfLine(1, ["HELIX"], [53]), pdfLine(2, ["1", "A", "B"], [N, P, T])],
      truncatedAfterLine: 2,
    });
    expect(cut.skipped).toEqual([{ line: 3, text: "…", reason: NOT_READ_PAST_HERE }]);
  });
});

describe("parsePublishedChecklistCells — a Donruss-layout spreadsheet", () => {
  const sheet = (rows: string[][]): ChecklistCellRecord[] => rows.map((cells, i) => ({ line: i + 1, cells }));

  it("finds the header under the credit line and reads the subset column, SEQ ignored", () => {
    const out = parsePublishedChecklistCells({
      format: "xlsx",
      records: sheet([
        ["Spreadsheet made available by Checklist Insider."],
        ["CARD SET", "CARD #", "ATHLETE", "TEAM", "SEQ"],
        ["Base", "1", "Ken Griffey Jr.", "Seattle Mariners"],
        ["Bomb Squad Red Ice", "1", "Bryce Eldridge", "San Francisco Giants", "149"],
        ["Base", "2", "Johnny Bench", "No Team"],
      ]),
    });
    expect(out.format).toBe("xlsx");
    expect(out.skipped).toEqual([
      { line: 1, text: "Spreadsheet made available by Checklist Insider.", reason: ABOVE_THE_HEADER },
    ]);
    expect(out.subsets).toEqual(["Base", "Bomb Squad Red Ice"]);
    expect(out.rows).toEqual([
      { number: "1", players: ["Ken Griffey Jr."], teams: ["Seattle Mariners"], subset: "Base" },
      { number: "1", players: ["Bryce Eldridge"], teams: ["San Francisco Giants"], subset: "Bomb Squad Red Ice" },
      { number: "2", players: ["Johnny Bench"], teams: [], noTeam: true, subset: "Base" },
    ]);
  });

  it("reads a headerless sheet by column: A number, B player, C team; a lone cell is skipped", () => {
    const out = parsePublishedChecklistCells({
      format: "xlsx",
      records: sheet([["2026 Donruss"], ["1", "Ken Griffey Jr.", "Seattle Mariners"], ["Rookie"]]),
    }, { setYear: "2026" });
    expect(out.rows).toEqual([{ number: "1", players: ["Ken Griffey Jr."], teams: ["Seattle Mariners"] }]);
    expect(out.skipped.map((s) => s.reason)).toEqual([LOOKS_LIKE_A_TITLE, ONE_CELL_ONLY]);
  });

  it("caps a one-subset sheet at 2,000 rows in leaf mode, as a paste is", () => {
    const rows = [["#", "Player"], ...Array.from({ length: 2002 }, (_, i) => [`${i + 1}`, `P${i}`])];
    const out = parsePublishedChecklistCells({ format: "xlsx", records: sheet(rows) });
    expect(out.rows).toHaveLength(PUBLISHED_CHECKLIST_MAX_ROWS);
    expect(out.skipped.map((s) => s.line)).toEqual([2002, 2003]);
    // One subset: there is nothing to untick, so the file is the way forward.
    expect(out.skipped[0].reason).toBe(pastLimit(PUBLISHED_CHECKLIST_MAX_ROWS, false));
  });
});

describe("parsePublishedChecklistCells — a workbook of several tabs", () => {
  const tab = (sheet: string, rows: string[][]): ChecklistCellRecord[] =>
    rows.map((cells, i) => ({ line: i + 1, cells, sheet }));

  it("reads each tab on its own: its own header, and the tab's name as its section", () => {
    const out = parsePublishedChecklistCells(
      {
        format: "xlsx",
        records: [
          ...tab("Base", [["2026 Donruss"], ["#", "Player", "Team"], ["1", "Ken Griffey Jr.", "Seattle Mariners"]]),
          ...tab("Bomb Squad", [["Player", "Card", "Team"], ["Aaron Judge", "BS-1", "New York Yankees"]]),
        ],
      },
      { mode: "set" },
    );
    expect(out.rows).toEqual([
      { number: "1", players: ["Ken Griffey Jr."], teams: ["Seattle Mariners"], subset: "Base" },
      { number: "BS-1", players: ["Aaron Judge"], teams: ["New York Yankees"], subset: "Bomb Squad" },
    ]);
    expect(out.subsets).toEqual(["Base", "Bomb Squad"]);
    expect(out.groups).toBeUndefined();
    expect(out.skipped).toEqual([
      { line: 1, sheet: "Base", text: "2026 Donruss", reason: ABOVE_THE_HEADER },
    ]);
  });

  it("groups a tab's headings under the tab, and a set column's sections under the tab", () => {
    const out = parsePublishedChecklistCells(
      {
        format: "xlsx",
        records: [
          ...tab("Inserts", [
            ["#", "Player", "Team"],
            ["FUTURE STARS"],
            ["FS-1", "Jackson Holliday", "Baltimore Orioles"],
            ["HELIX"],
            ["HX-1", "Paul Skenes", "Pittsburgh Pirates"],
          ]),
          ...tab("Parallels", [
            ["Card Set", "#", "Player", "Team"],
            ["Base Red", "1", "Ken Griffey Jr.", "Seattle Mariners"],
          ]),
        ],
      },
      { mode: "set" },
    );
    expect(out.subsets).toEqual(["FUTURE STARS", "HELIX", "Base Red"]);
    expect(out.groups).toEqual({ "FUTURE STARS": "Inserts", HELIX: "Inserts", "Base Red": "Parallels" });
  });

  it("starts each tab afresh: a heading never carries into the next tab", () => {
    const out = parsePublishedChecklistCells(
      {
        format: "xlsx",
        records: [
          ...tab("One", [["#", "Player"], ["HELIX"], ["1", "A"]]),
          ...tab("Two", [["#", "Player"], ["2", "B"]]),
        ],
      },
      { mode: "set" },
    );
    expect(out.rows.map((r) => r.subset)).toEqual(["HELIX", "Two"]);
  });

  it("tells a tab named like an earlier section apart, as a repeated heading is", () => {
    const out = parsePublishedChecklistCells(
      {
        format: "xlsx",
        records: [
          ...tab("Base", [["Card Set", "#", "Player"], ["Base", "1", "A"]]),
          ...tab("base", [["#", "Player"], ["2", "B"]]),
        ],
      },
      { mode: "set" },
    );
    // Told apart here; the set's sections then fold the two into one
    // ("Base" and "base" share a key), as two such subset cells would.
    expect(out.subsets).toEqual(["Base", "base"]);
    const tabNamedAgain = parsePublishedChecklistCells(
      {
        format: "xlsx",
        records: [
          ...tab("One", [["#", "Player"], ["HELIX"], ["1", "A"]]),
          ...tab("HELIX", [["#", "Player"], ["2", "B"]]),
        ],
      },
      { mode: "set" },
    );
    expect(tabNamedAgain.subsets).toEqual(["HELIX", "HELIX (2)"]);
  });

  it("says which tab a skipped line and a cut-off are on", () => {
    const out = parsePublishedChecklistCells({
      format: "xlsx",
      records: [...tab("One", [["#", "Player"], ["1", "A"]]), ...tab("Two", [["#", "Player"], ["x y", "B"]])],
      truncatedAfterLine: 2,
      truncatedInSheet: "Two",
    });
    expect(out.skipped).toEqual([
      { line: 2, sheet: "Two", text: "x y | B", reason: "Card number isn't one we can read" },
      { line: 3, sheet: "Two", text: "…", reason: NOT_READ_PAST_HERE },
    ]);
  });

  it("keeps the leaf cap's skipped list in tab order, then line order", () => {
    const rows = (from: number, n: number) =>
      [["#", "Player"], ...Array.from({ length: n }, (_, i) => [`${from + i}`, `P${from + i}`])];
    // Two tabs under one subset column value: one subset, so the leaf cap applies.
    const out = parsePublishedChecklistCells({
      format: "xlsx",
      records: [
        ...tab("A", [["Card Set", "#", "Player"], ...rows(1, 1500).slice(1).map((r) => ["Base", ...r])]),
        ...tab("B", [["Card Set", "#", "Player"], ...rows(1501, 600).slice(1).map((r) => ["Base", ...r])]),
      ],
    });
    expect(out.rows).toHaveLength(PUBLISHED_CHECKLIST_MAX_ROWS);
    expect(out.skipped).toHaveLength(100);
    expect(out.skipped[0]).toMatchObject({ sheet: "B", line: 502 });
    expect(out.skipped.every((s) => s.sheet === "B")).toBe(true);
    expect(out.skipped.map((s) => s.line)).toEqual(Array.from({ length: 100 }, (_, i) => 502 + i));
  });
});
