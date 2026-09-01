import { describe, expect, it } from "vitest";
import { compareCardNumbers } from "./card-number";

/** Sort with the comparator and return the resulting order, for readable assertions. */
function sorted(values: string[]): string[] {
  return [...values].sort(compareCardNumbers);
}

describe("compareCardNumbers", () => {
  describe("plain numeric cards (pre-existing behaviour — must not regress)", () => {
    it("orders single and multi-digit numbers numerically, not lexicographically", () => {
      expect(sorted(["10", "2", "1", "11", "3"])).toEqual(["1", "2", "3", "10", "11"]);
    });

    it("sorts a lettered variation suffix after its parent card", () => {
      expect(sorted(["11b", "11", "11c"])).toEqual(["11", "11b", "11c"]);
    });

    it("sorts a numbered card ahead of a lettered insert code", () => {
      expect(sorted(["CC-JA", "1"])).toEqual(["1", "CC-JA"]);
    });

    it("returns 0 for identical card numbers", () => {
      expect(compareCardNumbers("42", "42")).toBe(0);
    });
  });

  describe("prefixed insert/parallel codes (NEO-200)", () => {
    it("sorts the real 2024 Topps Chrome Insert -> Future Stars sequence naturally", () => {
      // This is the exact fixture from the bug report: under the old
      // digit-prefix-only rule this fell back to localeCompare and produced
      // FS-1, FS-10, FS-11, FS-2, FS-20, FS-3, FS-9.
      const input = ["FS-1", "FS-2", "FS-3", "FS-9", "FS-10", "FS-11", "FS-20"];
      expect(sorted([...input].reverse())).toEqual(input);
    });

    it("sorts FS-2 before FS-10 (the core regression)", () => {
      expect(sorted(["FS-10", "FS-2"])).toEqual(["FS-2", "FS-10"]);
    });

    it("orders two purely-lettered codes by their text, unaffected by the digit fix", () => {
      expect(sorted(["MIR-AJ", "CC-JA"])).toEqual(["CC-JA", "MIR-AJ"]);
    });
  });

  describe("multi-segment and internally-numbered codes", () => {
    it("compares a numeric run in the middle of the string, not just a leading one", () => {
      // T206-1 / T206-10: shared "T206-" text prefix ties, final digit run decides.
      expect(sorted(["T206-10", "T206-2", "T206-1"])).toEqual(["T206-1", "T206-2", "T206-10"]);
    });

    it("handles more than two alternating digit/text segments", () => {
      expect(sorted(["A2B10", "A2B2", "A10B1"])).toEqual(["A2B2", "A2B10", "A10B1"]);
    });

    it("ties on a shared numeric run and falls through to the next text segment", () => {
      expect(sorted(["12B", "12A"])).toEqual(["12A", "12B"]);
    });
  });

  describe("mixed case", () => {
    it("orders lettered prefixes via localeCompare on the text token, same as before the fix", () => {
      // Case ordering here is whatever the environment's localeCompare says
      // (this repo's Node/ICU sorts lowercase before uppercase) — the point
      // of this test is that the *comparison basis* for the text token is
      // unchanged from the pre-NEO-200 behaviour, not a specific case rule.
      expect("rc-".localeCompare("RC-")).toBe(-1);
      expect(sorted(["RC-1", "rc-2"])).toEqual(["rc-2", "RC-1"]);
    });
  });

  describe("equal numeric value, different printed width (FS-1 vs FS-01)", () => {
    it("treats them as adjacent, not equal — shorter printed form sorts first", () => {
      const result = sorted(["FS-01", "FS-1"]);
      expect(result).toEqual(["FS-1", "FS-01"]);
      expect(compareCardNumbers("FS-1", "FS-01")).not.toBe(0);
    });

    it("is consistent for the bare-numeric shape too (01 vs 1)", () => {
      expect(sorted(["01", "1"])).toEqual(["1", "01"]);
    });
  });

  describe("shorter token sequence sorts first when a shared prefix ties", () => {
    it("sorts FS-1 before FS-1a (variation suffix on a prefixed code)", () => {
      expect(sorted(["FS-1a", "FS-1"])).toEqual(["FS-1", "FS-1a"]);
    });
  });

  describe("digit-vs-text divergence past the first token", () => {
    it("sorts a numbered continuation ahead of a lettered one after a tied text prefix", () => {
      // Shared "FS" text token ties; then a digit run ("FS1") should still
      // sort ahead of a text run ("FSA") at the point they diverge.
      expect(sorted(["FSA", "FS1"])).toEqual(["FS1", "FSA"]);
    });
  });

  describe("mixed numeric and prefixed sets", () => {
    it("orders a set containing both plain numbers and insert codes", () => {
      const input = ["FS-2", "3", "FS-1", "1", "2", "FS-10"];
      expect(sorted(input)).toEqual(["1", "2", "3", "FS-1", "FS-2", "FS-10"]);
    });
  });
});
