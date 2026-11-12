/**
 * NEO-509 — the printed pick sheet's rows for sales NB has no card for: a
 * listing that says enough prints like a card (number, players, the
 * listing's own variant word, a "Not in NB" mark, its next step); one that
 * says too little prints under Can't find it with its step only. A matched
 * card never carries the mark. Named `.test.tsx` so the `app/` project
 * collects it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import type { Card } from "../data/types";
import { buildSections, type PickSection } from "./model";
import PrintSheet from "./PrintSheet";
import type { ListedCard, PickOrder, SaleLine } from "./types";

const ORDER: PickOrder = { id: "o1", venue: "BSC", number: "88240" };
const PROBLEM = "NB couldn't match this line. Check the order's photo.";

const CARD: Card = {
  id: "c1",
  set: {
    id: "s1",
    name: "Score",
    season: "2024",
    year: 2024,
    brand: { id: "b", name: "Panini" },
    sport: { id: "football", name: "Football" },
  },
  variant: {
    id: "v",
    kind: "base",
    name: null,
    insertName: null,
    printRun: null,
    order: 0,
    path: { typeId: "t", variantId: null, subVariantId: null },
    finish: { kind: "standard" },
  },
  cardNumber: "1",
  players: [{ id: "p", name: "Matched Player" }],
  teams: [],
  printRun: null,
  features: [],
  cardVariation: null,
  isVariation: false,
  sortOrder: 0,
  finish: { kind: "standard" },
};

let n = 0;
function matched(): SaleLine {
  n += 1;
  return { id: `m${n}`, card: CARD, sportCode: "FB", listingTitle: "Matched Player", quantity: 1, condition: "NM", order: ORDER };
}
function stray(listed: ListedCard | undefined, over: Partial<SaleLine> = {}): SaleLine {
  n += 1;
  return {
    id: `x${n}`,
    card: null,
    sportCode: null,
    listingTitle: "a listing",
    ...(listed ? { listed } : {}),
    problem: PROBLEM,
    quantity: 1,
    condition: "NM",
    order: ORDER,
    ...over,
  };
}
const LISTED: ListedCard = {
  sportName: "Football",
  year: 2024,
  season: "2024",
  setName: "Score",
  players: "Malik Nabers",
  cardNumber: "302",
  role: "base",
};

function sheet(lines: SaleLine[], pulled: ReadonlySet<string> = new Set()) {
  const sections: PickSection[] = buildSections(lines, {}, { sort: null, dir: "asc", groupByOrder: false });
  const view = render(<PrintSheet sections={sections} pulled={pulled} showSlot={false} />);
  return { ...view, table: view.getByRole("table", { name: "Pick sheet" }) };
}
const rowOf = (table: HTMLElement, text: string) => within(table).getByText(text, { exact: false }).closest("tr")!;

afterEach(cleanup);

describe("the printed sheet's lines for sales NB has no card for", () => {
  it("prints a described sale like a card: number, players, Not in NB, the Base band and its next step", () => {
    const { table } = sheet([matched(), stray(LISTED)]);
    const row = rowOf(table, "Malik Nabers");
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent);
    // tick, qty, number, players + marks, card, condition, order
    expect(cells[2]).toBe("#302");
    expect(cells[3]).toContain("Malik Nabers");
    expect(cells[3]).toContain("Not in NB");
    expect(cells[4]).toContain("Base");
    expect(cells[4]).toContain(PROBLEM);
    expect(cells[6]).toBe("BSC 88240");
    expect(row.className).toContain("nb-pick-sheet-lost");
    // Base wears its band, as a card's does.
    expect(row.querySelector(".nb-pick-sheet-band")).not.toBeNull();
    // It prints under its set's divider (joined to the matched card's set), not under Can't find it.
    const dividers = within(table).getAllByRole("rowheader").map((h) => h.textContent);
    expect(dividers.some((d) => d?.includes("Can't find it"))).toBe(false);
    expect(dividers[0]).toContain("2024 Score");
  });

  it("never marks a matched card Not in NB", () => {
    const { table } = sheet([matched(), stray(LISTED)]);
    const row = rowOf(table, "Matched Player");
    expect(row.textContent).not.toContain("Not in NB");
    expect(row.className).not.toContain("nb-pick-sheet-lost");
    expect(row.textContent).not.toContain(PROBLEM);
  });

  it("prints a listing's own variant word (never a guessed Base) and no band when it names no role", () => {
    const { table } = sheet([stray({ ...LISTED, role: undefined, variantWord: "Variation", variantName: "Photo Variation" })]);
    const row = rowOf(table, "Malik Nabers");
    const card = row.querySelectorAll("td")[4].textContent!;
    expect(card).toContain("Variation");
    expect(card).toContain("Photo Variation");
    expect(card).not.toContain("Base");
    expect(row.querySelector(".nb-pick-sheet-band")).toBeNull();
    // Own divider titled with the listing's set, the set title written inline (no card row repeats it).
    expect(within(table).getAllByRole("rowheader")[0].textContent).toContain("2024 Score");
    expect(card).not.toContain("2024 Score");
  });

  it("prints a sale that says too little under Can't find it: its next step, no number, no Not in NB", () => {
    const { table } = sheet([stray({ ...LISTED, cardNumber: undefined }), stray(undefined)]);
    const headers = within(table).getAllByRole("rowheader").map((h) => h.textContent);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain("Can't find it");
    const rows = [...table.querySelectorAll("tbody tr.nb-pick-sheet-lost")];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cells = [...row.querySelectorAll("td")].map((td) => td.textContent);
      expect(cells[2]).toBe("");
      expect(cells[3]).not.toContain("Not in NB");
      expect(cells[4]).toBe(PROBLEM);
    }
  });

  it("NEO-520: prints an eBay line known only by its title under Can't find it, the title where the players go, and its order", () => {
    const EBAY: PickOrder = { id: "o9", venue: "eBay", number: "27-11111-22222" };
    const title = "2024 Topps Chrome #205 Some Player RC";
    const { table } = sheet([stray({ title }, { listingTitle: title, order: EBAY })]);
    const headers = within(table).getAllByRole("rowheader").map((h) => h.textContent);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain("Can't find it");
    const row = rowOf(table, title);
    const cells = [...row.querySelectorAll("td")].map((td) => td.textContent);
    expect(cells[2]).toBe("");
    expect(cells[3]).toContain(title);
    expect(cells[4]).toBe(PROBLEM);
    expect(cells[6]).toBe("eBay 27-11111-22222");
  });

  it("ticks a pulled described line and counts its copies", () => {
    const line = stray(LISTED, { quantity: 2 });
    const { table } = sheet([line], new Set([line.id]));
    const row = rowOf(table, "Malik Nabers");
    expect(row.querySelector(".nb-pick-tick")?.textContent).toBe("✓");
    expect(row.querySelectorAll("td")[1].textContent).toBe("×2");
    expect(row.getAttribute("data-pulled")).toBe("true");
  });
});
