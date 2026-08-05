import React from "react";
import {
  formatAddressBlock,
  type PostalAddress,
} from "@/lib/shipping/address";
import {
  DEFAULT_LABEL_FORMAT,
  type LabelFormat,
} from "@/lib/shipping/label-formats";

/**
 * NEO-118 — the printable 4×6 shipping label.
 *
 * ## Every style here is inline, on purpose
 * Printing serializes this element's `outerHTML` into an isolated document that
 * has none of the app's stylesheets — no Tailwind, no globals.css. Inline
 * styles are the only ones that survive that trip, so they are also the ones
 * used on screen. The preview is therefore not an approximation of the label;
 * it is the same element with the same rules, which is what makes WYSIWYG hold.
 *
 * ## Black on white, always
 * Thermal label printers are 1-bit. The app's neon palette would come out as
 * unpredictable dither, so this component uses none of it — no `neon-*` tokens,
 * no theme variables. Unlike the QR page there is consequently no `@media
 * print` colour-override to keep in sync: the label is correct by construction.
 *
 * ## System font stack, not Lexend
 * A webfont has to load before the print dialog opens or the label prints in a
 * fallback face at different metrics. A system sans removes that race entirely,
 * and plain sans-serif is what USPS OCR prefers anyway.
 *
 * The top-right of the label is deliberately left clear. That is simply how an
 * address label is laid out — and it is where a postage indicia would go if
 * postage is added later.
 */

const LABEL_FONT_STACK =
  'Helvetica, "Helvetica Neue", Arial, "Liberation Sans", sans-serif';

export interface ShippingLabelProps {
  from: PostalAddress | null | undefined;
  to: Partial<PostalAddress> | null | undefined;
  format?: LabelFormat;
  /** Rendered in place of a missing recipient, so the preview is never blank. */
  toPlaceholder?: string;
}

function captionStyle(fontSize: string): React.CSSProperties {
  return {
    fontSize,
    fontWeight: 700,
    letterSpacing: "0.08em",
    margin: "0 0 0.04in 0",
  };
}

export const ShippingLabel = React.forwardRef<
  HTMLDivElement,
  ShippingLabelProps
>(function ShippingLabel(
  { from, to, format = DEFAULT_LABEL_FORMAT, toPlaceholder },
  ref,
) {
  const fromLines = formatAddressBlock(from);
  const toLines = formatAddressBlock(to);

  const containerStyle: React.CSSProperties = {
    width: `${format.widthIn}in`,
    height: `${format.heightIn}in`,
    padding: `${format.paddingIn}in`,
    boxSizing: "border-box",
    background: "#ffffff",
    color: "#000000",
    fontFamily: LABEL_FONT_STACK,
    display: "flex",
    flexDirection: "column",
    // A label that overflows its media silently loses the bottom of the
    // address; clipping at least makes the problem visible in the preview.
    overflow: "hidden",
  };

  return (
    <div ref={ref} style={containerStyle} data-label-format={format.id}>
      {/* FROM — top-left, small. The top-right stays clear (see header note). */}
      <div style={{ maxWidth: "60%" }}>
        <p style={captionStyle("7pt")}>FROM</p>
        <div
          style={{
            fontSize: "9pt",
            lineHeight: 1.3,
            wordBreak: "break-word",
          }}
        >
          {fromLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </div>

      {/* TO — the block the carrier actually reads, so it gets the space. */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          padding: "0 0.15in",
        }}
      >
        <p style={captionStyle("8pt")}>TO</p>
        {toLines.length > 0 ? (
          <div
            style={{
              fontSize: "17pt",
              fontWeight: 700,
              lineHeight: 1.25,
              wordBreak: "break-word",
            }}
          >
            {toLines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: "12pt", fontStyle: "italic" }}>
            {toPlaceholder ?? ""}
          </div>
        )}
      </div>
    </div>
  );
});

export default ShippingLabel;
