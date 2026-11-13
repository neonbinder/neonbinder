/**
 * NEO-527 (Jason, 2026-11-12: "a user should never see unknown outside of the
 * admin screen") — the Checklists drill never lists the year's brand-unknown
 * row. The server lists the sets beneath it straight in the year's brand
 * column, each carrying the row's id (`brandId`); picking one picks that row
 * and the set at once, so the drill skips the Sets column and goes on to the
 * set's variant types. A shared link that names the set reopens the same
 * view, and a year whose only brand is that row calls the column "Sets".
 *
 * The store is a stub (no Convex, no network): the catalog below.
 *
 *   Baseball
 *   └ 1990: Topps (brand) → Topps Traded (set)
 *           [brand-unknown row "unk"] → Starline Long John Silver, Classic
 *   └ 1989: [brand-unknown row "unk89" only] → Pacific Legends
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { CollectionStoreContext } from "../data/store";
import type { DrillItem, DrillLevel, DrillParents, SetPath } from "../data/types";
import Cascade from "./Cascade";
import {
  brandColumnPick,
  brandColumnPickTitle,
  brandColumnTitle,
  brandFieldLabel,
  EMPTY_DRILL,
  pickInBrandColumn,
  splitBrandColumn,
  type Drill,
} from "./drill";
import { useDrillState } from "./useDrillState";

const item = (id: string, level: DrillLevel, name: string, extra: Partial<DrillItem> = {}): DrillItem => ({
  id,
  level,
  name,
  hasChildren: true,
  ...extra,
});

const STARLINE = item("set9", "set", "Starline Long John Silver", { brandId: "unk" });
const CLASSIC = item("set10", "set", "Classic", { brandId: "unk" });
const PACIFIC = item("set20", "set", "Pacific Legends", { brandId: "unk89" });

const COLUMNS: Record<string, DrillItem[]> = {
  "sport|": [item("s1", "sport", "Baseball")],
  "year|s1": [item("y1990", "year", "1990"), item("y1989", "year", "1989"), item("y1988", "year", "1988")],
  "brand|y1990": [CLASSIC, STARLINE, item("m-topps", "brand", "Topps")],
  "brand|y1989": [PACIFIC],
  "brand|y1988": [item("m-fleer", "brand", "Fleer")],
  "set|m-topps": [item("set1", "set", "Topps Traded")],
  "set|unk": [item("set10", "set", "Classic"), item("set9", "set", "Starline Long John Silver")],
  "variantType|set9": [item("vt9", "variantType", "Base", { kind: "base", variantId: "vt9", hasChildren: false })],
  "variantType|set20": [item("vt20", "variantType", "Base", { kind: "base", variantId: "vt20", hasChildren: false })],
  "variantType|set1": [item("vt1", "variantType", "Base", { kind: "base", variantId: "vt1", hasChildren: false })],
};

const PARENT_OF: Partial<Record<DrillLevel, DrillLevel>> = {
  year: "sport",
  brand: "year",
  set: "brand",
  variantType: "set",
  variant: "variantType",
  subVariant: "variant",
};

const PATHS: Record<string, SetPath> = {
  set9: {
    sport: { id: "s1", name: "Baseball" },
    year: { id: "y1990", name: "1990" },
    brand: { id: "unk", name: "" },
    set: { id: "set9", name: "Starline Long John Silver" },
  },
  set20: {
    sport: { id: "s1", name: "Baseball" },
    year: { id: "y1989", name: "1989" },
    brand: { id: "unk89", name: "" },
    set: { id: "set20", name: "Pacific Legends" },
  },
  set1: {
    sport: { id: "s1", name: "Baseball" },
    year: { id: "y1990", name: "1990" },
    brand: { id: "m-topps", name: "Topps" },
    set: { id: "set1", name: "Topps Traded" },
  },
};

/** True to hold the brand column loading, as a slow read would. */
let brandsLoading = false;

const STUB = {
  kind: "convex",
  data: {
    useDrill(level: DrillLevel | null, parents: DrillParents) {
      if (!level) return undefined;
      if (level === "brand" && brandsLoading) return undefined;
      const parent = PARENT_OF[level];
      return COLUMNS[`${level}|${parent ? (parents[parent] ?? "") : ""}`] ?? [];
    },
    useSetPath(setId: string | null) {
      return setId ? (PATHS[setId] ?? null) : null;
    },
  },
} as never;

