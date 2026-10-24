/**
 * NEO-118 — print an arbitrary HTML fragment at an exact physical page size.
 *
 * ## Why not reuse `printSvg()` from app/print/qr/page.tsx
 * That helper opens a popup, `document.write`s into it, and prints on
 * `win.onload`. It works often enough for an occasional QR code, but it has
 * three failure modes that matter for something printed on every package:
 *
 *  1. `window.open` is popup-blocked unless the call is inside a user gesture,
 *     and stays blocked if anything is awaited first.
 *  2. A blank popup document is *already* loaded, so `onload` may never fire
 *     after `document.write` — the print silently never happens.
 *  3. `win.close()` immediately after `print()` truncates the job in some
 *     browsers, producing a blank or half-rendered label.
 *
 * A hidden same-origin iframe has none of those problems: no popup blocker, a
 * real `load` event via `srcdoc`, and a document we can keep alive until
 * `afterprint`.
 *
 * ## Why `bodyHtml` is a string rather than a specific element type
 * This is the seam for postage. Real postage providers return a *rendered*
 * label (PNG/PDF/ZPL) rather than data to lay out, so buying postage later
 * means printing `<img src="...">` at the same fixed page size. Keeping the
 * body opaque means that path reuses this function untouched.
 */

export interface PrintPageSize {
  widthIn: number;
  heightIn: number;
}

export interface PrintHtmlDocumentOptions {
  /** Becomes the document title, which browsers use as the default filename. */
  title: string;
  /** Markup to place inside <body>. Usually a serialized element's outerHTML. */
  bodyHtml: string;
  /** CSS for the print document. Nothing from the app's stylesheet is inherited. */
  css: string;
  /**
   * The page as the content is laid out: a 6×4 shipping label is
   * `{ widthIn: 6, heightIn: 4 }`. A landscape page is handed to the printer
   * portrait with the content turned onto it; see {@link printedPage}.
   */
  page: PrintPageSize;
}

/** A requested page as it reaches the printer; see {@link printedPage}. */
export interface PrintedPage {
  /** `@page` width, in inches: the paper as the printer feeds it. */
  widthIn: number;
  /** `@page` height, in inches. */
  heightIn: number;
  /** True when the content is turned 90deg clockwise onto the paper. */
  rotated: boolean;
}

/**
 * How a requested page reaches the printer.
 *
 * ## Why a landscape page is printed portrait, rotated
 * A label printer feeds its 4×6 stock short edge first, so the paper is a
 * portrait 4in × 6in page whatever the label's layout. Until Firefox 158 a
 * landscape `@page { size: 6in 4in }` was turned onto that stock by the
 * browser or the driver; since 158.0.1 (macOS) it no longer is, and the label
 * prints portrait on the stock while the print preview still looks right. A
 * carrier's 4×6 PDF label is laid out the same way, as a portrait page. So the
 * document asks for the page the paper actually is, and turns the content
 * itself:
 *
 *  - `@page` is the portrait page (`size: 4in 6in`).
 *  - A page box of that size, `position: relative; overflow: hidden`.
 *  - The content in a box at its own landscape size, absolutely placed at
 *    `top: 0; left: <page width>`, rotated 90deg clockwise about its top-left
 *    corner. That swings it down and left onto the page box exactly. This is
 *    the geometry proven on a label printer; do not "simplify" it to a
 *    centred rotation without paper to test on.
 *
 * Decided by shape, not by caller, because every landscape page this app
 * prints is a label on 4×6 roll stock, and a caller that had to opt in would
 * print a wasted label the day one forgot. Portrait pages (Letter and A4
 * sheets) pass through untouched. A square page is not landscape and is not
 * turned.
 */
export function printedPage(page: PrintPageSize): PrintedPage {
  if (page.widthIn > page.heightIn) {
    return { widthIn: page.heightIn, heightIn: page.widthIn, rotated: true };
  }
  return { widthIn: page.widthIn, heightIn: page.heightIn, rotated: false };
}

/**
 * How long to wait for `afterprint` before tearing the iframe down anyway.
 * `afterprint` is reliable in Chrome/Firefox but not guaranteed everywhere, and
 * a leaked iframe per print would accumulate across a shipping session. Long
 * enough that a user reading the print dialog is never cut off.
 */
const AFTERPRINT_FALLBACK_MS = 120_000;

/** Fonts should already be local (system stack); don't hang if that changes. */
const FONTS_READY_TIMEOUT_MS = 3_000;

