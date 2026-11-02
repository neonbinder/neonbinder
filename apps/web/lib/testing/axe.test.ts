import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UNIT_DISABLED_RULES, WCAG_TAGS } from "./axe";

/**
 * NEO-370 — the unit axe helper must check the same WCAG tags as the E2E
 * check. The Playwright helper imports Playwright, so its list is read as
 * source here rather than imported.
 */
describe("the unit axe helper", () => {
  it("uses the E2E check's WCAG tags", () => {
    const source = readFileSync(path.resolve(__dirname, "../../playwright/support/a11y.ts"), "utf8");
    const match = source.match(/export const WCAG_TAGS = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const e2eTags = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...WCAG_TAGS]).toEqual(e2eTags);
  });

  it("switches off only colour contrast, which happy-dom cannot judge", () => {
    expect(Object.keys(UNIT_DISABLED_RULES)).toEqual(["color-contrast"]);
  });
});
