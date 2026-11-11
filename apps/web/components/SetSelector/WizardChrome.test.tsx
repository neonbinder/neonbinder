/**
 * NEO-335 Phase 2 — the shared "Tidy up …" header. NEO-497 — its title names
 * the set ("Tidy up 2024 Topps Chrome Base").
 */
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import WizardChrome, {
  railFraction,
  stepCounterText,
  tidyUpTitle,
  tidyUpTitleFromChain,
  WIZARD_TITLE,
} from "./WizardChrome";
import { STEP_SUBTITLE, type WizardStepKind } from "./entity-review-steps";

const fill = () => document.querySelector<HTMLElement>("[data-rail-fill]")!;

describe("WizardChrome", () => {
  it("titles the screen 'Tidy up this set' by default and exposes the title by id", () => {
    render(<WizardChrome titleId="t-id" step={3} total={12} subtitle="New team" />);
    const heading = screen.getByRole("heading", { name: WIZARD_TITLE });
    expect(WIZARD_TITLE).toBe("Tidy up this set");
    expect(heading.id).toBe("t-id");
  });

  it("shows the host's title, and lets a long one wrap beside the counter", () => {
    const long = "Tidy up 2024 Topps Chrome Update Series Gold Wave Refractors";
    render(<WizardChrome titleId="t-id" title={long} step={3} total={12} subtitle="New team" />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe(long);
    expect(heading.id).toBe("t-id");
    expect(screen.queryByText(WIZARD_TITLE)).toBeNull();
    // Wraps (never truncates) and may shrink; the counter never does.
    expect(heading.className).toContain("min-w-0");
    expect(heading.className).toContain("wrap-anywhere");
    expect(heading.className).not.toContain("truncate");
    expect(screen.getByText("Step 3 of 12").className).toContain("shrink-0");
  });

  it("clamps a long title to three lines visually, keeping the full text as its name and title", () => {
    const long =
      "Tidy up 2024 Topps Chrome Update Series Sapphire Edition Future Stars Gold Wave Refractors";
    render(<WizardChrome titleId="t-id" title={long} step={3} total={12} subtitle="New team" />);
    // The accessible name is the WHOLE title: the clamp is CSS only.
    const heading = screen.getByRole("heading", { level: 2, name: long });
    expect(heading.textContent).toBe(long);
    expect(heading.className).toMatch(/(^|\s)line-clamp-3(\s|$)/);
    expect(heading.getAttribute("title")).toBe(long);
  });

  it("gives the title the whole row below sm and the counter its own right-aligned line", () => {
    render(<WizardChrome step={9} total={12} subtitle="New team" />);
    const heading = screen.getByRole("heading", { level: 2 });
    const counter = screen.getByText("Step 9 of 12");
    const row = heading.parentElement!;
    // Title and counter share one wrapping row.
    expect(counter.parentElement).toBe(row);
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "flex-wrap"]));
    // Below sm the title takes the full row, so the counter wraps to its own
    // line; from sm up the title takes what the counter leaves.
    expect(heading.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["basis-full", "sm:basis-auto", "sm:flex-1"]),
    );
    // The counter sits at the right on its own line, and from sm up holds a
    // constant width ("Step 99 of 99"), so "Step 9" -> "Step 10" never
    // re-wraps the title beside it.
    expect(counter.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["ml-auto", "text-right", "whitespace-nowrap", "sm:min-w-[6.5rem]"]),
    );
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

