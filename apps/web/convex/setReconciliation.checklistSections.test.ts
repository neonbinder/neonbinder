/**
 * NEO-496 (D7) — a set's stored checklist in the variant sync.
 *
 * `matchChecklistSections` pairs checklist sections with the lines of an
 * Inserts / Parallels sync; `buildRawOptionsChecklist` builds the
 * `checklist` that `fetchRawOptions` returns from the stored context and what
 * the marketplaces answered. Both are pure. The section names below are the
 * live probe's (2025 Donruss and 2025 Topps Chrome files against BSC).
 *
 * Product rules pinned here:
 *   - rule 8: a section whose best target is not unique stays unmatched and
 *     is only offered; a name twin is offered, never matched;
 *   - rule 5: every row's links are echoed (`rowLinks`), including a key the
 *     current checklist no longer holds, so a re-sync saving the row's full
 *     key set cannot drop one.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import {
  buildRawOptionsChecklist,
  matchChecklistSections,
  type ChecklistTarget,
  type VariantSyncChecklistContext,
} from "./setReconciliation";

const rowId = (s: string) => s as Id<"selectorOptions">;
const row = (id: string): ChecklistTarget => ({ kind: "row", rowId: rowId(id) });
const bscItem = (pv: string): ChecklistTarget => ({ kind: "item", side: "bsc", platformValue: pv });
const sec = (name: string, kind: "base" | "base-child" | "other" = "other") => ({
  sectionKey: name.toLowerCase(),
  name,
  kind,
});

describe("matchChecklistSections: the probe's names", () => {
  test("Donruss Base parallels: 'Base Red' and 'Base Rated Prospects Red' both match BSC's bare 'Red'", () => {
    const result = matchChecklistSections(
      [sec("Base Red", "base-child"), sec("Base Rated Prospects Red", "base-child")],
      [
        { target: bscItem("bsc-red"), labels: ["Red"] },
        { target: bscItem("bsc-blue"), labels: ["Blue"] },
      ],
      { setNames: ["Donruss", "2025 Donruss"], baseNames: ["Base", "Base Rated Prospects"] },
    );
    expect(result.matches).toEqual([
      { sectionKey: "base red", target: bscItem("bsc-red"), confidence: 1 },
      { sectionKey: "base rated prospects red", target: bscItem("bsc-red"), confidence: 1 },
    ]);
    expect(result.unmatchedSectionKeys).toEqual([]);
  });

  test("a base-child's base name is only stripped for base-children", () => {
    // The same name as an "other" section keeps its "Base" and finds nothing.
    const result = matchChecklistSections(
      [sec("Base Red", "other")],
      [{ target: bscItem("bsc-red"), labels: ["Red"] }],
      { baseNames: ["Base"] },
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatchedSectionKeys).toEqual(["base red"]);
  });

  test("'Donruss Ballpark Stars Signatures' matches 'Donruss Ballparks Stars Signatures' (plural fold)", () => {
    const result = matchChecklistSections(
      [sec("Donruss Ballpark Stars Signatures")],
      [
        { target: bscItem("bsc-bp"), labels: ["Donruss Ballparks Stars Signatures"] },
        { target: bscItem("bsc-sig"), labels: ["Signature Series"] },
      ],
      { setNames: ["Donruss", "2025 Donruss"] },
    );
    expect(result.matches).toEqual([
      { sectionKey: "donruss ballpark stars signatures", target: bscItem("bsc-bp"), confidence: 1 },
    ]);
  });

  test("Topps Chrome: the set's name comes off the front, accents and plurals fold", () => {
    const result = matchChecklistSections(
      [
        sec("TOPPS CHROME RADIATING ROOKIES"),
        sec("TOPPS CHROME EXPOSE"),
        sec("CHROME LEGEND AUTOGRAPHS"),
      ],
      [
        { target: bscItem("bsc-rr"), labels: ["Radiating Rookies"] },
        { target: bscItem("bsc-ex"), labels: ["Exposé"] },
        { target: bscItem("bsc-cla"), labels: ["Chrome Legends Autographs"] },
        { target: bscItem("bsc-fs"), labels: ["Future Stars"] },
      ],
      { setNames: ["Topps Chrome", "2025 Topps Chrome"] },
    );
    expect(result.matches).toEqual([
      { sectionKey: "topps chrome radiating rookies", target: bscItem("bsc-rr"), confidence: 1 },
      { sectionKey: "topps chrome expose", target: bscItem("bsc-ex"), confidence: 1 },
      { sectionKey: "chrome legend autographs", target: bscItem("bsc-cla"), confidence: 1 },
    ]);
    expect(result.unmatchedSectionKeys).toEqual([]);
  });

  test("the same words in another order match at 0.95", () => {
    const result = matchChecklistSections(
      [sec("Autographs Rookie")],
      [{ target: bscItem("bsc-ra"), labels: ["Rookie Autographs"] }],
    );
    expect(result.matches).toEqual([
      { sectionKey: "autographs rookie", target: bscItem("bsc-ra"), confidence: 0.95 },
    ]);
  });

  test("a near name whose words sit inside the target's matches below 1", () => {
    const result = matchChecklistSections(
      [sec("Future Stars")],
      [{ target: bscItem("bsc-fs"), labels: ["Future Stars Die-Cut"] }],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].target).toEqual(bscItem("bsc-fs"));
    expect(result.matches[0].confidence).toBeLessThan(1);
    expect(result.matches[0].confidence).toBeGreaterThan(0.6);
  });

  test("a row's labels count as its names", () => {
    const result = matchChecklistSections(
      [sec("Radiating Rookies")],
      [{ target: row("r1"), labels: ["Radiant Rooks", "Radiating Rookies"] }],
    );
    expect(result.matches).toEqual([
      { sectionKey: "radiating rookies", target: row("r1"), confidence: 1 },
    ]);
  });
});

describe("matchChecklistSections: rule 8, ties and twins stay with the operator", () => {
  test("two targets with the same name: the section is unmatched, both are offered", () => {
    const result = matchChecklistSections(
      [sec("Gold")],
      [
        { target: row("r-gold"), labels: ["Gold"] },
        { target: bscItem("bsc-gold"), labels: ["Gold"] },
      ],
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatchedSectionKeys).toEqual(["gold"]);
    expect(result.candidates).toEqual([
      {
        sectionKey: "gold",
        candidates: expect.arrayContaining([
          { target: row("r-gold"), confidence: 1 },
          { target: bscItem("bsc-gold"), confidence: 1 },
        ]),
      },
    ]);
  });

  test("a tie in the word-order pass is no match either", () => {
    const result = matchChecklistSections(
      [sec("Rookie Autographs")],
      [
        { target: bscItem("a"), labels: ["Autographs Rookie"] },
        { target: bscItem("b"), labels: ["Autograph Rookies"] },
      ],
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatchedSectionKeys).toEqual(["rookie autographs"]);
  });

  test("a blocked (name-twin) target is offered, never matched", () => {
    const result = matchChecklistSections(
      [sec("Gold")],
      [{ target: bscItem("bsc-gold-1"), labels: ["Gold"], blocked: true }],
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatchedSectionKeys).toEqual(["gold"]);
    expect(result.candidates[0].candidates[0]).toEqual({
      target: bscItem("bsc-gold-1"),
      confidence: 1,
    });
  });

  test("a near name with no word in common is never matched", () => {
    const result = matchChecklistSections(
      [sec("Gold Wave")],
      [{ target: bscItem("x"), labels: ["Gold Wav3s"] }],
    );
    expect(result.matches).toEqual([]);
  });

  test("candidates are ranked, top five, nothing below 0.3", () => {
    const labels = ["Gold", "Golds Refractor", "Gold Shimmer", "Gold Wave", "Gold Lava", "Gold Mini", "Zzzzzzzzzz"];
    const result = matchChecklistSections(
      [sec("Gold Ref")],
      labels.map((l, i) => ({ target: bscItem(`p${i}`), labels: [l] })),
    );
    const offered = result.candidates[0]?.candidates ?? [];
    expect(offered.length).toBeLessThanOrEqual(5);
    expect(offered.every((c) => c.confidence >= 0.3)).toBe(true);
    const confidences = offered.map((c) => c.confidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
    expect(offered.some((c) => c.target.kind === "item" && c.target.platformValue === "p6")).toBe(false);
  });

  test("the answer does not depend on target order", () => {
    const targets = [
      { target: bscItem("a"), labels: ["Red"] },
      { target: bscItem("b"), labels: ["Blue"] },
      { target: row("r"), labels: ["Green"] },
    ];
    const sections = [sec("Base Red", "base-child"), sec("Green"), sec("Purple")];
    const forward = matchChecklistSections(sections, targets, { baseNames: ["Base"] });
    const backward = matchChecklistSections(sections, [...targets].reverse(), { baseNames: ["Base"] });
    expect(backward.matches).toEqual(forward.matches);
    expect(backward.unmatchedSectionKeys).toEqual(forward.unmatchedSectionKeys);
  });
});

// ── buildRawOptionsChecklist ─────────────────────────────────────────────────

const SECTIONS = [
  { sectionKey: "base", name: "Base", rowCount: 200 },
  { sectionKey: "base rated prospects", name: "Base Rated Prospects", rowCount: 50 },
  { sectionKey: "base red", name: "Base Red", rowCount: 150 },
  { sectionKey: "base rated prospects red", name: "Base Rated Prospects Red", rowCount: 50 },
  { sectionKey: "donruss ballpark stars signatures", name: "Donruss Ballpark Stars Signatures", rowCount: 20 },
  { sectionKey: "gold", name: "Gold", rowCount: 10 },
];

function context(
  overrides: Partial<VariantSyncChecklistContext> = {},
): VariantSyncChecklistContext {
  return {
    checklistId: "cl1" as Id<"publishedChecklists">,
    variantTypeId: rowId("type-parallel"),
    kind: "parallel",
    setNames: ["Donruss", "2025 Donruss"],
    sections: SECTIONS,
    links: [
      { selectorOptionId: rowId("type-base"), sectionKey: "base" },
      { selectorOptionId: rowId("type-base"), sectionKey: "base rated prospects" },
    ],
    baseRowIds: [rowId("type-base")],
    siblings: [],
    ...overrides,
  };
}

const NOTHING_FETCHED = { autoMatched: [], unmatchedBsc: [], unmatchedSl: [] };

describe("buildRawOptionsChecklist", () => {
  test("Parallels: base-children match, the Base's linked sections are stripped, other sections wait", () => {
    const result = buildRawOptionsChecklist(context(), {
      ...NOTHING_FETCHED,
      unmatchedBsc: [
        { value: "Red", platformValue: "bsc-red" },
        { value: "Donruss Ballparks Stars Signatures", platformValue: "bsc-bp" },
      ],
    });
    expect(result.baseSectionNames).toEqual(["Base Rated Prospects", "Base"]);
    // Linked sections are gone from `sections`; every unlinked one is listed.
    expect(result.sections.map((s) => s.sectionKey)).toEqual([
      "base red",
      "base rated prospects red",
      "donruss ballpark stars signatures",
      "gold",
    ]);
    expect(result.sections.find((s) => s.sectionKey === "base red")).toMatchObject({
      kind: "base-child",
      parent: "Base",
    });
    expect(result.matches).toEqual([
      { sectionKey: "base red", target: bscItem("bsc-red"), confidence: 1 },
      { sectionKey: "base rated prospects red", target: bscItem("bsc-red"), confidence: 1 },
    ]);
    // Under a Parallel type the "other" sections are not matched (an Insert sync takes them).
    expect(result.unmatchedSectionKeys).toEqual([]);
  });

  test("Inserts: only the other sections match", () => {
    const result = buildRawOptionsChecklist(context({ kind: "insert" }), {
      ...NOTHING_FETCHED,
      unmatchedBsc: [
        { value: "Red", platformValue: "bsc-red" },
        { value: "Donruss Ballparks Stars Signatures", platformValue: "bsc-bp" },
      ],
    });
    expect(result.matches).toEqual([
      { sectionKey: "donruss ballpark stars signatures", target: bscItem("bsc-bp"), confidence: 1 },
    ]);
    expect(result.unmatchedSectionKeys).toEqual(["gold"]);
  });

  test("a kindless type matches both; the base section never", () => {
    const result = buildRawOptionsChecklist(
      context({ kind: null, links: [] }),
      {
        ...NOTHING_FETCHED,
        unmatchedBsc: [
          { value: "Base", platformValue: "bsc-base" },
          { value: "Red", platformValue: "bsc-red" },
          { value: "Donruss Ballparks Stars Signatures", platformValue: "bsc-bp" },
        ],
      },
    );
    // No Base links: the classifier's base is what is stripped.
    expect(result.baseSectionNames).toEqual(["Base"]);
    const matchedKeys = result.matches.map((m) => m.sectionKey);
    expect(matchedKeys).toContain("base red");
    expect(matchedKeys).toContain("donruss ballpark stars signatures");
    expect(matchedKeys).not.toContain("base");
    expect(result.unmatchedSectionKeys).not.toContain("base");
  });

  test("Map Base Set (the Base type): nothing is matched, the Base row's links are echoed", () => {
    const result = buildRawOptionsChecklist(
      context({ kind: "base", variantTypeId: rowId("type-base") }),
      { ...NOTHING_FETCHED, unmatchedBsc: [{ value: "Red", platformValue: "bsc-red" }] },
    );
    expect(result.matches).toEqual([]);
    expect(result.unmatchedSectionKeys).toEqual([]);
    expect(result.rowLinks).toEqual([
      {
        rowId: rowId("type-base"),
        sections: [
          { sectionKey: "base", name: "Base", rowCount: 200 },
          { sectionKey: "base rated prospects", name: "Base Rated Prospects", rowCount: 50 },
        ],
      },
    ]);
  });

  test("rowLinks: every sibling's links, a key the checklist lacks included (name = key); other types' rows left out", () => {
    const result = buildRawOptionsChecklist(
      context({
        links: [
          { selectorOptionId: rowId("type-base"), sectionKey: "base" },
          { selectorOptionId: rowId("p-red"), sectionKey: "base red" },
          { selectorOptionId: rowId("p-red"), sectionKey: "old red section" },
          { selectorOptionId: rowId("i-other-type"), sectionKey: "gold" },
        ],
        siblings: [
          { _id: rowId("p-red"), value: "Red", labels: [], bscIds: ["bsc-red"], slIds: [] },
          { _id: rowId("p-blue"), value: "Blue", labels: [], bscIds: [], slIds: [] },
        ],
      }),
      NOTHING_FETCHED,
    );
    expect(result.rowLinks).toEqual([
      {
        rowId: rowId("p-red"),
        sections: [
          { sectionKey: "base red", name: "Base Red", rowCount: 150 },
          // A key the checklist no longer holds: no count to carry.
          { sectionKey: "old red section", name: "old red section" },
        ],
      },
    ]);
    // A section linked anywhere in the set is out of `sections` (gold, under another type).
    expect(result.sections.map((s) => s.sectionKey)).not.toContain("gold");
  });

  test("a marketplace line a sibling already holds is that sibling's target, not a second one", () => {
    const result = buildRawOptionsChecklist(
      context({
        siblings: [
          { _id: rowId("p-crimson"), value: "Crimson", labels: [], bscIds: ["bsc-red"], slIds: [] },
        ],
      }),
      { ...NOTHING_FETCHED, unmatchedBsc: [{ value: "Red", platformValue: "bsc-red" }] },
    );
    // "Base Red" -> "Red" is the BSC label of the row named "Crimson": it lands on the row.
    expect(result.matches).toEqual([
      { sectionKey: "base red", target: row("p-crimson"), confidence: 1 },
      { sectionKey: "base rated prospects red", target: row("p-crimson"), confidence: 1 },
    ]);
  });

  test("an autoMatched pair is one target, with the SportLots base prefix taken off its label", () => {
    const result = buildRawOptionsChecklist(context(), {
      autoMatched: [
        {
          displayName: "Red",
          bsc: { value: "Reds", platformValue: "bsc-red" },
          sl: { value: "Donruss Red", platformValue: "sl-red" },
          confidence: 0.9,
        },
      ],
      unmatchedBsc: [],
      unmatchedSl: [],
      slStripPrefix: "Donruss",
    });
    expect(result.matches[0]).toEqual({
      sectionKey: "base red",
      target: { kind: "pair", bsc: "bsc-red", sportlots: "sl-red" },
      confidence: 1,
    });
  });

  test("a BSC name twin is offered to the section, never matched to it", () => {
    const result = buildRawOptionsChecklist(context({ kind: "insert" }), {
      ...NOTHING_FETCHED,
      unmatchedBsc: [{ value: "Gold", platformValue: "bsc-gold-a" }],
      twinIds: { bsc: ["bsc-gold-a"], sportlots: [] },
    });
    expect(result.matches.map((m) => m.sectionKey)).not.toContain("gold");
    expect(result.unmatchedSectionKeys).toContain("gold");
    const offered = result.candidates.find((c) => c.sectionKey === "gold")?.candidates ?? [];
    expect(offered[0]).toEqual({ target: bscItem("bsc-gold-a"), confidence: 1 });
  });

  describe("number-aware classification (stored first/last numbers)", () => {
    /** Donruss as stored: Base 1-100, Rated Prospects 101-150 after it, and a run of each. */
    const NUMBERED = [
      { sectionKey: "base", name: "Base", rowCount: 100, firstNumber: "1", lastNumber: "100" },
      {
        sectionKey: "base rated prospects",
        name: "Base Rated Prospects",
        rowCount: 50,
        firstNumber: "101",
        lastNumber: "150",
      },
      { sectionKey: "base red", name: "Base Red", rowCount: 100, firstNumber: "1", lastNumber: "100" },
      {
        sectionKey: "base rated prospects red",
        name: "Base Rated Prospects Red",
        rowCount: 50,
        firstNumber: "101",
        lastNumber: "150",
      },
    ];

    test("with nothing linked at the Base, Rated Prospects is a base subset and Rated Prospects Red matches BSC's 'Red'", () => {
      const result = buildRawOptionsChecklist(context({ sections: NUMBERED, links: [] }), {
        ...NOTHING_FETCHED,
        unmatchedBsc: [{ value: "Red", platformValue: "bsc-red" }],
      });
      expect(result.sections.find((s) => s.sectionKey === "base rated prospects")).toMatchObject({
        kind: "base-subset",
      });
      // The base and every subset of it are stripped, longest first.
      expect(result.baseSectionNames).toEqual(["Base Rated Prospects", "Base"]);
      expect(result.matches).toEqual([
        { sectionKey: "base red", target: bscItem("bsc-red"), confidence: 1 },
        { sectionKey: "base rated prospects red", target: bscItem("bsc-red"), confidence: 1 },
      ]);
    });

    test("a base subset is the Base's: never auto-matched, even under a kindless type", () => {
      const result = buildRawOptionsChecklist(
        context({ kind: null, sections: NUMBERED, links: [] }),
        {
          ...NOTHING_FETCHED,
          unmatchedBsc: [{ value: "Base Rated Prospects", platformValue: "bsc-rp" }],
        },
      );
      expect(result.matches.map((m) => m.sectionKey)).not.toContain("base rated prospects");
      expect(result.unmatchedSectionKeys).not.toContain("base rated prospects");
    });

    test("the context carries the stored number summary through to the classifier", () => {
      // Without the numbers the same names read as a run of the base: only
      // "Base" is stripped and "Rated Prospects Red" finds no "Red".
      const namesOnly = NUMBERED.map(({ sectionKey, name, rowCount }) => ({
        sectionKey,
        name,
        rowCount,
      }));
      const result = buildRawOptionsChecklist(context({ sections: namesOnly, links: [] }), {
        ...NOTHING_FETCHED,
        unmatchedBsc: [{ value: "Red", platformValue: "bsc-red" }],
      });
      expect(result.baseSectionNames).toEqual(["Base"]);
      expect(result.matches.map((m) => m.sectionKey)).not.toContain("base rated prospects red");
    });
  });

  test("no marketplace lines at all: every eligible section is unmatched (a checklist alone still opens Reconcile)", () => {
    const result = buildRawOptionsChecklist(context({ kind: "insert" }), NOTHING_FETCHED);
    expect(result.matches).toEqual([]);
    expect(result.unmatchedSectionKeys).toEqual(["donruss ballpark stars signatures", "gold"]);
    expect(result.sections.length).toBeGreaterThan(0);
  });
});

