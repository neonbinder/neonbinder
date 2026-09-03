import { describe, expect, it } from "vitest";
import { formatUsd } from "./money";

describe("formatUsd", () => {
  it("renders whole dollars with both decimal places", () => {
    expect(formatUsd(1200)).toBe("$12.00");
  });

  it("keeps the trailing zero on a sub-dollar amount", () => {
    // The real case: a 1oz First-Class letter is 80 cents, and "$0.8" reads
    // like a truncated number next to "$1.05".
    expect(formatUsd(80)).toBe("$0.80");
  });

  it("renders zero rather than an empty string", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("renders cents that are not a round number of dollars", () => {
    expect(formatUsd(1234)).toBe("$12.34");
  });

  it("rounds a fractional cent to two places instead of leaking it", () => {
    // Not expected from Convex, which stores integers — but a rounded value is
    // still a readable price, where "$0.805" is not.
    expect(formatUsd(80.5)).toBe("$0.81");
  });
});
