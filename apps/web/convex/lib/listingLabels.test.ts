/**
 * NEO-370 — the Sync status tab's set and card labels: NB's own words only,
 * matching the collection screens.
 */

import { describe, expect, test } from "vitest";
import { cardLabelOf, setAndVariantLabel } from "./listingLabels";

const parts = (extra: Partial<Parameters<typeof setAndVariantLabel>[0]>) => ({
  season: "1996",
  setName: "Playoff Contenders",
  level: "variantType",
  typeKind: null,
  name: "",
  insertName: null,
  ...extra,
});

describe("setAndVariantLabel", () => {
  test("a Base type reads as the set alone", () => {
    expect(setAndVariantLabel(parts({ typeKind: "base", name: "Base" }))).toBe("1996 Playoff Contenders");
  });

  test("any other variant type reads as the set and its name; a nameless one as the set", () => {
    expect(setAndVariantLabel(parts({ typeKind: "insert", name: "Inserts" }))).toBe("1996 Playoff Contenders Inserts");
    expect(setAndVariantLabel(parts({ typeKind: null, name: "" }))).toBe("1996 Playoff Contenders");
  });

  test("an insert or a parallel reads as the set and its own name", () => {
    expect(setAndVariantLabel(parts({ level: "insert", name: "Pennant Flyers" }))).toBe(
      "1996 Playoff Contenders Pennant Flyers",
    );
    expect(setAndVariantLabel(parts({ level: "parallel", name: "Gold" }))).toBe("1996 Playoff Contenders Gold");
  });

  test("a parallel under an insert puts the insert's name first", () => {
    expect(setAndVariantLabel(parts({ level: "parallel", name: "Foil", insertName: "Pennant Flyers" }))).toBe(
      "1996 Playoff Contenders Pennant Flyers Foil",
    );
  });

  test("a missing season does not leave a leading space", () => {
    expect(setAndVariantLabel(parts({ season: "", typeKind: "base" }))).toBe("Playoff Contenders");
  });
});

describe("cardLabelOf", () => {
  test("players joined with a slash, blanks dropped", () => {
    expect(cardLabelOf(["Dwight Gooden", " ", "Darryl Strawberry"], "Mets Aces")).toBe(
      "Dwight Gooden / Darryl Strawberry",
    );
  });

  test("no player: the card's own NB name; nothing at all: undefined", () => {
    expect(cardLabelOf([], " Team Checklist ")).toBe("Team Checklist");
    expect(cardLabelOf([], "  ")).toBeUndefined();
  });
});
