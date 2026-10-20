import { describe, expect, test } from "vitest";
import { isChangedSyncCard, needsSyncReview } from "./sync-review";

const diff = (over: Partial<Parameters<typeof needsSyncReview>[0]> = {}) => ({
  conflicts: [],
  removedUpstream: { fullyOrphaned: [] },
  cards: [{ bucket: "unchanged" }, { bucket: "new" }],
  ...over,
});

describe("needsSyncReview — one rule for the dialog and the tool (NEO-339)", () => {
  test("nothing changed, orphaned or held: no review", () => {
    expect(needsSyncReview(diff())).toBe(false);
  });
  test("a held conflict needs review", () => {
    expect(needsSyncReview(diff({ conflicts: [{}] }))).toBe(true);
  });
  test("a card no longer listed upstream needs review", () => {
    expect(needsSyncReview(diff({ removedUpstream: { fullyOrphaned: [{}] } }))).toBe(true);
  });
  test("a reformatted or changed card needs review", () => {
    expect(needsSyncReview(diff({ cards: [{ bucket: "formattingOnly" }] }))).toBe(true);
    expect(needsSyncReview(diff({ cards: [{ bucket: "contentChanges" }] }))).toBe(true);
  });
  test("isChangedSyncCard names exactly the two changed buckets", () => {
    expect(["formattingOnly", "contentChanges", "unchanged", "new"].map((bucket) => isChangedSyncCard({ bucket }))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});
