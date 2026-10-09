/**
 * NEO-325 — the Base match rules, pure. A pending marketplace set is judged
 * on its first card (number + who) and its card count against NB's saved Base.
 * Nothing here is keyed on a marketplace name: numbers are compared after the
 * marketplace's own prefix is stripped, and who is compared through
 * `card-name.ts`.
 *
 * Fixtures are tiny hand-built signatures. The probe hook
 * (`components/SetSelector/base-match-probe.test.tsx`) and the dialog
 * (`ReconciliationModal.baseMatch.test.tsx`) test their own wiring.
 */

import { describe, expect, test } from "vitest";
import {
  BASE_MATCH_COPY,
  judgeAgainstBase,
  judgeFirstCard,
  needsCount,
  normalizedCardNumber,
  sameWho,
  type BaseSignature,
  type BaseSignatureCard,
  type ObservedCard,
} from "./base-match";

const card = (
  cardNumber: string,
  cardName: string,
  extra: Partial<BaseSignatureCard> = {},
): BaseSignatureCard => ({
  cardNumber,
  cardName,
  namesOnCard: cardName ? [cardName] : [],
  isTeamCard: false,
  ...extra,
});

/** A Base whose first card is #1 Mike Trout, with two more behind it. */
function sig(over: Partial<BaseSignature> = {}): BaseSignature {
  const first = card("1", "Mike Trout");
  return {
    status: "ok",
    baseId: "base1",
    baseName: "Base",
    first,
    perSide: { bsc: 0, sportlots: 0 },
    cards: [first, card("2", "Aaron Judge"), card("3", "Shohei Ohtani")],
    ...over,
  };
}

const seen = (
  cardNumber: string,
  cardName: string,
  extra: Partial<ObservedCard> = {},
): ObservedCard => ({ cardNumber, cardName, ...extra });

describe("judgeFirstCard — number + who", () => {
  test("the first card matches on exact number and who", () => {
    expect(judgeFirstCard(sig(), seen("1", "Mike Trout"))).toBe("match");
  });

  test("the same number with a different who is a mismatch", () => {
    expect(judgeFirstCard(sig(), seen("1", "Someone Else"))).toBe("mismatch");
  });

  test("a different number with the same who is a mismatch", () => {
    expect(judgeFirstCard(sig(), seen("9", "Mike Trout"))).toBe("mismatch");
  });

  test("no card, or a blank number, is unknown rather than a mismatch", () => {
    expect(judgeFirstCard(sig(), null)).toBe("unknown");
    expect(judgeFirstCard(sig(), undefined)).toBe("unknown");
    expect(judgeFirstCard(sig(), seen("   ", "Mike Trout"))).toBe("unknown");
  });

  test("trims and upper-cases before comparing: '1a' equals '1A'", () => {
    const s = sig({
      first: card("1A", "Mike Trout"),
      cards: [card("1A", "Mike Trout")],
    });
    expect(judgeFirstCard(s, seen(" 1a ", "Mike Trout"))).toBe("match");
  });
});

describe("judgeFirstCard — the prefix belongs to the marketplace number only", () => {
  const prefixed = sig({ cardNumberPrefix: "US" });

  test("strips the prefix from the marketplace number: 'US1' vs Base '1'", () => {
    expect(judgeFirstCard(prefixed, seen("US1", "Mike Trout"))).toBe("match");
  });

  test("strips it case-insensitively and after trimming", () => {
    expect(judgeFirstCard(prefixed, seen(" us1 ", "Mike Trout"))).toBe("match");
  });

  test("a marketplace number without the prefix still matches", () => {
    expect(judgeFirstCard(prefixed, seen("1", "Mike Trout"))).toBe("match");
  });

  test("never re-strips the Base's number: a Base card literally numbered 'US1' is not '1'", () => {
    const s = sig({
      cardNumberPrefix: "US",
      first: card("US1", "Mike Trout"),
      cards: [card("US1", "Mike Trout")],
    });
    // The marketplace's "US1" loses its prefix to "1", the Base stays "US1".
    expect(judgeFirstCard(s, seen("US1", "Mike Trout"))).toBe("mismatch");
  });

  test("a number that IS the prefix is left whole, never stripped to nothing", () => {
    const s = sig({
      cardNumberPrefix: "US",
      first: card("US", "Mike Trout"),
      cards: [card("US", "Mike Trout")],
    });
    expect(judgeFirstCard(s, seen("US", "Mike Trout"))).toBe("match");
    expect(normalizedCardNumber("US", "US")).toBe("US");
  });

  test("normalizedCardNumber strips only when asked to", () => {
    expect(normalizedCardNumber(" us12 ", "US")).toBe("12");
    expect(normalizedCardNumber(" us12 ", undefined)).toBe("US12");
  });
});

