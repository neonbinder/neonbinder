/**
 * NEO-527 (Jason, 2026-11-12: "a user should never see unknown outside of the
 * admin screen") — "Start building a set" browses sport, year and brand. The
 * year's brand-unknown row is never offered: its sets sit in the brand
 * select in its place, after the brands under "More sets" (each carrying the
 * row's id as `brandId`), and the select is labelled by what it holds. Picking one
 * lists just that set, captioned with its sport alone. The store is a stub;
 * no test here reaches a server.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const COLUMNS = vi.hoisted(
  () =>
    ({
      "sport|": [{ id: "sp", name: "Baseball", hasChildren: true }],
      "year|sp": [
        { id: "y90", name: "1990", hasChildren: true },
        { id: "y89", name: "1989", hasChildren: true },
      ],
      "brand|y90": [
        { id: "s9", name: "Starline Long John Silver", hasChildren: true, brandId: "unk" },
        { id: "m-topps", name: "Topps", hasChildren: true },
      ],
      "brand|y89": [{ id: "s20", name: "Pacific Legends", hasChildren: true, brandId: "unk89" }],
      "set|m-topps": [{ id: "s1", name: "Topps Traded", hasChildren: true }],
      "set|unk": [
        { id: "s8", name: "Classic", hasChildren: true },
        { id: "s9", name: "Starline Long John Silver", hasChildren: true },
      ],
    }) as Record<string, { id: string; name: string; hasChildren: boolean; brandId?: string }[]>,
);

vi.mock("../data/store", async (importOriginal) => {
  const parentOf: Record<string, string> = { year: "sport", brand: "year", set: "brand" };
  return {
    ...(await importOriginal<object>()),
    useCollectionStore: () => ({ kind: "convex" }),
    useSuggestions: () => [],
    useBuildingSets: () => [],
    useCollectionActions: () => ({ setBuilding: vi.fn() }),
    useDrill: (level: string | null, parents: Record<string, string>) => {
      if (!level) return undefined;
      const parent = parentOf[level];
      return COLUMNS[`${level}|${parent ? (parents[parent] ?? "") : ""}`] ?? [];
    },
  };
});
vi.mock("./context", () => ({ useMyCards: () => ({ run: vi.fn() }) }));

import SetPicker from "./SetPicker";

afterEach(cleanup);

const optionsOf = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map((o) => o.text);

function browseTo(year: string) {
  render(<SetPicker onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText("Sport"), { target: { value: "sp" } });
  fireEvent.change(screen.getByLabelText("Year"), { target: { value: year } });
}

describe("Start building a set under a brand-unknown row", () => {
  it("offers the brands first, then the row's sets under More sets and, picked, lists that one set by its sport alone", () => {
    browseTo("y90");
    const select = screen.getByLabelText("Brand or set");
    expect(optionsOf(select)).toEqual(["Any brand or set", "Topps", "Starline Long John Silver"]);
    expect(select.querySelector("optgroup")?.label).toBe("More sets");
    fireEvent.change(select, { target: { value: "s9" } });
    expect(screen.getByRole("button", { name: "Building 1990 Starline Long John Silver" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Building 1990 Classic" })).toBeNull();
    const row = screen.getByRole("listitem");
    expect(row.textContent).toBe("1990 Starline Long John SilverBaseballBuilding");
    expect(document.body.textContent).not.toMatch(/unknown/i);
  });

  it("a real brand lists its sets, captioned with sport and brand", () => {
    browseTo("y90");
    fireEvent.change(screen.getByLabelText("Brand or set"), { target: { value: "m-topps" } });
    expect(screen.getByRole("button", { name: "Building 1990 Topps Traded" })).toBeTruthy();
    expect(screen.getByRole("listitem").textContent).toBe("1990 Topps TradedBaseball, ToppsBuilding");
  });

  it("a year whose only brand is the row asks for the set", () => {
    browseTo("y89");
    expect(optionsOf(screen.getByLabelText("Set"))).toEqual(["Any set", "Pacific Legends"]);
    expect(screen.queryByLabelText("Brand")).toBeNull();
    expect(screen.queryByLabelText("Brand or set")).toBeNull();
  });

  it("before a year is picked, the field is a Brand field", () => {
    render(<SetPicker onClose={() => {}} />);
    expect(screen.getByLabelText("Brand")).toBeTruthy();
  });
});
