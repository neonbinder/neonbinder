/**
 * NEO-536 — the words Card Requests' Sync reports and the dashboard's crew
 * rows say. A `.test.tsx` although it renders nothing: under `app/` only
 * `.test.tsx` is collected (`vitest.include.mjs`).
 */

import { describe, expect, it } from "vitest";
import { SYNC_REPORT_GROUP_COUNT_CAP } from "@/lib/collection/sync-report";
import {
  ALSO_REPORTED_INK,
  alsoReportedLine,
  alsoReportedSentence,
  alsoReportedSpoken,
  heldBackWords,
  syncReportWhen,
  waitedFor,
} from "./syncReportCopy";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13, 18);

describe("waitedFor", () => {
  it.each([
    [0, "sent today"],
    [1, "waiting 1 day"],
    [13, "waiting 13 days"],
    [14, "waiting 2 weeks"],
    [21, "waiting 3 weeks"],
  ])("%i days → %s", (days, words) => {
    expect(waitedFor(NOW - days * DAY, NOW)).toBe(words);
  });

  it("counts whole days: a day less a minute is still today", () => {
    expect(waitedFor(NOW - DAY + 60_000, NOW)).toBe("sent today");
  });

  it("a report stamped after now (clock skew) reads as sent today, never a negative wait", () => {
    expect(waitedFor(NOW + 5 * DAY, NOW)).toBe("sent today");
  });
});

describe("how many others reported the same set", () => {
  const CAP = SYNC_REPORT_GROUP_COUNT_CAP;

  it.each([
    [0, null, null, null],
    [1, "+1 reported", "also reported by 1 other collector", "Also reported by 1 other collector. Closing this closes theirs too."],
    [2, "+2 reported", "also reported by 2 other collectors", "Also reported by 2 other collectors. Closing this closes theirs too."],
    [
      CAP - 1,
      `+${CAP - 1} reported`,
      `also reported by ${CAP - 1} other collectors`,
      `Also reported by ${CAP - 1} other collectors. Closing this closes theirs too.`,
    ],
    [
      CAP,
      `${CAP}+ reported`,
      `also reported by ${CAP} or more other collectors`,
      `Also reported by ${CAP} or more other collectors. Closing this closes theirs too.`,
    ],
  ])("n = %i", (n, line, spoken, sentence) => {
    expect(alsoReportedLine(n)).toBe(line);
    expect(alsoReportedSpoken(n)).toBe(spoken);
    expect(alsoReportedSentence(n)).toBe(sentence);
  });

  it("past the cap reads as the cap (the server never counts further)", () => {
    expect(alsoReportedLine(CAP + 5)).toBe(`${CAP}+ reported`);
    expect(alsoReportedSpoken(CAP + 5)).toBe(`also reported by ${CAP} or more other collectors`);
  });

  it("wears the crew's blue, never the warning amber", () => {
    expect(ALSO_REPORTED_INK).toBe("text-neon-blue-text");
  });
});

describe("heldBackWords", () => {
  it("one card, then many", () => {
    expect(heldBackWords(1)).toBe("1 card held back");
    expect(heldBackWords(2)).toBe("2 cards held back");
  });
});

describe("syncReportWhen", () => {
  const AT = Date.UTC(2026, 10, 13, 15, 5, 42);

  it("is the medium date and short time, in the reader's own locale", () => {
    expect(syncReportWhen(AT)).toBe(new Date(AT).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
  });

  it("carries the year and no seconds", () => {
    const when = syncReportWhen(AT);
    expect(when).toContain("2026");
    expect(when).not.toMatch(/\d:\d\d:\d\d/);
  });

  it("tells two moments on one day apart", () => {
    expect(syncReportWhen(AT)).not.toBe(syncReportWhen(AT + 2 * 60 * 60 * 1000));
  });
});
