import { describe, expect, it } from "vitest";
import { MAX_COST_CENTS } from "@/convex/collection";
import { MAX_PRICE_CENTS } from "./price-cap";

// NEO-479 — the client cannot import the server's cap (it would pull the
// server graph into the bundle), so it keeps a copy. This holds the two equal:
// a client cap above the server's would let the Sell panel send a price the
// server refuses, and one below it would refuse a price the server takes.
describe("MAX_PRICE_CENTS (NEO-479)", () => {
  it("is the server's price cap", () => {
    expect(MAX_PRICE_CENTS).toBe(MAX_COST_CENTS);
  });
});
