import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { photosOfRow } from "./convexStore";

/** NEO-481 — a `photosOf` row's pending edits land on the side they belong to. */
const copyId = "c1" as Id<"collectionCopies">;
const photoId = "p1" as Id<"collectionCopyPhotos">;
const urls = { imageUrl: "i", thumbUrl: "t" };

describe("photosOfRow", () => {
  it("puts each side's edit in flight on that side, and nothing on the other", () => {
    const photos = photosOfRow({
      copyId,
      front: urls,
      back: urls,
      edits: [{ photoId, side: "back", status: "failed", error: "No luck.", turns: 1, crop: null, requestedAt: 1 }],
    });
    expect(photos.front).toEqual(urls);
    expect(photos.back).toEqual({ ...urls, pending: { status: "failed", edit: { turns: 1, crop: null }, error: "No luck." } });
  });

  it("a side with no photo stays absent", () => {
    expect(photosOfRow({ copyId, front: urls })).toEqual({ front: urls });
  });
});
