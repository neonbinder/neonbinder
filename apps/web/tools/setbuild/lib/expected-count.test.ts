import { describe, expect, test } from "vitest";
import {
  countCheck,
  countsFor,
  declaredPausedNames,
  fieldAt,
  pausedNames,
  skipSuffix,
  specExpects,
  type CountCheck,
} from "./expected-count";
import { NOTHING_PAUSED, pausedContextOf } from "./sync-column";

const SL_PAUSED = pausedContextOf(["sportlots"]);
const asserted = (c: CountCheck) => {
  if (c.kind !== "assert") throw new Error(`expected an assert, got ${c.kind}`);
  return c;
};

describe("countCheck: a count measured live, judged against the run's pause", () => {
  test("nothing paused: the live value is asserted, worded exactly as before", () => {
    const c = asserted(countCheck("expectCards", 336, 335, []));
    expect(c).toEqual({ kind: "assert", want: 336, field: "expectCards" });
    expect(specExpects(c)).toBe("the spec expects 336");
    expect(fieldAt("steps[1].variants[0]", c)).toBe("steps[1].variants[0].expectCards");
    expect(skipSuffix(c)).toBe("");
  });

  test("paused with a paused value: the paused value is asserted, and the words say so", () => {
    const c = asserted(countCheck("expectRows", 41, 40, ["sportlots"]));
    expect(c).toEqual({ kind: "assert", want: 40, field: "expectRows", pausedBy: "sportlots" });
    expect(specExpects(c)).toBe("the spec expects 40 with sportlots paused (expectRowsWhenPaused)");
    expect(fieldAt("steps[0].variants[1]", c)).toBe("steps[0].variants[1].expectRowsWhenPaused");
  });

  test("paused with no paused value: nothing is asserted, and the step says so", () => {
    const c = countCheck("expectCards", 336, undefined, ["sportlots"]);
    expect(c).toEqual({ kind: "skip", field: "expectCards", note: "count not asserted: sportlots paused" });
    expect(skipSuffix(c)).toBe("; count not asserted: sportlots paused");
  });

  test("no count in the spec is no check, paused or not", () => {
    expect(countCheck("expectCards", undefined, undefined, [])).toEqual({ kind: "none" });
    expect(countCheck("expectCards", undefined, undefined, ["sportlots"])).toEqual({ kind: "none" });
    // A paused value alone is asserted only when something is paused.
    expect(countCheck("expectCards", undefined, 7, [])).toEqual({ kind: "none" });
    expect(countCheck("expectCards", undefined, 7, ["sportlots"])).toMatchObject({ kind: "assert", want: 7 });
  });
});

describe("pausedNames", () => {
  test("the declared pause, plus any side a fetch reported paused, by site key", () => {
    expect(pausedNames(undefined)).toEqual([]);
    expect(pausedNames(NOTHING_PAUSED)).toEqual([]);
    expect(pausedNames(SL_PAUSED)).toEqual(["sportlots"]);
    expect(pausedNames(NOTHING_PAUSED, ["sportlots"])).toEqual(["sportlots"]);
    expect(pausedNames(SL_PAUSED, ["bsc", "sportlots"])).toEqual(["buysportscards", "sportlots"]);
  });

  test("a smoke's declaration parses strictly: an unknown key throws", () => {
    expect(declaredPausedNames(undefined)).toEqual([]);
    expect(declaredPausedNames("")).toEqual([]);
    expect(declaredPausedNames(" SportLots ")).toEqual(["sportlots"]);
    expect(() => declaredPausedNames("sportlot")).toThrow(/unknown platform "sportlot"/);
  });
});

describe("countsFor: an expectation file's apply counts", () => {
  const live = { reconciled: 21, built: 1106 };
  test("nothing paused: every count, nothing unchecked", () => {
    expect(countsFor(live, { built: 900 }, [])).toEqual({ counts: live, unchecked: [] });
  });
  test("paused: only the paused counts, the rest named", () => {
    expect(countsFor(live, { built: 900 }, ["sportlots"])).toEqual({ counts: { built: 900 }, unchecked: ["counts.reconciled"] });
    expect(countsFor(live, undefined, ["sportlots"])).toEqual({ counts: {}, unchecked: ["counts.reconciled", "counts.built"] });
  });
});
