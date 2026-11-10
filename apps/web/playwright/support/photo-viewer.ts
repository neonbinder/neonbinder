// NEO-481: the card photo viewer (`components/modules/CardPhotoViewer`), the
// one dialog every card photo opens: a big look, a quarter turn either way and
// a crop by hand. Used by `collection/card-photo-viewer-*`, `collection/add-cards-*`
// and the photo-box specs (`copy-photos-*`, `add-copy-with-photos-*`,
// `inventory-photo-line-*`, `card-request-*`).
import { expect, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./fixtures";

/**
 * An edited photo landing: Save is accepted at once (our own write, 7 s), then a
 * background render on the preprocess service makes the new file. That render is
 * a pipeline wait, and the fast preprocess instance can be cold: R1 measured a
 * cold start at about 23 s p50 and 36 s p95, so Jason approved up to about 40 s
 * for the new file to land (2026-11-10, NEO-481 plan amendment, option A). It
 * waits only on the landing ("All set. Your edited photo is in." or the tile's
 * "Touching it up…" going); everything the collector does still gets 7 s.
 * Voided if the save goes synchronous again or the render moves off preprocess.
 */
export const EDIT_LANDS = 40_000;

/** What the viewer says on a picked photo that is not uploaded yet (`sources.ts` HELD_REASON). */
export const HELD_REASON = "Add the card first, then you can turn or crop it.";
/** What the viewer says over a saved photo it can only trim (`VIEWER_WORDS.storedMode`). */
export const STORED_MODE = "This photo's original scan is gone, so a crop can only trim what's here.";
/** The viewer's status line once a render it started has landed (`VIEWER_WORDS.landed`). */
export const EDIT_LANDED = "All set. Your edited photo is in.";

type Side = "front" | "back";
const WORD: Record<Side, string> = { front: "Front", back: "Back" };

/** The viewer open on one side: a dialog named by its heading, "Front of <label>". */
export function photoViewer(page: Page, side: Side, label: string): Locator {
  return page.getByRole("dialog", { name: `${WORD[side]} of ${label}`, exact: true });
}

/**
 * A HELD photo (picked in a form, not uploaded yet) opens the viewer view-only:
 * it says why, has Close and no tools, and Escape closes only the viewer, with
 * focus back on the tile. `panel` is the photo box (region "Photos of ...");
 * `line` is what the box calls the photos ("your new copy", "this card").
 * Runs the axe check on the view-only viewer.
 */
export async function expectHeldPhotoViewOnly(page: Page, panel: Locator, side: Side, line: string, a11yLabel: string): Promise<void> {
  const tile = panel.getByRole("button", { name: `Open ${side} of ${line}`, exact: true });
  await tile.click();
  const viewer = photoViewer(page, side, line);
  await expect(viewer.getByText(HELD_REASON, { exact: true })).toBeVisible();
  // Positive anchors first (R2): the picture and Close are there, so the absences below mean something.
  await expect(viewer.getByRole("img", { name: `${WORD[side]} of ${line}`, exact: true })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Save photo" })).toHaveCount(0);
  await expect(viewer.getByRole("toolbar", { name: "Photo tools" })).toHaveCount(0);
  await expectAccessible(page, { within: viewer, label: a11yLabel });
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  // Only the viewer closed: the box that opened it is still there, its tile focused.
  await expect(tile).toBeFocused();
}

/**
 * The pixel size of the photo behind a picture or link, read from the file the
 * user's browser downloads (the same fetch as `expectPhotoServed`). A tile's
 * frame keeps its 5:7 shape whatever the photo inside, so nothing on the page
 * says "this photo is landscape"; the saved file does. Reads the size from the
 * file's own header (JPEG, WebP or PNG).
 */
export async function servedPhotoSize(page: Page, shown: Locator, attribute: "src" | "href"): Promise<{ w: number; h: number }> {
  await expect(shown).toHaveAttribute(attribute, /\/copy-photo\/[0-9a-f]{32}\/(thumb|image)$/);
  const address = await shown.getAttribute(attribute);
  expect(address, `a ${attribute} to fetch`).not.toBeNull();
  const response = await page.request.get(new URL(address!, page.url()).toString());
  expect(response.ok(), "the photo's address answers").toBe(true);
  const size = imageSize(await response.body());
  expect(size, "the photo's header names its size").not.toBeNull();
  return size!;
}

/** Width and height from an image file's header, or null for a format it doesn't know. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  // PNG: IHDR is the first chunk.
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  // WebP: RIFF....WEBP, then VP8 / VP8L / VP8X.
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
    return null;
  }
  // JPEG: walk the markers to the first start-of-frame.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1];
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { w: b.readUInt16BE(at + 7), h: b.readUInt16BE(at + 5) };
      at += 2 + b.readUInt16BE(at + 2);
    }
  }
  return null;
}
