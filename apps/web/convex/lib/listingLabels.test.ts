/**
 * NEO-370 — the Sync status tab's set and card labels: NB's own words only,
 * matching the collection screens.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { brandedSetLabel, cardLabelOf, ListingLabels, setAndVariantLabel, shownBrandName } from "./listingLabels";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("../**/*.*s");

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

describe("NEO-464 — a set named with its brand, as its cards' listing titles name it", () => {
  const set = (name: string, brand: string | null, season = "1993") => ({
    season,
    name,
    manufacturer: brand === null ? null : { _id: "m" as never, name: brand },
  });

  test("brandedSetLabel puts the brand before a name that does not lead with it", () => {
    expect(brandedSetLabel(set("Finest", "Topps"))).toBe("1993 Topps Finest");
    expect(brandedSetLabel(set("Topps Chrome", "Topps", "2024"))).toBe("2024 Topps Chrome");
    expect(brandedSetLabel(set("Finest", null))).toBe("1993 Finest");
    expect(brandedSetLabel(set("Finest", "Topps", ""))).toBe("Topps Finest");
  });

  test("setAndVariantLabel takes the brand when given and is unchanged without it", () => {
    expect(setAndVariantLabel(parts({ season: "1993", setName: "Finest", brand: "Topps", typeKind: "base" }))).toBe(
      "1993 Topps Finest",
    );
    expect(
      setAndVariantLabel(parts({ season: "1993", setName: "Finest", brand: "Topps", level: "parallel", name: "Refractor" })),
    ).toBe("1993 Topps Finest Refractor");
    expect(setAndVariantLabel(parts({ brand: "Playoff", typeKind: "base" }))).toBe("1996 Playoff Contenders");
    expect(setAndVariantLabel(parts({ season: "1993", setName: "Finest", brand: null, typeKind: "base" }))).toBe(
      "1993 Finest",
    );
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

describe("NEO-527 — the year's brand-unknown row is never in a label", () => {
  // Named "Unknown" here, but only the flag may decide: the operator can rename it.
  const unknown = (name: string, season = "2026") => ({
    season,
    name,
    manufacturer: { _id: "m" as never, name: "Unknown" },
    manufacturerBrandUnknown: true as const,
  });

  test("brandedSetLabel names the set alone under the brand-unknown row", () => {
    expect(brandedSetLabel(unknown("Bowman"))).toBe("2026 Bowman");
    expect(brandedSetLabel(unknown("Starline Long John Silver", "1990"))).toBe("1990 Starline Long John Silver");
  });

  test("the flag decides, never the name: a real brand called Unknown is still named", () => {
    expect(brandedSetLabel({ season: "2026", name: "Bowman", manufacturer: { _id: "m" as never, name: "Unknown" } })).toBe(
      "2026 Unknown Bowman",
    );
    expect(brandedSetLabel({ ...unknown("Bowman"), manufacturer: { _id: "m" as never, name: "Zzz Unsorted" } })).toBe(
      "2026 Bowman",
    );
  });

  test("shownBrandName is null for the brand-unknown row and the name otherwise", () => {
    expect(shownBrandName(unknown("Bowman"))).toBeNull();
    expect(shownBrandName({ manufacturer: { _id: "m" as never, name: "Topps" } })).toBe("Topps");
    expect(shownBrandName({ manufacturer: null })).toBeNull();
  });

  test("ListingLabels with brand: true names the set and variant without it, a real brand with it", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const row = (level: string, value: string, parentId?: Id<"selectorOptions">, extra: Record<string, unknown> = {}) =>
        ctx.db.insert("selectorOptions", {
          level,
          value,
          platformData: {},
          isCustom: false,
          children: [],
          ...(parentId ? { parentId } : {}),
          lastUpdated: 1,
          ...extra,
        } as never);
      const sport = await row("sport", "Baseball");
      const year = await row("year", "2026", sport);
      const flagged = await row("manufacturer", "Unknown", year, { metadata: { isBrandUnknown: true } });
      const set = await row("setName", "Bowman Chrome", flagged);
      const base = await row("variantType", "Base", set);
      const parallels = await row("variantType", "Parallels", set);
      const refractor = await row("insert", "Refractor", parallels);
      const topps = await row("manufacturer", "Topps", year);
      const finest = await row("setName", "Finest", topps);
      const finestBase = await row("variantType", "Base", finest);
      return { base, refractor, set, finestBase };
    });
    const labels = await t.run(async (ctx) => {
      const branded = new ListingLabels(ctx, { brand: true });
      return [
        await branded.setLabel(ids.base),
        await branded.setLabel(ids.refractor),
        await branded.setLabel(ids.set),
        await branded.setLabel(ids.finestBase),
      ];
    });
    expect(labels).toEqual(["2026 Bowman Chrome", "2026 Bowman Chrome Refractor", "2026 Bowman Chrome", "2026 Topps Finest"]);
    for (const label of labels) expect(label).not.toMatch(/unknown/i);
  });
});
