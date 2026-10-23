/**
 * NEO-356 — NeonButton is the one place a button's colour is decided. These
 * lock in what each variant paints (as role variables, so it follows the
 * mode), the outline form, and the disabled look in both modes, including the
 * `aria-disabled` path a caller uses to keep a button in the tab order.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NeonButton, { neonButtonPaint, type NeonButtonVariant } from "./NeonButton";

const HUE: Record<NeonButtonVariant, string> = {
  primary: "green",
  secondary: "blue",
  tertiary: "purple",
  negative: "pink",
};

const prop = (el: HTMLElement, name: string) => el.style.getPropertyValue(name);

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("NeonButton variants", () => {
  for (const variant of Object.keys(HUE) as NeonButtonVariant[]) {
    const hue = HUE[variant];

    it(`${variant} fills with neon ${hue}, its hover role and its on-neon ink`, () => {
      render(<NeonButton variant={variant}>Go</NeonButton>);
      const button = screen.getByRole("button", { name: "Go" });
      expect(prop(button, "--nb-fill")).toBe(`var(--neon-${hue})`);
      expect(prop(button, "--nb-fill-hover")).toBe(`var(--neon-${hue}-hover)`);
      expect(prop(button, "--nb-ink")).toBe(`var(--on-neon-${hue})`);
      expect(prop(button, "--nb-edge")).toBe("transparent");
    });

    it(`${variant} outline draws the hue as text and edge, filling under the pointer`, () => {
      render(
        <NeonButton variant={variant} outline>
          Go
        </NeonButton>,
      );
      const button = screen.getByRole("button", { name: "Go" });
      expect(prop(button, "--nb-fill")).toBe("transparent");
      expect(prop(button, "--nb-ink")).toBe(`var(--neon-${hue}-text)`);
      expect(prop(button, "--nb-edge")).toBe(`var(--neon-${hue}-text)`);
      expect(prop(button, "--nb-fill-hover")).toBe(`var(--neon-${hue})`);
      expect(prop(button, "--nb-ink-hover")).toBe(`var(--on-neon-${hue})`);
      expect(prop(button, "--nb-edge-hover")).toBe(`var(--neon-${hue})`);
    });
  }

  it("is primary by default, a Radix solid button at size 2, with the app's focus outline", () => {
    render(<NeonButton>Save</NeonButton>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(prop(button, "--nb-fill")).toBe("var(--neon-green)");
    expect(button.className).toContain("neon-button");
    expect(button.className).toContain("focus-outline");
    expect(button.className).toContain("rt-r-size-2");
  });

  it("paints only with role variables, never a literal colour", () => {
    for (const variant of Object.keys(HUE) as NeonButtonVariant[]) {
      for (const outline of [false, true]) {
        for (const value of Object.values(neonButtonPaint(variant, outline))) {
          expect(value).toMatch(/^(var\(--[a-z0-9-]+\)|transparent)$/);
        }
      }
    }
  });

  it("keeps the caller's className, style, type, handlers and aria attributes", () => {
    const onClick = vi.fn();
    render(
      <NeonButton
        variant="negative"
        type="submit"
        className="w-full"
        style={{ marginTop: "4px" }}
        aria-label="Delete the binder"
        onClick={onClick}
      >
        Delete
      </NeonButton>,
    );
    const button = screen.getByRole("button", { name: "Delete the binder" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.className).toContain("w-full");
    expect(button.style.marginTop).toBe("4px");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("forwards its ref to the button", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<NeonButton ref={ref}>Focus me</NeonButton>);
    expect(ref.current).toBe(screen.getByRole("button", { name: "Focus me" }));
  });
});

describe("NeonButton disabled", () => {
  it("dark: a fill keeps its neon, dimmed to 45%, with the not-allowed cursor", () => {
    document.documentElement.dataset.theme = "dark";
    render(
      <NeonButton variant="secondary" disabled>
        Preview
      </NeonButton>,
    );
    const button = screen.getByRole("button", { name: "Preview" });
    expect(button.style.backgroundColor).toBe("var(--neon-blue)");
    expect(button.style.color).toBe("var(--on-neon-blue)");
    expect(button.style.opacity).toBe("0.45");
    expect(button.style.cursor).toBe("not-allowed");
  });

  it("light: a fill swaps to the neutral button fill and quiet ink, at full opacity", () => {
    document.documentElement.dataset.theme = "light";
    render(
      <NeonButton variant="negative" disabled>
        Cancel
      </NeonButton>,
    );
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button.style.backgroundColor).toBe("var(--button-neutral)");
    expect(button.style.color).toBe("var(--ink-3)");
    expect(button.style.opacity).toBe("");
    expect(button.style.cursor).toBe("not-allowed");
  });

  it("aria-disabled looks the same as disabled but stays in the tab order", () => {
    document.documentElement.dataset.theme = "dark";
    render(<NeonButton aria-disabled>Confirm</NeonButton>);
    const button = screen.getByRole("button", { name: "Confirm" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.style.opacity).toBe("0.45");
    expect(button.style.cursor).toBe("not-allowed");
  });

  it("aria-disabled in light takes the neutral fill too", () => {
    document.documentElement.dataset.theme = "light";
    render(
      <NeonButton variant="tertiary" aria-disabled="true">
        Shuffle
      </NeonButton>,
    );
    const button = screen.getByRole("button", { name: "Shuffle" });
    expect(button.style.backgroundColor).toBe("var(--button-neutral)");
  });

  for (const mode of ["dark", "light"] as const) {
    it(`${mode}: an outline fades to half, keeping its hue`, () => {
      document.documentElement.dataset.theme = mode;
      render(
        <NeonButton variant="secondary" outline disabled>
          Back
        </NeonButton>,
      );
      const button = screen.getByRole("button", { name: "Back" });
      expect(button.style.opacity).toBe("0.5");
      expect(button.style.color).toBe("var(--neon-blue-text)");
      expect(button.style.cursor).toBe("not-allowed");
    });
  }

  it("an enabled button sets no disabled look", () => {
    render(<NeonButton aria-disabled={false}>Go</NeonButton>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.style.opacity).toBe("");
    expect(button.style.cursor).toBe("");
  });
});