describe("tidyUpTitle (NEO-497)", () => {
  it("joins year, set and variant after 'Tidy up'", () => {
    expect(tidyUpTitle({ year: "2026", setName: "Donruss Unleashed", variant: "Base" })).toBe(
      "Tidy up 2026 Donruss Unleashed Base",
    );
  });

  it("skips the year when the set name already opens with it as its own word", () => {
    expect(tidyUpTitle({ year: "2024", setName: "2024 Topps Chrome", variant: "Base" })).toBe(
      "Tidy up 2024 Topps Chrome Base",
    );
    expect(tidyUpTitle({ year: " 2024 ", setName: "2024 Topps Chrome" })).toBe(
      "Tidy up 2024 Topps Chrome",
    );
    // A different season, or the year glued to another word, is not a repeat.
    expect(tidyUpTitle({ year: "2024", setName: "2024-25 Hoops" })).toBe(
      "Tidy up 2024 2024-25 Hoops",
    );
    expect(tidyUpTitle({ year: "2024", setName: "2023 Topps Chrome" })).toBe(
      "Tidy up 2024 2023 Topps Chrome",
    );
  });

  it("skips any part that is missing or blank", () => {
    expect(tidyUpTitle({ setName: "Donruss Unleashed", variant: "Base" })).toBe(
      "Tidy up Donruss Unleashed Base",
    );
    expect(tidyUpTitle({ year: "2026", setName: null, variant: "Gold" })).toBe("Tidy up 2026 Gold");
    expect(tidyUpTitle({ year: "  ", setName: " Donruss ", variant: "" })).toBe("Tidy up Donruss");
  });

  it("falls back to 'Tidy up this set' when nothing is known", () => {
    expect(tidyUpTitle({})).toBe(WIZARD_TITLE);
    expect(tidyUpTitle({ year: null, setName: undefined, variant: " " })).toBe(WIZARD_TITLE);
  });
});

describe("tidyUpTitleFromChain (NEO-497)", () => {
  const chain = [
    { level: "sport", value: "Baseball" },
    { level: "year", value: "2024" },
    { level: "manufacturer", value: "Topps" },
    { level: "setName", value: "Topps Chrome" },
  ];

  it("reads the year and set by level, never the manufacturer, and the leaf as the variant", () => {
    expect(tidyUpTitleFromChain([...chain, { level: "variantType", value: "Base" }])).toBe(
      "Tidy up 2024 Topps Chrome Base",
    );
  });

  it("names an insert leaf by its own value, never the variant type", () => {
    expect(
      tidyUpTitleFromChain([
        ...chain,
        { level: "variantType", value: "Parallel" },
        { level: "insert", value: "Gold Wave Refractors" },
      ]),
    ).toBe("Tidy up 2024 Topps Chrome Gold Wave Refractors");
  });

  it("names a parallel after its insert, never the variant type", () => {
    expect(
      tidyUpTitleFromChain([
        ...chain,
        { level: "variantType", value: "Insert" },
        { level: "insert", value: "Future Stars" },
        { level: "parallel", value: "Gold" },
      ]),
    ).toBe("Tidy up 2024 Topps Chrome Future Stars Gold");
  });

  it("leaves a parallel alone when its name already opens with its insert's", () => {
    const donruss = [
      { level: "sport", value: "Baseball" },
      { level: "year", value: "2026" },
      { level: "manufacturer", value: "Panini" },
      { level: "setName", value: "Donruss" },
      { level: "variantType", value: "Inserts" },
      { level: "insert", value: "Unleashed" },
    ];
    expect(tidyUpTitleFromChain([...donruss, { level: "parallel", value: "Unleashed Blue Ice" }])).toBe(
      "Tidy up 2026 Donruss Unleashed Blue Ice",
    );
    // Case-folded.
    expect(tidyUpTitleFromChain([...donruss, { level: "parallel", value: "unleashed Gold" }])).toBe(
      "Tidy up 2026 Donruss unleashed Gold",
    );
    // A token, not a substring: "Unleashedx" does not open with "Unleashed".
    expect(tidyUpTitleFromChain([...donruss, { level: "parallel", value: "Unleashedx" }])).toBe(
      "Tidy up 2026 Donruss Unleashed Unleashedx",
    );
  });

  it("does not say the year twice when the set's own name opens with it", () => {
    const yearInName = chain.map((row) =>
      row.level === "setName" ? { ...row, value: "2024 Topps Chrome" } : row,
    );
    expect(tidyUpTitleFromChain([...yearInName, { level: "variantType", value: "Base" }])).toBe(
      "Tidy up 2024 Topps Chrome Base",
    );
  });

  it("never names the set twice when the chain ends at the set", () => {
    expect(tidyUpTitleFromChain(chain)).toBe("Tidy up 2024 Topps Chrome");
  });

  it("is 'Tidy up this set' while the chain is loading or empty", () => {
    expect(tidyUpTitleFromChain(undefined)).toBe(WIZARD_TITLE);
    expect(tidyUpTitleFromChain(null)).toBe(WIZARD_TITLE);
    expect(tidyUpTitleFromChain([])).toBe(WIZARD_TITLE);
  });
});
