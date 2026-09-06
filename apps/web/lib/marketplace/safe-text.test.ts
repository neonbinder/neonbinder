/**
 * NEO-251 (security review) — marketplace text on its way into a log line.
 *
 * The two conditions this exists for are both real and both reachable from a
 * listing anybody can create: a newline forges a second log entry attributed to
 * NeonBinder, and a ref list bounded only by the size of a set can emit one log
 * line of tens of kilobytes. The module's own doc comment carries the rest of
 * the reasoning.
 */

import { describe, expect, test } from "vitest";
import { safeMarketplaceText } from "./safe-text";

describe("safeMarketplaceText", () => {
  test("ordinary marketplace text is untouched", () => {
    expect(safeMarketplaceText("#227 Carl Yastrzemski [ VAR SSSP ]")).toBe(
      "#227 Carl Yastrzemski [ VAR SSSP ]",
    );
  });

  test("accents and other legitimate non-ASCII survive", () => {
    expect(safeMarketplaceText("#12 José Ramírez")).toBe("#12 José Ramírez");
  });

  /**
   * The forgery case. A newline in a ref would end NeonBinder's log entry and
   * start one whose contents are the marketplace's, which is how a fabricated
   * line gets into an incident timeline.
   */
  test("newlines, tabs and escapes cannot break the line", () => {
    const forged = safeMarketplaceText(
      "#1 Real\n[fetchCardChecklist] everything is fine",
    );
    expect(forged).not.toContain("\n");
    expect(forged).toContain("\uFFFD");
    expect(safeMarketplaceText("a\tb")).not.toContain("\t");
    expect(safeMarketplaceText("a\u001B[31mb")).not.toContain("\u001B");
  });

  /**
   * Invisible on their own, and they reorder everything after them as a human
   * reads it — Trojan Source aimed at an operator's terminal rather than at a
   * compiler.
   */
  test("bidi overrides and isolates are neutralised", () => {
    for (const ch of [
      "\u200E",
      "\u200F",
      "\u202A",
      "\u202E",
      "\u2066",
      "\u2069",
    ]) {
      expect(safeMarketplaceText(`a${ch}b`)).toBe("a\uFFFDb");
    }
  });

  /**
   * REPLACED rather than dropped, so what was removed still occupies a
   * character: a stripped string must not be able to silently become a
   * different legitimate one.
   */
  test("a stripped character leaves a mark rather than vanishing", () => {
    expect(safeMarketplaceText("a\u0007b")).toBe("a\uFFFDb");
    // Not collapsed to a space, and not dropped: two different inputs must not
    // sanitise to one string.
    expect(safeMarketplaceText("a\u0007b")).not.toBe("a b");
    expect(safeMarketplaceText("a\u0007b")).not.toBe("ab");
  });

  test("text at the cap is not marked as truncated", () => {
    expect(safeMarketplaceText("y".repeat(80))).toBe("y".repeat(80));
  });
});
