/**
 * NEO-356 — the header logo: neon art in dark, the single-colour Mark in
 * light, with the same accessible name either way.
 */
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "@/src/theme/ThemeProvider";
import { BrandMark } from "./BrandMark";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

const theme: { setPreference: (p: "light" | "dark") => void } = { setPreference: () => {} };
function Capture() {
  const { setPreference } = useTheme();
  useEffect(() => {
    theme.setPreference = setPreference;
  });
  return null;
}

describe("BrandMark", () => {
  it("dark: the neon logo image", () => {
    localStorage.setItem("nb-theme", "dark");
    render(
      <ThemeProvider>
        <BrandMark />
      </ThemeProvider>,
    );
    const img = screen.getByRole("img", { name: "Neon Binder" });
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe("/logo-120.png");
  });

  it("light: the Mark, masked from logo-mark.svg in the brand green, same name", () => {
    localStorage.setItem("nb-theme", "dark");
    render(
      <ThemeProvider>
        <Capture />
        <BrandMark size={32} />
      </ThemeProvider>,
    );
    act(() => theme.setPreference("light"));
    const mark = screen.getByRole("img", { name: "Neon Binder" });
    expect(mark.tagName).toBe("SPAN");
    expect(mark.className).toContain("brand-mark-mask");
    expect(mark.className).toContain("text-neon-green-text");
    expect(mark.style.width).toBe("32px");
  });
});
