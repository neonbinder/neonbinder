import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MINT_TIMEOUT_MS, errorWords, toEditStart, useScanPhotoSource } from "./convexEdits";
import type { PhotoSource } from "./types";

/** Every action this file calls; the scan's address mint is the one these tests drive. */
const action = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("convex/react", () => ({ useAction: () => action.fn }));

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

describe("useScanPhotoSource: the scan's address", () => {
  function Probe({ onSource }: { onSource: (s: PhotoSource) => void }) {
    onSource(useScanPhotoSource({ jobId: "j", label: "loose-1.jpg", front: { entryIndex: 0 } }));
    return null;
  }

  it("a refused mint (the scan is gone) marks the side failed instead of leaving it waiting", async () => {
    action.fn = vi.fn(async () => {
      throw new Error("Image not found");
    });
    let last: PhotoSource | undefined;
    render(<Probe onSource={(s) => (last = s)} />);
    await waitFor(() => expect(last?.front?.imageFailed).toBe(true));
    expect(last?.front?.imageUrl).toBeUndefined();
  });

  it("a mint that never answers counts as failed after a while; a good one gives the address", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    action.fn = vi.fn(() => new Promise(() => undefined));
    let last: PhotoSource | undefined;
    const view = render(<Probe onSource={(s) => (last = s)} />);
    expect(last?.front?.imageFailed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS + 10);
    await waitFor(() => expect(last?.front?.imageFailed).toBe(true));
    vi.useRealTimers();
    view.unmount();

    action.fn = vi.fn(async () => ({ url: "https://signed/0" }));
    render(<Probe onSource={(s) => (last = s)} />);
    await waitFor(() => expect(last?.front?.imageUrl).toBe("https://signed/0"));
    expect(last?.front?.imageFailed).toBeUndefined();
  });
});
