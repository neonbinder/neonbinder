/**
 * Unit tests for the shared postal-address helpers (NEO-118).
 *
 * These two functions carry more weight than their size suggests:
 * `formatAddressBlock` is the single source of truth for how an address renders
 * in BOTH the on-screen preview and the printed label, and `isCompleteAddress`
 * is the only thing standing between a user and a wasted 4×6 thermal label. The
 * cases below are the ones that actually produce a bad label — a blank line
 * where an optional field was omitted, a missing ZIP that still let Print
 * enable, whitespace-only input passing as filled.
 */

import { describe, expect, test } from "vitest";
import {
  EMPTY_ADDRESS,
  formatAddressBlock,
  isCompleteAddress,
  type PostalAddress,
} from "./address";

const COMPLETE: PostalAddress = {
  name: "Jane Buyer",
  line1: "123 Main St",
  city: "Dallas",
  state: "TX",
  postalCode: "75201",
  country: "US",
};

describe("formatAddressBlock", () => {
  test("renders the minimum address as three uppercase lines", () => {
    expect(formatAddressBlock(COMPLETE)).toEqual([
      "JANE BUYER",
      "123 MAIN ST",
      "DALLAS TX 75201",
    ]);
  });

  test("places company between the name and the street, USPS order", () => {
    expect(
      formatAddressBlock({ ...COMPLETE, company: "Neon Cards LLC" }),
    ).toEqual([
      "JANE BUYER",
      "NEON CARDS LLC",
      "123 MAIN ST",
      "DALLAS TX 75201",
    ]);
  });

  test("places line2 directly after line1", () => {
    expect(formatAddressBlock({ ...COMPLETE, line2: "Apt 4B" })).toEqual([
      "JANE BUYER",
      "123 MAIN ST",
      "APT 4B",
      "DALLAS TX 75201",
    ]);
  });

  // The defect this guards against: an empty optional field emitting an empty
  // string into the array, which renders as a blank line mid-address.
  test("drops omitted optional fields instead of emitting blank lines", () => {
    const lines = formatAddressBlock({
      ...COMPLETE,
      company: "",
      line2: "   ",
    });
    expect(lines).not.toContain("");
    expect(lines).toHaveLength(3);
  });

  test("omits the country line for US addresses", () => {
    expect(formatAddressBlock(COMPLETE)).not.toContain("US");
  });

  test("appends a country line for non-US addresses", () => {
    expect(
      formatAddressBlock({ ...COMPLETE, country: "CA" }).at(-1),
    ).toBe("CA");
  });

  test("trims stray whitespace rather than printing it", () => {
    expect(
      formatAddressBlock({ ...COMPLETE, name: "  Jane Buyer  " })[0],
    ).toBe("JANE BUYER");
  });

  test("returns an empty array for null/undefined", () => {
    expect(formatAddressBlock(null)).toEqual([]);
    expect(formatAddressBlock(undefined)).toEqual([]);
  });

  test("collapses the city line when parts are missing rather than leaving gaps", () => {
    expect(
      formatAddressBlock({ ...COMPLETE, state: "", postalCode: "" }).at(-1),
    ).toBe("DALLAS");
  });
});

describe("isCompleteAddress", () => {
  test("accepts an address with every required field", () => {
    expect(isCompleteAddress(COMPLETE)).toBe(true);
  });

  test("accepts a complete address regardless of optional fields", () => {
    expect(
      isCompleteAddress({ ...COMPLETE, company: "", line2: "" }),
    ).toBe(true);
  });

  test.each(["name", "line1", "city", "state", "postalCode"] as const)(
    "rejects an address missing %s",
    (field) => {
      expect(isCompleteAddress({ ...COMPLETE, [field]: "" })).toBe(false);
    },
  );

  // Whitespace-only input is what you get from a user who tabbed through a
  // field and hit space. It must not enable Print.
  test("rejects whitespace-only required fields", () => {
    expect(isCompleteAddress({ ...COMPLETE, postalCode: "   " })).toBe(false);
  });

  test("rejects the empty address the form starts from", () => {
    expect(isCompleteAddress(EMPTY_ADDRESS)).toBe(false);
  });

  test("rejects null/undefined", () => {
    expect(isCompleteAddress(null)).toBe(false);
    expect(isCompleteAddress(undefined)).toBe(false);
  });

  // company/line2 are genuinely optional — a missing one must not gate Print.
  test("does not require company or line2", () => {
    const { company: _c, line2: _l, ...withoutOptionals } = {
      ...COMPLETE,
      company: "x",
      line2: "y",
    };
    expect(isCompleteAddress(withoutOptionals)).toBe(true);
  });
});
