/**
 * NEO-254 — the career span, and the ±2 window a card year falls in.
 *
 * The Convex-side rules (which candidate a set year picks, and what the team
 * printed on the card does to a tie) are asserted against a real database in
 * `convex/playersCardYear.test.ts`. What is asserted HERE is the arithmetic
 * those rules stand on, at the edges where it is worth being sure.
 */

import { describe, expect, test } from "vitest";
import {
  CARD_YEAR_TOLERANCE,
  careerSpan,
  spanCoversCardYear,
  stintCoversYear,
} from "./career-span";

const NOW = 2026;

describe("careerSpan", () => {
  test("no stints is no span — never a zero-width one at year 0", () => {
    expect(careerSpan([], NOW)).toBeNull();
  });

  test("one closed stint is its own bounds", () => {
    expect(careerSpan([{ fromYear: 1982, toYear: 2001 }], NOW)).toEqual({
      fromYear: 1982,
      toYear: 2001,
    });
  });

  test("an open stint runs to the current year", () => {
    expect(careerSpan([{ fromYear: 2011 }], NOW)).toEqual({
      fromYear: 2011,
      toYear: NOW,
    });
  });

  test("several stints collapse to the outer bounds, gaps included", () => {
    // The 1993-2000 gap is deliberately NOT a hole in the span: a card of 1996
    // is still plausibly this man, and excluding him for a hole in OUR stint
    // data is how the narrowing would pick the wrong person confidently.
    expect(
      careerSpan(
        [
          { fromYear: 1990, toYear: 1992 },
          { fromYear: 2001, toYear: 2004 },
        ],
        NOW,
      ),
    ).toEqual({ fromYear: 1990, toYear: 2004 });
  });

  test("an open stint anywhere in the list extends the end", () => {
    expect(
      careerSpan([{ fromYear: 1990, toYear: 1992 }, { fromYear: 2001 }], NOW),
    ).toEqual({ fromYear: 1990, toYear: NOW });
  });

  test("a reversed stint widens rather than producing an empty span", () => {
    // Refused by every writer today, but this reads rows written before those
    // validators existed. An empty span would exclude the player from his own
    // career.
    expect(careerSpan([{ fromYear: 2001, toYear: 1982 }], NOW)).toEqual({
      fromYear: 1982,
      toYear: 2001,
    });
  });
});

describe("spanCoversCardYear", () => {
  const SPAN = { fromYear: 1990, toYear: 2000 };

  test("an unknown span is never a reason to exclude", () => {
    expect(spanCoversCardYear(null, 1600)).toBe(true);
  });

  test("inside the span", () => {
    expect(spanCoversCardYear(SPAN, 1995)).toBe(true);
  });

  test("exactly on the tolerance, both ends", () => {
    expect(spanCoversCardYear(SPAN, 1990 - CARD_YEAR_TOLERANCE)).toBe(true);
    expect(spanCoversCardYear(SPAN, 2000 + CARD_YEAR_TOLERANCE)).toBe(true);
  });

  test("one year past the tolerance, both ends", () => {
    expect(spanCoversCardYear(SPAN, 1990 - CARD_YEAR_TOLERANCE - 1)).toBe(false);
    expect(spanCoversCardYear(SPAN, 2000 + CARD_YEAR_TOLERANCE + 1)).toBe(false);
  });

  test("a career fifty years earlier is out", () => {
    expect(spanCoversCardYear({ fromYear: 1930, toYear: 1937 }, 1990)).toBe(false);
  });
});

describe("stintCoversYear", () => {
  test("no tolerance — the team tie-break asks a narrower question", () => {
    const stint = { fromYear: 1990, toYear: 1992 };
    expect(stintCoversYear(stint, 1990, NOW)).toBe(true);
    expect(stintCoversYear(stint, 1992, NOW)).toBe(true);
    expect(stintCoversYear(stint, 1989, NOW)).toBe(false);
    expect(stintCoversYear(stint, 1993, NOW)).toBe(false);
  });

  test("an open stint covers everything from its start to now", () => {
    expect(stintCoversYear({ fromYear: 2011 }, NOW, NOW)).toBe(true);
    expect(stintCoversYear({ fromYear: 2011 }, 2010, NOW)).toBe(false);
  });
});
