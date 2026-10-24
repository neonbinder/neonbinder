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
  buildDocument,
  imageBodyHtml,
  printedPage,
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

// NEO-341 made the app dark-only (`color-scheme: dark`, #ededed body text). The
// print iframe sits inside that page, so its document must say "light, black on
// white" itself; a label must never inherit the screen's scheme onto paper.
describe("buildDocument", () => {
  const doc = buildDocument({
    title: "Label",
    bodyHtml: "<p>To: Ken Griffey Jr.</p>",
    css: "",
    page: { widthIn: 4, heightIn: 6 },
  });

  test("declares a light colour scheme for the printed page", () => {
    expect(doc).toMatch(/:root\s*\{\s*color-scheme:\s*light;/);
  });

  test("prints black text on a white page", () => {
    const rule = doc.match(/html, body \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("background: #fff;");
    expect(rule).toContain("color: #000;");
  });
});

// NEO-365: since Firefox 158 a landscape `@page` is no longer turned onto the
// label printer's portrait 4×6 stock, so a landscape page is emitted portrait
// with the content rotated onto it. The geometry pinned here is the one proven
// on a label printer; changing any of it needs paper, not just a green test.
describe("printedPage", () => {
  test("turns a landscape page onto portrait paper", () => {
    expect(printedPage({ widthIn: 6, heightIn: 4 })).toEqual({
      widthIn: 4,
      heightIn: 6,
      rotated: true,
    });
  });

  test("passes a portrait page through untouched", () => {
    expect(printedPage({ widthIn: 8.5, heightIn: 11 })).toEqual({
      widthIn: 8.5,
      heightIn: 11,
      rotated: false,
    });
  });

  test("does not turn a square page", () => {
    expect(printedPage({ widthIn: 4, heightIn: 4 }).rotated).toBe(false);
  });
});

/** The body of a built document, between the tags. */
function bodyOf(doc: string): string {
  return doc.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? "";
}

/** The declarations of the first rule for `selector`, whitespace collapsed. */
function ruleFor(doc: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = doc.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return rule.replace(/\s+/g, " ").trim();
}

describe("buildDocument on a landscape 6×4 label page (NEO-365)", () => {
  const label = '<div style="width:6in;height:4in">To: Ken Griffey Jr.</div>';
  const doc = buildDocument({
    title: "Label",
    bodyHtml: label,
    css: ".caller { color: #000; }",
    page: { widthIn: 6, heightIn: 4 },
  });

  test("asks the printer for the portrait 4×6 page the stock really is", () => {
    expect(ruleFor(doc, "@page")).toBe("size: 4in 6in; margin: 0;");
    expect(doc).not.toContain("size: 6in 4in");
  });

  test("wraps the label in a 4×6 page box with a rotated 6×4 box inside", () => {
    expect(bodyOf(doc)).toBe(
      `<div class="nb-print-paper"><div class="nb-print-turned">${label}</div></div>`,
    );
  });

  test("the page box is the paper, relative and clipped", () => {
    expect(ruleFor(doc, ".nb-print-paper")).toBe(
      "position: relative; width: 4in; height: 6in; overflow: hidden;",
    );
  });

  test("the label box is 6×4, placed at the page's right edge and turned 90deg clockwise about its top-left", () => {
    expect(ruleFor(doc, ".nb-print-turned")).toBe(
      "position: absolute; top: 0; left: 4in; width: 6in; height: 4in; " +
        "transform-origin: top left; transform: rotate(90deg);",
    );
  });

  test("pins html and body to the paper so rounding cannot spill a second label", () => {
    const sized = doc.match(/html, body \{[^}]*width:[^}]*\}/)?.[0] ?? "";
    expect(sized.replace(/\s+/g, " ")).toContain(
      "width: 4in; height: 6in; overflow: hidden;",
    );
  });

  test("caller CSS still lands after the helper's own rules", () => {
    expect(doc.indexOf(".caller")).toBeGreaterThan(
      doc.indexOf(".nb-print-turned {"),
    );
  });
});

describe("buildDocument on a portrait page", () => {
  const bodyHtml = "<section>Spine labels</section>";
  const doc = buildDocument({
    title: "Sheet",
    bodyHtml,
    css: "",
    page: { widthIn: 8.5, heightIn: 11 },
  });

  test("keeps the requested page size", () => {
    expect(ruleFor(doc, "@page")).toBe("size: 8.5in 11in; margin: 0;");
  });

  test("leaves the body exactly as given, with no rotation", () => {
    expect(bodyOf(doc)).toBe(bodyHtml);
    expect(doc).not.toContain("nb-print-");
    expect(doc).not.toContain("rotate(");
  });
});