describe("matchChecklistSections: bounded pass 3 (NEO-496 security audit)", () => {
  /** A deterministic lower-case word string of about `length` characters. */
  const words = (seed: number, length: number) => {
    let x = seed >>> 0;
    let out = "";
    while (out.length < length) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out += String.fromCharCode(97 + ((x >>> 16) % 26));
      if (out.length % 7 === 6) out += " ";
    }
    return out.trim();
  };
  const longTargets = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      target: bscItem(`bsc-${i}`),
      labels: [words(i + 1, 120)],
    }));

  test("a section an exact name matched is never scored against every target", () => {
    const name = words(77_777, 120);
    const targets = [{ target: bscItem("bsc-exact"), labels: [name] }, ...longTargets(2_000)];
    const sections = Array.from({ length: 50 }, (_, i) => ({ ...sec(name), sectionKey: `s-${i}` }));
    const started = performance.now();
    const result = matchChecklistSections(sections, targets);
    // Before, every one of 50 × 2,000 pairs of 120 characters was scored (~3 s).
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.matches).toHaveLength(50);
    expect(result.matches.every((m) => m.confidence === 1 && m.target.kind === "item")).toBe(true);
  });

  test("a pair whose lengths alone rule out a candidate is not scored, and nothing is offered", () => {
    const sections = Array.from({ length: 200 }, (_, i) => ({
      ...sec(words(i + 90_000, 20)),
      sectionKey: `s-${i}`,
    }));
    const started = performance.now();
    const result = matchChecklistSections(sections, longTargets(2_000));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.matches).toEqual([]);
    expect(result.unmatchedSectionKeys).toHaveLength(200);
    expect(result.candidates.every((c) => c.candidates.length === 0)).toBe(true);
  });

  test("a candidate exactly at the 0.3 floor is still offered (the length skip has a margin)", () => {
    // "abc" → "abcdefghij" is 7 edits over 10: ratio 0.7, confidence 0.3.
    const result = matchChecklistSections([sec("abc")], [{ target: bscItem("bsc-a"), labels: ["abcdefghij"] }]);
    expect(result.matches).toEqual([]);
    expect(result.candidates).toEqual([
      { sectionKey: "abc", candidates: [{ target: bscItem("bsc-a"), confidence: 1 - 0.7 }] },
    ]);
  });
});
