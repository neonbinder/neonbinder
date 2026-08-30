/**
 * NEO-189 — the SportLots fan-out ate every variation on a multi-source row.
 *
 * Found while generalising the BSC fan-out, and fixed here because it is the
 * same defect class on the same code path: a dedup key that is not the thing
 * being deduped.
 *
 * `fetchCardChecklist`'s SL fan-out (NEO-6) merged the per-set results into a
 * Map keyed on `cardNumber`. SportLots deliberately reuses a card number across
 * variation rows — "#11 Alec Bohm" and "#11 Alec Bohm [ VAR Action Image ]" are
 * different cards sharing the number 11, which is exactly why `platformRef` is
 * the full description (NEO-91) and why `slClaimKey` keys claims on the ref
 * rather than the number. So every variation after the first collapsed into the
 * base card.
 *
 * The blast radius is precisely the sets this ticket is about: a SINGLE-source
 * row never reaches that merge and kept its variations, so only multi-source
 * rows lost them — silently, and in a way that reads as "SportLots had no
 * variations". It also starved NEO-189's BSC↔SL variation pairing of its SL
 * side, which is the shape of the real 2025 Topps sync that reported "350
 * paired, 393 BSC-only, 0 SL-only".
 *
 * Tested against the extracted `mergeSlFanOut` rather than through
 * `fetchCardChecklist`: the fan-out issues its per-set `ctx.runAction` calls
 * concurrently, and convex-test cannot mock that reliably — two concurrent
 * first-calls race the lazy module resolution and one of them reaches the
 * UNMOCKED adapter (observed while writing this: one call hit the mock, the
 * other tried to fetch a real SportLots session cookie). A pure function has no
 * such hole and lets the identity matrix be covered exhaustively.
 */

import { describe, expect, test } from "vitest";
import { mergeSlFanOut, summarizeCollisions } from "./selectorOptions";

const SET_A = "884412";
const SET_B = "884413";

const bohm = {
  cardNumber: "11",
  platformRef: "#11 Alec Bohm",
  sourceSlSetId: SET_A,
};
const bohmVariation = {
  cardNumber: "11",
  platformRef: "#11 Alec Bohm [ VAR Action Image ]",
  sourceSlSetId: SET_A,
};
const harper = {
  cardNumber: "12",
  platformRef: "#12 Bryce Harper",
  sourceSlSetId: SET_B,
};

describe("mergeSlFanOut — identity, not card number", () => {
  test("a variation sharing its parent's number SURVIVES — THE REGRESSION", () => {
    const merged = mergeSlFanOut([[bohm, bohmVariation], [harper]]);
    expect(merged.cards.map((c) => c.platformRef)).toEqual([
      "#11 Alec Bohm",
      "#11 Alec Bohm [ VAR Action Image ]",
      "#12 Bryce Harper",
    ]);
  });

  test("several variations of one card all survive", () => {
    const merged = mergeSlFanOut([
      [
        bohm,
        bohmVariation,
        {
          cardNumber: "11",
          platformRef: "#11 Alec Bohm [ VAR Throwback Alternate ]",
          sourceSlSetId: SET_A,
        },
      ],
      [harper],
    ]);
    expect(merged.cards).toHaveLength(4);
  });

  test("the SAME SportLots row returned by both sets is deduped", () => {
    // Two attached sets that genuinely overlap return byte-identical rows.
    // Identity dedup must still collapse those, or every shared card doubles.
    const merged = mergeSlFanOut([[bohm], [{ ...bohm, sourceSlSetId: SET_B }]]);
    expect(merged.cards).toHaveLength(1);
    expect(merged.cards[0].sourceSlSetId).toBe(SET_A); // first source wins
  });

  test("a row with no platformRef falls back to its number", () => {
    // The one case where nothing better exists — the same fallback
    // `slClaimKey` uses, so the merge and the claim bookkeeping agree.
    const merged = mergeSlFanOut([
      [{ cardNumber: "5", sourceSlSetId: SET_A }],
      [{ cardNumber: "5", sourceSlSetId: SET_B }],
    ]);
    expect(merged.cards).toHaveLength(1);
  });

  test("a single source set passes through untouched", () => {
    const merged = mergeSlFanOut([[bohm, bohmVariation]]);
    expect(merged.cards).toHaveLength(2);
    expect(merged.collisions).toEqual([]);
  });
});

describe("mergeSlFanOut — collision reporting", () => {
  test("the same number from two different sets is reported", () => {
    const judge = {
      cardNumber: "11",
      platformRef: "#11 Aaron Judge",
      sourceSlSetId: SET_B,
    };
    const merged = mergeSlFanOut([[bohm], [judge]]);

    expect(merged.collisions).toEqual([
      { cardNumber: "11", keptSource: SET_A, skippedSource: SET_B },
    ]);
    // Both rows are still offered. SportLots can tell them apart, so the
    // operator decides in the pairing modal rather than losing one silently.
    expect(merged.cards).toHaveLength(2);
  });

  test("a number repeated WITHIN one set is not a cross-source collision", () => {
    // That is a variation, not two sets overlapping. Reporting it would bury
    // the real signal under every variation in the set.
    const merged = mergeSlFanOut([[bohm, bohmVariation]]);
    expect(merged.collisions).toEqual([]);
  });

  test("an unattributed source is named rather than rendered as undefined", () => {
    const merged = mergeSlFanOut([
      [{ cardNumber: "1", platformRef: "#1 A" }],
      [{ cardNumber: "1", platformRef: "#1 B", sourceSlSetId: SET_B }],
    ]);
    expect(merged.collisions[0]).toEqual({
      cardNumber: "1",
      keptSource: "(unattributed)",
      skippedSource: SET_B,
    });
  });
});

describe("summarizeCollisions — what the operator actually reads", () => {
  test("no collisions adds nothing to the message", () => {
    expect(summarizeCollisions([])).toBe("");
  });

  test("names the marketplace, the count and the numbers", () => {
    const note = summarizeCollisions([
      { side: "BSC", cardNumber: "2", keptSource: "s1", skippedSource: "s2" },
      { side: "SL", cardNumber: "9", keptSource: "a", skippedSource: "b" },
    ]);
    expect(note).toContain("kept the first source");
    expect(note).toContain("BSC: 1 card number(s)");
    expect(note).toContain("#2");
    expect(note).toContain("SL: 1 card number(s)");
    expect(note).toContain("#9");
  });

  test("caps the examples so the counts stay readable", () => {
    // The operator's next action is the same whether two numbers collided or
    // two hundred — look at the two sets and decide. The count carries the
    // signal; a wall of numbers would push the matched/BSC-only/SL-only counts
    // this message exists for off the screen.
    const note = summarizeCollisions(
      Array.from({ length: 40 }, (_, i) => ({
        side: "BSC" as const,
        cardNumber: String(i + 1),
        keptSource: "s1",
        skippedSource: "s2",
      })),
    );
    expect(note).toContain("BSC: 40 card number(s)");
    expect(note).toContain("#1, #2, #3, +37 more");
  });
});
