/**
 * NEO-450 — the sentence a set-builder column shows when its own sync failed.
 *
 * Pure: `columnSyncFailedMessage` is shared with the Playwright specs, which
 * import it to assert the same words, so its shape is pinned here once.
 *
 * Named `.test.tsx` deliberately: a `.test.ts` under `components/` is collected
 * by neither vitest project (see `vitest.include.mjs`).
 */

import { describe, expect, it } from "vitest";
import { columnSyncFailedMessage } from "./column-sync-failed";

describe("columnSyncFailedMessage (NEO-450)", () => {
  it.each([
    ["Years", "Couldn't sync years — please try again."],
    ["Sets", "Couldn't sync sets — please try again."],
    ["Variant Types", "Couldn't sync variant types — please try again."],
    ["Autographs", "Couldn't sync autographs — please try again."],
  ])("names the %s column in lower case", (column, sentence) => {
    expect(columnSyncFailedMessage(column)).toBe(sentence);
  });

  it("keeps an em dash, not a hyphen, between the halves", () => {
    expect(columnSyncFailedMessage("Years")).toContain(" — ");
  });

  it("never carries the old generic 'options' wording", () => {
    expect(columnSyncFailedMessage("Years")).not.toMatch(/options/i);
  });
});