describe("sameWho", () => {
  test("players are compared with playersKey, order-insensitively", () => {
    const base = card("1", "Trout / Ohtani", {
      namesOnCard: ["Mike Trout", "Shohei Ohtani"],
    });
    expect(
      sameWho(base, seen("1", "x", { players: ["Shohei Ohtani", "Mike Trout"] })),
    ).toBe(true);
    expect(sameWho(base, seen("1", "x", { players: ["Mike Trout"] }))).toBe(false);
  });

  test("with no players the titles are compared with nameKey", () => {
    const base = card("1", "Mike Trout");
    expect(sameWho(base, seen("1", "MIKE  TROUT."))).toBe(true);
    expect(sameWho(base, seen("1", "Mike Trout Jr"))).toBe(false);
  });

  test("a team card agrees on number alone, whatever the marketplace calls it", () => {
    const team = card("5", "Angels Team Card", { namesOnCard: [], isTeamCard: true });
    expect(sameWho(team, seen("5", "Los Angeles Angels"))).toBe(true);
  });

  test("a card with no names and an empty title never agrees", () => {
    const blank = card("1", "", { namesOnCard: [], isTeamCard: false });
    expect(sameWho(blank, seen("1", ""))).toBe(false);
    expect(sameWho(blank, seen("1", "Anyone"))).toBe(false);
  });

  test("whitespace-only names are ignored", () => {
    const base = card("1", "Mike Trout", { namesOnCard: ["  ", "Mike Trout"] });
    expect(sameWho(base, seen("1", "x", { players: [" ", "Mike Trout"] }))).toBe(true);
  });
});

describe("judgeFirstCard — the fallback by number", () => {
  test("a marketplace sorted differently still matches a non-first Base card", () => {
    expect(judgeFirstCard(sig(), seen("3", "Shohei Ohtani"))).toBe("match");
  });

  test("two Base cards share the number and only the second agrees: match", () => {
    const s = sig({
      cards: [
        card("1", "Mike Trout"),
        card("7", "Aaron Judge"),
        card("7", "Shohei Ohtani"),
      ],
    });
    expect(judgeFirstCard(s, seen("7", "Shohei Ohtani"))).toBe("match");
  });

  test("no Base card on the number agrees: mismatch", () => {
    const s = sig({
      cards: [card("1", "Mike Trout"), card("7", "Aaron Judge"), card("7", "Bob")],
    });
    expect(judgeFirstCard(s, seen("7", "Shohei Ohtani"))).toBe("mismatch");
  });

  test("a number the Base does not have at all is a mismatch", () => {
    expect(judgeFirstCard(sig(), seen("99", "Mike Trout"))).toBe("mismatch");
  });
});

