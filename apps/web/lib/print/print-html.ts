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
  page: PrintPageSize;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDocument(options: PrintHtmlDocumentOptions): string {
  const { title, bodyHtml, css, page } = options;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      /* Exact physical page. The zero margin is what stops the browser adding
         its own half-inch and scaling the label down to fit inside it. */
      @page {
        size: ${page.widthIn}in ${page.heightIn}in;
        margin: 0;
      }
      html, body {
        margin: 0;
        padding: 0;
        background: #fff;
      }
      /* Keep backgrounds/borders when the browser would otherwise drop them. */
      * {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
${css}
    </style>
  </head>
  <body>${bodyHtml}</body>
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

    await waitForFonts(frameDocument);

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
