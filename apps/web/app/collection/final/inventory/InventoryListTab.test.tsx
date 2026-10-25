import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Theme } from "@radix-ui/themes";
import type { ReactNode } from "react";
import FinalCollectionPage from "../FinalCollectionPage";
import { DemoCollectionProvider } from "../data/demoStore";
import { CollectionStoreContext, useCollectionStore } from "../data/store";
import type { InventoryCards } from "../data/types";

/**
 * NEO-364 (D13) — the Inventory list on the demo store: the rail, sort,
 * filters and search, and the notes for a list the store cut short or
 * that holds a card the catalog dropped. Box copies only, never a binder's.
 */
vi.mock("@clerk/clerk-react", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "user_1" }) }));

function Probe() {
  const { search } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Page search">{search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser Back
      </button>
    </>
  );
}

/** The demo store with the Inventory list's answer replaced by `change(real answer)`. */
function Changed({ change, children }: { change: (inv: InventoryCards) => InventoryCards; children: ReactNode }) {
  const base = useCollectionStore();
  const data = { ...base.data, useInventoryCards: (o?: Parameters<typeof base.data.useInventoryCards>[0]) => {
    const inv = base.data.useInventoryCards(o);
    return inv ? change(inv) : inv;
  } };
  return <CollectionStoreContext.Provider value={{ ...base, data }}>{children}</CollectionStoreContext.Provider>;
}