function Harness({ start }: { start: Drill }) {
  const [drill, setDrill] = useState<Drill>(start);
  const state = useDrillState(drill);
  return (
    <>
      <Cascade state={state} onDrill={setDrill} label="Sport, year, brand and set" onReachedChecklist={() => true} />
      <output aria-label="Drill">{JSON.stringify(state.drill)}</output>
      <output aria-label="Title">{state.title ?? ""}</output>
    </>
  );
}

function renderDrill(start: Drill) {
  render(
    <CollectionStoreContext.Provider value={STUB}>
      <Harness start={start} />
    </CollectionStoreContext.Provider>,
  );
}

const drillNow = () => JSON.parse(screen.getByLabelText("Drill").textContent ?? "{}") as Drill;
const optionNames = (listbox: string) =>
  Array.from(screen.getByRole("listbox", { name: listbox }).querySelectorAll('[role="option"]')).map(
    (o) => o.textContent?.trim() ?? "",
  );

afterEach(() => {
  cleanup();
  brandsLoading = false;
});

describe("brand column helpers", () => {
  it("pickInBrandColumn picks the unseen brand row and the set together; a brand alone otherwise", () => {
    const at = { ...EMPTY_DRILL, sport: "s1", year: "y1990", type: "old" };
    expect(pickInBrandColumn(at, STARLINE)).toEqual({ ...EMPTY_DRILL, sport: "s1", year: "y1990", brand: "unk", set: "set9" });
    expect(pickInBrandColumn(at, { id: "m-topps" })).toEqual({ ...EMPTY_DRILL, sport: "s1", year: "y1990", brand: "m-topps" });
  });

  it("brandColumnPick finds the brand row, or the set standing in for the brand-unknown row", () => {
    const column = COLUMNS["brand|y1990"];
    expect(brandColumnPick(column, "m-topps", null)?.id).toBe("m-topps");
    expect(brandColumnPick(column, "unk", "set9")?.id).toBe("set9");
    expect(brandColumnPick(column, "unk", null)).toBeUndefined();
    expect(brandColumnPick(column, "unk", "set1")).toBeUndefined();
    expect(brandColumnPick(column, null, "set9")).toBeUndefined();
  });

  it("brandColumnTitle says what the column holds: Brands, Sets, or Brands and sets", () => {
    expect(brandColumnTitle([item("m-topps", "brand", "Topps")])).toBe("Brands");
    expect(brandColumnTitle(COLUMNS["brand|y1990"])).toBe("Brands and sets");
    expect(brandColumnTitle(COLUMNS["brand|y1989"])).toBe("Sets");
    expect(brandColumnTitle([])).toBe("Brands");
    // Still loading, it could be either: never a promise of brands.
    expect(brandColumnTitle(undefined)).toBe("Brands and sets");
  });

  it("brandFieldLabel is the singular of the same rule", () => {
    expect(brandFieldLabel([item("m-topps", "brand", "Topps")])).toBe("Brand");
    expect(brandFieldLabel(COLUMNS["brand|y1990"])).toBe("Brand or set");
    expect(brandFieldLabel(COLUMNS["brand|y1989"])).toBe("Set");
    expect(brandFieldLabel([])).toBe("Brand");
  });

  it("brandColumnPickTitle names a picked row by what it is", () => {
    expect(brandColumnPickTitle(STARLINE)).toBe("Sets");
    expect(brandColumnPickTitle(item("m-topps", "brand", "Topps"))).toBe("Brands");
  });

  it("splitBrandColumn puts the brands first and the loose sets after; a Sets-only column has no tail", () => {
    const split = splitBrandColumn(COLUMNS["brand|y1990"]);
    expect(split.main.map((i) => i.name)).toEqual(["Topps"]);
    expect(split.more.map((i) => i.name)).toEqual(["Classic", "Starline Long John Silver"]);
    expect(splitBrandColumn(COLUMNS["brand|y1989"])).toEqual({ main: [PACIFIC], more: [] });
  });
});

