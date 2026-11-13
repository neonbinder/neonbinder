/**
 * NEO-527 (Jason, 2026-11-12: "a user should never see unknown outside of the
 * admin screen") — Request a card walks sport, year, brand and set. The
 * year's brand-unknown row is never offered: the sets beneath it sit in the
 * Brand select in its place (each carrying that row's id as `brandId`), and
 * picking one picks the set too, so there is no Set select to fill. The store
 * is a stub; no test here reaches a server.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DRILL } from "../catalog/drill";

const calls = vi.hoisted(() => [] as { name: string; args: unknown }[]);
const answers = vi.hoisted(() => new Map<string, unknown>());

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => (args === "skip" ? undefined : answers.get(getFunctionName(ref))),
    useMutation: (ref: never) => async (args: unknown) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      return answers.get(name);
    },
  };
});

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
      "set|unk": [{ id: "s9", name: "Starline Long John Silver", hasChildren: true }],
      "variantType|s9": [{ id: "vt9", name: "Base", hasChildren: false, variantId: "vt9" }],
      "variantType|s20": [{ id: "vt20", name: "Base", hasChildren: false, variantId: "vt20" }],
    }) as Record<string, { id: string; name: string; hasChildren: boolean; variantId?: string; brandId?: string }[]>,
);

vi.mock("../data/store", () => {
  const parentOf: Record<string, string> = { year: "sport", brand: "year", set: "brand", variantType: "set" };
  return {
    useDrill: (level: string | null, parents: Record<string, string>) => {
      if (!level) return undefined;
      const parent = parentOf[level];
      return COLUMNS[`${level}|${parent ? (parents[parent] ?? "") : ""}`] ?? [];
    },
    useCard: () => undefined,
    writeErrorMessage: (e: unknown) => (e instanceof Error ? e.message : "Something went wrong."),
  };
});

import RequestCardForm from "./RequestCardForm";

function open(drill = { ...EMPTY_DRILL, sport: "sp", year: "y90" }) {
  render(<RequestCardForm searched="" drill={drill} privateSetId={null} onHave={() => {}} />);
  return screen.getByRole("form", { name: "Request a card" });
}

const optionsOf = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map((o) => o.text);

beforeEach(() => {
  calls.length = 0;
  answers.clear();
  answers.set("collectionRequests:mySets", []);
  answers.set("collectionRequests:requestCard", { requestId: "r1", privateCardId: "p1" });
});
afterEach(cleanup);

describe("Request a card under a brand-unknown row", () => {
  it("offers the brands first, then the row's sets under More sets; picking one picks the set", async () => {
    const form = open();
    const brand = within(form).getByLabelText("Brand or set");
    expect(optionsOf(brand)).toEqual(["Pick one", "Topps", "Starline Long John Silver"]);
    const group = brand.querySelector("optgroup");
    expect(group?.label).toBe("More sets");
    expect(Array.from(group?.querySelectorAll("option") ?? []).map((o) => o.text)).toEqual(["Starline Long John Silver"]);

    fireEvent.change(brand, { target: { value: "s9" } });
    expect((within(form).getByLabelText("Brand or set") as HTMLSelectElement).value).toBe("s9");
    expect(within(form).queryByLabelText("Set")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Checklist"), { target: { value: "vt9" } });
    fireEvent.change(within(form).getByLabelText("Card number"), { target: { value: "12" } });
    fireEvent.change(within(form).getByLabelText("Player"), { target: { value: "Ken Griffey Jr." } });
    fireEvent.click(within(form).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(calls.map((c) => c.name)).toEqual(["collectionRequests:requestCard"]));
    expect(calls[0].args).toMatchObject({ setId: "s9", variantId: "vt9" });
  });

  it("a real brand still asks for its set", () => {
    const form = open();
    fireEvent.change(within(form).getByLabelText("Brand or set"), { target: { value: "m-topps" } });
    expect(optionsOf(within(form).getByLabelText("Set"))).toEqual(["Pick one", "Topps Traded"]);
  });

  it("starts on the set when the Checklists drill stands on it", () => {
    const form = open({ ...EMPTY_DRILL, sport: "sp", year: "y90", brand: "unk", set: "s9" });
    expect((within(form).getByLabelText("Brand or set") as HTMLSelectElement).value).toBe("s9");
    expect(within(form).queryByLabelText("Set")).toBeNull();
    expect(within(form).getByLabelText("Checklist")).toBeTruthy();
  });

  it("a year whose only brand is the row asks for the set by name", () => {
    const form = open({ ...EMPTY_DRILL, sport: "sp", year: "y89" });
    const only = within(form).getByLabelText("Set");
    expect(optionsOf(only)).toEqual(["Pick one", "Pacific Legends"]);
    expect(within(form).queryByLabelText("Brand")).toBeNull();
    expect(within(form).queryByLabelText("Brand or set")).toBeNull();
    expect(only.querySelector("optgroup")).toBeNull();
  });

  it("a year of brands only says Brand", () => {
    COLUMNS["brand|y88"] = [{ id: "m-fleer", name: "Fleer", hasChildren: true }];
    COLUMNS["year|sp"].push({ id: "y88", name: "1988", hasChildren: true });
    try {
      const form = open({ ...EMPTY_DRILL, sport: "sp", year: "y88" });
      expect(optionsOf(within(form).getByLabelText("Brand"))).toEqual(["Pick one", "Fleer"]);
      expect(within(form).getByLabelText("Set")).toBeTruthy();
    } finally {
      delete COLUMNS["brand|y88"];
      COLUMNS["year|sp"].pop();
    }
  });
});

describe("Request a card: an empty set pick takes the keyboard to the select that picks it", () => {
  const sendEmpty = (form: HTMLElement) => fireEvent.click(within(form).getByRole("button", { name: "Send request" }));

  it("a drill left on the hidden row with no set: the brand select, never a Set select of its sets", () => {
    const form = open({ ...EMPTY_DRILL, sport: "sp", year: "y90", brand: "unk" });
    const brand = within(form).getByLabelText("Brand or set") as HTMLSelectElement;
    expect(brand.value).toBe("");
    // The hidden row's sets never open as a Set list of their own.
    expect(optionsOf(within(form).getByLabelText("Set"))).toEqual(["Pick one"]);
    sendEmpty(form);
    expect(document.activeElement).toBe(brand);
    expect(brand.getAttribute("aria-invalid")).toBe("true");
    expect(calls).toEqual([]);
  });

  it("a year whose only brand is the row: the Set-labelled select", () => {
    const form = open({ ...EMPTY_DRILL, sport: "sp", year: "y89" });
    sendEmpty(form);
    expect(document.activeElement).toBe(within(form).getByLabelText("Set"));
  });

  it("a real brand picked: its Set select", () => {
    const form = open();
    fireEvent.change(within(form).getByLabelText("Brand or set"), { target: { value: "m-topps" } });
    sendEmpty(form);
    expect(document.activeElement).toBe(within(form).getByLabelText("Set"));
  });
});
