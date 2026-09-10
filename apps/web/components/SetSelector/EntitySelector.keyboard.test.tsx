/**
 * NEO-260 — the cascade has to be walkable with a keyboard alone.
 *
 * Two things in this component were reachable only with a pointer:
 *
 * 1. **The collapsed selection card.** Once a column has a selection it shrinks
 *    to one card, and re-opening it is the ONLY way to change that selection.
 *    It was a `<div onClick>`: no tab stop, no Enter, no role. A keyboard-only
 *    operator who picked the wrong sport could not get back to the list, so the
 *    cascade was one-way — the single largest hole in "operable from the
 *    keyboard". It is a real `<button>` now, and because the collapsed card
 *    drops the column's `<h2>`, its accessible name has to carry the column.
 *
 * 2. **Enter on a focused row.** A synthetic KeyboardEvent has no default
 *    action, so `pressKey: Enter` at a focused row button never clicked it (see
 *    `.maestro/README.md`). Rows handle Enter themselves now, which is also
 *    what lets a keyboard-only E2E pass drill the cascade at all.
 *
 * happy-dom cannot reproduce maestro-web's XPath re-find; what it proves here
 * is that the product exposes real, named, key-operable controls.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: { selectorOptions: { getSelectorOptions: "getSelectorOptions" } },
}));

const state: { items: unknown } = { items: [] };

vi.mock("convex/react", () => ({
  useQuery: () => state.items,
}));

import EntitySelector, { displayByValue } from "./EntitySelector";
import type { SelectorItem } from "./EntitySelector";

const ITEMS = [
  { _id: "baseball", value: "Baseball" },
  { _id: "football", value: "Football" },
];

function renderSelector(
  overrides: Partial<{
    selectedId: string | null;
    expanded: boolean;
    onSelect: (id: string) => void;
    setExpanded: (v: boolean) => void;
  }> = {},
) {
  return render(
    <EntitySelector
      title="Sports"
      query={"getSelectorOptions" as never}
      queryArgs={{ level: "sport" } as never}
      selectedId={overrides.selectedId ?? null}
      onSelect={overrides.onSelect ?? vi.fn()}
      expanded={overrides.expanded ?? true}
      setExpanded={overrides.setExpanded ?? vi.fn()}
      getDisplayName={displayByValue as (i: SelectorItem) => string}
      selectedColor="bg-pink-100"
    />,
  );
}

describe("EntitySelector — keyboard operability (NEO-260)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.items = ITEMS;
  });

  it("selects a row on Enter, with no click and no mouse", () => {
    const onSelect = vi.fn();
    renderSelector({ onSelect });

    fireEvent.keyDown(screen.getByText("Baseball"), { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("baseball");
  });

  it("leaves Space to the browser, which clicks a button on keyup", () => {
    const onSelect = vi.fn();
    renderSelector({ onSelect });

    fireEvent.keyDown(screen.getByText("Baseball"), { key: " " });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the selected row, so a screen reader hears which one is chosen", () => {
    renderSelector({ selectedId: "baseball" });

    const rows = screen.getAllByRole("option");
    const baseball = rows.find((r) => r.textContent?.includes("Baseball"));
    const football = rows.find((r) => r.textContent?.includes("Football"));
    expect(baseball?.getAttribute("aria-selected")).toBe("true");
    expect(football?.getAttribute("aria-selected")).toBe("false");
    // `aria-pressed` is a toggle-BUTTON property and is not supported on
    // `option`. The two must never both be present — one of them would be
    // telling a screen reader something the other contradicts.
    expect(baseball?.getAttribute("aria-pressed")).toBeNull();
  });

  it("the collapsed selection card is a real button, named with its column", () => {
    renderSelector({ selectedId: "baseball", expanded: false });

    const card = screen.getByRole("button", {
      name: "Sports: Baseball — change",
    });
    // The visible text is inside the accessible name (WCAG 2.5.3), so
    // "click Baseball" still works for a voice-control user.
    expect(card.textContent).toContain("Baseball");
    expect(card.getAttribute("aria-expanded")).toBe("false");
  });

  it("re-opens the collapsed column on Enter — the cascade is not one-way", () => {
    const setExpanded = vi.fn();
    renderSelector({ selectedId: "baseball", expanded: false, setExpanded });

    fireEvent.keyDown(
      screen.getByRole("button", { name: "Sports: Baseball — change" }),
      { key: "Enter" },
    );

    expect(setExpanded).toHaveBeenCalledWith(true);
  });

  it("parks focus on the collapsed card, so Tab does not restart at the top of the page", () => {
    // The row that was focused unmounts when the column collapses. Without the
    // park, `document.activeElement` is <body> and the next Tab starts from the
    // page header — several columns away from the cascade.
    const { rerender } = renderSelector({ selectedId: null, expanded: true });
    const row = screen.getByText("Baseball").closest("button")!;
    row.focus();

    rerender(
      <EntitySelector
        title="Sports"
        query={"getSelectorOptions" as never}
        queryArgs={{ level: "sport" } as never}
        selectedId="baseball"
        onSelect={vi.fn()}
        expanded={false}
        setExpanded={vi.fn()}
        getDisplayName={displayByValue as (i: SelectorItem) => string}
        selectedColor="bg-pink-100"
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sports: Baseball — change" }),
    );
  });

  it("never steals focus the user has already moved elsewhere", () => {
    const { rerender } = renderSelector({ selectedId: null, expanded: true });
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    rerender(
      <EntitySelector
        title="Sports"
        query={"getSelectorOptions" as never}
        queryArgs={{ level: "sport" } as never}
        selectedId="baseball"
        onSelect={vi.fn()}
        expanded={false}
        setExpanded={vi.fn()}
        getDisplayName={displayByValue as (i: SelectorItem) => string}
        selectedColor="bg-pink-100"
      />,
    );

    expect(document.activeElement).toBe(elsewhere);
  });

  it("names the collapse control per column, so several open columns differ", () => {
    const setExpanded = vi.fn();
    renderSelector({ selectedId: "baseball", expanded: true, setExpanded });

    const collapse = screen.getByRole("button", { name: "Collapse sports" });
    fireEvent.keyDown(collapse, { key: "Enter" });

    expect(setExpanded).toHaveBeenCalledWith(false);
  });
});
