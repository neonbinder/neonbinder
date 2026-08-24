/**
 * NEO-120 — prod-only error redaction.
 *
 * Production Convex flattens thrown plain Errors to "Server Error" while dev
 * and preview deployments pass the message through — so this class of bug is
 * invisible to every pre-prod test tier and was found live, on the first real
 * purchase ("Insufficient funds…" reached the seller as bracket soup). These
 * cases pin the one rule that keeps it fixed: actionable messages travel as
 * ConvexError data, and nothing else is ever shown.
 */

import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { sellerMessage } from "./postage-error";

describe("sellerMessage", () => {
  it("passes a ConvexError's string data through — the backend chose it for the seller", () => {
    const err = new ConvexError(
      "EasyPost could not charge for this label: Insufficient funds.",
    );
    expect(sellerMessage(err, "Could not buy the label.")).toBe(
      "EasyPost could not charge for this label: Insufficient funds.",
    );
  });

  it("falls back on a ConvexError with non-string data", () => {
    const err = new ConvexError({ code: 402 });
    expect(sellerMessage(err, "Could not buy the label.")).toBe(
      "Could not buy the label.",
    );
  });

  it("falls back on a plain Error — its prod message is redacted operator noise", () => {
    const err = new Error(
      "[CONVEX A(postage:buyLetterLabel)] [Request ID: x] Server Error Called by client",
    );
    expect(sellerMessage(err, "Could not buy the label.")).toBe(
      "Could not buy the label.",
    );
  });

  it("falls back on non-Error rejections", () => {
    expect(sellerMessage(undefined, "Could not get postage prices.")).toBe(
      "Could not get postage prices.",
    );
  });
});
