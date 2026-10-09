/**
 * NEO-325 — a column row whose name a SIBLING (same parent) also carries is
 * followed by its marketplace ids, `(#378117)`. Column sync gives each
 * same-named marketplace twin its own row, and three "Anime" rows read
 * identically otherwise. A unique name gets nothing, so every existing visible
 * text and accessible name is unchanged (the listbox file's tripwire).
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

const row = (
  id: string,
  value: string,
  parentId: string | undefined,
  platformData: Record<string, unknown> = {},
) => ({ _id: id, value, parentId, platformData });

const sl = (...ids: string[]) => ({
  sportlots: Object.fromEntries(ids.map((id, i) => [`s${i}`, id])),
});
const bsc = (...ids: string[]) => ({
  bsc: Object.fromEntries(ids.map((id, i) => [`b${i}`, id])),
});

function column(selectedId: string | null = null) {
  return (
    <EntitySelector
      title="Sets"
      query={"getSelectorOptions" as never}
      queryArgs={{ level: "setName" } as never}
      selectedId={selectedId}
      onSelect={vi.fn()}
      expanded={true}
      setExpanded={vi.fn()}
      getDisplayName={displayByValue as (i: SelectorItem) => string}
      selectedColor="bg-pink-100"
    />
  );
}

const optionNames = () => screen.getAllByRole("option").map((o) => o.textContent);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EntitySelector — sibling twins wear (#id) (NEO-325)", () => {
  it("rows sharing a name under one parent show their marketplace id; the name stays alone in its text node", () => {
    state.items = [
      row("a", "Anime", "brand1", sl("378117")),
      row("b", "Anime", "brand1", sl("378118")),
      row("c", "Solo", "brand1", sl("378119")),
    ];
    render(column());

    expect(optionNames()).toEqual(["Anime (#378117)", "Anime (#378118)", "Solo"]);
    // The id sits in its own element, so a flow's text match on "Anime" still
    // finds the row's name node.
    expect(screen.getAllByText("Anime")).toHaveLength(2);
  });

  it("a BSC twin shows its slug", () => {
    state.items = [
      row("a", "Gold", "brand1", bsc("gold-a")),
      row("b", "Gold", "brand1", bsc("gold-b")),
    ];
    render(column());

    expect(optionNames()).toEqual(["Gold (#gold-a)", "Gold (#gold-b)"]);
  });

  it("a row with both marketplaces names both ids", () => {
    state.items = [
      row("a", "Chrome", "brand1", { ...bsc("chrome-a"), ...sl("11") }),
      row("b", "Chrome", "brand1", sl("12")),
    ];
    render(column());

    expect(optionNames()[0]).toContain("#chrome-a");
    expect(optionNames()[0]).toContain("#11");
    expect(optionNames()[1]).toBe("Chrome (#12)");
  });

  it("the same name under DIFFERENT parents is not a twin: no suffix", () => {
    state.items = [
      row("a", "Chrome", "brand1", sl("1")),
      row("b", "Chrome", "brand2", sl("2")),
    ];
    render(column());

    expect(optionNames()).toEqual(["Chrome", "Chrome"]);
  });

  it("a twin with no marketplace id has nothing to show and gets no suffix", () => {
    state.items = [
      row("a", "Anime", "brand1"),
      row("b", "Anime", "brand1", sl("5")),
    ];
    render(column());

    expect(optionNames()).toEqual(["Anime", "Anime (#5)"]);
  });

  it("the suffix is decided over the WHOLE column: filtering to one twin does not strip it", () => {
    state.items = [
      row("a", "Anime", "brand1", sl("378117")),
      row("b", "Anime Gold", "brand1", sl("378118")),
      row("c", "Anime", "brand1", sl("378119")),
    ];
    render(column());
    const box = screen.getByRole("combobox", { name: /Search/ });

    fireEvent.change(box, { target: { value: "gold" } });
    expect(optionNames()).toEqual(["Anime Gold"]);
    fireEvent.change(box, { target: { value: "anime" } });
    expect(optionNames()).toContain("Anime (#378117)");
  });

  it("the collapsed header names the selected twin with its id", () => {
    state.items = [
      row("a", "Anime", "brand1", sl("378117")),
      row("b", "Anime", "brand1", sl("378118")),
    ];
    render(
      <EntitySelector
        title="Sets"
        query={"getSelectorOptions" as never}
        queryArgs={{ level: "setName" } as never}
        selectedId="b"
        onSelect={vi.fn()}
        expanded={false}
        setExpanded={vi.fn()}
        getDisplayName={displayByValue as (i: SelectorItem) => string}
        selectedColor="bg-pink-100"
      />,
    );

    expect(screen.getByLabelText("Sets: Anime (#378118) — change")).toBeTruthy();
  });

  it("no twins, no suffix: every name is exactly what it was", () => {
    state.items = [
      row("a", "Baseball", undefined, sl("BB")),
      row("b", "Football", undefined, sl("FB")),
    ];
    render(column());

    expect(optionNames()).toEqual(["Baseball", "Football"]);
  });
});
