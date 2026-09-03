import { describe, expect, test } from "vitest";
import {
  assessListingTitle,
  generateListingTitle,
  generateListingDescription,
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
    expect(title).toBe("2024 Topps Chrome Elly De La Cruz #50 RC");
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

  test("optional tokens dropped once the 80-char budget is exhausted, card number never dropped", () => {
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
    // The card number is the least negotiable token — must always survive,
    // even when the descriptive prefix has to be truncated to fit.
    expect(title.endsWith("#1")).toBe(true);
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

  test("hard cap truncates the descriptive prefix (never the card number) when even the core overflows 80 chars", () => {
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
    expect(title).toBe(
      "2024 Topps Chrome An Absurdly Long Player Full Name That Alone Exceeds #99999",
    );
    expect(title.endsWith("#99999")).toBe(true);
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
      title: "2024 Topps Chrome Elly De La Cruz #50 RC",
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
    // cardVariation -> RC -> SP/SSP. This is NOT the old order (which led with
    // parallel and trailed with /printRun), so this test is the record of the
    // decision as much as it is a check.
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
    });
    expect(title).toBe("2024 A Player #1 AUTO RELIC Gold /25 Action RC SSP");
    expect(dropped).toEqual([]);
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
    expect(title).toBe("2024 Topps Chrome Elly De La Cruz #50 RC SP");
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
    const { title, coreFits } = assessListingTitle({
      cardNumber: "1",
      playerNames: ["X".repeat(120)],
    });
    expect(coreFits).toBe(false);
    expect(title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    expect(title.endsWith(" #1")).toBe(true);
  });

  test("the hard-slice fallback never leaves an orphaned surrogate half", () => {
    // Astral characters (emoji, and plenty of real scripts) are TWO UTF-16
    // code units, and the fallback slice measures in code units — so the cut
    // can land between the halves. A lone high surrogate is not a character:
    // it renders as a replacement glyph and is not encodable as valid UTF-8
    // once a marketplace adapter serialises the title.
    const unbroken = "\u{1F600}".repeat(60); // 120 code units, zero spaces
    const { title, coreFits } = assessListingTitle({
      cardNumber: "1",
      playerNames: [unbroken],
    });

    expect(coreFits).toBe(false);
    expect(title.length).toBeLessThanOrEqual(LISTING_TITLE_MAX);
    expect(title.endsWith(" #1")).toBe(true);
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

  test("for any inputs: <= 80 chars, and the card number is present and never cut", () => {
    const rand = mulberry32(20260902);
    const pick = <T,>(list: T[]): T => list[Math.floor(rand() * list.length)];
    const words = (n: number) =>
      Array.from({ length: n }, () => pick(WORDS)).join(" ");

    for (let i = 0; i < 2000; i++) {
      // Card numbers stay within real-world shape (BSC/SportLots numbers are a
      // handful of characters; sku.ts already caps its own copy at 10). The
      // guarantee is "the number is never the thing that gets cut", which is
      // only expressible while `#<number>` itself fits inside the cap.
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
      };

      const { title, coreFits, dropped } = assessListingTitle(inputs);
      const context = JSON.stringify(inputs);

      expect(title.length, context).toBeLessThanOrEqual(LISTING_TITLE_MAX);
      expect(title, context).not.toContain("…");
      // The card number is present, and it is the end of the title or is
      // followed only by optional tokens.
      const marker = `#${cardNumber}`;
      expect(title.endsWith(marker) || title.includes(`${marker} `), context).toBe(
        true,
      );
      // A dropped token really would not have fitted. Tokens are only ever
      // appended after a drop, so the final title is at least as long as the
      // one the token was measured against — if it does not fit now, it did
      // not fit then either.
      for (const token of dropped) {
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

  test("autographed None does not add an autograph sentence", () => {
    const desc = generateListingDescription({
      cardNumber: "1",
      autographed: "None",
    });
    expect(desc).not.toContain("Autographed");
  });
});
