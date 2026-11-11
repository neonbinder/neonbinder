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

  it.each(["None", "N/A", "No team listed", "-", ""])(
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
  it.each(["none", "None", "NONE", "n/a", "N/A", "No team listed", "no  team  listed", "-"])(
    "reads %j as no team and no claim",
    (cell) => {
      const out = parsePublishedChecklist(`#,Player,Team\n1,Mike Trout,"${cell}"`);
      expect(out.skipped).toEqual([]);
      expect(out.rows).toEqual([{ number: "1", players: ["Mike Trout"], teams: [] }]);
      expect(out.rows[0].noTeam).toBeUndefined();
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