describe("judgeAgainstBase — count", () => {
  const withSl = (n: number) => sig({ perSide: { bsc: 0, sportlots: n } });

  test("an exactly equal count with the first card agreeing is a match", () => {
    const j = judgeAgainstBase(withSl(3), "sportlots", {
      status: "ok",
      first: seen("1", "Mike Trout"),
      count: 3,
    });
    expect(j).toEqual({ verdict: "match", reason: BASE_MATCH_COPY.matched });
  });

  test("off by one, either way, is a mismatch", () => {
    for (const count of [2, 4]) {
      const j = judgeAgainstBase(withSl(3), "sportlots", {
        status: "ok",
        first: seen("1", "Mike Trout"),
        count,
      });
      expect(j.verdict).toBe("mismatch");
    }
  });

  test("a correct count does not rescue a first card that disagrees", () => {
    const j = judgeAgainstBase(withSl(3), "sportlots", {
      status: "ok",
      first: seen("1", "Someone Else"),
      count: 3,
    });
    expect(j.verdict).toBe("mismatch");
  });

  test("the count is measured against THIS side's linked cards, not the other's", () => {
    const s = sig({ perSide: { bsc: 10, sportlots: 3 } });
    const obs = { status: "ok" as const, first: seen("1", "Mike Trout"), count: 3 };
    expect(judgeAgainstBase(s, "sportlots", obs).verdict).toBe("match");
    expect(judgeAgainstBase(s, "bsc", obs).verdict).toBe("mismatch");
  });

  test("a side with no linked Base cards is judged on the first card alone", () => {
    const j = judgeAgainstBase(sig(), "sportlots", {
      status: "ok",
      first: seen("1", "Mike Trout"),
    });
    expect(j.verdict).toBe("match");
    const bad = judgeAgainstBase(sig(), "sportlots", {
      status: "ok",
      first: seen("1", "Someone Else"),
    });
    expect(bad.verdict).toBe("mismatch");
  });

  test("a side with no linked Base cards and no first card is unverifiable", () => {
    expect(
      judgeAgainstBase(sig(), "sportlots", { status: "ok", first: null }),
    ).toEqual({
      verdict: "unverifiable",
      reason: BASE_MATCH_COPY.nothingToCompare("sportlots"),
    });
  });

  test("a missing count while the side has linked cards is unverifiable, never guessed", () => {
    expect(
      judgeAgainstBase(withSl(3), "sportlots", {
        status: "ok",
        first: seen("1", "Mike Trout"),
      }),
    ).toEqual({
      verdict: "unverifiable",
      reason: BASE_MATCH_COPY.unverifiable("sportlots"),
    });
  });

  test("an exact count with no first card to compare still matches", () => {
    const j = judgeAgainstBase(withSl(3), "sportlots", {
      status: "ok",
      first: null,
      count: 3,
    });
    expect(j.verdict).toBe("match");
  });
});

describe("judgeAgainstBase — the other outcomes", () => {
  test("only variations on the first page is a mismatch, with its reason", () => {
    const j = judgeAgainstBase(sig(), "sportlots", {
      status: "ok",
      first: null,
      onlyVariations: true,
    });
    expect(j).toEqual({
      verdict: "mismatch",
      reason:
        "Doesn't match the Base — only variations on its first page (Base: first #1 Mike Trout)",
    });
  });

  test("a failed probe is unverifiable, on either side", () => {
    for (const side of ["bsc", "sportlots"] as const) {
      expect(judgeAgainstBase(sig(), side, { status: "failed" })).toEqual({
        verdict: "unverifiable",
        reason: BASE_MATCH_COPY.unverifiable(side),
      });
    }
  });
});

describe("needsCount", () => {
  const s = sig({ perSide: { bsc: 0, sportlots: 3 } });

  test("a side with linked cards counts after a matching first card", () => {
    expect(needsCount(s, "sportlots", "match")).toBe(true);
  });

  test("a first card that could not be read still gets counted", () => {
    expect(needsCount(s, "sportlots", "unknown")).toBe(true);
  });

  test("a first-card mismatch costs no count", () => {
    expect(needsCount(s, "sportlots", "mismatch")).toBe(false);
  });

  test("a side with no linked cards never counts", () => {
    expect(needsCount(s, "bsc", "match")).toBe(false);
    expect(needsCount(s, "bsc", "unknown")).toBe(false);
  });
});

