import { describe, expect, test } from "vitest";
import {
  assessListingTitle,
  generateListingTitle,
  generateListingDescription,
  isFillerToken,
  rookieAsRc,
  SHORT_NAME_RULE,
  type ListingCardInputs,
} from "./generateListing";
import { LISTING_TITLE_MAX } from "./listingLimits";

describe("generateListingTitle", () => {
  test("full base card gets core tokens + RC", () => {
    const title = generateListingTitle({
      cardNumber: "50",
      playerNames: ["Elly De La Cruz"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      parallelName: "Base",
      isRookie: true,
    });
    // NEO-101 (Jason, 2026-09-02): titles now PACK. `Rookie` is appended as a
    // second spelling behind `RC` — a third of sold rookie listings carry both
    // words, and an unused character is a search term thrown away.
    expect(title).toBe("2024 Topps Chrome Elly De La Cruz #50 RC Rookie");
    expect(title.length).toBeLessThanOrEqual(80);
  });

  test("parallel name included when not Base", () => {
    const title = generateListingTitle({
      cardNumber: "50",
      playerNames: ["Elly De La Cruz"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      parallelName: "Gold Refractor",
      printRun: 50,
    });
    expect(title).toBe(
      "2024 Topps Chrome Elly De La Cruz #50 Gold Refractor /50",
    );
  });

  test("autographed, relic, and short print all append", () => {
    const title = generateListingTitle({
      cardNumber: "1",
      playerNames: ["Mike Trout"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Update",
      autographed: "On Card",
      isRelic: true,
      shortPrint: "SSP",
    });
    expect(title).toContain("AUTO");
    expect(title).toContain("RELIC");
    expect(title).toContain("SSP");
  });

  test("multiple players joined with &", () => {
    const title = generateListingTitle({
      cardNumber: "1",
      playerNames: ["Mike Trout", "Shohei Ohtani"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
    });
    expect(title).toBe("2024 Topps Chrome Mike Trout & Shohei Ohtani #1");
  });

  test("no players still produces a valid title", () => {
    const title = generateListingTitle({
      cardNumber: "1",
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
    });
    expect(title).toBe("2024 Topps Chrome #1");
  });

  test("optional tokens dropped once the 80-char budget is exhausted; the parallel and print run stay", () => {
    const title = generateListingTitle({
      cardNumber: "1",
      playerNames: ["A Very Long Player Name Indeed Jones Jr"],
      year: "2024",
      manufacturer: "Topps Chrome Update Series Baseball",
      setName: "Extremely Long Insert Set Name Here",
      parallelName: "Gold Refractor",
      isRookie: true,
      autographed: "On Card",
      isRelic: true,
      shortPrint: "SSP",
      printRun: 25,
    });
    expect(title.length).toBeLessThanOrEqual(80);
    // Jason, 2026-10-19: the parallel's name and the print run are never
    // dropped; the attributes (AUTO, RELIC, RC, SSP) and the set words that
    // do not fit go instead. The number still fits here.
    expect(title).toBe(
      "2024 Topps Chrome A Very Long Player Name Indeed Jones Jr #1 Gold Refractor /25",
    );
    // NEO-339: the set words were cut, not the player.
    expect(title).not.toContain("Extremely");
  });

  test("setName matching manufacturer is not duplicated (e.g. Topps flagship base product)", () => {
    const title = generateListingTitle({
      cardNumber: "2",
      playerNames: ["Daulton Varsho"],
      year: "2026",
      manufacturer: "Topps",
      setName: "Topps",
    });
    expect(title).toBe("2026 Topps Daulton Varsho #2");
    expect(title).not.toContain("Topps Topps");
  });

  test("setName carrying manufacturer as a prefix word is not duplicated (e.g. Topps Heritage)", () => {
    const title = generateListingTitle({
      cardNumber: "390",
      playerNames: ["Colson Montgomery"],
      year: "2026",
      manufacturer: "Topps",
      setName: "Topps Heritage",
    });
    expect(title).toBe("2026 Topps Heritage Colson Montgomery #390");
    expect(title).not.toContain("Topps Topps");
  });

  test("setName sharing a prefix that is NOT a whole word is left alone", () => {
    const title = generateListingTitle({
      cardNumber: "1",
      year: "2024",
      manufacturer: "Topps",
      setName: "Toppsmania",
    });
    expect(title).toBe("2024 Topps Toppsmania #1");
  });

  test("a player name that alone nearly fills the cap is kept whole; the number, year and set words give way", () => {
    const title = generateListingTitle({
      cardNumber: "99999",
      playerNames: [
        "An Absurdly Long Player Full Name That Alone Exceeds The Entire Title Budget",
      ],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
    });
    expect(title.length).toBeLessThanOrEqual(80);
    // NEO-101: the "…" this used to assert is gone — an ellipsis in a live
    // eBay title reads to a buyer as a broken listing. The cut is at a whole
    // word instead.
    expect(title).not.toContain("…");
    // Jason, 2026-10-19: the player is never dropped and the card number may
    // be. The name is 76 characters, so nothing else fits beside it: before
    // this the number was kept and the name cut ("... The Entire #99999").
    expect(title).toBe(
      "An Absurdly Long Player Full Name That Alone Exceeds The Entire Title Budget",
    );
    const a = assessListingTitle({
      cardNumber: "99999",
      playerNames: [
        "An Absurdly Long Player Full Name That Alone Exceeds The Entire Title Budget",
      ],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
    });
    expect(a.coreFits).toBe(false);
    expect(a.dropped).toEqual(["#99999"]);
  });
});

// ===========================================================================
// NEO-101 — the cap, the new token priority, and the assessment
// ===========================================================================

describe("assessListingTitle (NEO-101)", () => {
  const BASE = {
    cardNumber: "50",
    playerNames: ["Elly De La Cruz"],
    year: "2024",
    manufacturer: "Topps",
    setName: "Chrome",
  };

  test("reports the title, that the core fit, and nothing dropped, for a card that fits easily", () => {
    expect(assessListingTitle({ ...BASE, isRookie: true })).toEqual({
      title: "2024 Topps Chrome Elly De La Cruz #50 RC Rookie",
      coreFits: true,
      dropped: [],
    });
  });

  test("generateListingTitle is exactly assessListingTitle's title", () => {
    const inputs = { ...BASE, isRookie: true, autographed: "On Card" };
    expect(generateListingTitle(inputs)).toBe(assessListingTitle(inputs).title);
  });

  test("cardVariation goes into the title VERBATIM, not parsed", () => {
    // The `;`-separated shape some rows carry is an artefact of how the string
    // was authored, not a schema. Splitting on it would be re-introducing the
    // marketplace vocabulary NEO-189 removed.
    const { title } = assessListingTitle({
      ...BASE,
      cardVariation: "Image Variation; Wearing sunglasses",
    });
    expect(title).toBe(
      "2024 Topps Chrome Elly De La Cruz #50 Image Variation; Wearing sunglasses",
    );
  });

  test("optional tokens come out in the agreed priority order", () => {
    // Jason, 2026-09-02: AUTO -> RELIC -> parallel -> /printRun ->
    // cardVariation -> RC -> SP/SSP -> teams -> "Rookie" -> sport. This is NOT
    // the old order (which led with parallel and trailed with /printRun), so
    // this test is the record of the decision as much as it is a check.
    const { title, dropped } = assessListingTitle({
      cardNumber: "1",
      playerNames: ["A Player"],
      year: "2024",
      autographed: "On Card",
      isRelic: true,
      parallelName: "Gold",
      printRun: 25,
      cardVariation: "Action",
      isRookie: true,
      shortPrint: "SSP",
      teamNames: ["Reds"],
      sport: "Baseball",
    });
    expect(title).toBe(
      "2024 A Player #1 AUTO RELIC Gold /25 Action RC SSP Reds Rookie Baseball",
    );
    expect(dropped).toEqual([]);
    expect(title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
  });

  test("a parallelName that IS the cardVariation is not printed twice", () => {
    // Not a contrived case: `deriveCardObservedFeatures` copies a card's
    // `cardVariation` into `features.parallelName` (NEO-189), so both insert
    // call sites hand the generator the same string in two fields. Before the
    // de-dup this titled as "... #300b Image Variation Image Variation".
    const { title, dropped } = assessListingTitle({
      cardNumber: "300b",
      playerNames: ["Julio Rodriguez"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      parallelName: "Image Variation",
      cardVariation: "Image Variation",
    });
    expect(title).toBe("2024 Topps Chrome Julio Rodriguez #300b Image Variation");
    // A duplicate is not "dropped" — it is right there in the title.
    expect(dropped).toEqual([]);
  });

  test("de-duplication ignores case and surrounding whitespace", () => {
    const { title } = assessListingTitle({
      cardNumber: "1",
      parallelName: "  Gold Refractor ",
      cardVariation: "gold refractor",
    });
    expect(title).toBe("#1 Gold Refractor");
  });

  test('parallelName "Base" is not a token, in any casing', () => {
    for (const parallelName of ["Base", "base", "  BASE  "]) {
      expect(assessListingTitle({ ...BASE, parallelName }).title).toBe(
        "2024 Topps Chrome Elly De La Cruz #50",
      );
    }
  });

  test("a token that does not fit is SKIPPED, and later, shorter tokens still land", () => {
    // The old loop `break`ed on the first miss, so one long variation name
    // silently swallowed the three-character RC sitting behind it even though
    // RC fit perfectly well. Priority decides who wins a contested character,
    // not who is allowed to be considered at all.
    const longVariation = "A Preposterously Long Photo Variation Description";
    const { title, coreFits, dropped } = assessListingTitle({
      ...BASE,
      cardVariation: longVariation,
      isRookie: true,
      shortPrint: "SP",
    });
    expect(coreFits).toBe(true);
    expect(dropped).toEqual([longVariation]);
    expect(title).toBe("2024 Topps Chrome Elly De La Cruz #50 RC SP Rookie");
    expect(title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
  });

  test("the core is cut at a whole word, never mid-word, and never with an ellipsis", () => {
    const { title, coreFits } = assessListingTitle({
      cardNumber: "7",
      playerNames: ["Wenceslaus Bartholomew Fitzwilliam-Harrington III"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome Sapphire Edition Refractor Selections",
    });
    expect(coreFits).toBe(false);
    expect(title).not.toContain("…");
    expect(title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    expect(title.endsWith(" #7")).toBe(true);
    // Every surviving word of the prefix is a WHOLE word from the source.
    const source =
      "2024 Topps Chrome Sapphire Edition Refractor Selections Wenceslaus Bartholomew Fitzwilliam-Harrington III";
    const sourceWords = new Set(source.split(" "));
    for (const word of title.slice(0, -" #7".length).split(" ")) {
      expect(sourceWords.has(word)).toBe(true);
    }
  });

  test("a single unbroken token longer than the budget falls back to a hard slice", () => {
    // No whitespace to cut at. Returning nothing at all would be worse than a
    // mid-"word" cut of a string that is not really a word.
    // The player is the last thing given up, so the name takes the whole cap
    // and the card number goes (Jason, 2026-10-19).
    const { title, coreFits, dropped } = assessListingTitle({
      cardNumber: "1",
      playerNames: ["X".repeat(120)],
    });
    expect(coreFits).toBe(false);
    expect(title).toBe("X".repeat(LISTING_TITLE_MAX));
    expect(dropped).toEqual(["#1"]);
  });

  test("the hard-slice fallback never leaves an orphaned surrogate half", () => {
    // Astral characters (emoji, and plenty of real scripts) are TWO UTF-16
    // code units, and the fallback slice measures in code units — so the cut
    // can land between the halves. A lone high surrogate is not a character:
    // it renders as a replacement glyph and is not encodable as valid UTF-8
    // once a marketplace adapter serialises the title.
    const unbroken = "\u{1F600}".repeat(60); // 120 code units, zero spaces
    // The print run is kept first ("/5" and its space: 3 units), which leaves
    // the name an ODD 77 units, so a plain slice would end on a high
    // surrogate. The number goes: the player outranks it (Jason, 2026-10-19).
    const { title, coreFits } = assessListingTitle({
      cardNumber: "1",
      playerNames: [unbroken],
      printRun: 5,
    });

    expect(coreFits).toBe(false);
    expect(title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    expect(title).toBe(`${"\u{1F600}".repeat(38)} /5`);
    // No code unit in the surrogate range survives on its own: spreading a
    // string iterates by CODEPOINT, so a well-formed pair yields one 2-unit
    // character and an orphan yields a 1-unit one still inside D800-DFFF.
    for (const ch of title) {
      const cp = ch.codePointAt(0)!;
      expect(cp < 0xd800 || cp > 0xdfff).toBe(true);
    }
    // The whole title survives a UTF-8 round trip unchanged. An orphan would
    // be replaced by U+FFFD here.
    const roundTripped = new TextDecoder().decode(new TextEncoder().encode(title));
    expect(roundTripped).toBe(title);
  });

  test("a word-boundary cut never leaves a dangling ' & ' connector on a multi-player core", () => {
    // playerNames join with " & " (see the header note). A cut that keeps the
    // space-then-"&" but loses the player it was joining to produces
    // "Aaron Judge &" — a title reading "... Aaron Judge & #17" that promises
    // a second player and does not deliver one. `&` is a whole word between
    // two spaces, so the plain word-boundary rule alone treats it as a safe
    // place to stop; this pins that it keeps looking instead.
    //
    // The players are cut only when they alone do not fit (Jason,
    // 2026-10-19: the number goes first), so the second "name" is one
    // unbroken word longer than the cap: the last space in the window is the
    // one after "&", exactly where the naive cut used to stop.
    const cardNumber = "17";
    const { title, coreFits } = assessListingTitle({
      cardNumber,
      playerNames: ["Aaron Judge", "X".repeat(100)],
    });

    expect(coreFits).toBe(false);
    expect(title).not.toMatch(/&(\s|$)/);
    expect(title).toBe(`Aaron Judge #${cardNumber}`);
    expect(title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
  });

  test("the dangling-connector guard degrades a core that is nothing but connectors to empty, not a crash or an infinite loop", () => {
    // Degenerate input a real card can never produce (player names are free
    // text an operator or a marketplace sync supplied), included because
    // `dropDanglingConnector` LOOPS and must terminate on a core built
    // entirely from the "&" it strips, rather than spin.
    // Thirty of them join to 117 characters, so the players must be cut, and
    // the cut strips connector after connector down to nothing; the number
    // then has the room.
    const cardNumber = "9".repeat(70);
    const { title, coreFits } = assessListingTitle({
      cardNumber,
      playerNames: Array.from({ length: 30 }, () => "&"),
    });
    expect(coreFits).toBe(false);
    expect(title).toBe(`#${cardNumber}`);
  });

  test("team names are appended verbatim, in stored order, and never abbreviated", () => {
    // ~50% of sold listings name the team (Jason's two-sample research,
    // 2026-09-02). Verbatim matters: a buyer types the name as it is printed,
    // so "Seattle Mariners" must not become "SEA" or "Mariners".
    const { title, dropped } = assessListingTitle({
      cardNumber: "12",
      playerNames: ["Julio Rodriguez"],
      year: "2024",
      manufacturer: "Topps",
      teamNames: ["Seattle Mariners"],
      sport: "Baseball",
    });
    expect(title).toBe("2024 Topps Julio Rodriguez #12 Seattle Mariners Baseball");
    expect(dropped).toEqual([]);
  });

  test("a multi-team card names every team it fits, in stored order", () => {
    const { title } = assessListingTitle({
      cardNumber: "1",
      year: "2024",
      teamNames: ["Tigres del Licey", "Aguilas Cibaenas"],
    });
    expect(title).toBe("2024 #1 Tigres del Licey Aguilas Cibaenas");
  });

  test('"Rookie" rides behind RC, and only when the card is a rookie', () => {
    const rookie = assessListingTitle({
      cardNumber: "1",
      year: "2024",
      isRookie: true,
    });
    expect(rookie.title).toBe("2024 #1 RC Rookie");
    // Order matters: RC is the token that must survive if only one fits.
    expect(rookie.title.indexOf("RC")).toBeLessThan(rookie.title.indexOf("Rookie"));

    const notRookie = assessListingTitle({ cardNumber: "1", year: "2024" });
    expect(notRookie.title).toBe("2024 #1");
    expect(notRookie.title).not.toContain("Rookie");
  });

  test('a team name that already contains the sport swallows the sport token', () => {
    // "Oregon Ducks baseball" ⊃ "Baseball". Word-level, case-insensitive — and
    // NOT reported as dropped, because the word is right there in the title.
    const { title, dropped } = assessListingTitle({
      cardNumber: "5",
      year: "2024",
      teamNames: ["Oregon Ducks baseball"],
      sport: "Baseball",
    });
    expect(title).toBe("2024 #5 Oregon Ducks baseball");
    expect(dropped).toEqual([]);
  });

  test("a token repeating a word already in the CORE is skipped", () => {
    // The core carries "Topps" via the set name; a parallel that repeats it
    // spends five characters saying nothing new.
    const { title } = assessListingTitle({
      cardNumber: "1",
      year: "2024",
      manufacturer: "Topps",
      setName: "Topps Chrome",
      parallelName: "Topps Chrome",
    });
    expect(title).toBe("2024 Topps Chrome #1");
  });

  test("RC and Rookie are NOT collapsed into each other", () => {
    // Different words, and carrying both is what real sold listings do — the
    // de-dup is word-level, not concept-level, precisely so this survives.
    const { title } = assessListingTitle({ cardNumber: "1", isRookie: true });
    expect(title).toBe("#1 RC Rookie");
  });

  test("the same team listed twice is named once", () => {
    const { title } = assessListingTitle({
      cardNumber: "1",
      year: "2024",
      teamNames: ["Seattle Mariners", "Seattle Mariners"],
    });
    expect(title).toBe("2024 #1 Seattle Mariners");
  });

  test("a typical base card now PACKS toward the cap instead of stopping at ~34", () => {
    // The defect this whole change answers: NB's real titles averaged 34
    // characters against a sold-listing mean of 70, which is half the
    // searchable surface of the listing left blank. A perfectly ordinary base
    // card — year, set, one player, number, parallel, one team, sport — must
    // now land in the band real sellers use.
    const { title, coreFits, dropped } = assessListingTitle({
      cardNumber: "150",
      playerNames: ["Bobby Witt Jr"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      parallelName: "Refractor",
      teamNames: ["Kansas City Royals"],
      sport: "Baseball",
    });
    expect(coreFits).toBe(true);
    expect(dropped).toEqual([]);
    expect(title).toBe(
      "2024 Topps Chrome Bobby Witt Jr #150 Refractor Kansas City Royals Baseball",
    );
    expect(title.length).toBeGreaterThanOrEqual(60);
    expect(title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
  });

  test("no optional tokens present means nothing dropped and nothing invented", () => {
    expect(assessListingTitle({ cardNumber: "9" })).toEqual({
      title: "#9",
      coreFits: true,
      dropped: [],
    });
  });
});

describe("generateListingTitle invariants — fuzz (NEO-101)", () => {
  // A deterministic PRNG, so a failure is reproducible from the seed printed
  // in the assertion message rather than being a Heisenbug in CI.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const WORDS = [
    "Chrome",
    "Sapphire",
    "Update",
    "Heritage",
    "Refractor",
    "Superfractor",
    "Rodriguez",
    "Fitzwilliam-Harrington",
    "Elly",
    "De",
    "La",
    "Cruz",
    "Extraordinarily",
    "Photographic",
    "Variation",
  ];

  test("for any inputs: <= 80 chars, the never-dropped pieces stay, and a lost number is reported", () => {
    const rand = mulberry32(20260902);
    const pick = <T,>(list: T[]): T => list[Math.floor(rand() * list.length)];
    const words = (n: number) =>
      Array.from({ length: n }, () => pick(WORDS)).join(" ");

    for (let i = 0; i < 2000; i++) {
      // Card numbers stay within real-world shape (BSC/SportLots numbers are a
      // handful of characters; sku.ts already caps its own copy at 10).
      const cardNumber = `${Math.floor(rand() * 100000)}${
        rand() < 0.25 ? pick(["a", "b", "c", "SP"]) : ""
      }`;
      const inputs = {
        cardNumber,
        // Long multi-player lists — a League Leaders / rookie-combo card.
        playerNames:
          rand() < 0.15
            ? undefined
            : Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
                words(1 + Math.floor(rand() * 4)),
              ),
        year: rand() < 0.1 ? undefined : String(1950 + Math.floor(rand() * 80)),
        manufacturer: rand() < 0.1 ? undefined : words(1 + Math.floor(rand() * 5)),
        // Long set / insert names.
        setName: rand() < 0.1 ? undefined : words(1 + Math.floor(rand() * 8)),
        parallelName: rand() < 0.4 ? "Base" : words(1 + Math.floor(rand() * 5)),
        isRookie: rand() < 0.5,
        isRelic: rand() < 0.3,
        autographed: rand() < 0.3 ? "On Card" : "None",
        shortPrint: pick(["None", "SP", "SSP"]),
        // Huge print runs, including ones that are themselves long strings.
        printRun:
          rand() < 0.5 ? undefined : Math.floor(rand() * 10 ** (1 + Math.floor(rand() * 12))),
        // Long variation strings.
        cardVariation: rand() < 0.5 ? undefined : words(1 + Math.floor(rand() * 10)),
        // NEO-101 fill tokens: several long team names, and a sport that
        // sometimes duplicates a word already inside one of them.
        teamNames:
          rand() < 0.3
            ? undefined
            : Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
                words(1 + Math.floor(rand() * 4)),
              ),
        sport: rand() < 0.3 ? undefined : pick(WORDS),
        // NEO-335: long insert names in the core, and a short name standing
        // in for the set and insert words (every rule must keep the guarantees).
        insertName: rand() < 0.5 ? undefined : words(1 + Math.floor(rand() * 6)),
        setShortName: rand() < 0.5 ? undefined : words(1 + Math.floor(rand() * 4)).slice(0, 60),
        // NEO-335: the "Parallel" label rides on the parallel role.
        parallelIsRole: rand() < 0.5,
      };

      const assessment = assessListingTitle(inputs, {
        shortNameRule: pick(["A", "B", "C"] as const),
      });
      const { title, coreFits, dropped } = assessment;
      const context = JSON.stringify(inputs);
      const titleWords = new Set(title.toLowerCase().split(/\s+/));
      const allSaid = (text: string | undefined) =>
        (text ?? "").toLowerCase().split(/\s+/).filter(Boolean).every((w) => titleWords.has(w));

      expect(title.length, context).toBeLessThanOrEqual(LISTING_TITLE_MAX);
      expect(title, context).not.toContain("…");
      // A word-boundary cut on a multi-player core must never strand the
      // " & " join connector with nothing after it (the dangling-ampersand
      // regression pinned above) — checked here across the whole fuzzed
      // space, not just the one hand-built boundary case. A legitimate
      // multi-player title always has a real word between "&" and the card
      // number (`... & Ohtani #1`), so "&" landing directly against the
      // reserved " #<number>" marker is unambiguously the dangling case, not
      // a false positive on an ordinary join.
      expect(title, context).not.toContain(`& #${cardNumber}`);
      // Jason, 2026-10-19: the card number may go, but never silently: a
      // title without it reports the cut and lists the number as dropped.
      const marker = `#${cardNumber}`;
      const hasNumber = title.endsWith(marker) || title.includes(`${marker} `);
      if (!hasNumber) {
        expect(coreFits, context).toBe(false);
        expect(dropped, context).toContain(marker);
      }
      // The print run is vital: always in the title.
      if (inputs.printRun) expect(titleWords.has(`/${inputs.printRun}`), context).toBe(true);
      // The players are kept whole whenever they fit beside the print run.
      const players = (inputs.playerNames ?? []).join(" & ");
      const printRunCost = inputs.printRun ? `/${inputs.printRun}`.length + 1 : 0;
      if (players && players.length + printRunCost <= LISTING_TITLE_MAX) {
        expect(title, context).toContain(players);
      }
      // A core that fits says every word of its identity: the number, the
      // year, the insert's name (or the short name in its place) and the
      // parallel's name, redundant words included (a set word says them).
      if (coreFits) {
        expect(hasNumber, context).toBe(true);
        expect(allSaid(inputs.year), context).toBe(true);
        const insert = assessment.rookieAsRcUsed && inputs.insertName
          ? rookieAsRc(inputs.insertName)
          : inputs.insertName;
        expect(allSaid(assessment.shortNameUsed ? inputs.setShortName : insert), context).toBe(true);
        if (inputs.parallelName !== "Base") expect(allSaid(inputs.parallelName), context).toBe(true);
      }
      // A dropped token really would not have fitted. Tokens are only ever
      // appended after a drop, so the final title is at least as long as the
      // one the token was measured against — if it does not fit now, it did
      // not fit then either.
      //
      // Except a redundant AUTO or RELIC (one the title says anyway) on a
      // title that lost something real: that is withheld even from room left
      // over, the redundant words being strictly the first to go.
      const lostReal = !coreFits || dropped.some((t) => !isFillerToken(t, inputs, title));
      for (const token of dropped) {
        if (lostReal && (token === "AUTO" || token === "RELIC") && isFillerToken(token, inputs, title)) {
          continue;
        }
        expect(
          title.length + 1 + token.length,
          `${context} :: dropped ${token}`,
        ).toBeGreaterThan(LISTING_TITLE_MAX);
      }
      expect(typeof coreFits, context).toBe("boolean");
    }
  });
});

describe("generateListingDescription", () => {
  test("full facts compose a multi-sentence description", () => {
    const desc = generateListingDescription({
      cardNumber: "50",
      playerNames: ["Elly De La Cruz"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      parallelName: "Gold Refractor",
      isRookie: true,
      autographed: "On Card",
      isRelic: true,
      shortPrint: "SSP",
      printRun: 50,
    });
    expect(desc).toContain("2024 Topps Chrome Gold Refractor card of Elly De La Cruz, #50.");
    expect(desc).toContain("This is a Rookie Card.");
    expect(desc).toContain("Autographed (On Card).");
    expect(desc).toContain("Includes a memorabilia relic piece.");
    expect(desc).toContain("Super Short Print (SSP).");
    expect(desc).toContain("Serial numbered to 50.");
  });

  test("each fact renders on its own line rather than one run-on paragraph", () => {
    const desc = generateListingDescription({
      cardNumber: "50",
      playerNames: ["Elly De La Cruz"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      isRookie: true,
      autographed: "On Card",
    });
    expect(desc.split("\n")).toEqual([
      "2024 Topps Chrome card of Elly De La Cruz, #50.",
      "This is a Rookie Card.",
      "Autographed (On Card).",
    ]);
  });

  test("base card with no special attributes gets a minimal description", () => {
    const desc = generateListingDescription({
      cardNumber: "1",
      playerNames: ["Mike Trout"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      parallelName: "Base",
    });
    expect(desc).toBe("2024 Topps Chrome card of Mike Trout, #1.");
  });

  test("no ancestor data at all still produces a sane sentence", () => {
    expect(generateListingDescription({ cardNumber: "1" })).toBe(
      "Card #1.",
    );
    expect(
      generateListingDescription({
        cardNumber: "1",
        playerNames: ["Mike Trout"],
      }),
    ).toBe("Card #1 of Mike Trout.");
  });

  test("setName matching manufacturer is not duplicated (e.g. Topps flagship base product)", () => {
    const desc = generateListingDescription({
      cardNumber: "2",
      playerNames: ["Daulton Varsho"],
      year: "2026",
      manufacturer: "Topps",
      setName: "Topps",
    });
    expect(desc).toBe("2026 Topps card of Daulton Varsho, #2.");
    expect(desc).not.toContain("Topps Topps");
  });

  test("setName carrying manufacturer as a prefix word is not duplicated (e.g. Topps Heritage)", () => {
    const desc = generateListingDescription({
      cardNumber: "390",
      playerNames: ["Colson Montgomery"],
      year: "2026",
      manufacturer: "Topps",
      setName: "Topps Heritage",
    });
    expect(desc).toBe("2026 Topps Heritage card of Colson Montgomery, #390.");
    expect(desc).not.toContain("Topps Topps");
  });

  test("NEO-101: cardVariation gets its own line, verbatim and uncapped", () => {
    const desc = generateListingDescription({
      cardNumber: "300b",
      playerNames: ["Julio Rodriguez"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      cardVariation: "Image Variation; Wearing sunglasses",
      shortPrint: "SP",
    });
    expect(desc.split("\n")).toEqual([
      "2024 Topps Chrome card of Julio Rodriguez, #300b.",
      "Variation: Image Variation; Wearing sunglasses.",
      "Short Print (SP).",
    ]);
  });

  test("NEO-101: a variation that already ends in a full stop does not get a second one", () => {
    const desc = generateListingDescription({
      cardNumber: "1",
      cardVariation: "Bat on shoulder.",
    });
    expect(desc).toContain("Variation: Bat on shoulder.");
    expect(desc).not.toContain("shoulder..");
  });

  test("NEO-101: a variation far too long for the title still states itself in full here", () => {
    // The description has no cap (eBay takes ~500k of HTML), so unlike the
    // title nothing is dropped — this is where the dropped token goes.
    const variation = "A ".repeat(60) + "Variation";
    const desc = generateListingDescription({ cardNumber: "1", cardVariation: variation });
    expect(desc).toContain(variation);
    expect(generateListingTitle({ cardNumber: "1", cardVariation: variation })).toBe(
      "#1",
    );
  });

  test("NEO-101: teams get their own line, named in full", () => {
    const desc = generateListingDescription({
      cardNumber: "12",
      playerNames: ["Julio Rodriguez"],
      year: "2024",
      manufacturer: "Topps",
      setName: "Chrome",
      teamNames: ["Seattle Mariners"],
      isRookie: true,
    });
    expect(desc.split("\n")).toEqual([
      "2024 Topps Chrome card of Julio Rodriguez, #12.",
      "Team: Seattle Mariners.",
      "This is a Rookie Card.",
    ]);
  });

  test("NEO-101: a multi-team card lists every team, uncapped", () => {
    // The description has no cap, so unlike the title nothing here competes
    // for room — a team the title had to drop still states itself in full.
    const desc = generateListingDescription({
      cardNumber: "1",
      teamNames: ["Tigres del Licey", "Aguilas Cibaenas", "Estrellas Orientales"],
    });
    expect(desc).toContain(
      "Team: Tigres del Licey, Aguilas Cibaenas, Estrellas Orientales.",
    );
  });

  test("NEO-101: no teams means no Team line at all", () => {
    const desc = generateListingDescription({ cardNumber: "1", teamNames: [] });
    expect(desc).not.toContain("Team:");
  });

  test("autographed None does not add an autograph sentence", () => {
    const desc = generateListingDescription({
      cardNumber: "1",
      autographed: "None",
    });
    expect(desc).not.toContain("Autographed");
  });
});

// ===========================================================================
// NEO-272 — a set whose brand NB has not identified
// ===========================================================================

/**
 * `syncSetsAcrossManufacturers` files a BSC set under the marketplace's
 * all-brands FILTER OPTION — "show all cards from all brands", carried on the
 * brand axis as a `manufacturer` row — whenever the set name prefix-matches no
 * real brand. That row names no brand, so its name says nothing about the card
 * and must never reach a listing. It is identified by
 * `manufacturerBrandUnknown`, an NB ROLE resolved from the ancestor row's
 * `metadata.isBrandUnknown`, NEVER by comparing the name.
 *
 * The name comparison is the thing this ticket removes: the name is a
 * marketplace filter label NB does not own, so keying on it would be NB
 * behaviour driven by a marketplace value (product invariant 4) — and it would
 * miss a renamed row besides.
 *
 * The fixture below deliberately KEEPS the name in `manufacturer` while
 * setting the flag. A generator that passed these tests by ignoring the flag
 * and matching the string would be caught by
 * `an unflagged manufacturer named "All Brands" is still a brand`.
 */
describe("a set whose brand NB has not identified (NEO-272)", () => {
  const BUCKET = {
    cardNumber: "12",
    playerNames: ["Chris Grassie"],
    year: "1995",
    manufacturer: "All Brands",
    setName: "Roanoke Express ECHL",
  };

  test("a flagged manufacturer is omitted from the title entirely", () => {
    const title = generateListingTitle({
      ...BUCKET,
      manufacturerBrandUnknown: true,
    });
    expect(title).toBe("1995 Roanoke Express ECHL Chris Grassie #12");
    expect(title).not.toContain("All Brands");
  });

  test("omitting it leaves no dangling separator and no double space", () => {
    // The failure this guards is an empty token surviving the join — a title
    // reading "1995  Roanoke ..." or "1995 - Roanoke ...". The generator never
    // produces a manufacturer token at all for a flagged row, which is what
    // makes `filter(Boolean).join(" ")` a complete answer.
    const title = generateListingTitle({
      ...BUCKET,
      manufacturerBrandUnknown: true,
    });
    expect(title).not.toMatch(/\s{2}/);
    expect(title.trim()).toBe(title);
    // Same check with every other core part absent, so nothing else is
    // covering for the missing token.
    const bare = generateListingTitle({
      cardNumber: "12",
      manufacturer: "All Brands",
      manufacturerBrandUnknown: true,
      setName: "Roanoke Express ECHL",
    });
    expect(bare).toBe("Roanoke Express ECHL #12");
    expect(bare).not.toMatch(/\s{2}/);
  });

  test('an unflagged manufacturer named "All Brands" is still a brand', () => {
    // The regression guard, and the reason the flag is read instead of the
    // name. A row that carries no brand-unknown role is an ordinary
    // manufacturer whatever it happens to be called.
    const title = generateListingTitle(BUCKET);
    expect(title).toBe("1995 All Brands Roanoke Express ECHL Chris Grassie #12");
    // …and an explicit `false` reads the same as absent.
    expect(
      generateListingTitle({ ...BUCKET, manufacturerBrandUnknown: false }),
    ).toBe(title);
  });

  test("the freed characters are genuinely available to the optional tokens", () => {
    // "All Brands" plus its separator is 11 characters. The variation below is
    // 29 characters and costs 30 to append, which does not fit beside that name
    // and does fit without it — so this is the exact case the ticket is about:
    // a title the attention walker would flag as having dropped a real search
    // term now carries it, and the characters it reclaimed were spent on a word
    // that told a buyer nothing.
    const variation = "Image Variation Sunglasses On";
    expect(variation).toHaveLength(29);

    const withBucket = assessListingTitle({ ...BUCKET, cardVariation: variation });
    expect(withBucket.dropped).toContain(variation);
    expect(withBucket.title).not.toContain(variation);

    const withoutBucket = assessListingTitle({
      ...BUCKET,
      cardVariation: variation,
      manufacturerBrandUnknown: true,
    });
    expect(withoutBucket.dropped).toEqual([]);
    expect(withoutBucket.title).toBe(
      "1995 Roanoke Express ECHL Chris Grassie #12 Image Variation Sunglasses On",
    );
    expect(withoutBucket.title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    expect(withoutBucket.coreFits).toBe(true);
  });

  test("the description omits it too — one helper serves both", () => {
    const desc = generateListingDescription({
      ...BUCKET,
      manufacturerBrandUnknown: true,
      isRookie: true,
    });
    expect(desc.split("\n")).toEqual([
      "1995 Roanoke Express ECHL card of Chris Grassie, #12.",
      "This is a Rookie Card.",
    ]);
    expect(desc).not.toContain("All Brands");
    // Unflagged, the same inputs still name it.
    expect(generateListingDescription({ ...BUCKET, isRookie: true })).toContain(
      "1995 All Brands Roanoke Express ECHL card of Chris Grassie, #12.",
    );
  });

  test("a setName starting with the flagged manufacturer keeps the setName whole", () => {
    // The `startsWithWord` collapse branch needs a truthy manufacturer, so a
    // flagged row never reaches it. The result has to be the same either way:
    // the set name is a display value in its own right and is emitted verbatim,
    // never stripped of a prefix that happens to match the dropped row's name.
    const flagged = generateListingTitle({
      cardNumber: "7",
      year: "1995",
      manufacturer: "All Brands",
      manufacturerBrandUnknown: true,
      setName: "All Brands Showcase",
      playerNames: ["Chris Grassie"],
    });
    expect(flagged).toBe("1995 All Brands Showcase Chris Grassie #7");
    expect(flagged).not.toMatch(/\s{2}/);
    // Unflagged, the collapse still does its job: the word is not doubled.
    const unflagged = generateListingTitle({
      cardNumber: "7",
      year: "1995",
      manufacturer: "All Brands",
      setName: "All Brands Showcase",
      playerNames: ["Chris Grassie"],
    });
    expect(unflagged).toBe("1995 All Brands Showcase Chris Grassie #7");
  });

  test("a flagged manufacturer with no setName leaves only year, players and number", () => {
    const title = generateListingTitle({
      cardNumber: "3",
      year: "1995",
      manufacturer: "All Brands",
      manufacturerBrandUnknown: true,
      playerNames: ["Chris Grassie"],
    });
    expect(title).toBe("1995 Chris Grassie #3");
    expect(title).not.toMatch(/\s{2}/);
  });
});

describe("NEO-335 — the insert's name is set identity", () => {
  const score: ListingCardInputs = {
    cardNumber: "5",
    year: "1996",
    manufacturer: "Score",
    setName: "Score",
    playerNames: ["Ken Griffey Jr."],
  };

  test("joins the core after the set name and before the players", () => {
    expect(generateListingTitle({ ...score, insertName: "Dugout Collection" })).toBe(
      "1996 Score Dugout Collection Insert Ken Griffey Jr. #5",
    );
  });

  test("no insert name: the title is exactly what it was", () => {
    expect(generateListingTitle(score)).toBe("1996 Score Ken Griffey Jr. #5");
  });

  test("an insert named after its set collapses into it, like a set named after its maker", () => {
    expect(
      generateListingTitle({
        ...score,
        manufacturer: "Topps",
        setName: "Topps Chrome",
        insertName: "Topps Chrome Refractor",
      }),
    ).toBe("1996 Topps Chrome Refractor Insert Ken Griffey Jr. #5");
    expect(
      generateListingTitle({
        ...score,
        manufacturer: "Upper Deck",
        setName: "Collector's Choice",
        insertName: "Collector's Choice Silver Signature",
      }),
    ).toBe("1996 Upper Deck Collector's Choice Silver Signature Insert Ken Griffey Jr. #5");
  });

  test("an insert whose every word the set already says adds nothing", () => {
    expect(
      generateListingTitle({ ...score, manufacturer: "Topps", setName: "Topps Chrome", insertName: "Chrome" }),
    ).toBe("1996 Topps Chrome Insert Ken Griffey Jr. #5");
  });

  test("never dropped: a long insert cuts the core (flagged) rather than leaving the title", () => {
    const a = assessListingTitle({
      ...score,
      insertName: "Extraordinarily Photographic Superfractor Heritage Refractor Update",
      playerNames: ["Fitzwilliam-Harrington Rodriguez"],
    });
    // The player and the insert alone are 100 characters: the fallback keeps
    // the player and the insert's leading words, then the year; the number
    // and the set word do not fit (Jason, 2026-10-19: the number may go).
    expect(a.title).toBe(
      "1996 Extraordinarily Photographic Superfractor Fitzwilliam-Harrington Rodriguez",
    );
    expect(a.coreFits).toBe(false);
    expect(a.dropped).toEqual(["#5"]);
  });

  test("the description names the insert too, in full", () => {
    expect(
      generateListingDescription({ ...score, insertName: "Dugout Collection", setShortName: "Score DC" }),
    ).toMatch(/^1996 Score Dugout Collection card of Ken Griffey Jr\., #5\./);
  });
});

describe("NEO-335 — the short name replaces the set and insert words", () => {
  // 1990 Upper Deck Collector's Choice, Hologram insert, a card whose
  // full-name title cannot hold its own identity.
  const long: ListingCardInputs = {
    cardNumber: "H12",
    year: "1990",
    manufacturer: "Upper Deck",
    setName: "Upper Deck Collector's Choice",
    insertName: "Hologram Heroes Extraordinarily Photographic",
    playerNames: ["Fitzwilliam-Harrington Rodriguez"],
    setShortName: "Upper Deck Hologram",
  };
  // Fits whole, but a real optional token (RC) is dropped.
  const dropsRc: ListingCardInputs = {
    cardNumber: "1",
    year: "2024",
    manufacturer: "Topps",
    setName: "Topps Chrome Sapphire",
    // No "Rookie" in the name: "Rookie" → "RC" (tried before the short name)
    // would otherwise let the RC token fold into it. Covered on its own below.
    insertName: "Debut Patch Autographs",
    playerNames: ["Elly De La Cruz"],
    autographed: "On Card",
    isRelic: true,
    isRookie: true,
    printRun: 99,
    cardVariation: "Image Variation",
    setShortName: "Topps Debut",
  };
  // Fits whole and drops only filler (the sport).
  const dropsFiller: ListingCardInputs = {
    cardNumber: "1",
    year: "2024",
    manufacturer: "Topps",
    setName: "Topps Chrome Sapphire",
    insertName: "Rookie Debut Patch Autographs",
    playerNames: ["Elly De La Cruz"],
    sport: "Baseball",
    setShortName: "Topps Debut",
  };

  test("the fixtures are what they claim", () => {
    const noShort = (i: ListingCardInputs) => assessListingTitle({ ...i, setShortName: undefined });
    expect(noShort(long).coreFits).toBe(false);
    expect(noShort(dropsRc).coreFits).toBe(true);
    expect(noShort(dropsRc).dropped).toContain("RC");
    expect(noShort(dropsFiller).coreFits).toBe(true);
    // The "Insert" label is filler too: only filler is lost.
    expect(noShort(dropsFiller).dropped).toEqual(["Baseball", "Insert"]);
  });

  test("the shipped rule is A", () => {
    expect(SHORT_NAME_RULE).toBe("A");
  });

  test("rule A: a cut core uses the short name; the maker is not repeated", () => {
    const a = assessListingTitle(long, { shortNameRule: "A" });
    expect(a).toEqual({
      title: "1990 Upper Deck Hologram Fitzwilliam-Harrington Rodriguez #H12",
      coreFits: true,
      dropped: [],
      shortNameUsed: true,
    });
  });

  test("rule A: a dropped real token uses the short name", () => {
    const a = assessListingTitle(dropsRc, { shortNameRule: "A" });
    expect(a.shortNameUsed).toBe(true);
    expect(a.title).toContain("Topps Debut");
    expect(a.title).not.toContain("Sapphire");
    expect(a.title).toContain("RC");
  });

  test("rule A: only filler dropped keeps the full names", () => {
    const a = assessListingTitle(dropsFiller, { shortNameRule: "A" });
    expect(a.shortNameUsed).toBeUndefined();
    expect(a.title).toContain("Rookie Debut Patch Autographs");
  });

  test("rule B: only a cut core uses it", () => {
    expect(assessListingTitle(long, { shortNameRule: "B" }).shortNameUsed).toBe(true);
    expect(assessListingTitle(dropsRc, { shortNameRule: "B" }).shortNameUsed).toBeUndefined();
    expect(assessListingTitle(dropsFiller, { shortNameRule: "B" }).shortNameUsed).toBeUndefined();
  });

  test("rule C: always, whenever there is one", () => {
    expect(assessListingTitle(long, { shortNameRule: "C" }).shortNameUsed).toBe(true);
    expect(assessListingTitle(dropsRc, { shortNameRule: "C" }).shortNameUsed).toBe(true);
    const c = assessListingTitle(dropsFiller, { shortNameRule: "C" });
    expect(c.shortNameUsed).toBe(true);
    expect(c.title).toBe("2024 Topps Debut Elly De La Cruz #1 Baseball");
    // A short title that fits whole: no rule changes anything.
    const short = { cardNumber: "1", year: "2024", setName: "Topps", setShortName: "T" };
    expect(assessListingTitle(short, { shortNameRule: "A" }).shortNameUsed).toBeUndefined();
  });

  test("a short name that does not start with the maker keeps the maker", () => {
    const a = assessListingTitle({ ...long, setShortName: "CC Hologram" }, { shortNameRule: "C" });
    expect(a.title.startsWith("1990 Upper Deck CC Hologram ")).toBe(true);
  });

  test("a brand NB has not identified is never put back by the short name", () => {
    const a = assessListingTitle(
      { ...long, manufacturer: "All Brands", manufacturerBrandUnknown: true, setShortName: "CC Hologram" },
      { shortNameRule: "C" },
    );
    expect(a.title.startsWith("1990 CC Hologram ")).toBe(true);
  });

  test("a blank short name is no short name", () => {
    expect(assessListingTitle({ ...long, setShortName: "   " })).toEqual(
      assessListingTitle({ ...long, setShortName: undefined }),
    );
  });
});

describe("NEO-335 — the \"Insert\" and \"Parallel\" labels (the old builder's, first to drop)", () => {
  const score: ListingCardInputs = {
    cardNumber: "5",
    year: "1996",
    manufacturer: "Score",
    setName: "Score",
    playerNames: ["Ken Griffey Jr."],
  };
  const both: ListingCardInputs = {
    ...score,
    insertName: "Dugout Collection",
    parallelName: "Gold",
    parallelIsRole: true,
  };

  test("each label follows the name it labels", () => {
    expect(assessListingTitle(both)).toEqual({
      title: "1996 Score Dugout Collection Insert Ken Griffey Jr. #5 Gold Parallel",
      coreFits: true,
      dropped: [],
    });
    expect(generateListingTitle({ ...score, insertName: "Dugout Collection" })).toBe(
      "1996 Score Dugout Collection Insert Ken Griffey Jr. #5",
    );
    expect(generateListingTitle({ ...score, parallelName: "Gold", parallelIsRole: true })).toBe(
      "1996 Score Ken Griffey Jr. #5 Gold Parallel",
    );
  });

  test("\"Parallel\" only on the parallel ROLE, never on a parallel name alone", () => {
    // A base card whose features name a parallel (or a copied variation)
    // carries no role: the title is what it always was.
    expect(generateListingTitle({ ...score, parallelName: "Gold" })).toBe(
      "1996 Score Ken Griffey Jr. #5 Gold",
    );
    expect(
      generateListingTitle({ ...score, parallelName: "Gold", parallelIsRole: false }),
    ).toBe("1996 Score Ken Griffey Jr. #5 Gold");
    // A "Base" parallel name is no parallel token, so nothing to label.
    expect(generateListingTitle({ ...score, parallelName: "Base", parallelIsRole: true })).toBe(
      "1996 Score Ken Griffey Jr. #5",
    );
  });

  test("a name that already ends with the word is not labelled twice", () => {
    expect(generateListingTitle({ ...score, insertName: "Gold Insert" })).toBe(
      "1996 Score Gold Insert Ken Griffey Jr. #5",
    );
    expect(generateListingTitle({ ...score, insertName: "Hot Inserts" })).toBe(
      "1996 Score Hot Inserts Ken Griffey Jr. #5",
    );
    expect(
      generateListingTitle({ ...score, parallelName: "Prizm Parallel", parallelIsRole: true }),
    ).toBe("1996 Score Ken Griffey Jr. #5 Prizm Parallel");
    // A word that merely ends in the letters is not the word.
    expect(generateListingTitle({ ...score, insertName: "Reinsert" })).toBe(
      "1996 Score Reinsert Insert Ken Griffey Jr. #5",
    );
  });

  test("a parallel token that is really the card's variation is not called a parallel", () => {
    expect(
      generateListingTitle({
        ...score,
        parallelName: "Image Variation",
        cardVariation: "Image Variation",
        parallelIsRole: true,
      }),
    ).toBe("1996 Score Ken Griffey Jr. #5 Image Variation");
  });

  test("\"Insert\" is the first word lost: the team and the parallel label keep their room", () => {
    const a = assessListingTitle({ ...both, teamNames: ["Seattle Mariners"] });
    expect(a.title).toBe(
      "1996 Score Dugout Collection Ken Griffey Jr. #5 Gold Parallel Seattle Mariners",
    );
    expect(a.dropped).toEqual(["Insert"]);
  });

  test("\"Parallel\" is the second: both labels go before a team does", () => {
    const a = assessListingTitle({ ...both, teamNames: ["Seattle Mariners Club"] });
    expect(a.title).toBe("1996 Score Dugout Collection Ken Griffey Jr. #5 Gold Seattle Mariners Club");
    expect(a.dropped).toEqual(["Parallel", "Insert"]);
  });

  test("the labels lose to even the filler words that come before them (the sport)", () => {
    const a = assessListingTitle({ ...both, teamNames: ["Seattle Mariners"], sport: "Baseball" });
    expect(a.title).toContain("Seattle Mariners");
    expect(a.title).not.toContain(" Insert ");
    expect(a.dropped).toContain("Insert");
  });

  test("no \"Insert\" label on a cut core: the insert's own words come first", () => {
    const a = assessListingTitle({
      ...score,
      insertName: "Extraordinarily Photographic Superfractor Heritage Refractor Update",
      playerNames: ["Fitzwilliam-Harrington Rodriguez"],
    });
    expect(a.coreFits).toBe(false);
    expect(a.title).not.toMatch(/\bInsert\b/);
  });

  test("no \"Insert\" label beside the short name: the insert's name is not there to label", () => {
    const a = assessListingTitle(
      { ...both, setShortName: "Score DC" },
      { shortNameRule: "C" },
    );
    expect(a.shortNameUsed).toBe(true);
    expect(a.title).toBe("1996 Score DC Ken Griffey Jr. #5 Gold Parallel");
  });

  test("rule A: losing only the labels never switches to the short name", () => {
    const inputs: ListingCardInputs = {
      ...both,
      teamNames: ["Seattle Mariners Club"],
      setShortName: "Score DC",
    };
    const a = assessListingTitle(inputs, { shortNameRule: "A" });
    expect(a.dropped).toEqual(["Parallel", "Insert"]);
    expect(a.shortNameUsed).toBeUndefined();
    expect(a.title).toContain("Dugout Collection");
  });

  test("the description is unchanged: no labels there", () => {
    expect(generateListingDescription(both)).toMatch(
      /^1996 Score Dugout Collection Gold card of Ken Griffey Jr\., #5\./,
    );
  });

  test("a base card's title is byte-identical: no role, no label", () => {
    expect(
      generateListingTitle({
        cardNumber: "50",
        playerNames: ["Elly De La Cruz"],
        year: "2024",
        manufacturer: "Topps",
        setName: "Chrome",
        parallelName: "Base",
        isRookie: true,
        teamNames: ["Cincinnati Reds"],
        sport: "Baseball",
      }),
    ).toBe("2024 Topps Chrome Elly De La Cruz #50 RC Cincinnati Reds Rookie Baseball");
  });
});

describe("NEO-335 — \"Rookie\" → \"RC\" in an insert's name, only when needed", () => {
  const debut: ListingCardInputs = {
    cardNumber: "RD-12",
    year: "2024",
    manufacturer: "Topps",
    setName: "Topps Chrome",
    insertName: "Rookie Debut Patch Autographs",
    playerNames: ["Elly De La Cruz"],
    autographed: "On Card",
    isRookie: true,
  };

  test("the old builder's exact replacement: first occurrence, case-sensitive, no word boundary", () => {
    expect(rookieAsRc("Rookie Debut")).toBe("RC Debut");
    expect(rookieAsRc("Rookie Rookie")).toBe("RC Rookie");
    expect(rookieAsRc("Rookies Club")).toBe("RCs Club");
    expect(rookieAsRc("rookie debut")).toBe("rookie debut");
    expect(rookieAsRc("Future Stars")).toBe("Future Stars");
  });

  test("a title that fits keeps the printed name", () => {
    const a = assessListingTitle(debut);
    expect(a.title).toBe(
      "2024 Topps Chrome Rookie Debut Patch Autographs Elly De La Cruz #RD-12 AUTO RC",
    );
    // Only the "Insert" label (filler) was lost: not a reason to shorten.
    expect(a.dropped).toEqual(["Insert"]);
    expect(a.rookieAsRcUsed).toBeUndefined();
  });

  test("shortened when it keeps a real token the printed name lost", () => {
    const a = assessListingTitle({ ...debut, isRelic: true, printRun: 99 });
    expect(a.rookieAsRcUsed).toBe(true);
    // The print run is never dropped and AUTO is redundant beside
    // "Autographs" (Jason, 2026-10-19), so AUTO is the word that goes.
    expect(a.title).toBe(
      "2024 Topps Chrome RC Debut Patch Autographs Elly De La Cruz #RD-12 RELIC /99",
    );
    // RC is said by the shortened name, so it is not lost.
    expect(a.dropped).not.toContain("RC");
    expect(assessListingTitle({ ...debut, insertName: "Freshman Debut Patch Autographs", isRelic: true, printRun: 99 }).dropped).toContain("RELIC");
  });

  test("not shortened when it buys nothing: the same tokens are lost either way", () => {
    const a = assessListingTitle({ ...debut, teamNames: ["Cincinnati Reds"] });
    expect(a.rookieAsRcUsed).toBeUndefined();
    expect(a.title).toContain("Rookie Debut");
    expect(a.dropped).toContain("Cincinnati Reds");
  });

  test("shortened on a cut core: four characters back for the card's identity", () => {
    const a = assessListingTitle({
      ...debut,
      insertName: "Rookie Debut Patch Autographs Sapphire Platinum Anniversary Edition",
    });
    expect(a.coreFits).toBe(false);
    expect(a.rookieAsRcUsed).toBe(true);
    // The printed insert name and the player do not fit together (82); the
    // shortened one does, whole, ahead of the year, number and set words.
    expect(a.title).toBe(
      "RC Debut Patch Autographs Sapphire Platinum Anniversary Edition Elly De La Cruz",
    );
  });

  test("tried BEFORE the short name: when it is enough, the short name is not used", () => {
    const a = assessListingTitle(
      { ...debut, isRelic: true, printRun: 99, setShortName: "Topps RDPA" },
      { shortNameRule: "A" },
    );
    expect(a.rookieAsRcUsed).toBe(true);
    expect(a.shortNameUsed).toBeUndefined();
    expect(a.title).toContain("RC Debut Patch Autographs");
  });

  test("when it is not enough, the short name still takes over (rule A)", () => {
    const a = assessListingTitle(
      { ...debut, isRelic: true, printRun: 99, cardVariation: "Gold Glove", setShortName: "Topps RDPA" },
      { shortNameRule: "A" },
    );
    expect(a.shortNameUsed).toBe(true);
    expect(a.rookieAsRcUsed).toBeUndefined();
    expect(a.title).toBe("2024 Topps RDPA Elly De La Cruz #RD-12 AUTO RELIC /99 Gold Glove RC Rookie");
  });

  test("never touches a name without \"Rookie\", nor the description", () => {
    expect(
      assessListingTitle({ ...debut, insertName: "Debut Patch Autographs", isRelic: true, printRun: 99 })
        .rookieAsRcUsed,
    ).toBeUndefined();
    expect(generateListingDescription({ ...debut, isRelic: true, printRun: 99 })).toContain(
      "Rookie Debut Patch Autographs",
    );
  });
});

// ===========================================================================
// Jason, 2026-10-19 — what gives way when a title does not fit
// ===========================================================================

describe("shortening an over-limit title (Jason, 2026-10-19)", () => {
  // 2023 Topps Chrome, as the set builder files it: an insert named for the
  // 1988 Topps design, a SuperFractor parallel beneath it.
  const chrome: ListingCardInputs = {
    cardNumber: "88BA-VGJ",
    year: "2023",
    manufacturer: "Topps",
    setName: "Topps Chrome",
    insertName: "1988 Topps Baseball Autographs",
    playerNames: ["Vladimir Guerrero Jr."],
    sport: "Baseball",
  };
  const superfractor: ListingCardInputs = {
    ...chrome,
    parallelName: "SuperFractor",
    parallelIsRole: true,
    printRun: 1,
    autographed: "On Card",
    teamNames: ["Toronto Blue Jays"],
  };

  test("rule 1: a SuperFractor /1 keeps its parallel's name and print run; the card number goes first", () => {
    const a = assessListingTitle(superfractor);
    // Before: "2023 Topps Chrome 1988 Topps Baseball Autographs Vladimir
    // Guerrero Jr. #88BA-VGJ", with SuperFractor and /1 both dropped.
    expect(a.title).toBe(
      "2023 Topps Chrome 1988 Baseball Autographs Vladimir Guerrero Jr. SuperFractor /1",
    );
    expect(a.title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    // The number is a real loss: reported, and the row is flagged.
    expect(a.coreFits).toBe(false);
    expect(a.dropped).toEqual(["#88BA-VGJ", "Toronto Blue Jays", "AUTO", "Parallel"]);
  });

  test("rule 1: the insert's name is never cut; the card number gives way instead", () => {
    // A flat insert carrying its parallel's words. Before: the cut took
    // "Refractor" and the print run. The number goes before any set word:
    // "Topps Chrome" without "Chrome" would name a different product.
    const a = assessListingTitle({
      cardNumber: "TCA-VG",
      year: "2023",
      manufacturer: "Topps",
      setName: "Topps Chrome",
      insertName: "Authentics Relics Orange Refractor",
      playerNames: ["Vladimir Guerrero Jr."],
      isRelic: true,
      printRun: 25,
      teamNames: ["Toronto Blue Jays"],
      sport: "Baseball",
    });
    expect(a.title).toBe(
      "2023 Topps Chrome Authentics Relics Orange Refractor Vladimir Guerrero Jr. /25",
    );
    expect(a.title).toContain("Orange Refractor");
    expect(a.coreFits).toBe(false);
    // RELIC beside "Relics" is the redundant word (rule 2), not a loss.
    expect(a.dropped).toEqual(["#TCA-VG", "Toronto Blue Jays", "RELIC", "Baseball"]);
    expect(isFillerToken("RELIC", { isRelic: true, cardNumber: "TCA-VG" }, a.title)).toBe(true);
  });

  test("rule 2: \"Topps\" in the insert's name goes when the set already says it, and only when needed", () => {
    const tovar: ListingCardInputs = {
      ...chrome,
      sport: undefined,
      cardNumber: "88BA-ET",
      playerNames: ["Ezequiel Tovar"],
      printRun: 99,
      isRookie: true,
    };
    // Room for everything real: the insert's name stays as printed.
    expect(assessListingTitle(tovar).title).toBe(
      "2023 Topps Chrome 1988 Topps Baseball Autographs Ezequiel Tovar #88BA-ET /99 RC",
    );
    // One attribute more, and the repeated "Topps" makes the room for it. The
    // title still says Topps, so nothing identifying was lost.
    const a = assessListingTitle({ ...tovar, shortPrint: "SSP" });
    expect(a.title).toBe(
      "2023 Topps Chrome 1988 Baseball Autographs Ezequiel Tovar #88BA-ET /99 RC SSP",
    );
    expect(a.coreFits).toBe(true);
    // Only filler went: the second "Rookie" (never worth a printed word of
    // a name) and the "Insert" label.
    expect(a.dropped).toEqual(["Rookie", "Insert"]);
  });

  test("rule 2: a parallel's word the set already says goes before a real token", () => {
    const a = assessListingTitle({
      cardNumber: "RA-CS",
      year: "2023",
      manufacturer: "Panini",
      setName: "Prizm",
      insertName: "Rookie Autographs",
      parallelName: "Red White and Blue Prizm",
      parallelIsRole: true,
      printRun: 99,
      autographed: "Sticker/Label",
      isRookie: true,
      playerNames: ["C.J. Stroud"],
      teamNames: ["Houston Texans"],
      sport: "Football",
    });
    // Before: "... #RA-CS AUTO /99 RC Football", the parallel dropped whole.
    expect(a.title).toBe(
      "2023 Panini Prizm Rookie Autographs C.J. Stroud #RA-CS Red White and Blue /99 RC",
    );
    expect(a.coreFits).toBe(true);
    expect(a.dropped).toEqual(["Houston Texans", "AUTO", "Football", "Parallel", "Insert"]);
  });

  test("rule 2: AUTO beside \"Autographs\" is redundant: the first attribute to go, and no loss", () => {
    const a = assessListingTitle(superfractor);
    expect(a.title).not.toMatch(/\bAUTO\b/);
    expect(a.dropped).toContain("AUTO");
    expect(isFillerToken("AUTO", superfractor, a.title)).toBe(true);
    // Without the title to read, AUTO is never assumed redundant.
    expect(isFillerToken("AUTO", superfractor)).toBe(false);
    // With room it stays: redundant words go only when needed.
    expect(
      assessListingTitle({ ...chrome, cardNumber: "1", playerNames: ["Ohtani"], autographed: "On Card" })
        .title,
    ).toBe("2023 Topps Chrome 1988 Topps Baseball Autographs Insert Ohtani #1 AUTO");
    // Beside a name that does not say it, AUTO is the most valuable attribute.
    const plain = assessListingTitle({
      ...superfractor,
      insertName: "Future Stars",
      playerNames: ["Shohei Ohtani"],
      cardNumber: "FS-1",
    });
    expect(plain.title).toBe(
      "2023 Topps Chrome Future Stars Shohei Ohtani #FS-1 AUTO SuperFractor /1 Baseball",
    );
    expect(plain.dropped).toEqual(["Toronto Blue Jays", "Parallel", "Insert"]);
  });

  test("rule 3: the sport is the first word to go, ahead of a redundant word", () => {
    // Dropping the parallel's repeated "Prizm" would make room for the sport;
    // the sport goes instead, and the shorter "Insert" label takes the slack.
    const a = assessListingTitle({
      cardNumber: "RA-CJS",
      year: "2023",
      manufacturer: "Panini",
      setName: "Prizm",
      insertName: "Rookie Autographs",
      parallelName: "Silver Prizm",
      parallelIsRole: true,
      printRun: 99,
      playerNames: ["C.J. Stroud"],
      sport: "Football",
    });
    expect(a.title).toBe(
      "2023 Panini Prizm Rookie Autographs Insert C.J. Stroud #RA-CJS Silver Prizm /99",
    );
    expect(a.coreFits).toBe(true);
    expect(a.dropped).toEqual(["Football", "Parallel"]);
  });

  test("rule 4: the print run is never dropped; the attributes are", () => {
    const a = assessListingTitle({
      ...superfractor,
      autographed: "None",
      isRelic: true,
      isRookie: true,
      shortPrint: "SSP",
      cardVariation: "Image Variation",
      insertName: "Future Stars",
    });
    expect(a.title).toMatch(/ \/1( |$)/);
    expect(a.title).toContain("SuperFractor");
    expect(a.coreFits).toBe(true);
    // Every attribute went, in priority order, before any set word did.
    expect(a.dropped).toEqual([
      "RELIC",
      "Image Variation",
      "RC",
      "SSP",
      "Toronto Blue Jays",
      "Rookie",
      "Baseball",
      "Parallel",
      "Insert",
    ]);
    expect(a.title).toBe(
      "2023 Topps Chrome Future Stars Vladimir Guerrero Jr. #88BA-VGJ SuperFractor /1",
    );
  });

  test("a variation copied into the parallel name is still a variation: dropped, never protected", () => {
    const variation = "Image Variation; Wearing a throwback uniform with the 1970s powder blue logo";
    const a = assessListingTitle({
      cardNumber: "300b",
      year: "2024",
      manufacturer: "Topps",
      setName: "Topps Chrome",
      playerNames: ["Julio Rodriguez"],
      parallelName: variation,
      cardVariation: variation,
    });
    expect(a.title).toBe("2024 Topps Chrome Julio Rodriguez #300b");
    expect(a.coreFits).toBe(true);
    // Listed once, though it arrives in two fields.
    expect(a.dropped).toEqual([variation]);
  });

  test("the fallback: the never-dropped pieces alone exceed the cap", () => {
    // Not a real card. The print run is kept first, then the players whole,
    // then the insert's leading words; the cap is absolute and the row is
    // flagged.
    const a = assessListingTitle({
      cardNumber: "DR-GTR",
      year: "2023",
      manufacturer: "Topps",
      setName: "Topps Chrome",
      insertName: "Authentics Relics Orange Refractor",
      playerNames: ["Vladimir Guerrero Jr.", "Fernando Tatis Jr."],
      printRun: 25,
    });
    expect(a.title).toBe(
      "2023 Authentics Relics Orange Vladimir Guerrero Jr. & Fernando Tatis Jr. /25",
    );
    expect(a.title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    expect(a.coreFits).toBe(false);
    expect(a.dropped).toEqual(["#DR-GTR"]);
  });

  test("a title that fits is byte-identical to the NEO-101 layout", () => {
    expect(
      assessListingTitle({
        ...superfractor,
        insertName: undefined,
        teamNames: undefined,
        sport: undefined,
        cardNumber: "1",
        playerNames: ["Ohtani"],
      }),
    ).toEqual({
      title: "2023 Topps Chrome Ohtani #1 AUTO SuperFractor Parallel /1",
      coreFits: true,
      dropped: [],
    });
  });
});

// ===========================================================================
// The parallel's repeat of its insert (NEO-339 preview, 2023 Topps Chrome)
// ===========================================================================

describe("the parallel's repeat of its insert goes first, and whole", () => {
  // A BSC parallel leaf carries its insert's name in its own: "Rookie
  // Autographs Black & White Mini-Diamond Refractor" under "Rookie
  // Autographs". `titleChainFacts` hands that value through as the parallel
  // token (`parallelLeafValue`). Printing plates carry no print run.
  const chrome: ListingCardInputs = {
    cardNumber: "1",
    year: "2023",
    manufacturer: "Topps",
    setName: "Topps Chrome",
    sport: "Baseball",
    parallelIsRole: true,
  };

  test("no stray \"Topps\": the Authentics Relics repeat goes as one", () => {
    const vlad: ListingCardInputs = {
      ...chrome,
      cardNumber: "TCAR-VG",
      insertName: "Topps Chrome Authentics Relics",
      parallelName: "Topps Chrome Authentics Relics Green Refractor",
      playerNames: ["Vladimir Guerrero Jr."],
      isRelic: true,
      teamNames: ["Toronto Blue Jays"],
    };
    // Before: "... Vladimir Guerrero Jr. Topps Green Refractor".
    const a = assessListingTitle(vlad);
    expect(a.title).toBe(
      "2023 Topps Chrome Authentics Relics Vladimir Guerrero Jr. Green Refractor",
    );
    // The number is the real loss; RELIC beside "Relics" is redundant.
    expect(a.coreFits).toBe(false);
    expect(a.dropped).toEqual(["#TCAR-VG", "Toronto Blue Jays", "RELIC", "Baseball", "Parallel"]);
    // The same card named the other way round: before, "... Jr. Relics Green
    // Refractor".
    expect(
      assessListingTitle({
        ...vlad,
        insertName: "Authentics Relics",
        parallelName: "Authentics Relics Topps Green Refractor",
      }).title,
    ).toBe("2023 Topps Chrome Authentics Relics Vladimir Guerrero Jr. Green Refractor");
  });

  test("no stray \"1988\": the 1988 Topps Baseball Autographs repeat goes as one", () => {
    const a = assessListingTitle({
      ...chrome,
      cardNumber: "88BA-AR",
      insertName: "1988 Topps Baseball Autographs",
      parallelName: "1988 Topps Baseball Autographs Printing Plate Cyan",
      playerNames: ["Austin Riley"],
      autographed: "On Card",
      teamNames: ["Atlanta Braves"],
    });
    // Before: "... Austin Riley 1988 Printing Plate Cyan".
    expect(a.title).toBe(
      "2023 Topps Chrome 1988 Baseball Autographs Austin Riley Printing Plate Cyan",
    );
    expect(a.title).toContain("Printing Plate Cyan");
    expect(a.dropped).toEqual(["#88BA-AR", "Atlanta Braves", "AUTO", "Parallel"]);
  });

  test("no stray \"in\": the in Technicolor Autographs repeat goes as one", () => {
    const a = assessListingTitle({
      ...chrome,
      cardNumber: "TA-AJ",
      insertName: "Topps Chrome in Technicolor Autographs",
      parallelName: "Topps Chrome in Technicolor Autographs Printing Plate Black",
      playerNames: ["Aaron Judge"],
      autographed: "On Card",
      teamNames: ["New York Yankees"],
    });
    // Before: "... Aaron Judge in Printing Plate Black".
    expect(a.title).toBe(
      "2023 Topps Chrome in Technicolor Autographs Aaron Judge Printing Plate Black",
    );
  });

  test("a parallel's \"Rookie\" repeats an insert shortened to RC (Dual Rookie Autographs)", () => {
    const a = assessListingTitle({
      ...chrome,
      cardNumber: "DRA-CG",
      insertName: "Dual Rookie Autographs",
      parallelName: "Dual Rookie Autographs Red",
      playerNames: ["Corbin Carroll", "Riley Greene"],
      autographed: "On Card",
      isRookie: true,
      printRun: 5,
      teamNames: ["Arizona Diamondbacks", "Detroit Tigers"],
    });
    // Before: "2023 Topps Chrome Dual RC Autographs Corbin Carroll & Riley
    // Greene Rookie Red /5". Shortening to RC would win nothing now (the
    // number misses either way), so the insert keeps its printed name and
    // the parallel reads its own word.
    expect(a.title).toBe(
      "2023 Topps Chrome Dual Rookie Autographs Corbin Carroll & Riley Greene Red /5 RC",
    );
    expect(a.rookieAsRcUsed).toBeUndefined();
  });

  test("a parallel's \"Rookies\" repeats an insert shortened to RCs (Radiating Rookies)", () => {
    const a = assessListingTitle({
      ...chrome,
      cardNumber: "RRA-AR",
      insertName: "Topps Chrome Radiating Rookies Autographs",
      parallelName: "Radiating Rookies Autographs SuperFractor",
      playerNames: ["Adley Rutschman"],
      autographed: "On Card",
      isRookie: true,
      printRun: 1,
      teamNames: ["Baltimore Orioles"],
    });
    // Before: "Topps Chrome Radiating RCs Autographs Adley Rutschman Rookies
    // SuperFractor /1 RC", the year lost to the set words the insert's name
    // starts with. They are set words: the year now leads.
    expect(a.title).toBe(
      "2023 Topps Chrome Radiating RCs Autographs Adley Rutschman SuperFractor /1 RC",
    );
    expect(a.rookieAsRcUsed).toBe(true);
  });

  test("the worst case: a redundant \"Rookie\" never outlasts a set word", () => {
    const burleson: ListingCardInputs = {
      ...chrome,
      cardNumber: "RA-AB",
      insertName: "Rookie Autographs",
      parallelName: "Rookie Autographs Black & White Mini-Diamond Refractor",
      playerNames: ["Alec Burleson"],
      autographed: "On Card",
      isRookie: true,
      teamNames: ["St. Louis Cardinals"],
    };
    const a = assessListingTitle(burleson);
    // Before: "2023 RC Autographs Alec Burleson Rookie Black & White
    // Mini-Diamond Refractor", "Topps Chrome" lost while "Rookie" stayed.
    expect(a.title).toBe(
      "2023 Topps RC Autographs Alec Burleson Black & White Mini-Diamond Refractor",
    );
    expect(a.title).not.toMatch(/\bRookie\b/);
    // "Chrome" (7 with its space) does not fit beside the never-dropped
    // pieces with either spelling of the insert: 82 characters with "RC".
    expect(`${a.title.slice(0, 10)} Chrome${a.title.slice(10)}`.length).toBeGreaterThan(
      LISTING_TITLE_MAX,
    );
    expect(a.coreFits).toBe(false);
    expect(a.title).toContain("Black & White Mini-Diamond Refractor");
  });

  test("Ultraviolet: \"Chrome\" goes before \"Topps\" because set words go from the end", () => {
    const uv: ListingCardInputs = {
      ...chrome,
      cardNumber: "UV-JR",
      insertName: "Ultraviolet All-Stars Autographs",
      parallelName: "Ultraviolet All-Stars Autographs Printing Plate Black",
      playerNames: ["Julio Rodriguez"],
      autographed: "On Card",
      teamNames: ["Seattle Mariners"],
    };
    // Not the redundant-word bug: no redundant word is in the title, and the
    // whole title is 87 characters with "Chrome". Unchanged by the fix.
    expect(assessListingTitle(uv).title).toBe(
      "2023 Topps Ultraviolet All-Stars Autographs Julio Rodriguez Printing Plate Black",
    );
    // An insert stored with the set's name ahead of its own reads those
    // words as SET words: given up before the year, never the parallel's
    // "Black". Before: "Topps Chrome Ultraviolet All-Stars Autographs Julio
    // Rodriguez Printing Plate /1".
    const a = assessListingTitle({
      ...uv,
      insertName: "Topps Chrome Ultraviolet All-Stars Autographs",
      parallelName: "Topps Chrome Ultraviolet All-Stars Autographs Printing Plate Black",
      printRun: 1,
    });
    expect(a.title).toBe(
      "2023 Ultraviolet All-Stars Autographs Julio Rodriguez Printing Plate Black /1",
    );
  });

  test("with room, the repeat reads whole in its own place; short of room, it goes whole", () => {
    const ohtani: ListingCardInputs = {
      ...chrome,
      insertName: "Rookie Autographs",
      parallelName: "Rookie Autographs Black Refractor",
      playerNames: ["Ohtani"],
    };
    expect(assessListingTitle(ohtani).title).toBe(
      "2023 Topps Chrome Rookie Autographs Ohtani #1 Rookie Autographs Black Refractor",
    );
    // Before: "... Ohtani #1 Rookie Black Refractor Reds", half the repeat.
    const a = assessListingTitle({ ...ohtani, teamNames: ["Reds"] });
    expect(a.title).toBe("2023 Topps Chrome Rookie Autographs Ohtani #1 Black Refractor Reds Baseball");
    expect(a.coreFits).toBe(true);
    expect(a.dropped).toEqual(["Parallel", "Insert"]);
  });

  test("a redundant word never spends room a real loss left over", () => {
    // The team does not fit; "Topps" would (6 of the 6 characters left), and
    // before it took them: "... #FS-VG Topps Gold Refractor".
    const a = assessListingTitle({
      ...chrome,
      cardNumber: "FS-VG",
      insertName: "Future Stars",
      parallelName: "Topps Gold Refractor",
      playerNames: ["Vladimir Guerrero Jr."],
      teamNames: ["Toronto Blue Jays"],
    });
    expect(a.title).toBe("2023 Topps Chrome Future Stars Vladimir Guerrero Jr. #FS-VG Gold Refractor");
    expect(a.dropped).toContain("Toronto Blue Jays");
  });

  test("a parallel that only shares a word with its insert keeps it", () => {
    // "Gold Refractor" under "Gold Rush" repeats no insert. Before: "...
    // AUTO Refractor Toronto Blue Jays", the parallel's own "Gold" gone.
    const goldRush: ListingCardInputs = {
      ...chrome,
      setName: "Topps",
      cardNumber: "88BA-VGJ",
      insertName: "Gold Rush",
      parallelName: "Gold Refractor",
      playerNames: ["Elly De La Cruz"],
      autographed: "On Card",
      teamNames: ["Toronto Blue Jays"],
    };
    expect(assessListingTitle(goldRush).title).toBe(
      "2023 Topps Gold Rush Elly De La Cruz #88BA-VGJ AUTO Gold Refractor Baseball",
    );
    // The repeat is the leading insert name only: the second "Gold" of
    // "Gold Rush Gold Refractor" is the parallel's own.
    expect(
      assessListingTitle({ ...goldRush, parallelName: "Gold Rush Gold Refractor", cardNumber: "GR-5" }).title,
    ).toBe("2023 Topps Gold Rush Elly De La Cruz #GR-5 AUTO Gold Refractor Toronto Blue Jays");
  });

  test("the little words of a repeated name go with it: no lone \"&\" or \"of the\"", () => {
    // Before: "... Aaron Judge #1 & Orange Refractor SP".
    expect(
      assessListingTitle({
        ...chrome,
        insertName: "Black & White Autographs",
        parallelName: "Black & White Autographs Orange Refractor",
        playerNames: ["Aaron Judge"],
        shortPrint: "SP",
      }).title,
    ).toBe("2023 Topps Chrome Black & White Autographs Aaron Judge #1 Orange Refractor SP");
    // Before: "... Ohtani #250 RELIC of the Silver Prizm /99".
    expect(
      assessListingTitle({
        ...chrome,
        manufacturer: "Bowman",
        setName: "Bowman Chrome",
        cardNumber: "250",
        insertName: "Stars of the Game",
        parallelName: "Stars of the Game Silver Prizm",
        playerNames: ["Ohtani"],
        isRelic: true,
        printRun: 99,
      }).title,
    ).toBe("2023 Bowman Chrome Stars of the Game Ohtani #250 RELIC Silver Prizm /99 Baseball");
  });
});
