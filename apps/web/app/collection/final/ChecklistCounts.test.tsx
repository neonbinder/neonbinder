import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { Theme } from "@radix-ui/themes";
import PublicCollectionDemo from "./PublicCollectionDemo";

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

  it("the cascade's Base and set rows read the same base count", () => {
    renderDemo(`${DEMO}&tab=checklists&set=${CHROME}&type=Base`);
    const { owned, total } = haveLine(checklist("2024 Topps Chrome Base"));
    cleanup();

    renderDemo(`${DEMO}&tab=checklists&set=${CHROME}`);
    const base = within(screen.getByRole("listbox", { name: "Variant Types" })).getByRole("option", { name: /^Base/ });
    expect(base.textContent).toContain(`${total} cards`);
    cleanup();

    renderDemo(`${DEMO}&tab=checklists&sport=baseball&year=2024&brand=brand-topps`);
    const set = within(screen.getByRole("listbox", { name: "Sets" })).getByRole("option", { name: /^Topps Chrome/ });
    expect(set.textContent).toContain(owned > 0 ? `Have ${owned} of ${total} base` : `${total} base cards`);
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