/**
 * Images are the slow dependency: a purchased postage label is a REMOTE PNG
 * fetched from the carrier, not inline markup. More generous than the font
 * budget for that reason, but still bounded — printing late beats hanging.
 */
const IMAGES_READY_TIMEOUT_MS = 15_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inputs for {@link imageBodyHtml} — a remote label image sized to the page. */
export interface ImageBodyHtmlOptions {
  /** Absolute https URL of the image. Anything else is refused. */
  src: string;
  widthIn: number;
  heightIn: number;
}

/**
 * Build the `<img>` body for a printed label, from a URL we did not author.
 *
 * ## Why this is a function rather than a template literal at the call site
 * `bodyHtml` is dropped verbatim into the print iframe's `srcdoc`, and that
 * iframe is SAME-ORIGIN. A label URL comes back from EasyPost via the browser
 * service, so it is external input reaching a markup sink: a value containing
 * `"` closes the attribute and everything after it is markup we did not write,
 * executing with the page's origin. Both print call sites interpolated it by
 * hand, which is exactly the shape that goes wrong once and is then wrong
 * everywhere.
 *
 * Two defences, because either alone leaves a gap:
 *
 *  1. **Scheme check.** Only `https:` renders. `javascript:` is inert in a
 *     `src`, but `data:` is not — a `data:image/svg+xml` document runs script in
 *     the iframe's origin. A postage label is always an https URL from the
 *     carrier; anything else is a bug or an attack, and printing a blank sheet
 *     with no explanation is the worse outcome, so this throws a message the
 *     seller can act on.
 *  2. **Attribute escaping.** Even a legitimate https URL can carry `"` or `&`,
 *     and escaping keeps it inside the attribute where it belongs.
 *
 * For an ordinary https URL the output is byte-identical to the markup this
 * replaced, so nothing about the printed sheet changes.
 */
