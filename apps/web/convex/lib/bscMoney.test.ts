import { describe, expect, test } from "vitest";
import {
  BSC_MAX_PRICE_CENTS,
  BSC_MIN_PRICE_CENTS,
  bscDollarsToCents,
  centsToBscDollars,
  checkBscPrice,
} from "./bscMoney";

describe("bscMoney (NEO-370)", () => {
  test("dollars strings and numbers to cents", () => {
    expect(bscDollarsToCents("0.25")).toBe(25);
    expect(bscDollarsToCents("0")).toBe(0);
    expect(bscDollarsToCents("1.69")).toBe(169);
    expect(bscDollarsToCents("0.0")).toBe(0);
    expect(bscDollarsToCents(3.44)).toBe(344);
    expect(bscDollarsToCents(".5")).toBe(50);
  });

  test("rounds float noise and half cents up", () => {
    expect(bscDollarsToCents("1.3299439999999998")).toBe(133);
    expect(bscDollarsToCents("0.420056")).toBe(42);
    expect(bscDollarsToCents(0.285)).toBe(29);
    expect(bscDollarsToCents("1.005")).toBe(101);
  });

  test("null for what is not a number", () => {
    expect(bscDollarsToCents("")).toBeNull();
    expect(bscDollarsToCents("abc")).toBeNull();
    expect(bscDollarsToCents("$1.00")).toBeNull();
    expect(bscDollarsToCents(null)).toBeNull();
    expect(bscDollarsToCents(undefined)).toBeNull();
    expect(bscDollarsToCents(Number.NaN)).toBeNull();
    expect(bscDollarsToCents({})).toBeNull();
  });

  test("cents back to the dollars number a PUT sends", () => {
    expect(centsToBscDollars(25)).toBe(0.25);
    expect(centsToBscDollars(99_900)).toBe(999);
  });

  test("price check: none, below the minimum, in range, above the cap", () => {
    expect(checkBscPrice(null)).toEqual({ ok: false, reason: "no_price" });
    expect(checkBscPrice(undefined)).toEqual({ ok: false, reason: "no_price" });
    expect(checkBscPrice(0)).toEqual({ ok: true, priceCents: BSC_MIN_PRICE_CENTS, raisedToMinimum: true });
    expect(checkBscPrice(24)).toEqual({ ok: true, priceCents: 25, raisedToMinimum: true });
    expect(checkBscPrice(25)).toEqual({ ok: true, priceCents: 25, raisedToMinimum: false });
    expect(checkBscPrice(BSC_MAX_PRICE_CENTS)).toEqual({ ok: true, priceCents: 99_900, raisedToMinimum: false });
    expect(checkBscPrice(BSC_MAX_PRICE_CENTS + 1)).toEqual({ ok: false, reason: "price_too_high" });
  });
});
