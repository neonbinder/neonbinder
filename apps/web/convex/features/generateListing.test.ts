import { describe, expect, test } from "vitest";
import { generateListingTitle, generateListingDescription } from "./generateListing";

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
    expect(title).toContain("…");
    expect(title.endsWith("#99999")).toBe(true);
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

  test("autographed None does not add an autograph sentence", () => {
    const desc = generateListingDescription({
      cardNumber: "1",
      autographed: "None",
    });
    expect(desc).not.toContain("Autographed");
  });
});
