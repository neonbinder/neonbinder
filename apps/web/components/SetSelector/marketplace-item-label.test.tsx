/**
 * NEO-325 — the words a marketplace item is called on screen. Pure helpers;
 * this file is .tsx only because vitest.include.mjs collects component-root
 * tests by that extension (a .test.ts under components/ is collected by
 * nothing).
 */

import { describe, expect, it } from "vitest";
import {
  duplicateNames,
  itemLabel,
  itemLabelParts,
  nameKey,
  sharedTitleLabels,
  sideNamedIdsText,
} from "./marketplace-item-label";
import { twinLeftIdsText } from "./selector-sync-feedback";

const item = (value: string, platformValue: string) => ({ value, platformValue });

describe("nameKey", () => {
  it("case-folds and trims", () => {
    expect(nameKey("  Anime ")).toBe("anime");
    expect(nameKey("ANIME")).toBe(nameKey("anime"));
  });
});

describe("duplicateNames", () => {
  it("returns the names two distinct ids share, and nothing for unique names", () => {
    const dups = duplicateNames([
      item("Anime", "111"),
      item("Anime", "222"),
      item("Solo", "333"),
    ]);

    expect([...dups]).toEqual(["anime"]);
  });

  it("matches names regardless of case and surrounding space", () => {
    const dups = duplicateNames([item("Anime", "1"), item(" anime ", "2")]);

    expect(dups.has("anime")).toBe(true);
  });

  it("counts an id once: the same set listed twice is not a twin of itself", () => {
    // A marketplace set mapped by two NB sets appears twice in the full list.
    const dups = duplicateNames([
      item("Anime", "111"),
      item("Anime", "111"),
      item("Solo", "333"),
    ]);

    expect(dups.size).toBe(0);
  });

  it("counts every item that has no id", () => {
    const dups = duplicateNames([{ value: "Anime" }, { value: "Anime" }]);

    expect(dups.has("anime")).toBe(true);
  });

  it("is empty for an empty list", () => {
    expect(duplicateNames([]).size).toBe(0);
  });
});

describe("itemLabelParts / itemLabel", () => {
  const dups = new Set(["anime"]);

  it("suffixes a shared SportLots name with its id", () => {
    expect(itemLabelParts(item("Anime", "222"), "sl", dups)).toEqual({
      name: "Anime",
      suffix: "(#222)",
    });
    expect(itemLabel(item("Anime", "222"), "sl", dups)).toBe("Anime (#222)");
  });

  it("suffixes a shared BSC name with its slug", () => {
    expect(itemLabel(item("Anime", "anime-slug"), "bsc", dups)).toBe(
      "Anime (#anime-slug)",
    );
  });

  it("leaves a unique name exactly as it was", () => {
    expect(itemLabelParts(item("Solo", "333"), "sl", dups)).toEqual({
      name: "Solo",
      suffix: null,
    });
    expect(itemLabel(item("Solo", "333"), "sl", dups)).toBe("Solo");
  });

  it("looks the name up case-insensitively, but keeps the item's own spelling", () => {
    expect(itemLabel(item("ANIME", "9"), "sl", dups)).toBe("ANIME (#9)");
  });

  it("suffixes nothing when no name is shared", () => {
    expect(itemLabel(item("Anime", "1"), "sl", new Set())).toBe("Anime");
  });
});

describe("sideNamedIdsText (NEO-325)", () => {
  it("names each side once, BSC first, joined by a middle dot", () => {
    expect(sideNamedIdsText(["chrome-a"], ["378118"])).toBe("BSC #chrome-a · SportLots #378118");
  });

  it("several ids on one side share one side name", () => {
    expect(sideNamedIdsText([], ["1", "2"])).toBe("SportLots #1, #2");
    expect(sideNamedIdsText(["a", "b"], [])).toBe("BSC #a, #b");
  });

  it("is the same form the twin notice uses, so the two cannot read differently", () => {
    expect(sideNamedIdsText(["x"], ["1", "2"])).toBe(
      twinLeftIdsText({ name: "N", bsc: ["x"], sportlots: ["1", "2"] }),
    );
    expect(sideNamedIdsText([], ["1"])).toBe(twinLeftIdsText({ name: "N", bsc: [], sportlots: ["1"] }));
  });

  it("nothing on either side is nothing", () => {
    expect(sideNamedIdsText([], [])).toBe("");
  });
});

describe("sharedTitleLabels (NEO-325)", () => {
  const set = (
    key: string,
    title: string,
    bsc: string[] = [],
    sl: string[] = [],
  ) => ({
    key,
    title,
    bsc: bsc.map((platformValue) => ({ platformValue })),
    sl: sl.map((platformValue) => ({ platformValue })),
  });

  it("a unique title is its own label", () => {
    const labels = sharedTitleLabels([set("a", "Anime", ["x"]), set("b", "Gold", [], ["1"])]);
    expect(labels.get("a")).toBe("Anime");
    expect(labels.get("b")).toBe("Gold");
  });

  it("twins with ids from ONE marketplace stay bare: the row's chips name the side", () => {
    const labels = sharedTitleLabels([
      set("a", "Anime", [], ["378117"]),
      set("b", "Anime", [], ["378118", "378119"]),
    ]);
    expect(labels.get("a")).toBe("Anime (#378117)");
    expect(labels.get("b")).toBe("Anime (#378118, #378119)");
  });

  it("a set with ids from BOTH marketplaces names each side", () => {
    const labels = sharedTitleLabels([
      set("a", "Chrome Update Sapphire", ["chrome-update-sapphire"], ["378118"]),
      set("b", "Chrome Update Sapphire", [], ["378117"]),
    ]);
    expect(labels.get("a")).toBe(
      `Chrome Update Sapphire (${sideNamedIdsText(["chrome-update-sapphire"], ["378118"])})`,
    );
    expect(labels.get("a")).toContain("BSC #chrome-update-sapphire");
    expect(labels.get("a")).toContain("SportLots #378118");
    // The other twin has one side only, so stays bare.
    expect(labels.get("b")).toBe("Chrome Update Sapphire (#378117)");
  });

  it("the title is trimmed before the ids, and folded case-insensitively to find twins", () => {
    const labels = sharedTitleLabels([
      set("a", "  anime ", [], ["1"]),
      set("b", "Anime", [], ["2"]),
    ]);
    expect(labels.get("a")).toBe("anime (#1)");
    expect(labels.get("b")).toBe("Anime (#2)");
  });

  it("twins with no ids keep their title; twins mapped to the same ids are finished by position", () => {
    const bare = sharedTitleLabels([set("a", "Anime"), set("b", "Anime")]);
    expect(bare.get("a")).toBe("Anime");
    expect(bare.get("b")).toBe("Anime");

    const same = sharedTitleLabels([set("a", "Anime", [], ["1"]), set("b", "Anime", [], ["1"])]);
    expect(same.get("a")).toBe("Anime (#1), 1 of 2");
    expect(same.get("b")).toBe("Anime (#1), 2 of 2");
  });
});
