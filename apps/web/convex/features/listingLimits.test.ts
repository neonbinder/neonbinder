/**
 * NEO-101: the marketplace length limits, pinned.
 *
 * Modelled on `convex/sku.test.ts`, and for the same reason: these are numbers
 * transcribed from someone else's documentation, so the test's job is to make
 * a change to one of them DELIBERATE. A number that moves because an eBay
 * policy actually changed should arrive with a red test and a re-read of the
 * doc block in `listingLimits.ts`; a number that moves because someone was
 * tidying should never get that far.
 *
 * The relational assertions below are the part that is not merely a
 * transcription: they encode that the two CLIP values are soft bands UNDER the
 * one hard cap, which is the distinction the whole feature turns on.
 */

import { describe, expect, test } from "vitest";
import {
  ASPECT_VALUE_MAX,
  LISTING_TITLE_MAX,
  LISTING_TITLE_MOBILE_CLIP,
  LISTING_TITLE_SEARCH_CLIP,
} from "./listingLimits";

describe("listing limits", () => {
  test("the confirmed values (2026-09-02)", () => {
    expect(LISTING_TITLE_MAX).toBe(80);
    expect(LISTING_TITLE_MOBILE_CLIP).toBe(55);
    expect(LISTING_TITLE_SEARCH_CLIP).toBe(70);
    expect(ASPECT_VALUE_MAX).toBe(65);
  });

  test("the display bands sit strictly under the hard cap, in clip order", () => {
    // mobile tiles clip earlier than desktop search results, and neither is a
    // limit — a title between the two bands is perfectly listable.
    expect(LISTING_TITLE_MOBILE_CLIP).toBeLessThan(LISTING_TITLE_SEARCH_CLIP);
    expect(LISTING_TITLE_SEARCH_CLIP).toBeLessThan(LISTING_TITLE_MAX);
  });

  test("the aspect-value cap is independent of the title cap", () => {
    // Different eBay field, different number. Pinned so a future "tidy up,
    // they're all 80" cannot quietly happen.
    expect(ASPECT_VALUE_MAX).not.toBe(LISTING_TITLE_MAX);
    expect(ASPECT_VALUE_MAX).toBeLessThan(LISTING_TITLE_MAX);
  });

  test("every limit is a positive whole number of characters", () => {
    for (const limit of [
      LISTING_TITLE_MAX,
      LISTING_TITLE_MOBILE_CLIP,
      LISTING_TITLE_SEARCH_CLIP,
      ASPECT_VALUE_MAX,
    ]) {
      expect(Number.isInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
    }
  });
});
