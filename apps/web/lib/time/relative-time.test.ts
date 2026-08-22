/**
 * The boundaries are the whole content of this helper — everything else is a
 * template literal. Each case below is a place a label could name a unit the
 * elapsed time has not actually reached.
 */

import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relative-time";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = 1_760_000_000_000;
const ago = (ms: number) => formatRelativeTime(NOW - ms, NOW);

describe("formatRelativeTime", () => {
  it("says 'just now' below the seconds threshold", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(44 * SECOND)).toBe("just now");
  });

  it("never prints '0m ago'", () => {
    // 45s is past the threshold but floors to zero minutes. A unit label with a
    // zero in it reads as "no time has passed", which is what "just now" is for.
    expect(ago(45 * SECOND)).toBe("1m ago");
  });

  it("floors within a unit instead of rounding into the next one", () => {
    expect(ago(59 * MINUTE + 59 * SECOND)).toBe("59m ago");
    expect(ago(23 * HOUR + 59 * MINUTE)).toBe("23h ago");
  });

  it("steps units exactly at the boundary", () => {
    expect(ago(HOUR)).toBe("1h ago");
    expect(ago(DAY)).toBe("1d ago");
  });

  it("keeps counting in days for old runs", () => {
    expect(ago(45 * DAY)).toBe("45d ago");
  });

  it("reads a future timestamp as 'just now' rather than a negative age", () => {
    // Clock skew between the Convex server that stamped the row and the browser
    // rendering it. "in 2 minutes ago" is worse than slightly wrong.
    expect(formatRelativeTime(NOW + 2 * MINUTE, NOW)).toBe("just now");
  });
});
