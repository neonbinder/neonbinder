/**
 * NEO-335 Phase 2 — the shared "Tidy up this set" header.
 */
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import WizardChrome, { railFraction, stepCounterText, WIZARD_TITLE } from "./WizardChrome";
import { STEP_SUBTITLE, type WizardStepKind } from "./entity-review-steps";

const fill = () => document.querySelector<HTMLElement>("[data-rail-fill]")!;

describe("WizardChrome", () => {
  it("titles the screen 'Tidy up this set' and exposes the title by id", () => {
    render(<WizardChrome titleId="t-id" step={3} total={12} subtitle="New team" />);
    const heading = screen.getByRole("heading", { name: WIZARD_TITLE });
    expect(WIZARD_TITLE).toBe("Tidy up this set");
    expect(heading.id).toBe("t-id");
  });

  it("says 'Step x of y' as one text node in a status region", () => {
    render(<WizardChrome step={3} total={12} subtitle="New team" />);
    const counter = screen.getByText("Step 3 of 12");
    expect(counter.getAttribute("role")).toBe("status");
    // One text node, so a matcher on the visible phrase sees all of it.
    expect(counter.childNodes).toHaveLength(1);
    expect(counter.className).toContain("tabular-nums");
    expect(stepCounterText(1, 2)).toBe("Step 1 of 2");
  });

  it("keeps the counter's region mounted but empty when there is no count", () => {
    render(<WizardChrome step={0} total={0} subtitle="" />);
    const statuses = screen.getAllByRole("status");
    expect(statuses.map((s) => s.textContent)).toEqual([""]);
    expect(fill().style.width).toBe("0.000%");
  });

  it.each(Object.entries(STEP_SUBTITLE) as Array<[WizardStepKind, string]>)(
    "shows the %s subtitle on the line below",
    (_kind, subtitle) => {
      render(<WizardChrome step={1} total={2} subtitle={subtitle} />);
      const line = screen.getByText(subtitle);
      const heading = screen.getByRole("heading", { name: WIZARD_TITLE });
      // DOCUMENT_POSITION_FOLLOWING: the subtitle comes after the title row.
      expect(heading.compareDocumentPosition(line) & 4).toBe(4);
      expect(line.tagName).not.toMatch(/^H\d$/);
    },
  );

  it("fills the rail to x/y and hides it from assistive tech", () => {
    render(<WizardChrome step={3} total={12} subtitle="New team" />);
    expect(fill().style.width).toBe("25.000%");
    expect(fill().parentElement!.getAttribute("aria-hidden")).toBe("true");
    expect(railFraction(5, 4)).toBe(1);
    expect(railFraction(2, 0)).toBe(0);
  });

  it("animates the width only forward, and never under reduced motion", () => {
    const { rerender } = render(<WizardChrome step={1} total={4} subtitle="New team" />);
    // First paint: nothing to animate from.
    expect(fill().className).toContain("transition-none");

    rerender(<WizardChrome step={2} total={4} subtitle="New team" />);
    expect(fill().getAttribute("data-rail-forward")).toBe("true");
    expect(fill().className).toContain("transition-[width]");
    // Reduced motion switches the transition off.
    expect(fill().className).toContain("motion-reduce:transition-none");

    // Back a step: the fill moves without a transition.
    rerender(<WizardChrome step={1} total={4} subtitle="New team" />);
    expect(fill().getAttribute("data-rail-forward")).toBe("false");
    expect(fill().className).not.toContain("transition-[width]");
    expect(fill().style.width).toBe("25.000%");

    // A total that grew is also "backwards" (x/y shrank): no slide back.
    rerender(<WizardChrome step={2} total={4} subtitle="New team" />);
    rerender(<WizardChrome step={2} total={6} subtitle="New team" />);
    expect(fill().className).not.toContain("transition-[width]");
  });

  it("carries the growth line in an always-mounted polite region", () => {
    const { rerender } = render(<WizardChrome step={3} total={10} subtitle="New player" />);
    const region = document.querySelector('[aria-live="polite"]')!;
    expect(region.textContent).toBe("");

    rerender(
      <WizardChrome
        step={3}
        total={12}
        subtitle="New player"
        announcement="2 more steps: teams for Jim Thome"
      />,
    );
    // The same node, now with text — a region that mounts with its message
    // announces unreliably.
    expect(document.querySelector('[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toBe("2 more steps: teams for Jim Thome");
    expect(screen.getByText("Step 3 of 12")).toBeTruthy();
  });

  it("lets a long growth line wrap rather than clip it, in a row whose height is reserved", () => {
    const long =
      "3 more steps: teams for Jean-Baptiste Giancarlo Fernández-Montgomery and Ken Griffey Jr.";
    render(<WizardChrome step={3} total={12} subtitle="New player" announcement={long} />);
    const line = document.querySelector<HTMLElement>("[data-growth-line]")!;
    expect(line.textContent).toBe(long);
    // a11y audit: never truncated, at any width.
    expect(line.className).not.toMatch(/(^|\s)(sm:)?truncate(\s|$)/);
    expect(line.className).toContain("sm:whitespace-normal");
    // Two lines reserved from `sm` up, so a line arriving or wrapping does not
    // move the body.
    expect(line.parentElement!.className).toContain("sm:min-h-8");
  });

  it("renders children under the subtitle row", () => {
    render(
      <WizardChrome step={1} total={2} subtitle="Cards with no team">
        <p>extra</p>
      </WizardChrome>,
    );
    expect(screen.getByText("extra")).toBeTruthy();
  });
});

void React;