export function imageBodyHtml(options: ImageBodyHtmlOptions): string {
  const { src, widthIn, heightIn } = options;

  let parsed: URL;
  try {
    parsed = new URL(src);
  } catch {
    throw new Error("That label's image address isn't a usable link.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("That label's image address isn't a secure (https) link.");
  }

  return `<img src="${escapeHtml(src)}" alt="" style="width:${widthIn}in;height:${heightIn}in;display:block">`;
}

/**
 * The print iframe's whole document. Exported for its unit test only.
 *
 * ## Why it pins a light scheme and black text
 * The app around the iframe is dark-only (`color-scheme: dark` on `:root`,
 * `#ededed` body text, NEO-341). None of that crosses into a `srcdoc`
 * document, but the iframe ELEMENT inherits the dark scheme, and an embedded
 * document's `prefers-color-scheme` follows its embedder. A label printed on
 * white paper must never pick up either, so the document declares
 * `color-scheme: light` and black text itself instead of relying on browser
 * defaults. Label CSS still sets its own colours on top.
 */
export function buildDocument(options: PrintHtmlDocumentOptions): string {
  const { title, bodyHtml, css, page } = options;
  const paper = printedPage(page);
  // Rotated pages only (see printedPage). The page and body are pinned to the
  // paper and clipped, so a page rounded a hair larger never spills a blank
  // second label off the roll. Caller CSS comes after this and may still set
  // colours on html/body; it must not set their size.
  const rotationCss = paper.rotated
    ? `
      html, body {
        width: ${paper.widthIn}in;
        height: ${paper.heightIn}in;
        overflow: hidden;
      }
      .nb-print-paper {
        position: relative;
        width: ${paper.widthIn}in;
        height: ${paper.heightIn}in;
        overflow: hidden;
      }
      .nb-print-turned {
        position: absolute;
        top: 0;
        left: ${paper.widthIn}in;
        width: ${page.widthIn}in;
        height: ${page.heightIn}in;
        transform-origin: top left;
        transform: rotate(90deg);
      }`
    : "";
  const body = paper.rotated
    ? `<div class="nb-print-paper"><div class="nb-print-turned">${bodyHtml}</div></div>`
    : bodyHtml;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      /* Exact physical page, as the printer feeds it (portrait for a
         landscape label; see printedPage). The zero margin is what stops the
         browser adding its own half-inch and scaling the label down to fit
         inside it. */
      @page {
        size: ${paper.widthIn}in ${paper.heightIn}in;
        margin: 0;
      }
      :root {
        color-scheme: light;
      }
      html, body {
        margin: 0;
        padding: 0;
        background: #fff;
        color: #000;
      }
      /* Keep backgrounds/borders when the browser would otherwise drop them. */
      * {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }${rotationCss}
${css}
    </style>
  </head>
  <body>${body}</body>
</html>`;
}

function waitForFonts(doc: Document): Promise<void> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return Promise.resolve();
  return Promise.race([
    fonts.ready.then(() => undefined),
    new Promise<void>((resolve) =>
      setTimeout(resolve, FONTS_READY_TIMEOUT_MS),
    ),
  ]);
}

/**
 * The slice of `Document` {@link waitForImages} actually needs.
 *
 * Narrowed to this so the function can be unit-tested by handing it a plain
 * object with an `images` array — no DOM environment, no iframe, no real
 * decoding. A real `Document` satisfies it structurally.
 */
export interface ImageBearingDocument {
  images: ArrayLike<PrintableImage>;
}

/** The image surface used here — `HTMLImageElement` satisfies it structurally. */
export interface PrintableImage {
  complete: boolean;
  naturalWidth: number;
  decode(): Promise<unknown>;
  addEventListener(
    type: "load" | "error",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
}

/**
 * Wait for every <img> in the print document to be decoded and ready to paint.
 *
 * The iframe's `load` event does NOT cover this. `load` fires when the document
 * and its subresources are considered loaded, but an image added via `srcdoc`
 * can still be mid-fetch or decoded-but-not-yet-painted when `print()` runs —
 * and a print snapshot taken at that moment captures a blank box where the
 * label should be. Silent, intermittent, and worst on exactly the slow
 * connection where it matters most.
 *
 * This is why it exists at all: a purchased postage label is a remote PNG from
 * the carrier. Nothing printed before NEO-120 used an image, so the gap was
 * latent rather than broken.
 *
 * `decode()` is the precise primitive — it resolves when the image is ready to
 * paint, not merely fetched. Individual failures resolve rather than reject: a
 * broken image should still print (visibly missing, so the operator can see it)
 * instead of throwing away a label the seller has already paid for.
 */
export function waitForImages(doc: ImageBearingDocument): Promise<void> {
  const images = Array.from(doc.images ?? []);
  if (images.length === 0) return Promise.resolve();

  const settled = images.map((img) => {
    if (img.complete && img.naturalWidth > 0) {
      return img.decode().catch(() => undefined);
    }
    return new Promise<void>((resolve) => {
      img.addEventListener("load", () => {
        img.decode().then(
          () => resolve(),
          () => resolve(),
        );
      }, { once: true });
      img.addEventListener("error", () => resolve(), { once: true });
    });
  });

  return Promise.race([
    Promise.all(settled).then(() => undefined),
    new Promise<void>((resolve) =>
      setTimeout(resolve, IMAGES_READY_TIMEOUT_MS),
    ),
  ]);
}

/**
 * Render `bodyHtml` into a hidden iframe and open the browser's print dialog
 * for it. Resolves once the dialog has been dismissed (or the fallback fires) —
 * the iframe is removed by then.
 *
 * The returned promise rejects only if the iframe document is unreachable,
 * which in practice means the call happened outside a browser.
 */
export async function printHtmlDocument(
  options: PrintHtmlDocumentOptions,
): Promise<void> {
  const iframe = document.createElement("iframe");
  // Off-screen rather than display:none — a display:none iframe does not lay
  // out, and an unlaid-out document has nothing to print.
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  iframe.srcdoc = buildDocument(options);

  const loaded = new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
  });

  document.body.appendChild(iframe);

  try {
    await loaded;

    const frameWindow = iframe.contentWindow;
    const frameDocument = iframe.contentDocument;
    if (!frameWindow || !frameDocument) {
      throw new Error("Print frame was not reachable");
    }

    // Both, in parallel — they are independent and each is separately bounded.
    await Promise.all([
      waitForFonts(frameDocument),
      waitForImages(frameDocument),
    ]);

    // Resolve on afterprint so the iframe outlives the dialog. Registered
    // before print() because print() can block until the dialog is dismissed.
    const printed = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, AFTERPRINT_FALLBACK_MS);
      frameWindow.addEventListener("afterprint", finish, { once: true });
    });

    // Safari will not print an iframe that does not hold focus.
    frameWindow.focus();
    frameWindow.print();

    await printed;
  } finally {
    iframe.remove();
  }
}
