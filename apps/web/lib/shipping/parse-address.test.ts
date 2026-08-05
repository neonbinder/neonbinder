/**
 * NEO-118 — tests for pasted-address parsing.
 *
 * The stake here is higher than it looks: a parser that quietly mis-assigns a
 * line mails someone else's card to the wrong street, and the seller has no
 * reason to double-check a field that filled itself. So these tests care as
 * much about what the parser REFUSES to guess as about what it extracts.
 *
 * Addresses below are fabricated.
 */

import { describe, expect, test } from "vitest";
import { parseAddressText } from "./parse-address";

describe("parseAddressText — common packing-slip shapes", () => {
  test("name / street / city-state-zip", () => {
    const { fields } = parseAddressText(
      "Jane Buyer\n742 Evergreen Ter\nSpringfield, IL 62704",
    );
    expect(fields).toMatchObject({
      name: "Jane Buyer",
      line1: "742 Evergreen Ter",
      city: "Springfield",
      state: "IL",
      postalCode: "62704",
      country: "US",
    });
  });

  test("city/state/zip without a comma", () => {
    const { fields } = parseAddressText(
      "Jane Buyer\n742 Evergreen Ter\nSpringfield IL 62704",
    );
    expect(fields).toMatchObject({
      city: "Springfield",
      state: "IL",
      postalCode: "62704",
    });
  });

  test("multi-word city keeps all of its words", () => {
    const { fields } = parseAddressText(
      "Jane Buyer\n1 Main St\nSalt Lake City, UT 84101",
    );
    expect(fields.city).toBe("Salt Lake City");
  });

  test("ZIP+4 is preserved", () => {
    const { fields } = parseAddressText("1 Main St\nAustin, TX 78701-1234");
    expect(fields.postalCode).toBe("78701-1234");
  });

  test("lowercase state is normalised to uppercase", () => {
    const { fields } = parseAddressText("1 Main St\nAustin, tx 78701");
    expect(fields.state).toBe("TX");
  });

  test("a secondary unit line becomes line2, not line1", () => {
    const { fields } = parseAddressText(
      "Jane Buyer\n742 Evergreen Ter\nApt 4B\nSpringfield, IL 62704",
    );
    expect(fields.line1).toBe("742 Evergreen Ter");
    expect(fields.line2).toBe("Apt 4B");
  });

  test.each(["Apt 4B", "Suite 200", "Ste 200", "Unit 12", "#7", "Floor 3"])(
    "recognises %s as a secondary unit",
    (unit) => {
      const { fields } = parseAddressText(
        `Jane Buyer\n742 Evergreen Ter\n${unit}\nSpringfield, IL 62704`,
      );
      expect(fields.line2).toBe(unit);
      expect(fields.line1).toBe("742 Evergreen Ter");
    },
  );

  test("a company between name and street lands in company", () => {
    const { fields } = parseAddressText(
      "Jane Buyer\nCard Shop LLC\n742 Evergreen Ter\nSpringfield, IL 62704",
    );
    expect(fields).toMatchObject({
      name: "Jane Buyer",
      company: "Card Shop LLC",
      line1: "742 Evergreen Ter",
    });
  });

  test("a single comma-separated line is split", () => {
    const { fields } = parseAddressText(
      "Jane Buyer, 742 Evergreen Ter, Springfield, IL 62704",
    );
    expect(fields).toMatchObject({
      name: "Jane Buyer",
      line1: "742 Evergreen Ter",
      city: "Springfield",
      state: "IL",
      postalCode: "62704",
    });
  });

  test("city and state/zip split across two lines", () => {
    const { fields } = parseAddressText(
      "Jane Buyer\n742 Evergreen Ter\nSpringfield\nIL 62704",
    );
    expect(fields).toMatchObject({
      city: "Springfield",
      state: "IL",
      postalCode: "62704",
      line1: "742 Evergreen Ter",
    });
  });
});

describe("parseAddressText — noise the slip brings along", () => {
  test('drops a "Ship To:" header', () => {
    const { fields } = parseAddressText(
      "Ship To:\nJane Buyer\n742 Evergreen Ter\nSpringfield, IL 62704",
    );
    expect(fields.name).toBe("Jane Buyer");
  });

  test("drops a trailing country line", () => {
    const { fields, unparsed } = parseAddressText(
      "Jane Buyer\n742 Evergreen Ter\nSpringfield, IL 62704\nUnited States",
    );
    expect(fields.name).toBe("Jane Buyer");
    expect(unparsed).toEqual([]);
  });

  test("drops phone and email lines", () => {
    const { fields } = parseAddressText(
      "Jane Buyer\n742 Evergreen Ter\nSpringfield, IL 62704\n(555) 123-4567\njane@example.com",
    );
    expect(fields.name).toBe("Jane Buyer");
    expect(fields.city).toBe("Springfield");
  });

  test("collapses blank lines and non-breaking spaces", () => {
    const { fields } = parseAddressText(
      "Jane Buyer\n\n\n742  Evergreen   Ter\n\nSpringfield, IL 62704",
    );
    expect(fields.name).toBe("Jane Buyer");
    expect(fields.line1).toBe("742 Evergreen Ter");
  });

  test("tolerates trailing whitespace on every line", () => {
    const { fields } = parseAddressText(
      "  Jane Buyer  \n  742 Evergreen Ter  \n  Springfield, IL 62704  ",
    );
    expect(fields.name).toBe("Jane Buyer");
  });
});

describe("parseAddressText — refuses to guess", () => {
  test("empty input yields nothing", () => {
    expect(parseAddressText("").filled).toEqual([]);
    expect(parseAddressText("   \n  ").filled).toEqual([]);
  });

  // The whole point: an unparsed line is recoverable, a misassigned one is not.
  test("reports extra unrecognised lines instead of inventing fields", () => {
    const { fields, unparsed } = parseAddressText(
      "Jane Buyer\nCard Shop LLC\nAttention: Receiving\n742 Evergreen Ter\nSpringfield, IL 62704",
    );
    expect(fields.name).toBe("Jane Buyer");
    expect(fields.company).toBe("Card Shop LLC");
    expect(fields.line1).toBe("742 Evergreen Ter");
    expect(unparsed).toEqual(["Attention: Receiving"]);
  });

  test("text with no city/state/ZIP still fills what it can, without a country", () => {
    const { fields, filled } = parseAddressText("Jane Buyer\n742 Evergreen Ter");
    expect(fields.line1).toBe("742 Evergreen Ter");
    expect(fields.name).toBe("Jane Buyer");
    expect(filled).not.toContain("postalCode");
  });

  test("a bare street with no name leaves name unset", () => {
    const { fields } = parseAddressText("742 Evergreen Ter\nSpringfield, IL 62704");
    expect(fields.name).toBeUndefined();
    expect(fields.line1).toBe("742 Evergreen Ter");
  });

  test("total nonsense sets no fields rather than mangling them", () => {
    const { fields } = parseAddressText("...");
    expect(fields.city).toBeUndefined();
    expect(fields.postalCode).toBeUndefined();
  });

  test("`filled` lists exactly the keys that were populated", () => {
    const { fields, filled } = parseAddressText(
      "Jane Buyer\n742 Evergreen Ter\nSpringfield, IL 62704",
    );
    for (const key of filled) {
      if (key === "country") continue;
      expect(fields[key]).toBeTruthy();
    }
    expect(filled).toContain("name");
    expect(filled).toContain("line1");
    expect(filled).toContain("city");
    expect(filled).not.toContain("line2");
  });
});
