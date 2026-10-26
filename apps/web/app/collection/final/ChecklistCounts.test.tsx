import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "./PublicCollectionDemo";
import { demoCard, demoVariantId } from "./data/demoStore";
import { initialCollectionState, MAIN_BINDER_ID, SHOW_BOX_ID } from "./store";

/**
 * NEO-358 — a checklist's numbers agree (Jason, 2026-10-23): "Have 2 of 300 ·
 * Need 298" above the list, "300 cards" in its count line, and "335 with
 * variations" on a second line only when the checklist lists image
 * variations. The cascade and the board read the same base count.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: false }) }));
vi.mock("convex/react", () => ({}));

const DEMO = "/binder-tracking?demo=on";
const CHROME = "2024-topps-chrome-baseball";

function renderDemo(entry: string) {
  render(
    <Theme>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/binder-tracking"
            element={<PublicCollectionDemo onExit={vi.fn()} keepParams={{ demo: "on" }} />}
          />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

/** The checklist section under its heading. */
function checklist(name: string): HTMLElement {
  return screen.getByRole("heading", { level: 3, name }).closest("section")!;
}

/** The count line: the one status in the checklist that reads "… cards". */
function countLine(section: HTMLElement): string {
  const line = within(section)
    .getAllByRole("status")
    .find((s) => /cards?\b/.test(s.textContent ?? ""));
  expect(line, "the count line is mounted").toBeTruthy();
  return line!.textContent ?? "";
}

function haveLine(section: HTMLElement): { owned: number; total: number } {
  const text =
    Array.from(section.querySelectorAll("p"))
      .map((p) => p.textContent ?? "")
      .find((t) => /^Have \d+ of \d+/.test(t)) ?? "";
  const [, owned, total] = /^Have (\d+) of (\d+)/.exec(text)!;
  return { owned: Number(owned), total: Number(total) };
}

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
});

describe("a checklist's counts agree", () => {
  it("reads the base count, and the variations on a second line", () => {
    renderDemo(`${DEMO}&tab=checklists&set=${CHROME}&type=Base`);
    const section = checklist("2024 Topps Chrome Base");
    const { total } = haveLine(section);
    const rows = within(section).getAllByRole("button", { name: /^Details for / }).length;
    expect(rows, "the fixture's Base lists an image variation").toBeGreaterThan(total);
    expect(countLine(section)).toBe(`${total} cards, ${rows} with variations`);
    // Two lines on screen.
    expect(within(section).getByText(`${total} cards`)).toBeTruthy();
    expect(within(section).getByText(`${rows} with variations`)).toBeTruthy();
  });

  it("Haves and Needs count against the same two totals as the header", () => {
    renderDemo(`${DEMO}&tab=checklists&set=${CHROME}&type=Base`);
    const section = checklist("2024 Topps Chrome Base");
    const { owned, total } = haveLine(section);
    const all = within(section).getAllByRole("button", { name: /^Details for / }).length;
    const show = within(section).getByRole("radiogroup", { name: "Show" });

    fireEvent.click(within(show).getByRole("radio", { name: "Haves" }));
    const haves = within(section).queryAllByRole("button", { name: /^Details for / }).length;
    const havesLine = countLine(section);
    expect(havesLine.startsWith(`${owned} of ${total} cards`)).toBe(true);
    if (haves !== all) expect(havesLine).toMatch(new RegExp(`, ${haves} of ${all} with variations$`));

    fireEvent.click(within(show).getByRole("radio", { name: "Needs" }));
    const needs = within(section).queryAllByRole("button", { name: /^Details for / }).length;
    const needsLine = countLine(section);
    expect(needsLine.startsWith(`${total - owned} of ${total} cards`)).toBe(true);
    if (needs !== all) expect(needsLine).toMatch(new RegExp(`, ${needs} of ${all} with variations$`));
  });

  it("a checklist without variations has one line", () => {
    renderDemo(`${DEMO}&tab=checklists&set=${CHROME}&type=Parallels&variant=Gold+Refractor`);
    const section = checklist("2024 Topps Chrome Gold Refractor");
    const { total } = haveLine(section);
    expect(within(section).getAllByRole("button", { name: /^Details for / })).toHaveLength(total);
    expect(countLine(section)).toBe(`${total} ${total === 1 ? "card" : "cards"}`);
    expect(within(section).queryByText(/with variations/)).toBeNull();
  });

  it("the cascade shows no counts on any level (NEO-364)", () => {
    // Jason, 2026-10-25: showing or not showing the row is the only signal.
    // A parallel keeps its print run, which is not a count.
    const COUNT = /\d+\s+(base\s+)?cards?\b|\bhave\s+\d+|\d+\s+(inserts?|parallels?)\b/i;
    const optionsOf = (name: string) =>
      within(screen.getByRole("listbox", { name })).getAllByRole("option");

    renderDemo(`${DEMO}&tab=checklists&sport=baseball&year=2024&brand=brand-topps`);
    const sets = optionsOf("Sets");
    expect(sets.length).toBeGreaterThan(0);
    for (const option of sets) expect(option.textContent ?? "").not.toMatch(COUNT);
    cleanup();

    renderDemo(`${DEMO}&tab=checklists&set=${CHROME}`);
    const types = optionsOf("Variant Types");
    expect(types.map((o) => o.textContent)).toContain("Base");
    for (const option of types) expect(option.textContent ?? "").not.toMatch(COUNT);
    cleanup();

    renderDemo(`${DEMO}&tab=checklists&set=${CHROME}&type=Parallels`);
    const parallels = optionsOf("Parallels");
    for (const option of parallels) expect(option.textContent ?? "").not.toMatch(COUNT);
    const gold = parallels.find((o) => (o.textContent ?? "").startsWith("Gold Refractor"));
    expect(gold?.textContent).toBe("Gold Refractor/50");
  });

  it("a board's bulbs are spoken base first, variations after", () => {
    // Put the Chrome set (whose Base lists a variation) on the board first.
    renderDemo(`${DEMO}&tab=checklists&set=${CHROME}&type=Base`);
    const building = screen.getByRole("button", { name: "Building this set" });
    if (building.getAttribute("aria-pressed") !== "true") fireEvent.click(building);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Collection sections" })).getByRole("link", { name: "My Cards" }),
    );
    const hide = screen.getByRole("button", { name: "Hide the cards, Base of 2024 Topps Chrome" });
    const strip = hide.closest("li")!;
    const spoken = within(strip).getByText(/ lit up/).textContent ?? "";
    const [, base, all] = /^\d+ of (\d+) lit up, \d+ of (\d+) with variations/.exec(spoken) ?? [];
    expect(Number(all), spoken).toBeGreaterThan(Number(base));
  });
});