describe("the copy a verdict puts on screen", () => {
  test("a mismatch reason names what was seen and what the Base has", () => {
    const s = sig({ perSide: { bsc: 0, sportlots: 3 } });
    const j = judgeAgainstBase(s, "sportlots", {
      status: "ok",
      first: seen("2", "Aaron Judge", { players: ["Aaron Judge"] }),
      count: 3,
    });
    // Number 2 is Aaron Judge in the Base, so the first card is found by
    // fallback; the count is equal, so this is a match.
    expect(j.verdict).toBe("match");

    const off = judgeAgainstBase(s, "sportlots", {
      status: "ok",
      first: seen("1", "Mike Trout"),
      count: 1,
    });
    expect(off.reason).toBe(
      "Doesn't match the Base — 1 card, first #1 Mike Trout (Base: 3 on SportLots, first #1 Mike Trout)",
    );
  });

  test("a first-card mismatch on a side without linked cards says no count for the Base", () => {
    const j = judgeAgainstBase(sig(), "bsc", {
      status: "ok",
      first: seen("9", "Nobody"),
    });
    expect(j.reason).toBe(
      "Doesn't match the Base — first #9 Nobody (Base: first #1 Mike Trout)",
    );
  });

  test("a card with no title is labelled by the names printed on it", () => {
    const s = sig({
      first: card("1", "", { namesOnCard: ["Mike Trout", "Aaron Judge"] }),
      cards: [],
    });
    const j = judgeAgainstBase(s, "bsc", {
      status: "ok",
      first: seen("4", "", { players: ["Bob", "Sue"] }),
    });
    expect(j.reason).toBe(
      "Doesn't match the Base — first #4 Bob / Sue (Base: first #1 Mike Trout / Aaron Judge)",
    );
  });

  test("a marketplace that listed nothing reads as 0 cards", () => {
    const j = judgeAgainstBase(sig(), "bsc", {
      status: "ok",
      first: seen("   ", "x"),
    });
    // An unreadable number is "unknown", so nothing to compare, not a mismatch.
    expect(j.verdict).toBe("unverifiable");
    const s = sig({ perSide: { bsc: 4, sportlots: 0 } });
    const empty = judgeAgainstBase(s, "bsc", { status: "ok", first: null, count: 0 });
    expect(empty.reason).toBe(
      "Doesn't match the Base — 0 cards (Base: 4 on BSC, first #1 Mike Trout)",
    );
  });

  test("checkedHeader counts matches, mismatches and — only when there are some — unchecked", () => {
    expect(BASE_MATCH_COPY.checkedHeader(3, 1, 0)).toBe(
      "Checked against Base — 3 match, 1 don't",
    );
    expect(BASE_MATCH_COPY.checkedHeader(3, 1, 2)).toBe(
      "Checked against Base — 3 match, 1 don't, 2 couldn't be checked",
    );
  });

  test("checkingHeader reads 'done of total'", () => {
    expect(BASE_MATCH_COPY.checkingHeader(4, 10)).toBe(
      "Checking against Base — 4 of 10",
    );
  });

  test("keepAllLeftOut names only what it leaves out", () => {
    expect(BASE_MATCH_COPY.keepAllLeftOut(0, 0)).toBe("");
    expect(BASE_MATCH_COPY.keepAllLeftOut(2, 0)).toBe(
      " Leaves out 2 still being checked against the Base.",
    );
    expect(BASE_MATCH_COPY.keepAllLeftOut(0, 3)).toBe(
      " Leaves out 3 that don't match the Base.",
    );
    expect(BASE_MATCH_COPY.keepAllLeftOut(2, 3)).toBe(
      " Leaves out 2 still being checked against the Base and 3 that don't match the Base.",
    );
  });

  test("the toggle's accessible name begins with its visible words and ends with the column", () => {
    const visible = BASE_MATCH_COPY.showMismatched(4);
    expect(BASE_MATCH_COPY.toggleName(visible, "sportlots")).toBe(
      `${visible}, SportLots`,
    );
    expect(BASE_MATCH_COPY.toggleName(visible, "bsc")).toBe(`${visible}, BSC`);
  });
});
