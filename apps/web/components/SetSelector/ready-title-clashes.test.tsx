/**
 * NEO-325 — `readyTitleClashes` / `titleClashMessage`: Save is blocked while
 * two NeonBinder sets would be saved under one parent with the same title.
 *
 * `.test.tsx` although nothing renders: the `components` vitest project
 * collects only `.test.tsx`.
 */

import { describe, expect, it } from "vitest";
import {
  readyTitleClashes,
  titleClashMessage,
  RENAME_TIP,
  TITLE_CLASH_ROW_LINE,
  titleClashSignature,
  type ClashExistingRow,
  type ClashReadySet,
} from "./ready-title-clashes";

const set = (
  key: string,
  title: string,
  over: Partial<ClashReadySet> = {},
): ClashReadySet => ({ key, title, bsc: [], sl: [], ...over });

const row = (
  name: string,
  over: Partial<ClashExistingRow> = {},
): ClashExistingRow => ({ name, bsc: [], sportlots: [], ...over });

const sl = (id: string) => ({ platformValue: id });

describe("readyTitleClashes — Ready sets against each other", () => {
  it("two sets with one title clash, listing both keys in Ready order", () => {
    const out = readyTitleClashes([set("a", "Anime"), set("b", "Anime")]);
    expect(out).toEqual([
      { key: "anime", title: "Anime", readyKeys: ["a", "b"], existingCount: 0 },
    ]);
  });

  it("the fold ignores case and surrounding spaces", () => {
    const out = readyTitleClashes([set("a", "Anime"), set("b", "  anime ")]);
    expect(out).toHaveLength(1);
    expect(out[0].readyKeys).toEqual(["a", "b"]);
  });

  it("N sets share ONE clash, not N-1", () => {
    const out = readyTitleClashes([
      set("a", "Anime"),
      set("b", "Anime"),
      set("c", "Anime"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].readyKeys).toEqual(["a", "b", "c"]);
  });

  it("distinct titles do not clash", () => {
    expect(readyTitleClashes([set("a", "Anime"), set("b", "Anime Gold")])).toEqual([]);
  });

  it("two separate shared titles are two clashes", () => {
    const out = readyTitleClashes([
      set("a", "Anime"),
      set("b", "Anime"),
      set("c", "Gold"),
      set("d", "Gold"),
    ]);
    expect(out.map((c) => c.key)).toEqual(["anime", "gold"]);
  });

  it("no sets, no clashes", () => {
    expect(readyTitleClashes([])).toEqual([]);
  });
});

describe("readyTitleClashes — drafts the operator is still typing", () => {
  it("a draft that resolves a clash clears it before the field is left", () => {
    const ready = [set("a", "Anime"), set("b", "Anime")];
    expect(readyTitleClashes(ready, new Map([["b", "Anime Gold"]]))).toEqual([]);
  });

  it("a draft that creates a clash raises it at once", () => {
    const ready = [set("a", "Anime"), set("b", "Gold")];
    const out = readyTitleClashes(ready, new Map([["b", "Anime"]]));
    expect(out).toHaveLength(1);
    expect(out[0].readyKeys).toEqual(["a", "b"]);
  });

  it("an empty or blank draft does not count: the committed title still speaks", () => {
    const ready = [set("a", "Anime"), set("b", "Anime")];
    expect(readyTitleClashes(ready, new Map([["b", ""]]))).toHaveLength(1);
    expect(readyTitleClashes(ready, new Map([["b", "   "]]))).toHaveLength(1);
  });

  it("a draft for a key that is not Ready is ignored", () => {
    const ready = [set("a", "Anime")];
    expect(readyTitleClashes(ready, new Map([["zzz", "Anime"]]))).toEqual([]);
  });
});

describe("readyTitleClashes — rows already saved under the parent", () => {
  it("a Ready set made with Make its own set clashes with a saved same-named row that holds other ids", () => {
    const out = readyTitleClashes(
      [set("a", "Anime", { ownSet: true, sl: [sl("2")] })],
      new Map(),
      [row("Anime", { sportlots: ["1"] })],
    );
    expect(out).toEqual([
      { key: "anime", title: "Anime", readyKeys: ["a"], existingCount: 1 },
    ]);
  });

  it("a Ready set that shares an id with the saved row IS that row: no clash", () => {
    const out = readyTitleClashes(
      [set("a", "Anime", { ownSet: true, sl: [sl("1")] })],
      new Map(),
      [row("Anime", { sportlots: ["1"] })],
    );
    expect(out).toEqual([]);
  });

  it("a Ready set that is not an own set links onto a saved same-named row with NO ids: no clash", () => {
    const out = readyTitleClashes([set("a", "Anime", { sl: [sl("2")] })], new Map(), [
      row("Anime"),
    ]);
    expect(out).toEqual([]);
  });

  it("an own set DOES clash with a saved id-less same-named row (identity only never matches by name)", () => {
    const out = readyTitleClashes(
      [set("a", "Anime", { ownSet: true, sl: [sl("2")] })],
      new Map(),
      [row("Anime")],
    );
    expect(out).toHaveLength(1);
    expect(out[0].existingCount).toBe(1);
  });

  it("a saved row that holds other ids and is matched by name only is withheld: a clash", () => {
    const out = readyTitleClashes([set("a", "Anime", { sl: [sl("2")] })], new Map(), [
      row("Anime", { sportlots: ["1"] }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("a seeded row whose Ready set still exists is spoken for by that set's live title, not counted again", () => {
    const out = readyTitleClashes(
      [set("seed", "Anime Renamed", { sl: [sl("1")] })],
      new Map(),
      [row("Anime", { sportlots: ["1"], seededKey: "seed" })],
    );
    expect(out).toEqual([]);
  });

  it("a seeded row renamed in Ready no longer holds its old name: a new Ready set may take it", () => {
    const out = readyTitleClashes(
      [
        set("seed", "Gold", { sl: [sl("1")] }),
        set("b", "Anime", { ownSet: true, sl: [sl("2")] }),
      ],
      new Map(),
      [row("Anime", { sportlots: ["1"], seededKey: "seed" })],
    );
    expect(out).toEqual([]);
  });

  it("a seeded row whose Ready set was removed stands under its saved name", () => {
    const out = readyTitleClashes(
      [set("b", "Anime", { ownSet: true, sl: [sl("2")] })],
      new Map(),
      [row("Anime", { sportlots: ["1"], seededKey: "gone" })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].existingCount).toBe(1);
  });

  it("two Ready sets and a saved namesake count the saved row once", () => {
    const out = readyTitleClashes(
      [
        set("a", "Anime", { ownSet: true, sl: [sl("2")] }),
        set("b", "Anime", { ownSet: true, sl: [sl("3")] }),
      ],
      new Map(),
      [row("Anime", { sportlots: ["1"] })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].readyKeys).toEqual(["a", "b"]);
    expect(out[0].existingCount).toBe(1);
  });

  it("a saved row one of the Ready sets matches by id is not double-counted", () => {
    const out = readyTitleClashes(
      [
        set("a", "Anime", { ownSet: true, sl: [sl("1")] }),
        set("b", "Anime", { ownSet: true, sl: [sl("3")] }),
      ],
      new Map(),
      [row("Anime", { sportlots: ["1"] })],
    );
    expect(out[0].existingCount).toBe(0);
  });
});

describe("titleClashSignature", () => {
  it("is empty with no clashes and changes when the clash changes", () => {
    expect(titleClashSignature([])).toBe("");
    const two = readyTitleClashes([set("a", "Anime"), set("b", "Anime")]);
    const three = readyTitleClashes([
      set("a", "Anime"),
      set("b", "Anime"),
      set("c", "Anime"),
    ]);
    expect(titleClashSignature(two)).not.toBe("");
    expect(titleClashSignature(two)).not.toBe(titleClashSignature(three));
  });

  it("is stable across calls with the same clashes", () => {
    const mk = () => readyTitleClashes([set("a", "Anime"), set("b", "Anime")]);
    expect(titleClashSignature(mk())).toBe(titleClashSignature(mk()));
  });
});

describe("titleClashMessage", () => {
  it("names the shared title in every shape", () => {
    const two = readyTitleClashes([set("a", "Anime"), set("b", "Anime")])[0];
    const many = readyTitleClashes([
      set("a", "Anime"),
      set("b", "Anime"),
      set("c", "Anime"),
    ])[0];
    const beside = readyTitleClashes(
      [set("a", "Anime", { ownSet: true })],
      new Map(),
      [row("Anime", { sportlots: ["1"] })],
    )[0];
    for (const c of [two, many, beside]) expect(titleClashMessage(c)).toContain("Anime");
  });

  it("the three shapes read differently: two, N, and one beside a saved row", () => {
    const two = readyTitleClashes([set("a", "Anime"), set("b", "Anime")])[0];
    const many = readyTitleClashes([
      set("a", "Anime"),
      set("b", "Anime"),
      set("c", "Anime"),
      set("d", "Anime"),
    ])[0];
    const beside = readyTitleClashes(
      [set("a", "Anime", { ownSet: true })],
      new Map(),
      [row("Anime", { sportlots: ["1"] })],
    )[0];
    const msgs = new Set([titleClashMessage(two), titleClashMessage(many), titleClashMessage(beside)]);
    expect(msgs.size).toBe(3);
  });

  it("the N-set message states the count", () => {
    const many = readyTitleClashes([
      set("a", "Anime"),
      set("b", "Anime"),
      set("c", "Anime"),
      set("d", "Anime"),
    ])[0];
    expect(titleClashMessage(many)).toContain("4");
  });

  it("a Ready set plus saved rows counts both toward the total", () => {
    const c = readyTitleClashes(
      [set("a", "Anime", { ownSet: true }), set("b", "Anime", { ownSet: true })],
      new Map(),
      [row("Anime", { sportlots: ["1"] })],
    )[0];
    expect(titleClashMessage(c)).toContain("3");
  });
});

describe("titleClashMessage — curly quotes and where the clash is (NEO-325)", () => {
  const beside = () =>
    readyTitleClashes(
      [set("a", "Anime", { ownSet: true })],
      new Map(),
      [row("Anime", { sportlots: ["1"] })],
    )[0];
  const two = () => readyTitleClashes([set("a", "Anime"), set("b", "Anime")])[0];
  const many = () =>
    readyTitleClashes([set("a", "Anime"), set("b", "Anime"), set("c", "Anime")])[0];

  it("quotes the name with curly quotes in every shape, and never with straight ones", () => {
    for (const c of [two(), many(), beside()]) {
      const text = titleClashMessage(c, "2024 Topps Chrome › Inserts");
      expect(text).toContain("\u201cAnime\u201d");
      expect(text).not.toContain("'Anime'");
      expect(text).not.toContain('"Anime"');
    }
  });

  it("a clash beside a saved set names where, when the caller says where", () => {
    const text = titleClashMessage(beside(), "2024 Topps Chrome › Inserts");
    expect(text).toContain("under 2024 Topps Chrome › Inserts");
    expect(text).not.toBe(titleClashMessage(beside()));
  });

  it("without a place it says 'here', and a blank place counts as none", () => {
    expect(titleClashMessage(beside())).toContain("” here.");
    expect(titleClashMessage(beside(), "")).toBe(titleClashMessage(beside()));
  });

  it("the place is for the saved-set sentence only: two Ready sets and N sets do not mention it", () => {
    for (const c of [two(), many()]) {
      expect(titleClashMessage(c, "2024 Topps Chrome › Inserts")).toBe(titleClashMessage(c));
    }
  });

  it("the row line and the tip are stable, non-empty draft strings", () => {
    expect(TITLE_CLASH_ROW_LINE.length).toBeGreaterThan(0);
    expect(RENAME_TIP).toMatch(/^Tip: /);
    expect(RENAME_TIP).toContain("\u201c");
  });
});
