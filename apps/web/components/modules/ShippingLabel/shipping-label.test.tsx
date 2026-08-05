/**
 * NEO-118 — component tests for the printable 4×6 shipping label.
 *
 * What is actually at risk here is not "does it render text" — it is the two
 * properties that make the printed paper match the screen:
 *
 *  1. **Physical dimensions in inches.** The print document sets
 *     `@page { size: 6in 4in }`; if the label element itself is not also 6in ×
 *     4in the label prints scaled or spills onto a second page. These assert
 *     the literal inch values rather than pixels, because inches are what
 *     survive into the print document.
 *  2. **Styles are inline, not classes.** Printing serializes `outerHTML` into
 *     an isolated document with none of the app's stylesheets. A style that
 *     lives in a Tailwind class renders correctly on screen and vanishes on
 *     paper — the exact bug class that is invisible until someone wastes a
 *     label. The serialization test below is the guard.
 */

import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { ShippingLabel } from "./shipping-label";
import { LABEL_4X6_LANDSCAPE } from "@/lib/shipping/label-formats";
import type { PostalAddress } from "@/lib/shipping/address";

const FROM: PostalAddress = {
  name: "Jason Seller",
  line1: "500 Commerce St",
  city: "Dallas",
  state: "TX",
  postalCode: "75202",
  country: "US",
};

const TO: PostalAddress = {
  name: "Jane Buyer",
  line1: "123 Main St",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

function renderLabel(props: Partial<React.ComponentProps<typeof ShippingLabel>> = {}) {
  const ref = React.createRef<HTMLDivElement>();
  render(<ShippingLabel ref={ref} from={FROM} to={TO} {...props} />);
  return ref;
}

describe("ShippingLabel", () => {
  it("renders both address blocks, uppercased", () => {
    renderLabel();
    expect(screen.getByText("JASON SELLER")).toBeTruthy();
    expect(screen.getByText("500 COMMERCE ST")).toBeTruthy();
    expect(screen.getByText("JANE BUYER")).toBeTruthy();
    expect(screen.getByText("AUSTIN TX 78701")).toBeTruthy();
  });

  it("labels the two blocks so the recipient block is unambiguous", () => {
    renderLabel();
    expect(screen.getByText("FROM")).toBeTruthy();
    expect(screen.getByText("TO")).toBeTruthy();
  });

  // The core geometry contract with @page in lib/print/print-html.ts.
  it("sizes itself in inches to match the print page exactly", () => {
    const ref = renderLabel();
    const style = ref.current!.style;
    expect(style.width).toBe(`${LABEL_4X6_LANDSCAPE.widthIn}in`);
    expect(style.height).toBe(`${LABEL_4X6_LANDSCAPE.heightIn}in`);
    expect(style.padding).toBe(`${LABEL_4X6_LANDSCAPE.paddingIn}in`);
    // Without border-box the padding would push the label past 6x4.
    expect(style.boxSizing).toBe("border-box");
  });

  it("prints black on white with no theme colour leaking in", () => {
    const ref = renderLabel();
    const style = ref.current!.style;
    // Compared case-insensitively as hex: happy-dom preserves the authored
    // form rather than normalising to rgb().
    expect(style.color.toLowerCase()).toBe("#000000");
    expect(style.background.toLowerCase()).toBe("#ffffff");
    // Thermal printers are 1-bit; any neon token here would dither badly.
    expect(ref.current!.outerHTML).not.toMatch(/#00D558|#00E5C0|neon-/);
  });

  // The serialization guard: what gets printed is outerHTML, so every style
  // that matters must already be in the style attribute.
  it("carries its styling inline so it survives serialization", () => {
    const ref = renderLabel();
    const html = ref.current!.outerHTML;
    expect(html).toContain("width: 6in");
    expect(html).toContain("height: 4in");
    expect(html).toContain("JANE BUYER");
    // No class-based styling to be lost in the isolated print document.
    expect(ref.current!.className).toBe("");
  });

  it("shows a placeholder instead of a blank block before a recipient is typed", () => {
    render(
      <ShippingLabel
        from={FROM}
        to={null}
        toPlaceholder="Recipient address appears here"
      />,
    );
    expect(screen.getByText("Recipient address appears here")).toBeTruthy();
  });

  it("omits blank optional lines rather than printing empty rows", () => {
    const ref = renderLabel({ to: { ...TO, company: "", line2: "" } });
    // name + street + city line, and nothing between them.
    expect(ref.current!.outerHTML).not.toMatch(/<div><\/div>/);
  });

  it("includes company and line2 when they are provided", () => {
    renderLabel({ to: { ...TO, company: "Card Shop LLC", line2: "Suite 200" } });
    expect(screen.getByText("CARD SHOP LLC")).toBeTruthy();
    expect(screen.getByText("SUITE 200")).toBeTruthy();
  });
});
