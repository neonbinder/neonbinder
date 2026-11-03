import { describe, expect, it } from "vitest";
import {
  EBAY_ORDERS_URL,
  EBAY_SANDBOX_ORDERS_URL,
  PROBLEM_COPY,
  PROBLEM_COPY_READ_ONLY,
  UNMATCHED_CARD,
  ebayOrderUrl,
  orderStatus,
  ordersUrl,
  pausedLineReadOnly,
  problemCardName,
  problemCopy,
  problemCopyReadOnly,
  problemSentence,
  reauthLineReadOnly,
  saleCondition,
  saleItemProblem,
  unmatchedCard,
} from "./copy";

describe("listing copy, per platform (NEO-415)", () => {
  it("every problem reason has a sentence on every platform, and BSC's are the ones NEO-370 shipped", () => {
    const reasons = Object.keys(problemCopy("bsc"));
    expect(Object.keys(problemCopy("ebay")).sort()).toEqual(reasons.sort());
    expect(PROBLEM_COPY).toEqual(problemCopy("bsc"));
    expect(PROBLEM_COPY.noLink).toBe("BuySportsCards has no match for this card yet, so there's nowhere to list it.");
    expect(PROBLEM_COPY.priceTooHigh).toBe("Priced over $999, the most BuySportsCards takes.");
    expect(PROBLEM_COPY_READ_ONLY).toEqual(problemCopyReadOnly("bsc"));
  });

  it("eBay sentences name eBay, and none promises a BSC-only limit", () => {
    const copy = problemCopy("ebay");
    for (const sentence of Object.values(copy)) expect(sentence).not.toMatch(/BuySportsCards|\$999/);
    expect(copy.noPhoto).toBe("eBay listings need a photo. Add one to a copy of this card and it goes up.");
    // NEO-415: eBay's settings live under Profile → Credentials → eBay; the line says so, never just "your Profile".
    expect(copy.setupIncomplete).toBe("Finish your eBay setup in Profile → Credentials → eBay and this one goes up.");
    expect(copy.missingAspect).toContain("eBay");
    expect(problemCopyReadOnly("ebay").setupIncomplete).toBe("The collector's eBay setup isn't finished.");
    expect(problemCopyReadOnly("ebay").noPhoto).toContain("eBay listings need one");
  });

  it("missingAspect names the detail the server gave, and says eBay", () => {
    expect(problemSentence({ reason: "missingAspect", detail: "Team, Set" }, false, "ebay")).toBe(
      "eBay wants this card's Team, Set, and we don't have it yet, so it's held back.",
    );
    expect(problemSentence({ reason: "missingAspect" }, false, "ebay")).toBe(problemCopy("ebay").missingAspect);
    expect(problemSentence({ reason: "missingAspect", detail: "   " }, false, "ebay")).toBe(problemCopy("ebay").missingAspect);
  });

  it("a rejected row's detail is NB's own sentence, said as ours, never as a quote from the platform", () => {
    // EBAY_CARD_REJECTED (convex/listingDrainEbay.ts) and BSC's rejectedPushDetail are both NB-written.
    const ebay = "Its photos didn't go through. Check them on the card, then press Sync.";
    expect(problemSentence({ reason: "rejected", detail: ebay }, false, "ebay")).toBe(`eBay turned this one down. ${ebay}`);
    const bsc = "NeonBinder sent 3 for Near Mint, but the listing didn't take it.";
    expect(problemSentence({ reason: "rejected", detail: bsc }, false, "bsc")).toBe(`BuySportsCards turned this one down. ${bsc}`);
    for (const platform of ["ebay", "bsc"] as const) {
      expect(problemSentence({ reason: "rejected", detail: "Check the card" }, false, platform)).not.toMatch(/They said|“|”/);
    }
    // A detail with no full stop still ends as a sentence; none at all leaves the reason alone.
    expect(problemSentence({ reason: "rejected", detail: "Check the card" }, false, "ebay")).toBe(
      "eBay turned this one down. Check the card.",
    );
    expect(problemSentence({ reason: "rejected" }, false, "ebay")).toBe("eBay turned this one down.");
  });

  it("BSC callers that pass no platform still get BSC's sentence", () => {
    expect(problemSentence({ reason: "noLink" })).toBe(PROBLEM_COPY.noLink);
    expect(problemSentence({ reason: "noLink" }, true)).toBe(PROBLEM_COPY_READ_ONLY.noLink);
  });

  it("read-only lines are about the collector, per platform", () => {
    expect(pausedLineReadOnly("ebay")).toBe("eBay is on a break. Changes wait here and go up when it's back.");
    expect(reauthLineReadOnly("ebay")).toBe("The eBay connection ran out, so nothing goes up until the collector connects again.");
    expect(reauthLineReadOnly("bsc")).toContain("sign-in ran out");
  });

  it("an unmatched card says 'An eBay' and 'A BuySportsCards'", () => {
    expect(unmatchedCard("ebay")).toBe("An eBay card we can't match");
    expect(unmatchedCard("bsc")).toBe("A BuySportsCards card we can't match");
    expect(UNMATCHED_CARD).toBe(unmatchedCard("bsc"));
    expect(problemCardName({ cardNo: undefined, cardLabel: undefined }, "ebay")).toBe("An eBay card we can't match");
  });

  it("eBay order statuses read in plain words, case-insensitively, and an unknown one is tidied", () => {
    expect(orderStatus("NOT_STARTED", "ebay")).toBe("Ready to ship");
    expect(orderStatus("IN_PROGRESS", "ebay")).toBe("Partly shipped");
    expect(orderStatus("FULFILLED", "ebay")).toBe("Shipped");
    expect(orderStatus("FULLY_REFUNDED", "ebay")).toBe("Refunded");
    expect(orderStatus("CANCELED", "ebay")).toBe("Cancelled");
    expect(orderStatus("canceled", "ebay")).toBe("Cancelled");
    expect(orderStatus("PENDING", "ebay")).toBe("Payment pending");
    // BSC's words stay BSC's: SHIPPED is not an eBay word.
    expect(orderStatus("SHIPPED")).toBe("Shipped");
    expect(orderStatus("READY_TO_SHIP")).toBe("Ready to ship");
    expect(orderStatus("NOT_STARTED")).not.toBe("Ready to ship");
  });

  it("an eBay sale line's bucket reads the way eBay's listing says it", () => {
    expect(saleCondition("NM", "ebay")).toBe("Near Mint or better");
    expect(saleCondition("vg", "ebay")).toBe("Very Good");
    expect(saleCondition("PR", "ebay")).toBe("Poor");
    // Not a bucket: tidied like any other word.
    expect(saleCondition("near_mint", "ebay")).toBe("Near mint");
    expect(saleCondition("near_mint")).toBe("Near mint");
  });

  it("sale problems name the platform that sold", () => {
    expect(saleItemProblem({ problem: "linkMismatch", quantity: 1 }, "ebay")).toContain("whose eBay link");
    expect(saleItemProblem({ problem: "oversold", quantity: 3, shortBy: 2 }, "ebay")).toBe(
      "Sold 3 on eBay but only 1 in your boxes. We took that one; 2 more need a look.",
    );
    expect(saleItemProblem({ problem: "oversold", quantity: 2, shortBy: 2 }, "ebay")).toContain("We took none");
    expect(saleItemProblem({ problem: "oversold", quantity: 1, shortBy: 1 })).toContain("on BuySportsCards");
    expect(saleItemProblem({ quantity: 1 })).toBeNull();
  });

  it("order links: one eBay order, and each platform's list, real or sandbox", () => {
    expect(ebayOrderUrl("12-34567-89012")).toBe("https://www.ebay.com/sh/ord/details?orderid=12-34567-89012");
    expect(ebayOrderUrl("12-34567-89012", true)).toBe("https://www.sandbox.ebay.com/sh/ord/details?orderid=12-34567-89012");
    expect(ebayOrderUrl("a b&c=d")).toBe("https://www.ebay.com/sh/ord/details?orderid=a%20b%26c%3Dd");
    expect(ordersUrl("ebay")).toBe(EBAY_ORDERS_URL);
    expect(ordersUrl("ebay", true)).toBe(EBAY_SANDBOX_ORDERS_URL);
    expect(ordersUrl("bsc", true)).toBe(ordersUrl("bsc"));
    expect(ordersUrl("bsc")).not.toContain("ebay");
  });
});
