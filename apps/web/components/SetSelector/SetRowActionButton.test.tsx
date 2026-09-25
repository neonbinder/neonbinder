/**
 * NEO-306 — SetRowActionButton, the one button every set-row action wears.
 *
 * Pinned here: the name is the visible text (the icon is hidden from it),
 * `disabled`/`busy` are aria-only so the button stays focusable and swallows
 * activation, Enter activates like a click (maestro-web's `pressKey` is
 * synthetic), `inert` passes through, and each tone carries its classes and
 * the one focus ring.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { Square2StackIcon } from "@heroicons/react/24/outline";
import { afterEach, describe, expect, it, vi } from "vitest";

import SetRowActionButton, {
  SET_ROW_ACTION_TONE_CLASSES,
} from "./SetRowActionButton";

afterEach(() => {
  vi.clearAllMocks();
});

const RING = [
  "focus-visible:outline-none",
  "focus-visible:ring-2",
  "focus-visible:ring-[#00B7FF]",
  "focus-visible:ring-offset-2",
];

function hasAll(el: HTMLElement, classes: string) {
  return classes.split(" ").every((cls) => el.classList.contains(cls));
}

describe("SetRowActionButton", () => {
  it("is named by its visible text alone: no aria-label, and the icon is aria-hidden", () => {
    render(
      <SetRowActionButton icon={Square2StackIcon} onActivate={vi.fn()}>
        Make parallel of…
      </SetRowActionButton>,
    );
    const button = screen.getByRole("button", { name: "Make parallel of…" });
    expect(button.getAttribute("aria-label")).toBeNull();
    expect(button.textContent).toBe("Make parallel of…");
    expect(button.getAttribute("type")).toBe("button");
    const icon = button.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
  });

  it("activates on click and on Enter, once each", () => {
    const onActivate = vi.fn();
    render(
      <SetRowActionButton icon={Square2StackIcon} onActivate={onActivate}>
        Go
      </SetRowActionButton>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(2);
    // Space is left to the browser's own keyup click.
    fireEvent.keyDown(button, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("disabled is aria-disabled, never native: it stays focusable and swallows activation", () => {
    const onActivate = vi.fn();
    render(
      <SetRowActionButton icon={Square2StackIcon} onActivate={onActivate} disabled>
        Go
      </SetRowActionButton>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-busy")).toBeNull();

    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("busy is aria-busy AND aria-disabled, keeps focus, and swallows activation", () => {
    const onActivate = vi.fn();
    const { rerender } = render(
      <SetRowActionButton icon={Square2StackIcon} onActivate={onActivate}>
        Go
      </SetRowActionButton>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    button.focus();

    rerender(
      <SetRowActionButton icon={Square2StackIcon} onActivate={onActivate} busy>
        Go
      </SetRowActionButton>,
    );
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    // The button the operator just pressed does not lose focus to <body>.
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("carries no state attributes when idle", () => {
    render(
      <SetRowActionButton icon={Square2StackIcon} onActivate={vi.fn()}>
        Go
      </SetRowActionButton>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.hasAttribute("inert")).toBe(false);
  });

  it("passes inert, the disclosure/popup attributes, id, title and ref through", () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <SetRowActionButton
        ref={ref}
        id="move-set-brand"
        icon={Square2StackIcon}
        onActivate={vi.fn()}
        inert
        title="Why you would"
        aria-haspopup="dialog"
        aria-expanded={false}
        aria-controls="list-1"
        aria-describedby="reason-1"
      >
        Go
      </SetRowActionButton>,
    );
    const button = document.getElementById("move-set-brand")!;
    expect(ref.current).toBe(button);
    expect(button.hasAttribute("inert")).toBe(true);
    expect(button.getAttribute("title")).toBe("Why you would");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("list-1");
    expect(button.getAttribute("aria-describedby")).toBe("reason-1");
  });

  it("quiet (the default) is the outlined chip: slate-500 boundary, gray-200 text, 32px, the one ring", () => {
    render(
      <SetRowActionButton icon={Square2StackIcon} onActivate={vi.fn()}>
        Go
      </SetRowActionButton>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    expect(hasAll(button, SET_ROW_ACTION_TONE_CLASSES.quiet)).toBe(true);
    for (const cls of ["min-h-8", "border", "border-slate-500", "text-gray-200", ...RING]) {
      expect(button.classList.contains(cls)).toBe(true);
    }
    expect(button.classList.contains("bg-amber-400/15")).toBe(false);
  });

  it("attention is the amber pill with the exclamation icon, and the same ring", () => {
    render(
      <SetRowActionButton tone="attention" onActivate={vi.fn()}>
        3 cards need a team
      </SetRowActionButton>,
    );
    const button = screen.getByRole("button", { name: "3 cards need a team" });
    expect(hasAll(button, SET_ROW_ACTION_TONE_CLASSES.attention)).toBe(true);
    for (const cls of [
      "min-h-8",
      "rounded-full",
      "border-amber-700",
      "bg-amber-400/15",
      "text-amber-800",
      ...RING,
    ]) {
      expect(button.classList.contains(cls)).toBe(true);
    }
    expect(button.classList.contains("border-slate-500")).toBe(false);
    // The icon is part of what the tone means; it never joins the name.
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
