import { describe, expect, it } from "vitest";
import {
  BSC_NAME,
  CREDENTIALS_PATH,
  credentialsPathFor,
  EBAY_CONSENT_LINE,
  EBAY_NAME,
  EBAY_PATH,
  EBAY_SETUP_LINE,
  PAUSED_LINE,
  PLATFORM_NAME,
  PLATFORM_PROFILE_PATH,
  REAUTH_LINE,
  SELLER_CONFLICT_LINE,
  pausedLine,
  reauthLine,
  sellerConflictLine,
} from "./listing-copy";

describe("listing copy per platform (NEO-415)", () => {
  it("names and Profile pages are keyed by NB's own platform key", () => {
    expect(PLATFORM_NAME).toEqual({ bsc: BSC_NAME, ebay: "eBay" });
    // Both land on Profile → Credentials with their own platform picked.
    expect(PLATFORM_PROFILE_PATH).toEqual({
      bsc: "/profile/credentials?platform=buysportscards",
      ebay: "/profile/credentials?platform=ebay",
    });
    expect(EBAY_PATH).toBe(`${CREDENTIALS_PATH}?platform=ebay`);
    expect(credentialsPathFor("sportlots")).toBe("/profile/credentials?platform=sportlots");
  });

  it("the BSC sentences are unchanged by the generalisation", () => {
    expect(PAUSED_LINE).toBe(`${BSC_NAME} is on a break. Your changes wait here and go up when it's back.`);
    expect(REAUTH_LINE).toBe(`Your ${BSC_NAME} sign-in ran out, so nothing goes up until you sign in again.`);
    expect(SELLER_CONFLICT_LINE).toBe(sellerConflictLine(BSC_NAME));
    expect(pausedLine(BSC_NAME)).toBe(PAUSED_LINE);
    expect(reauthLine("bsc")).toBe(REAUTH_LINE);
  });

  it("eBay reads as a connection, not a sign-in", () => {
    expect(reauthLine("ebay")).toBe("Your eBay connection ran out, so nothing goes up until you connect again.");
    expect(reauthLine("ebay")).not.toMatch(/sign-in/);
    expect(pausedLine(EBAY_NAME)).toContain("eBay is on a break");
    expect(sellerConflictLine(EBAY_NAME)).toContain("That eBay seller account");
  });

  it("the seller-conflict line names the username inside the sentence, never after it", () => {
    expect(sellerConflictLine(EBAY_NAME, "cardshark88")).toBe(
      "That eBay seller account (cardshark88) already lists from another NeonBinder account, so nothing goes up or comes in from this one.",
    );
    expect(sellerConflictLine(EBAY_NAME, null)).toBe(sellerConflictLine(EBAY_NAME));
  });

  it("the setup and consent lines never use an internal word", () => {
    for (const line of [EBAY_SETUP_LINE, EBAY_CONSENT_LINE]) {
      expect(line).not.toMatch(/outbox|lease|drain|SKU|offer id|inventory item/i);
    }
    expect(EBAY_SETUP_LINE).toContain("setup isn't finished");
    expect(EBAY_CONSENT_LINE).toContain("in-person box");
    expect(EBAY_CONSENT_LINE).toContain("we take down the ones we put up");
  });
});