describe("a card for sale is out of the checklist (NEO-359)", () => {
  // Jason, 2026-10-24: "Binders are your collection and For Sale are your
  // inventory." A card held only in a box reads as not had in a checklist;
  // taking it off sale from its drawer puts it back in the count.
  const INSERT = demoVariantId(CHROME, { type: "Inserts", name: "Chrome Rookie Autographs" });
  const seed = initialCollectionState().copies;
  const inInsert = (cardId: string) => demoCard(cardId)?.variant.id === INSERT;
  const boxedOnly = seed.find(
    (c) =>
      c.homeId === SHOW_BOX_ID &&
      inInsert(c.cardId) &&
      !seed.some((o) => o.cardId === c.cardId && o.homeId !== SHOW_BOX_ID),
  )!;
  const heldInBinders = new Set(seed.filter((c) => c.homeId !== SHOW_BOX_ID && inInsert(c.cardId)).map((c) => c.cardId));

  it("counts only the binders' copies, and Take off sale brings the card back", async () => {
    expect(boxedOnly, "the seed sells a Chrome rookie auto from the Show box").toBeTruthy();
    renderDemo(
      `${DEMO}&tab=checklists&set=${CHROME}&type=Inserts&variant=Chrome+Rookie+Autographs&detail=${boxedOnly.cardId}`,
    );
    const section = screen.getByRole("heading", { level: 3, name: /Chrome Rookie Autographs$/, hidden: true }).closest("section")!;
    expect(haveLine(section).owned).toBe(heldInBinders.size);

    // Its drawer still lists it, for sale; take it off sale into a binder.
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getAllByText(/^For sale · Show box$/).length).toBeGreaterThan(0);
    fireEvent.click(within(drawer).getByRole("button", { name: /^Take off sale, #.+$/ }));
    const panel = within(drawer).getByRole("form", { name: /^Take .+ off sale$/ });
    fireEvent.change(within(panel).getByRole("combobox", { name: "Back into" }), { target: { value: MAIN_BINDER_ID } });
    fireEvent.click(within(panel).getByRole("button", { name: /^Take (\d+|it) off sale$/ }));
    await waitFor(() => expect(haveLine(section).owned).toBe(heldInBinders.size + 1));
    expect(within(drawer).queryByText(/^For sale · Show box$/)).toBeNull();
  });
});
