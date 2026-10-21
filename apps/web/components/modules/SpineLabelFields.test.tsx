/**
 * The spine label designer's shared style sections (NEO-147 fields, shared
 * with the collection page's binder label editor in NEO-350): controlled
 * colours with Invert and the contrast readout, and the lettering picker.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import { SpineLabelColors, SpineLabelLettering } from "./SpineLabelFields";

function colors(background: string, text: string) {
  const handlers = { onBackgroundChange: vi.fn(), onTextChange: vi.fn(), onInvert: vi.fn() };
  render(
    <Theme>
      <SpineLabelColors background={background} text={text} {...handlers} />
    </Theme>,
  );
  return handlers;
}

describe("SpineLabelColors", () => {
  it("reads out an easy pair as easy", () => {
    colors("#203731", "#FFB612");
    expect(screen.getByText(/Contrast 7\.2:1/).textContent).toContain("easy to read on a shelf.");
  });

  it("warns on a pair below 3:1 and says what will fix it", () => {
    colors("#005A9C", "#EF3E42");
    expect(screen.getByText(/Contrast 1\.8:1/).textContent).toContain(
      "hard to read on a shelf. Try a lighter or darker lettering color.",
    );
  });

  it("never offers Invert as the fix: swapping the pair cannot change the ratio", () => {
    colors("#EF3E42", "#005A9C");
    const readout = screen.getByText(/Contrast 1\.8:1/).textContent ?? "";
    expect(readout).toContain("Try a lighter or darker lettering color.");
    expect(readout).not.toMatch(/invert/i);
  });

  it("asks for two hex colours while one is mid-edit", () => {
    colors("#00", "#ffffff");
    expect(screen.getByText("Enter two hex colors (e.g. #01214b) to see contrast.")).toBeTruthy();
  });

  it("hands every edit and Invert to the caller", () => {
    const h = colors("#203731", "#FFB612");
    fireEvent.change(screen.getByLabelText("Background"), { target: { value: "#000000" } });
    fireEvent.change(screen.getByLabelText("Lettering"), { target: { value: "#ffffff" } });
    fireEvent.click(screen.getByRole("button", { name: "Invert" }));
    expect(h.onBackgroundChange).toHaveBeenCalledWith("#000000");
    expect(h.onTextChange).toHaveBeenCalledWith("#ffffff");
    expect(h.onInvert).toHaveBeenCalledOnce();
  });
});

describe("SpineLabelLettering", () => {
  it("checks the chosen face, sets each option in its own face, and reports a pick", () => {
    const onFontChange = vi.fn();
    render(<SpineLabelLettering fontId="anton" onFontChange={onFontChange} />);
    const group = screen.getByRole("radiogroup", { name: "Label typeface" });
    expect(group).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Anton" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("radio", { name: "Teko" }) as HTMLElement).style.fontFamily).toContain("Teko");
    fireEvent.click(screen.getByRole("radio", { name: "Teko" }));
    expect(onFontChange).toHaveBeenCalledWith("teko");
    expect(screen.getByText("Heavy condensed. Jersey lettering.")).toBeTruthy();
  });
});
