import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import type { PhotoEdit } from "@/lib/photo-edit/geometry";
import CardPhotoViewer, { VIEWER_WORDS } from "./CardPhotoViewer";
import { CardPhoto } from "./EditedPhoto";
import { rememberPreview, resetPreviewsForTest } from "./previewStore";
import { heldPhotoSource, HELD_REASON } from "./sources";
import type { EditableStart, PhotoSideSource, PhotoSource } from "./types";
import { usePhotoViewer } from "./usePhotoViewer";

/**
 * NEO-481 — the card photo viewer, driven the way a collector drives it: the
 * keyboard on the crop box, the visible step buttons, Save handing the edit
 * over at once, the pending and failed states, Undo, and Escape closing only
 * the viewer. The sources are fakes; no test reaches a server.
 */

const STORED: EditableStart = {
  mode: "stored",
  sourceUrl: "blob:stored",
  srcW: 1000,
  srcH: 1400,
  opening: { turns: 0, crop: null },
  reset: { turns: 0, crop: null },
  guard: "token-1",
};

function side(over: Partial<PhotoSideSource> = {}, start: EditableStart = STORED): PhotoSideSource & {
  save: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
} {
  return {
    imageUrl: "blob:front-image",
    previewKey: "test:front",
    load: vi.fn(async () => start),
    save: vi.fn(async () => undefined),
    ...over,
  } as never;
}

function open(source: PhotoSource, onClose = vi.fn(), initialSide: "front" | "back" = "front") {
  const outerKeys = vi.fn();
  render(
    <Theme>
      {/* The card drawer under the viewer: Escape must never reach it. */}
      <div onKeyDown={outerKeys}>
        <CardPhotoViewer source={source} initialSide={initialSide} onClose={onClose} />
      </div>
    </Theme>,
  );
  const dialog = screen.getByRole("dialog");
  return { dialog, onClose, outerKeys };
}

const savedEdit = (s: { save: ReturnType<typeof vi.fn> }, call = 0) => s.save.mock.calls[call][0] as PhotoEdit;

