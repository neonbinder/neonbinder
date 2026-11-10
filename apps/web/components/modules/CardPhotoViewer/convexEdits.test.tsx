import { describe, expect, it, vi } from "vitest";
import { errorWords, toEditStart } from "./convexEdits";

/** NEO-481 — the server's `photoEditSource` answer as the viewer's start. */
vi.mock("./sources", () => ({ measureImage: vi.fn(async () => ({ w: 1600, h: 1143 })) }));

const AUTO = { cx: 500, cy: 700, w: 600, h: 840, angle: 2, srcW: 1000, srcH: 1400 };

describe("toEditStart", () => {
  it("a view-only answer keeps its reason; one with no picture is view-only too", async () => {
    expect(await toEditStart({ mode: "viewOnly", reason: "Photos are on their way." }, undefined)).toEqual({
      mode: "viewOnly",
      reason: "Photos are on their way.",
    });
    expect((await toEditStart({ mode: "original" }, undefined)).mode).toBe("viewOnly");
  });

  it("opens on the server's edit; Start over keeps its turn and goes back to the auto crop", async () => {
    const start = await toEditStart(
      { mode: "original", sourceUrl: "u", srcW: 1000, srcH: 1400, edit: { turns: 1, crop: null }, autoCrop: AUTO, editsLeft: 4 },
      7,
    );
    expect(start).toMatchObject({ mode: "original", srcW: 1000, opening: { turns: 1, crop: null }, reset: { turns: 1, crop: AUTO }, editsLeft: 4, guard: 7 });
  });

  it("with no edit, opens on the auto crop at the scan's own turn", async () => {
    const start = await toEditStart({ mode: "original", sourceUrl: "u", autoCrop: AUTO }, 0, 3);
    expect(start).toMatchObject({ opening: { turns: 3, crop: AUTO }, srcW: 1000, srcH: 1400 });
  });

  it("measures the picture when the server does not know its size", async () => {
    const start = await toEditStart({ mode: "stored", sourceUrl: "u", expectToken: "t" }, "t");
    expect(start).toMatchObject({ mode: "stored", srcW: 1600, srcH: 1143, opening: { turns: 0, crop: null }, guard: "t" });
  });

  it("marks a photo with no auto crop, and only that one", async () => {
    const none = await toEditStart({ mode: "original", sourceUrl: "u", srcW: 1000, srcH: 1400 }, 0, 1);
    expect(none).toMatchObject({ noAutoCrop: true, opening: { turns: 1, crop: null }, reset: { turns: 1, crop: null } });
    const some = await toEditStart({ mode: "original", sourceUrl: "u", autoCrop: AUTO }, 0);
    expect(some).not.toHaveProperty("noAutoCrop");
  });

  it("drops a malformed crop rather than drawing it", async () => {
    const start = await toEditStart({ mode: "original", sourceUrl: "u", srcW: 10, srcH: 10, autoCrop: { cx: "x" } }, 0);
    expect(start).toMatchObject({ opening: { turns: 0, crop: null }, reset: { crop: null } });
  });
});

describe("errorWords", () => {
  it("reads a ConvexError's message, else falls back", () => {
    expect(errorWords({ data: { code: "x", message: "Out of edits." } }, "f")).toBe("Out of edits.");
    expect(errorWords({ data: "Plain words." }, "f")).toBe("Plain words.");
    expect(errorWords(new Error("[CONVEX A(x)] Server Error"), "f")).toBe("f");
  });
});