describe("the Checklists drill with a brand-unknown row", () => {
  it("lists the real brands first, then the row's sets under More sets; picking one goes straight to its variant types", () => {
    renderDrill({ ...EMPTY_DRILL, sport: "s1", year: "y1990" });
    expect(optionNames("Brands and sets")).toEqual(["Topps", "Classic", "Starline Long John Silver"]);
    const more = screen.getByRole("group", { name: "More sets" });
    expect(Array.from(more.querySelectorAll('[role="option"]')).map((o) => o.textContent)).toEqual([
      "Classic",
      "Starline Long John Silver",
    ]);
    expect(screen.getByRole("combobox", { name: "Search brands and sets" })).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: /Starline Long John Silver/ }));

    expect(drillNow()).toEqual({ ...EMPTY_DRILL, sport: "s1", year: "y1990", brand: "unk", set: "set9" });
    // The summary card names what was picked: a set, not a brand.
    expect(screen.getByRole("button", { name: "Sets: Starline Long John Silver, change" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Sets" })).toBeNull();
    expect(optionNames("Variant Types")).toEqual(["Base"]);
    expect(screen.getByLabelText("Title").textContent).toBe("1990 Starline Long John Silver");
  });

  it("a real brand still opens its own Sets column, and its card says Brands", () => {
    renderDrill({ ...EMPTY_DRILL, sport: "s1", year: "y1990" });
    fireEvent.click(screen.getByRole("option", { name: /Topps/ }));
    expect(drillNow()).toEqual({ ...EMPTY_DRILL, sport: "s1", year: "y1990", brand: "m-topps" });
    expect(screen.getByRole("button", { name: "Brands: Topps, change" })).toBeTruthy();
    expect(optionNames("Sets")).toEqual(["Topps Traded"]);
  });

  it("the keyboard walks the brands, then the loose sets, never stopping on the divider", () => {
    renderDrill({ ...EMPTY_DRILL, sport: "s1", year: "y1990" });
    const box = screen.getByRole("combobox", { name: "Search brands and sets" });
    const highlighted = () => {
      const id = box.getAttribute("aria-activedescendant");
      return id ? document.getElementById(id)?.textContent : null;
    };
    expect(highlighted()).toBe("Topps");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(highlighted()).toBe("Classic");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(highlighted()).toBe("Starline Long John Silver");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(drillNow()).toMatchObject({ brand: "unk", set: "set9" });
  });

  it("while the brand column loads, the loading line promises neither brands nor sets alone", () => {
    brandsLoading = true;
    renderDrill({ ...EMPTY_DRILL, sport: "s1", year: "y1990" });
    const said = screen.getAllByRole("status").map((n) => n.textContent);
    expect(said).toContain("Loading brands and sets…");
    expect(said).not.toContain("Loading brands…");
  });

  it("a year of brands only keeps its Brands column, with no divider", () => {
    renderDrill({ ...EMPTY_DRILL, sport: "s1", year: "y1988" });
    expect(optionNames("Brands")).toEqual(["Fleer"]);
    expect(screen.queryByRole("group", { name: "More sets" })).toBeNull();
  });

  it("a link naming only the set reopens the same view", () => {
    renderDrill({ ...EMPTY_DRILL, set: "set9" });
    expect(drillNow()).toMatchObject({ sport: "s1", year: "y1990", brand: "unk", set: "set9" });
    expect(screen.getByRole("button", { name: "Sets: Starline Long John Silver, change" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Sets" })).toBeNull();
    expect(optionNames("Variant Types")).toEqual(["Base"]);
  });

  it("while the brand column loads, a link to a set draws no Sets column that would vanish", () => {
    brandsLoading = true;
    renderDrill({ ...EMPTY_DRILL, set: "set9" });
    expect(screen.queryByRole("listbox", { name: "Sets" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Sets:/ })).toBeNull();
    expect(drillNow()).toMatchObject({ brand: "unk", set: "set9" });
  });

  it("a year whose only brand is the brand-unknown row calls its column Sets", () => {
    renderDrill({ ...EMPTY_DRILL, sport: "s1", year: "y1989" });
    expect(optionNames("Sets")).toEqual(["Pacific Legends"]);
    expect(screen.queryByRole("listbox", { name: "Brands" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Pacific Legends/ }));
    expect(drillNow()).toEqual({ ...EMPTY_DRILL, sport: "s1", year: "y1989", brand: "unk89", set: "set20" });
    expect(screen.getByRole("button", { name: "Sets: Pacific Legends, change" })).toBeTruthy();
  });

  it("a drill left on the brand-unknown row without a set stops at the year, quietly", () => {
    renderDrill({ ...EMPTY_DRILL, sport: "s1", year: "y1990", brand: "unk" });
    expect(drillNow()).toEqual({ ...EMPTY_DRILL, sport: "s1", year: "y1990" });
    expect(optionNames("Brands and sets")).toHaveLength(3);
  });
});