function renderList(start = "/inventory", change?: (inv: InventoryCards) => InventoryCards) {
  const page = (
    <>
      <FinalCollectionPage surface="inventory" />
      <Probe />
    </>
  );
  render(
    <Theme>
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route
            path="/inventory"
            element={
              <DemoCollectionProvider>{change ? <Changed change={change}>{page}</Changed> : page}</DemoCollectionProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </Theme>,
  );
}

const search = () => screen.getByLabelText("Page search").textContent;
const rail = () => within(screen.getByRole("navigation", { name: "Boxes" }));
const items = () => within(screen.getByRole("list", { name: /, \d+ cards?/ })).getAllByRole("button").map((b) => b.getAttribute("aria-label")!);
const hasItems = () => screen.queryByRole("list", { name: /, \d+ cards?/ }) !== null;
const sortBy = (value: string) => fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value } });
const chip = (name: string) => within(screen.getByRole("group", { name: "Only show" })).getByRole("button", { name });
const filter = (text: string) => fireEvent.change(screen.getByRole("textbox", { name: "Filter these cards" }), { target: { value: text } });
const names = (labels: string[]) => labels.map((l) => /#\S+ ([^,]+),/.exec(l)![1]);

beforeEach(() => window.sessionStorage.clear());
afterEach(cleanup);

describe("the Inventory list", () => {
  it("heads the list with the boxes' own counts", () => {
    renderList();
    expect(screen.getByRole("heading", { level: 2, name: "Everything for sale" })).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === "P" && /^5 cards for sale in 1 box\.$/.test(el.textContent ?? ""))).toBeTruthy();
  });

  it("lists one item per card across every box, with how many and where, and never a binder's copy", () => {
    renderList();
    const labels = items();
    expect(labels).toHaveLength(3);
    expect(labels.every((l) => /in Show box/.test(l))).toBe(true);
    expect(labels.some((l) => /^×3 .*Steve Yzerman/.test(l))).toBe(true);
    // Jim Kelly lives in a binder only.
    expect(labels.some((l) => /Jim Kelly/.test(l))).toBe(false);
  });

  it("each item opens the card's Details", () => {
    renderList();
    const button = screen.getAllByRole("button", { name: /Steve Yzerman/ })[0];
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(search()).toMatch(/detail=/);
  });

  describe("the rail", () => {
    it("stands All boxes, Unsorted, Up for Trade, then the collector's boxes, with All boxes current", () => {
      renderList();
      const buttons = rail().getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual([
        "All boxes5 cards",
        "Unsorted0 cards",
        "Up for TradeTradeTrade bait in your boxes",
        "Show box5 cards",
      ]);
      expect(buttons.map((b) => b.getAttribute("aria-current"))).toEqual(["true", null, null, null]);
    });

    it("picking a box pushes box= on the URL and narrows the list; Back steps back to All", () => {
      renderList();
      fireEvent.click(rail().getByRole("button", { name: /^Show box/ }));
      expect(search()).toMatch(/box=box-show/);
      expect(screen.getByRole("heading", { level: 3, name: "Show box" })).toBeTruthy();
      expect(rail().getByRole("button", { name: /^Show box/ }).getAttribute("aria-current")).toBe("true");
      fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
      expect(search()).not.toMatch(/box=/);
      expect(screen.getByRole("heading", { level: 3, name: "Every box" })).toBeTruthy();
    });

    it("picking the box you are already on adds no history entry", () => {
      renderList();
      fireEvent.click(rail().getByRole("button", { name: /^Show box/ }));
      fireEvent.click(rail().getByRole("button", { name: /^Show box/ }));
      fireEvent.click(screen.getByRole("button", { name: "Browser Back" }));
      expect(search()).not.toMatch(/box=/);
    });

    it("an unknown or deleted box reads as All boxes", () => {
      renderList("/inventory?tab=cards&box=gone");
      expect(rail().getByRole("button", { name: /^All boxes/ }).getAttribute("aria-current")).toBe("true");
      expect(items()).toHaveLength(3);
    });

    it("a binder's id as the box reads as All boxes too", () => {
      renderList("/inventory?tab=cards&box=binder-main");
      expect(rail().getByRole("button", { name: /^All boxes/ }).getAttribute("aria-current")).toBe("true");
    });

    it("an empty box says so and where to fill it", () => {
      renderList("/inventory?tab=cards&box=box-unsorted");
      expect(screen.getByText(/Empty box\. Fill it from Checklists/)).toBeTruthy();
      expect(hasItems()).toBe(false);
    });

    it("Up for Trade lists box cards up for trade only, hides its own chip, and says binder trade bait stays away", () => {
      renderList("/inventory?tab=cards&box=binder-trade-bait");
      expect(screen.getByText(/Trade bait in a binder stays on the collection side/)).toBeTruthy();
      expect(within(screen.getByRole("group", { name: "Only show" })).queryByRole("button", { name: "Up for trade" })).toBeNull();
      expect(screen.getByText("No box cards up for trade. Flag one from its Details.")).toBeTruthy();
    });
  });

  describe("sort, filters and search", () => {
    it("sorts by player A to Z", () => {
      renderList();
      sortBy("player");
      const sorted = names(items());
      expect(sorted).toEqual([...sorted].sort((a, b) => a.localeCompare(b)));
    });

    it("sorts by card number, team, newest and box without losing an item", () => {
      renderList();
      for (const how of ["number", "team", "added", "box", "set"]) {
        sortBy(how);
        expect(items()).toHaveLength(3);
      }
    });

    it("sorting by card number starts at the lowest number", () => {
      renderList();
      sortBy("number");
      expect(items()[0]).toMatch(/ #1 /);
    });

    it("the sport filter offers the sports in the boxes, and narrows to one", () => {
      renderList();
      const sport = screen.getByRole("combobox", { name: "Sport" });
      expect(within(sport).getAllByRole("option").map((o) => o.textContent)).toEqual(["Every sport", "Baseball", "Football", "Hockey"]);
      fireEvent.change(sport, { target: { value: "hockey" } });
      expect(items()).toHaveLength(1);
      expect(items()[0]).toMatch(/Yzerman/);
    });

    it("Dupes only keeps cards with more than one", () => {
      renderList();
      fireEvent.click(chip("Dupes only"));
      expect(items()).toHaveLength(1);
      expect(items()[0]).toMatch(/^×3 .*Yzerman/);
      expect(chip("Dupes only").getAttribute("aria-pressed")).toBe("true");
    });

    it("Up for trade and Slabs only say nothing matches rather than showing an empty list", () => {
      renderList();
      fireEvent.click(chip("Up for trade"));
      expect(screen.getByText("Nothing here matches. Loosen a filter.")).toBeTruthy();
      fireEvent.click(chip("Up for trade"));
      expect(items()).toHaveLength(3);
      fireEvent.click(chip("Slabs only"));
      if (hasItems()) expect(items().every((l) => /slab/.test(l))).toBe(true);
      else expect(screen.getByText("Nothing here matches. Loosen a filter.")).toBeTruthy();
    });

    it("the filter box narrows to the cards the search finds", () => {
      renderList();
      filter("skenes");
      expect(items()).toHaveLength(1);
      expect(items()[0]).toMatch(/Skenes/);
      filter("zzzzzz nothing");
      expect(screen.getByText("Nothing here matches. Loosen a filter.")).toBeTruthy();
    });

    it("the tally follows the filters", () => {
      renderList();
      expect(screen.getByRole("list", { name: "Every box, 5 cards, 3 different" })).toBeTruthy();
      fireEvent.click(chip("Dupes only"));
      expect(screen.getByRole("list", { name: "Every box, 3 cards, 1 different" })).toBeTruthy();
    });
  });

  describe("a list the store cut short, and a card the catalog dropped", () => {
    it("says the list stops short of every box and points at the rail", () => {
      renderList("/inventory", (inv) => ({ ...inv, truncated: true }));
      expect(screen.getByText(/stops short of every box; pick one on the rail/)).toBeTruthy();
    });

    it("on one box it says Show more digs deeper", () => {
      renderList("/inventory?tab=cards&box=box-show", (inv) => ({ ...inv, truncated: true }));
      expect(screen.getByText(/stops short of the whole box; Show more digs deeper/)).toBeTruthy();
    });

    it("counts a card the catalog no longer holds, and keeps the rest", () => {
      renderList("/inventory", (inv) => ({ ...inv, goneCardIds: ["gone-1"] }));
      expect(screen.getByText("1 card in your boxes isn't in the catalog anymore. It still counts in its box.")).toBeTruthy();
      expect(items()).toHaveLength(3);
      cleanup();
      renderList("/inventory", (inv) => ({ ...inv, goneCardIds: ["a", "b"] }));
      expect(screen.getByText(/^2 cards in your boxes aren't in the catalog anymore/)).toBeTruthy();
    });

    it("stays quiet when nothing was cut and nothing is gone", () => {
      renderList();
      expect(screen.queryByText(/stops short/)).toBeNull();
      expect(screen.queryByText(/isn't in the catalog|aren't in the catalog/)).toBeNull();
    });

    it("shows a skeleton, never an empty-state, while the list loads", () => {
      renderList("/inventory", () => undefined as unknown as InventoryCards);
      expect(screen.getByText("Flipping through the boxes…")).toBeTruthy();
      expect(screen.queryByText("No cards in your boxes yet.")).toBeNull();
    });

    it("with nothing in any box offers Checklists", () => {
      renderList("/inventory", () => ({ items: [], goneCardIds: [], truncated: false }));
      expect(screen.getByText("No cards in your boxes yet.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Stock up in Checklists" }));
      expect(search()).toMatch(/tab=checklists/);
    });
  });
});
