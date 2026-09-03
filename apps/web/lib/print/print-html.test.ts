/**
 * NEO-120 — tests for the image wait in the print pipeline.
 *
 * ## Why this exists
 * A purchased postage label is a REMOTE PNG fetched from the carrier. The print
 * iframe's `load` event does not guarantee that image is decoded and paintable,
 * so calling `print()` too early snapshots a blank box where the label should
 * be. Silent, intermittent, and worst on the slow connection where it matters
 * most — and the seller has already paid for that label.
 *
 * Nothing printed before NEO-120 used an image, so the gap was latent rather
 * than broken. These tests keep it that way.
 *
 * `waitForImages` takes only `{ images }`, so it can be driven with plain fakes
 * — no DOM, no iframe, no real decoding, and no flakiness from either.
 */

import { describe, expect, test, vi } from "vitest";
import {
  imageBodyHtml,
  waitForImages,
  type ImageBearingDocument,
  type PrintableImage,
} from "./print-html";

/** A controllable stand-in for an <img> that has not finished loading. */
function pendingImage(): PrintableImage & {
  fireLoad: () => void;
  fireError: () => void;
  decodeCalls: number;
} {
  const listeners: Record<string, Array<() => void>> = { load: [], error: [] };
  let decodeCalls = 0;
  return {
    complete: false,
    naturalWidth: 0,
    decode() {
      decodeCalls += 1;
      return Promise.resolve();
    },
    addEventListener(type, listener) {
      listeners[type].push(listener);
    },
    fireLoad: () => listeners.load.forEach((l) => l()),
    fireError: () => listeners.error.forEach((l) => l()),
    get decodeCalls() {
      return decodeCalls;
    },
  };
}

/** An <img> already loaded and decodable — the fast path. */
function loadedImage(decode: () => Promise<unknown> = () => Promise.resolve()) {
  return {
    complete: true,
    naturalWidth: 600,
    decode,
    addEventListener: () => {},
  } satisfies PrintableImage;
}

function docWith(...images: PrintableImage[]): ImageBearingDocument {
  return { images };
}

/** Has the promise settled? Used to prove the wait actually blocks. */
async function isSettled(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  const winner = await Promise.race([
    p.then(() => "settled"),
    Promise.resolve(marker),
  ]);
  return winner !== marker;
}

// NEO-213 — the label URL is EasyPost's, and `bodyHtml` is dropped verbatim
// into a SAME-ORIGIN iframe's srcdoc. Both print call sites used to build the
// <img> by hand, so a URL carrying a quote could close the attribute and run as
// markup with the app's origin. These pin both halves of the fix.
describe("imageBodyHtml", () => {
  const SIZE = { widthIn: 6, heightIn: 4 };

  test("renders an ordinary https label exactly as before", () => {
    // Byte-for-byte the markup the hand-built template produced — the printed
    // sheet must not change, only the handling of a hostile URL.
    expect(
      imageBodyHtml({ src: "https://easypost.example/label.png", ...SIZE }),
    ).toBe(
      '<img src="https://easypost.example/label.png" alt="" style="width:6in;height:4in;display:block">',
    );
  });

  test("escapes a quote rather than letting it close the attribute", () => {
    const body = imageBodyHtml({
      src: 'https://easypost.example/a.png?x="><script>alert(1)</script>',
      ...SIZE,
    });
    expect(body).not.toContain("<script>");
    expect(body).toContain("&quot;");
    // One tag, still one tag: nothing escaped the src attribute.
    expect(body.match(/</g)).toHaveLength(1);
  });

  test("escapes & and < in a query string", () => {
    const body = imageBodyHtml({
      src: "https://easypost.example/a.png?a=1&b=2",
      ...SIZE,
    });
    expect(body).toContain("a=1&amp;b=2");
  });

  // `javascript:` is inert in a src, but a data: SVG is a document that runs
  // script in the iframe's origin. A postage label is always https.
  test.each([
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "http://easypost.example/label.png",
    "javascript:alert(1)",
    "file:///etc/passwd",
  ])("refuses a non-https src (%s)", (src) => {
    expect(() => imageBodyHtml({ src, ...SIZE })).toThrow(/https/i);
  });

  test("refuses something that is not a URL at all", () => {
    expect(() => imageBodyHtml({ src: "not a url", ...SIZE })).toThrow(
      /usable link/i,
    );
  });

  // The seller sees this text, so it must not be a stack trace or a scheme name.
  test("its refusal reads as a sentence a seller can act on", () => {
    expect(() => imageBodyHtml({ src: "", ...SIZE })).toThrow(
      /label's image address/i,
    );
  });
});

describe("waitForImages", () => {
  test("resolves immediately when there are no images", async () => {
    await expect(waitForImages(docWith())).resolves.toBeUndefined();
  });

  test("tolerates a document with no images collection at all", async () => {
    const doc = {} as unknown as ImageBearingDocument;
    await expect(waitForImages(doc)).resolves.toBeUndefined();
  });

  test("decodes an already-loaded image rather than assuming it is paintable", async () => {
    const decode = vi.fn(() => Promise.resolve());
    await waitForImages(docWith(loadedImage(decode)));
    // `complete` only means fetched. decode() is what guarantees paintable.
    expect(decode).toHaveBeenCalledTimes(1);
  });

  // The actual regression: print() must not happen while a label is in flight.
  test("does NOT resolve while an image is still loading", async () => {
    const img = pendingImage();
    const p = waitForImages(docWith(img));
    expect(await isSettled(p)).toBe(false);

    img.fireLoad();
    await expect(p).resolves.toBeUndefined();
  });

  test("waits for every image, not just the first", async () => {
    const fast = pendingImage();
    const slow = pendingImage();
    const p = waitForImages(docWith(fast, slow));

    fast.fireLoad();
    expect(await isSettled(p)).toBe(false);

    slow.fireLoad();
    await expect(p).resolves.toBeUndefined();
  });

  test("decodes after load, not merely on the load event", async () => {
    const img = pendingImage();
    const p = waitForImages(docWith(img));
    img.fireLoad();
    await p;
    expect(img.decodeCalls).toBe(1);
  });

  // A broken image should still print — visibly missing, so the operator can
  // see it — rather than throwing away a label already paid for.
  test("a failed image resolves instead of rejecting", async () => {
    const img = pendingImage();
    const p = waitForImages(docWith(img));
    img.fireError();
    await expect(p).resolves.toBeUndefined();
  });

  test("a rejected decode() resolves instead of rejecting", async () => {
    const img = loadedImage(() => Promise.reject(new Error("decode failed")));
    await expect(waitForImages(docWith(img))).resolves.toBeUndefined();
  });

  // Printing late beats hanging forever on a carrier that never responds.
  test("gives up after the timeout rather than blocking print forever", async () => {
    vi.useFakeTimers();
    try {
      const p = waitForImages(docWith(pendingImage()));
      let settled = false;
      void p.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(14_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      await p;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