beforeEach(() => resetPreviewsForTest());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("opening", () => {
  it("names the side and the card, focuses the heading, and switches sides", async () => {
    const front = side();
    const back = side({ imageUrl: "blob:back-image", previewKey: "test:back" });
    const { dialog } = open({ label: "1993 Upper Deck #24 Ken Griffey Jr.", front, back });
    const heading = within(dialog).getByRole("heading", { name: "Front of 1993 Upper Deck #24 Ken Griffey Jr." });
    expect(document.activeElement).toBe(heading);
    await waitFor(() => expect(front.load).toHaveBeenCalledTimes(1));

    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getByRole("heading", { name: /^Back of / })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Back" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(back.load).toHaveBeenCalledTimes(1));
  });

  it("a held photo opens view-only: the reason, the picture, no tools and no Save", () => {
    const { dialog } = open(heldPhotoSource("your new copy", { front: "blob:held" }));
    expect(within(dialog).getByText(HELD_REASON)).toBeTruthy();
    expect(within(dialog).getByRole("img", { name: "Front of your new copy" }).getAttribute("src")).toBe("blob:held");
    expect(within(dialog).queryByRole("button", { name: "Save photo" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Crop by hand" })).toBeNull();
    expect(within(dialog).queryByRole("toolbar")).toBeNull();
  });

  it("a server view-only answer says why", async () => {
    const front = side({ load: vi.fn(async () => ({ mode: "viewOnly" as const, reason: "Photos are on their way." })) });
    const { dialog } = open({ label: "a card", front });
    await within(dialog).findByText("Photos are on their way.");
    expect(within(dialog).queryByRole("button", { name: "Save photo" })).toBeNull();
  });

  it("the stored-mode line shows only when the source is the stored photo", async () => {
    const { dialog } = open({ label: "a card", front: side() });
    await within(dialog).findByText(VIEWER_WORDS.storedMode);
    cleanup();
    const original = side({}, { ...STORED, mode: "original" });
    const again = open({ label: "a card", front: original });
    await waitFor(() => expect(original.load).toHaveBeenCalled());
    await within(again.dialog).findByRole("button", { name: "Crop by hand" });
    expect(within(again.dialog).queryByText(VIEWER_WORDS.storedMode)).toBeNull();
  });

  it("a failed read says so and reads again only when asked", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValue(STORED);
    const front = side({ load });
    const { dialog } = open({ label: "a card", front });
    const again = await within(dialog).findByRole("button", { name: "Open it again" });
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(again);
    await within(dialog).findByRole("button", { name: "Crop by hand" });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("turning and saving", () => {
  it("Turn right then Save hands over a quarter turn at once, says Saved, and remembers the preview", async () => {
    const front = side();
    const { dialog } = open({ label: "a card", front });
    const save = await within(dialog).findByRole("button", { name: "Save photo" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(save);
    expect(within(dialog).getByRole("alert").textContent).toBe(VIEWER_WORDS.nothingChanged);
    expect(front.save).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Turn right" }));
    expect(save.getAttribute("aria-disabled")).toBeNull();
    await act(async () => fireEvent.click(save));
    expect(savedEdit(front)).toEqual({ turns: 1, crop: null });
    expect(front.save.mock.calls[0][1]).toMatchObject({ guard: "token-1", mode: "stored" });
    expect(within(dialog).getByRole("status").textContent).toBe(VIEWER_WORDS.saved);
    // Saved is the new baseline: nothing left to save.
    expect(save.getAttribute("aria-disabled")).toBe("true");

    // The tile shows the edit while it renders, from the remembered picture.
    render(<CardPhoto src="blob:thumb" alt="tile" previewKey="test:front" pending={{ status: "rendering", edit: { turns: 1, crop: null } }} />);
    const tile = screen.getByRole("img", { name: "tile" });
    expect(tile.tagName.toLowerCase()).toBe("svg");
    expect(tile.querySelector("image")?.getAttribute("href")).toBe("blob:stored");
    expect(screen.getByText("Touching it up…")).toBeTruthy();
  });

  it("[ and ] turn the photo, c starts the crop", async () => {
    const front = side();
    const { dialog } = open({ label: "a card", front });
    await within(dialog).findByRole("button", { name: "Crop by hand" });
    const panel = dialog.querySelector("[data-card-photo-viewer]")!;
    fireEvent.keyDown(panel, { key: "]" });
    fireEvent.keyDown(panel, { key: "]" });
    fireEvent.keyDown(panel, { key: "[" });
    fireEvent.keyDown(panel, { key: "c" });
    expect(within(dialog).getByRole("button", { name: "Crop by hand" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("group", { name: "Crop box" })).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    expect(savedEdit(front).turns).toBe(1);
  });

  it("a refused save keeps the draft, says why, and forgets the preview", async () => {
    const front = side({ save: vi.fn(async () => Promise.reject(new Error("This photo changed somewhere else."))) });
    const { dialog } = open({ label: "a card", front });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Turn left" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    expect(within(dialog).getByRole("alert").textContent).toBe("This photo changed somewhere else.");
    expect(within(dialog).getByRole("button", { name: "Save photo" }).getAttribute("aria-disabled")).toBeNull();
    render(<CardPhoto src="blob:thumb" alt="tile" previewKey="test:front" pending={{ status: "rendering", edit: { turns: 3, crop: null } }} />);
    expect(screen.getByRole("img", { name: "tile" }).tagName.toLowerCase()).toBe("img");
  });
});

describe("the crop box", () => {
  async function cropping(start: EditableStart = STORED) {
    const front = side({}, start);
    const view = open({ label: "a card", front });
    fireEvent.click(await within(view.dialog).findByRole("button", { name: "Crop by hand" }));
    const box = within(view.dialog).getByRole("group", { name: "Crop box" });
    return { ...view, front, box };
  }

  it("is one focusable group described by its instructions", async () => {
    const { dialog, box } = await cropping();
    expect(box.getAttribute("tabindex")).toBe("0");
    const help = document.getElementById(box.getAttribute("aria-describedby")!);
    expect(help?.textContent).toMatch(/arrows nudge it/);
    expect(within(dialog).getByRole("spinbutton", { name: "Angle, degrees" })).toBeTruthy();
  });

  it("says so when the photo has no auto crop, and only then", async () => {
    const { dialog } = await cropping();
    expect(within(dialog).queryByText(VIEWER_WORDS.noAutoCrop)).toBeNull();
    cleanup();
    const front = side({}, { ...STORED, mode: "original", noAutoCrop: true });
    const view = open({ label: "a card", front });
    fireEvent.click(await within(view.dialog).findByRole("button", { name: "Crop by hand" }));
    expect(within(view.dialog).getByText(VIEWER_WORDS.noAutoCrop)).toBeTruthy();
  });

  it("keys shrink, nudge and tilt it; Save sends the box", async () => {
    const { dialog, box, front } = await cropping();
    // The whole frame cannot move or tilt: shrink it first, then nudge right and tilt.
    for (let i = 0; i < 10; i++) fireEvent.keyDown(box, { key: "-" });
    fireEvent.keyDown(box, { key: "ArrowRight" });
    fireEvent.keyDown(box, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(box, { key: "." });
    fireEvent.keyDown(box, { key: ">" });
    fireEvent.keyDown(box, { key: "," });
    expect((within(dialog).getByRole("spinbutton", { name: "Angle, degrees" }) as HTMLInputElement).value).toBe("15");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    const crop = savedEdit(front).crop!;
    const scale = 1 / 1.04 ** 10;
    expect(crop.w).toBeCloseTo(1000 * scale, 1);
    expect(crop.cx).toBeCloseTo(507, 1);
    expect(crop.cy).toBeCloseTo(770, 1);
    expect(crop.angle).toBe(15);
    expect(crop.srcW).toBe(1000);
  });

  it("the visible step buttons do what the keys do", async () => {
    const { dialog, front } = await cropping();
    fireEvent.click(within(dialog).getByRole("button", { name: "Shrink crop" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Shrink crop" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Nudge crop left" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Tilt crop right" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    const crop = savedEdit(front).crop!;
    expect(crop.cx).toBeLessThan(500);
    expect(crop.angle).toBe(1);
  });

  it("the Angle field sets the tilt; Start over goes back to the whole frame", async () => {
    const { dialog, front } = await cropping();
    const angle = within(dialog).getByRole("spinbutton", { name: "Angle, degrees" });
    fireEvent.change(angle, { target: { value: "-30" } });
    fireEvent.blur(angle);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start over" }));
    expect(within(dialog).getByRole("button", { name: "Save photo" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(angle, { target: { value: "-30" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    expect(savedEdit(front).crop!.angle).toBe(-30);
  });

  it("reads the box out once it holds still", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { dialog, box } = await cropping();
    fireEvent.keyDown(box, { key: "-" });
    fireEvent.keyDown(box, { key: "." });
    const live = dialog.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");
    await act(async () => vi.advanceTimersByTime(700));
    expect(live.textContent).toMatch(/^Tilted 1°, \d+ by \d+ pixels\.$/);
  });

  it("arrows follow the screen on a turned photo", async () => {
    const { dialog, front } = await cropping();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn right" }));
    const box = within(dialog).getByRole("group", { name: "Crop box" });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(box, { key: "-" });
    fireEvent.keyDown(box, { key: "ArrowRight" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    // Turned a quarter right, screen right is source up.
    expect(savedEdit(front).crop!.cy).toBeCloseTo(693, 1);
  });
});

describe("pending, failure and Undo", () => {
  it("while an edit renders, Save waits and says why", async () => {
    const front = side({ pending: { status: "rendering", edit: { turns: 1, crop: null } } });
    const { dialog } = open({ label: "a card", front });
    expect(within(dialog).getByText("Touching it up…")).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Turn right" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    expect(front.save).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert").textContent).toBe(VIEWER_WORDS.stillRendering);
  });

  it("a failed edit keeps the old photo and offers Try again (the same save) and Keep the old photo", async () => {
    const failed: PhotoEdit = { turns: 2, crop: null };
    const dismissFailure = vi.fn(async () => undefined);
    const front = side({ pending: { status: "failed", edit: failed, error: "The renderer didn't answer." }, dismissFailure });
    const { dialog } = open({ label: "a card", front });
    expect(within(dialog).getByText("The renderer didn't answer.")).toBeTruthy();
    await waitFor(() => expect(front.load).toHaveBeenCalled());
    await act(async () => fireEvent.click(await within(dialog).findByRole("button", { name: "Try again" })));
    expect(savedEdit(front)).toEqual(failed);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Keep the old photo" })));
    expect(dismissFailure).toHaveBeenCalledTimes(1);
  });

  it("a scan's Undo saves the edit it had before", async () => {
    const opening: PhotoEdit = { turns: 3, crop: { cx: 500, cy: 700, w: 600, h: 840, angle: 0, srcW: 1000, srcH: 1400 } };
    const front = side({}, { ...STORED, mode: "original", opening, reset: opening });
    const { dialog } = open({ label: "a card", front });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Turn right" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    expect(savedEdit(front).turns).toBe(0);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Undo" })));
    expect(savedEdit(front, 1)).toEqual(opening);
  });

  it("a copy's Undo is the adapter's own", async () => {
    const undo = vi.fn(async () => undefined);
    const front = side({ undo });
    const { dialog } = open({ label: "a card", front });
    expect(within(dialog).queryByRole("button", { name: "Undo" })).toBeNull();
    fireEvent.click(await within(dialog).findByRole("button", { name: "Turn left" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Undo" })));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(front.save).toHaveBeenCalledTimes(1);
  });

  it("a stored photo with no adapter Undo offers none", async () => {
    const front = side();
    const { dialog } = open({ label: "a card", front });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Turn left" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save photo" })));
    expect(within(dialog).queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("re-reads the start when the photo underneath changes (a new version landed)", async () => {
    const front = side();
    const { dialog } = open({ label: "a card", front });
    await within(dialog).findByRole("button", { name: "Crop by hand" });
    cleanup();
    // The same viewer re-rendered with the new file's address.
    const source = { label: "a card", front };
    const { rerender } = render(
      <Theme>
        <CardPhotoViewer source={source} onClose={vi.fn()} />
      </Theme>,
    );
    await waitFor(() => expect(front.load).toHaveBeenCalledTimes(2));
    rerender(
      <Theme>
        <CardPhotoViewer source={{ label: "a card", front: { ...front, imageUrl: "blob:front-v2" } }} onClose={vi.fn()} />
      </Theme>,
    );
    await waitFor(() => expect(front.load).toHaveBeenCalledTimes(3));
  });
});

describe("closing", () => {
  it("Escape closes the viewer and never reaches the drawer under it", async () => {
    const { dialog, onClose, outerKeys } = open({ label: "a card", front: side() });
    fireEvent.keyDown(within(dialog).getByRole("heading"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outerKeys).not.toHaveBeenCalled();
  });

  it("puts focus back on the photo button that opened it", async () => {
    function Harness() {
      const viewer = usePhotoViewer();
      return (
        <Theme>
          <button type="button" onClick={(e) => viewer.open("front", e.currentTarget)}>
            Open front of a card
          </button>
          {viewer.side && (
            <CardPhotoViewer source={heldPhotoSource("a card", { front: "blob:x" })} initialSide={viewer.side} onClose={viewer.close} />
          )}
        </Theme>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open front of a card" });
    // A click in Safari does not focus the button: start from the page.
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe("CardPhoto", () => {
  it("a failed edit shows the old photo with its own chip", () => {
    rememberPreview("k", { edit: { turns: 1, crop: null }, sourceUrl: "blob:src", srcW: 10, srcH: 14 });
    render(<CardPhoto src="blob:old" alt="tile" previewKey="k" pending={{ status: "failed", edit: { turns: 1, crop: null } }} />);
    expect(screen.getByRole("img", { name: "tile" }).getAttribute("src")).toBe("blob:old");
    expect(screen.getByText("Edit didn’t save")).toBeTruthy();
  });

  it("never draws a remembered preview of a different edit", () => {
    rememberPreview("k", { edit: { turns: 1, crop: null }, sourceUrl: "blob:src", srcW: 10, srcH: 14 });
    render(<CardPhoto src="blob:old" alt="tile" previewKey="k" pending={{ status: "rendering", edit: { turns: 2, crop: null } }} />);
    expect(screen.getByRole("img", { name: "tile" }).getAttribute("src")).toBe("blob:old");
  });
});
