/**
 * NEO-121 — the tracker-field → words mapping.
 *
 * The two cases worth pinning are the ones a letter actually hits and a first
 * draft got wrong: `out_for_delivery` is the DONE state (nothing scans a
 * mailbox, so `delivered` never arrives for a letter), and USPS's
 * "Cancellation of Postage" needs the postmark gloss or a seller reads their
 * first scan as a refund.
 */

import { describe, expect, it } from "vitest";
import {
  describeTrackingStatus,
  formatScanPlace,
  glossScanMessage,
  isHttpsUrl,
} from "./tracking-status";

describe("describeTrackingStatus", () => {
  it.each([
    ["unknown", "Label printed — no scans yet", "idle"],
    ["pre_transit", "Label printed — no scans yet", "idle"],
    ["in_transit", "Moving through USPS", "moving"],
    ["out_for_delivery", "Out for delivery — last USPS scan", "done"],
    ["delivered", "Delivered", "done"],
    ["available_for_pickup", "Waiting at the post office", "moving"],
    ["return_to_sender", "Returned to sender", "warn"],
    ["failure", "Problem — check USPS", "warn"],
    ["error", "Problem — check USPS", "warn"],
    ["cancelled", "Problem — check USPS", "warn"],
  ])("maps %s", (status, label, tone) => {
    expect(describeTrackingStatus(status)).toEqual({ label, tone });
  });

  /**
   * The whole reason the tone exists. A letter's LAST scan is the destination
   * post office marking it out for delivery; if that rendered as an in-flight
   * tone, every delivered letter would sit forever looking unfinished.
   */
  it("treats out_for_delivery as the finish line, not as in-flight", () => {
    expect(describeTrackingStatus("out_for_delivery").tone).toBe("done");
    expect(describeTrackingStatus("in_transit").tone).toBe("moving");
  });

  it("says no scans yet when the row has no status at all", () => {
    expect(describeTrackingStatus(undefined)).toEqual({
      label: "Label printed — no scans yet",
      tone: "idle",
    });
    expect(describeTrackingStatus("")).toEqual({
      label: "Label printed — no scans yet",
      tone: "idle",
    });
  });

  /**
   * An enum value we do not know about is OUR gap. It must not be dressed up as
   * a problem the seller has to chase — "Problem — check USPS" on a status
   * EasyPost added last week would send them to a post office for nothing.
   */
  it("falls back to no-scans-yet for a status outside the enum", () => {
    expect(describeTrackingStatus("teleported").tone).toBe("idle");
    expect(describeTrackingStatus("teleported").label).toBe(
      "Label printed — no scans yet",
    );
  });

  it("tolerates the casing and padding of a hand-seeded row", () => {
    expect(describeTrackingStatus("  In_Transit ").label).toBe(
      "Moving through USPS",
    );
  });
});

describe("glossScanMessage", () => {
  /** The real first scan on the production letter this feature was built from. */
  it("explains USPS's alarming postmark wording", () => {
    expect(glossScanMessage("Origin Processing Cancellation of Postage")).toBe(
      "Origin Processing Cancellation of Postage (postmarked — the letter wasn't cancelled)",
    );
  });

  it("matches regardless of USPS's casing", () => {
    expect(glossScanMessage("origin processing cancellation of postage")).toContain(
      "(postmarked — the letter wasn't cancelled)",
    );
  });

  it("leaves every other scan message exactly as USPS wrote it", () => {
    for (const message of [
      "Origin Primary Processing",
      "Destination MMP Processing",
      "Delivery",
    ]) {
      expect(glossScanMessage(message)).toBe(message);
    }
  });

  it("does not stack a second gloss on an already-glossed message", () => {
    const once = glossScanMessage("Origin Processing Cancellation of Postage");
    expect(glossScanMessage(once)).toBe(once);
  });
});

describe("formatScanPlace", () => {
  it("joins city and state the way USPS prints them", () => {
    expect(formatScanPlace({ city: "OLYMPIA", state: "WA" })).toBe("OLYMPIA, WA");
  });

  it("renders whichever half it has", () => {
    expect(formatScanPlace({ city: "MADISON" })).toBe("MADISON");
    expect(formatScanPlace({ state: "WI" })).toBe("WI");
  });

  /** Empty means the caller drops the separator instead of showing "· ·". */
  it("is empty when the scan carried no location", () => {
    expect(formatScanPlace({})).toBe("");
    expect(formatScanPlace({ city: "  ", state: "" })).toBe("");
  });
});

describe("isHttpsUrl", () => {
  it("accepts EasyPost's public tracking page", () => {
    expect(
      isHttpsUrl("https://track.easypost.com/djE6dHJrX2ZpeHR1cmVfMDAx"),
    ).toBe(true);
  });

  /**
   * The value reaches us through a webhook body a seller can forge, so the
   * anchor re-checks what the backend already checked.
   */
  it.each([
    "http://track.easypost.com/x",
    "javascript:alert(1)",
    "//track.easypost.com/x",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(isHttpsUrl(url)).toBe(false);
  });

  it("rejects a missing url", () => {
    expect(isHttpsUrl(undefined)).toBe(false);
    expect(isHttpsUrl(null)).toBe(false);
  });
});
