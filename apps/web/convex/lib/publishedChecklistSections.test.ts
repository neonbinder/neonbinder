/**
 * NEO-496 — the pure half of `publishedChecklistSections.ts`: the stored
 * section key, the name checks and the byte chunking.
 */
import { describe, expect, test } from "vitest";
import {
  CHUNK_ROW_BYTES,
  MAX_SECTION_KEY,
  MAX_SECTION_NAME,
  checkFileName,
  checkSectionName,
  chunkRowsByBytes,
  hasHiddenNameChars,
  sectionKeyOf,
  storedRowBytes,
} from "./publishedChecklistSections";

describe("sectionKeyOf (a stored format)", () => {
  test.each([
    ["Base", "base"],
    ["  BASE  CARDS ", "base cards"],
    ["Future\tStars\nRed", "future stars red"],
    // NFD é becomes NFC é, so the two spellings are one key.
    ["Café", "café"],
  ])("%j → %j", (name, key) => {
    expect(sectionKeyOf(name)).toBe(key);
  });
});

describe("checkSectionName", () => {
  test("trims and returns the name as written", () => {
    expect(checkSectionName("  Bomb Squad Red Ice ", "Name")).toBe("Bomb Squad Red Ice");
  });
  test.each([
    ["", /blank/],
    ["x".repeat(MAX_SECTION_NAME + 1), /over 120 characters/],
    ["Base\u007f", /control character/],
    ["Base\u0085", /control character/],
  ])("refuses %j", (name, why) => {
    expect(() => checkSectionName(name, "Name")).toThrow(why);
  });
  test("refuses a name whose folded key outgrows the key cap", () => {
    // U+FB2C is a composition exclusion: NFC turns it into three code
    // units, so 120 of them fold to 360.
    const name = "\uFB2C".repeat(MAX_SECTION_NAME);
    expect(sectionKeyOf(name).length).toBeGreaterThan(MAX_SECTION_KEY);
    expect(() => checkSectionName(name, "Name")).toThrow(/too long once folded/);
  });
  test("checkFileName refuses blank, long and control characters", () => {
    expect(checkFileName(" a.pdf ")).toBe("a.pdf");
    expect(() => checkFileName(" ")).toThrow(/blank/);
    expect(() => checkFileName("a".repeat(201))).toThrow(/over 200/);
    expect(() => checkFileName("a\nb")).toThrow(/control character/);
  });

  // Zero-width and bidi format characters print nothing, so a name holding
  // one can show as another ("Base" with a ZWSP, or an RLO flipping a file
  // name's extension). Each range end is pinned, and its neighbours pass.
  const HIDDEN = [
    "\u200b", "\u200c", "\u200d", "\u200e", "\u200f",
    "\u202a", "\u202b", "\u202c", "\u202d", "\u202e",
    "\u2066", "\u2067", "\u2068", "\u2069",
  ];
  test.each(HIDDEN.map((ch) => [ch.codePointAt(0)!.toString(16), ch]))(
    "refuses U+%s in a section, group or file name",
    (_, ch) => {
      expect(hasHiddenNameChars(`Base${ch}`)).toBe(true);
      expect(() => checkSectionName(`Bomb${ch} Squad`, "Section 2's name")).toThrow(
        "Section 2's name has a hidden direction or zero-width character in it.",
      );
      expect(() => checkSectionName(`AUTO${ch}GRAPH`, "The group of section “X”")).toThrow(
        /hidden direction or zero-width character/,
      );
      expect(() => checkFileName(`checklist${ch}fdp.xlsx`)).toThrow(
        "The file name has a hidden direction or zero-width character in it.",
      );
    },
  );
  test("lets the characters either side of those ranges through", () => {
    for (const ch of ["\u200a", "\u2010", "\u2029", "\u202f", "\u2065", "\u206a", "é", "—"]) {
      expect(hasHiddenNameChars(`Base${ch}x`)).toBe(false);
    }
    // U+200A (hair space) and U+202F are whitespace: trimmed and folded, not refused.
    expect(checkSectionName("Bomb\u200aSquad", "Name")).toBe("Bomb\u200aSquad");
    expect(checkFileName("Topps — 2026.pdf")).toBe("Topps — 2026.pdf");
  });
});

describe("chunkRowsByBytes", () => {
  const row = (n: number, pad = 0) => ({
    number: String(n),
    players: ["x".repeat(pad)],
    teams: [] as string[],
  });

  test("nothing in, nothing out; small rows share one chunk", () => {
    expect(chunkRowsByBytes([])).toEqual([]);
    const rows = [row(1), row(2), row(3)];
    expect(chunkRowsByBytes(rows)).toEqual([rows]);
  });

  test("a new chunk starts when the next row would pass the cap, order kept", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, 60_000));
    const size = storedRowBytes(rows[0]);
    const perChunk = Math.floor(CHUNK_ROW_BYTES / size);
    const chunks = chunkRowsByBytes(rows);
    expect(chunks.map((c) => c.length)).toEqual([perChunk, perChunk, 10 - 2 * perChunk]);
    expect(chunks.flat()).toEqual(rows);
    for (const chunk of chunks) {
      expect(chunk.reduce((n, r) => n + storedRowBytes(r), 0)).toBeLessThanOrEqual(CHUNK_ROW_BYTES);
    }
  });

  test("a row larger than the cap still gets a chunk of its own", () => {
    const big = row(1, CHUNK_ROW_BYTES + 10);
    expect(chunkRowsByBytes([row(0), big, row(2)])).toEqual([[row(0)], [big], [row(2)]]);
  });
});
