/**
 * NEO-464 — the dashboard is ONE screen (Jason, 2026-11-10): every section
 * draws only when the data has something for it, and the one ordering rule
 * is data-driven (an order waiting to ship leads; otherwise the boards do).
 * Drawn on the demo's fake collector, who has every section, then with parts
 * of that data taken away.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { bindersOf, getDashboard, type DashboardData } from "../fake-data";
import DashboardScreen, { summary } from "./DashboardScreen";
import { priceWords } from "./NewListings";
import { HELD_PREVIEW } from "./SyncStatus";
import type { ShelfBinder } from "./shelf-model";

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={["/demo"]}>{children}</MemoryRouter>;
}

function draw(data: DashboardData) {
  return render(<DashboardScreen data={data} />, { wrapper });
}

const heading = (name: string) => screen.queryByRole("heading", { name, level: 2 });

/** True when `a` comes before `b` in the document. */
function before(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

const NO_INTAKE: DashboardData["intake"] = { total: 0, waiting: 0, needsYou: 0, uploads: [], preview: [] };

describe("DashboardScreen: one screen, sections by data", () => {
  it("a collector with a bit of everything sees every section", () => {
    draw(getDashboard());
    for (const name of [
      "Out the Door",
      "In the Hopper",
      "Needs a Look",
      "On the Bubble",
      "Sync status",
      "Your binders and boxes",
      "Could fit your smart binders",
      "The Chase",
      "Fresh Pulls",
      "New Listings",
      "Binders Filling Up",
      "Odds and Ends",
      "New on NeonBinder",
    ]) {
      expect(heading(name), name).not.toBeNull();
    }
  });

  it("an order waiting to ship leads, the boards follow", () => {
    draw(getDashboard());
    expect(before(heading("Out the Door")!, heading("On the Bubble")!)).toBe(true);
  });

  it("nothing waiting to ship: the boards lead, and the all-shipped line follows them", () => {
    draw({ ...getDashboard(), sales: { unshipped: [] } });
    const shipped = screen.getByText("All shipped. Nice.");
    expect(before(heading("On the Bubble")!, shipped)).toBe(true);
  });

  it("an account that does not sell has no sales section at all, but its boxes still need a look", () => {
    // The demo store keeps no box off the marketplaces, so the account here brings its own.
    draw({ ...getDashboard(), sales: null, unlistedBoxes: [{ id: "box-show", name: "Show box", unlisted: 5 }] });
    expect(heading("Out the Door")).toBeNull();
    expect(screen.queryByText("All shipped. Nice.")).toBeNull();
    const look = screen.getByRole("region", { name: "Needs a Look" });
    expect(within(look).getByText("5 boxed cards not listed yet")).toBeTruthy();
    expect(screen.queryByText(/to ship\./)).toBeNull();
  });

  it("no data for a section draws no section: no scans, no boxes, no sales", () => {
    draw({ ...getDashboard(), sales: null, intake: NO_INTAKE, unlistedBoxes: [] });
    for (const name of ["Out the Door", "In the Hopper", "Needs a Look"]) {
      expect(heading(name), name).toBeNull();
    }
    expect(heading("Your binders and boxes")).not.toBeNull();
    // The trade pile still fills Odds and Ends.
    expect(heading("Odds and Ends")).not.toBeNull();
  });
});

describe("New on NeonBinder", () => {
  it("shows every collector the newest sets, each opening its checklist; below their own sections when they have some", () => {
    const data = getDashboard();
    draw(data);
    const news = screen.getByRole("region", { name: "New on NeonBinder" });
    const links = within(news).getAllByRole("link");
    expect(links).toHaveLength(data.newSets.length);
    const first = data.newSets[0];
    expect(within(news).getByRole("link", { name: new RegExp(`^${first.label}`) }).getAttribute("href")).toBe(
      `/demo/collection?tab=checklists&set=${encodeURIComponent(first.id)}`,
    );
    expect(before(heading("Odds and Ends")!, heading("New on NeonBinder")!)).toBe(true);
  });

  it("leads, right under the greeting, when nothing else is up top", () => {
    const data = getDashboard();
    // Plain binders only (no checklist to put on a board), nothing being built, nothing to ship or look at.
    const plain = bindersOf(data).filter((b) => !b.checklist);
    draw({ ...data, binders: plain, sales: null, intake: NO_INTAKE, unlistedBoxes: [], building: [], syncStatus: null });
    expect(heading("On the Bubble")).toBeNull();
    expect(before(heading("New on NeonBinder")!, heading("Your binders and boxes")!)).toBe(true);
  });

  it("a lone variant reads as the set, then the variant, and opens on that variant's checklist", () => {
    const data = getDashboard();
    const gold = {
      ...data.newSets[0],
      id: "x:gold",
      variant: "Gold Refractor",
      checklist: { tab: "checklists", set: "x", type: "pt", variant: "gold" },
    };
    draw({ ...data, newSets: [gold] });
    const news = screen.getByRole("region", { name: "New on NeonBinder" });
    const link = within(news).getByRole("link", { name: new RegExp(`^${gold.label} Gold Refractor`) });
    expect(link.getAttribute("href")).toBe("/demo/collection?tab=checklists&set=x&type=pt&variant=gold");
  });

  it("no new sets: no section", () => {
    draw({ ...getDashboard(), newSets: [] });
    expect(heading("New on NeonBinder")).toBeNull();
  });
});

describe("the chase and fresh pulls", () => {
  it("nothing filed lately: no Fresh Pulls at all", () => {
    draw({ ...getDashboard(), additions: [] });
    expect(heading("Fresh Pulls")).toBeNull();
    expect(screen.queryByText(/No new cards yet/)).toBeNull();
  });

  it("an empty Want List keeps the chase, with the star and the way to a checklist", () => {
    draw({ ...getDashboard(), wantList: [] });
    const chase = screen.getByRole("region", { name: "The Chase" });
    expect(within(chase).getByText(/Your Want List is empty/)).toBeTruthy();
    expect(within(chase).getByRole("link", { name: "any checklist" }).getAttribute("href")).toBe("/demo/collection?tab=checklists");
  });
});

describe("the open binder's place", () => {
  it("with none open, the first binder on the shelf stands shut there, one button to open it", () => {
    draw(getDashboard());
    const first = screen.getByRole("list", { name: "Shelf 1" }).querySelector("button")!;
    const name = first.getAttribute("aria-label")!.split(",")[0];
    // Its own words, apart from the rail's "Open <binder>".
    expect(screen.getByRole("button", { name: `Crack open ${name}` })).toBeTruthy();
  });

  it("the demo's shelf is full past the first shelf and it has boxes: no starter stands", () => {
    draw(getDashboard());
    expect(screen.queryByRole("link", { name: "We all have a shoebox. Sort it into binders" })).toBeNull();
    expect(screen.queryByRole("link", { name: "That to-list pile won't list itself. Add cards to sell" })).toBeNull();
  });
});

describe("the hopper", () => {
  it("says scan processing, never still being identified, and links each run to where it is finished", () => {
    draw(getDashboard());
    const hopper = screen.getByRole("region", { name: "In the Hopper" });
    expect(within(hopper).getByRole("heading", { name: "18 scans processing" })).toBeTruthy();
    expect(within(hopper).queryByText(/still being identified/)).toBeNull();
    const shoebox = within(hopper).getByRole("link", { name: "Garage shoebox 6 of 24 scans done Finish on Collection Last scan 9:14 AM" });
    expect(shoebox.getAttribute("href")).toBe("/demo/collection?tab=add");
    const show = within(hopper).getByRole("link", { name: "Show pickups 0 of 2 scans done Finish on Inventory Last scan yesterday" });
    expect(show.getAttribute("href")).toBe("/demo/inventory?side=inventory&tab=add");
  });

  it("draws one empty sleeve per scan processing, six at most, then the rest as +N more, all hidden from a reader", () => {
    const { container } = draw(getDashboard());
    const hopper = screen.getByRole("region", { name: "In the Hopper" });
    // 18 processing: six sleeves and "+12 more".
    expect(within(hopper).getAllByRole("img", { name: "Scan processing", hidden: true })).toHaveLength(6);
    expect(within(hopper).getByText("+12 more").closest("[aria-hidden='true']")).not.toBeNull();
    // The strip names nothing of its own: the h3 is the one name for it.
    expect(within(hopper).queryAllByRole("img")).toHaveLength(0);
    expect(container.querySelector("[role='img'][aria-label$='scans processing']")).toBeNull();
  });

  it("a short pile is exactly as deep as the count, with no +N", () => {
    const intake = getDashboard().intake;
    draw({ ...getDashboard(), intake: { ...intake, total: intake.needsYou + 3, waiting: 3 } });
    const hopper = screen.getByRole("region", { name: "In the Hopper" });
    expect(within(hopper).getByRole("heading", { name: "3 scans processing" })).toBeTruthy();
    expect(within(hopper).getAllByRole("img", { name: "Scan processing", hidden: true })).toHaveLength(3);
    expect(within(hopper).queryByText(/more$/)).toBeNull();
  });

  it("a run link is named by what it shows, with no aria-label of its own", () => {
    draw(getDashboard());
    const hopper = screen.getByRole("region", { name: "In the Hopper" });
    for (const link of within(hopper).getAllByRole("link")) expect(link.getAttribute("aria-label")).toBeNull();
  });

  it("the runs' scans not yet done add up to the hopper's total", () => {
    const { intake } = getDashboard();
    expect(intake.uploads.reduce((n, u) => n + u.scans - u.done, 0)).toBe(intake.total);
    expect(intake.waiting + intake.needsYou).toBe(intake.total);
  });

  it("a run with only yeses left still links to its run", () => {
    draw({
      ...getDashboard(),
      intake: {
        total: 1,
        waiting: 0,
        needsYou: 1,
        uploads: [
          { id: "r", name: "Main", scans: 1, done: 0, side: "collection", href: "/collection?tab=add&run=r", lastScan: "Last scan 3:42 PM" },
        ],
        preview: [{ id: "s", guess: getDashboard().intake.preview[0].guess }],
      },
    });
    const hopper = screen.getByRole("region", { name: "In the Hopper" });
    expect(within(hopper).queryByText(/processing/)).toBeNull();
    expect(within(hopper).getByRole("link", { name: "Main 0 of 1 scan done Finish on Collection Last scan 3:42 PM" }).getAttribute("href")).toBe(
      "/collection?tab=add&run=r",
    );
  });

  it("two runs into one binder read apart by their last scan, and a sorted run says so instead of Finish", () => {
    const run = { side: "collection" as const, href: "/collection?tab=add&run=a" };
    draw({
      ...getDashboard(),
      intake: {
        total: 1,
        waiting: 1,
        needsYou: 0,
        uploads: [
          { ...run, id: "a", name: "Main", scans: 1, done: 0, lastScan: "Last scan 3:42 PM" },
          { ...run, id: "b", name: "Main", scans: 2, done: 2, href: "/collection?tab=add&run=b", lastScan: "Last scan yesterday" },
        ],
        preview: [],
      },
    });
    const hopper = screen.getByRole("region", { name: "In the Hopper" });
    expect(within(hopper).getByRole("link", { name: "Main 0 of 1 scan done Finish on Collection Last scan 3:42 PM" })).toBeTruthy();
    expect(
      within(hopper).getByRole("link", { name: "Main 2 of 2 scans done All sorted. Open on Collection Last scan yesterday" }).getAttribute("href"),
    ).toBe("/collection?tab=add&run=b");
  });
});

describe("summary: since your last visit counts the cards filed into a binder", () => {
  it("counts the cards filed into each binder since the last visit", () => {
    const filed = [{ newCards: [{}, {}] }, { newCards: [{}] }] as never;
    expect(summary({ sales: null }, filed, null)).toBe("3 cards filed since your last visit.");
    // Nothing filed anywhere: the binders are as they were.
    expect(summary({ sales: null }, [{ newCards: [] }] as never, null)).toBe("Your binders are right where you left them.");
  });

  it("an account that sells hears its orders first, then the filing, then the closest finish", () => {
    const data = getDashboard();
    expect(summary(data, [{ newCards: [{}] }] as never, { label: "1993 Finest", need: 2 })).toBe(
      `${data.sales!.unshipped.length} orders to ship. 1 card filed since your last visit. 1993 Finest is 2 cards from done.`,
    );
    expect(summary({ sales: { unshipped: [] } }, [], null)).toBe("Nothing to ship.");
  });

  it("the demo's line comes from its shelf's filed cards", () => {
    const data = getDashboard();
    const filed = bindersOf(data).reduce((n, b) => n + b.newCards.length, 0);
    draw(data);
    expect(screen.getByText(new RegExp(`${filed} cards? filed since your last visit\\.`))).toBeTruthy();
  });
});

describe("the sync status (review round 4)", () => {
  it("stands at the top, under the greeting, with what is waiting and the sets that still need a look", () => {
    const data = getDashboard();
    draw(data);
    const sync = screen.getByRole("region", { name: "Sync status" });
    expect(before(sync, heading("Out the Door")!)).toBe(true);
    expect(within(sync).getByText("3 cards waiting for the next sync.")).toBeTruthy();
    expect(within(sync).getByRole("link", { name: "Open Sync status" }).getAttribute("href")).toBe("/demo/inventory?tab=sync");
    // Each set names its marketplace for a reader, and each held-back card opens its panel over the
    // dashboard as stock for sale, where the fix is.
    const set = data.syncStatus!.problems[0];
    expect(within(sync).getByRole("heading", { level: 3, name: `${set.setLabel} on eBay` })).toBeTruthy();
    const first = set.cards[0];
    const link = within(sync).getByRole("link", { name: new RegExp(`^${first.card.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
    expect(link.getAttribute("href")).toBe(`/demo?detail=${encodeURIComponent(first.card.id)}&side=inventory`);
    expect(link.textContent).toContain(first.reason);
  });

  it("a set whose last sync failed says so after its held-back cards; the cards it does not name open on Sync status", () => {
    const data = getDashboard();
    const set = { ...data.syncStatus!.problems[0], failure: "The marketplace didn't answer.", heldBack: 5 };
    draw({ ...data, syncStatus: { pending: [], problems: [set], more: true } });
    const sync = screen.getByRole("region", { name: "Sync status" });
    const failure = within(sync).getByText("The marketplace didn't answer.");
    expect(within(sync).getByText("5 cards held back from eBay. Fix each one on its card:")).toBeTruthy();
    // Held-back cards lead: every named card comes before the failure sentence.
    for (const link of within(sync).getAllByRole("link", { name: /No price yet|need a photo/ })) {
      expect(before(link, failure)).toBe(true);
    }
    const rest = within(sync).getByRole("link", { name: `${5 - set.cards.length} more cards on Sync status, held back in ${set.setLabel} on eBay` });
    expect(rest.getAttribute("href")).toBe("/demo/inventory?tab=sync");
    expect(within(sync).getByText("More sets need a look on Sync status.")).toBeTruthy();
    expect(within(sync).queryByText(/waiting for the next sync/)).toBeNull();
  });

  it(`more than ${HELD_PREVIEW} held-back cards: the rest behind Show all, each still opening its card`, () => {
    const data = getDashboard();
    const base = data.syncStatus!.problems[0];
    const cards = Array.from({ length: HELD_PREVIEW + 3 }, (_, i) => ({
      reason: "No price yet. Set one on the card, or a common price for the set.",
      card: { ...base.cards[0].card, id: `${base.cards[0].card.id}-${i}`, title: `Held card ${i}` },
    }));
    const set = { ...base, heldBack: cards.length, cards };
    draw({ ...data, syncStatus: { pending: [], problems: [set], more: false } });
    const sync = screen.getByRole("region", { name: "Sync status" });
    const held = () => within(sync).getAllByRole("link", { name: /^Held card \d+/ });
    expect(held()).toHaveLength(HELD_PREVIEW);
    const showAll = within(sync).getByRole("button", { name: `Show all ${cards.length} held back in ${set.setLabel} on eBay (+3)` });
    expect(showAll.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(showAll);
    expect(held()).toHaveLength(cards.length);
    const last = held()[cards.length - 1];
    expect(last.getAttribute("href")).toBe(
      `/demo?open=${encodeURIComponent(set.id)}&detail=${encodeURIComponent(cards[cards.length - 1].card.id)}&side=inventory`,
    );
    expect(last.textContent).toContain("No price yet.");
    expect(within(sync).getByRole("button", { name: /^Show fewer/ }).getAttribute("aria-expanded")).toBe("true");
    // Every card the read named is on the page: nothing points elsewhere.
    expect(within(sync).queryByRole("link", { name: /more cards? on Sync status/ })).toBeNull();
  });

  it("sets needing a look come before the cards waiting for the next sync", () => {
    draw(getDashboard());
    const sync = screen.getByRole("region", { name: "Sync status" });
    const set = within(sync).getAllByRole("heading", { level: 3 })[0];
    expect(before(set, within(sync).getByText("3 cards waiting for the next sync."))).toBe(true);
  });

  it("only cards waiting: no set, and a count that may be a floor", () => {
    draw({ ...getDashboard(), syncStatus: { pending: [{ marketplace: "bsc", cards: 100, more: true }], problems: [], more: false } });
    const sync = screen.getByRole("region", { name: "Sync status" });
    expect(within(sync).getByText("100+ cards waiting for the next sync.")).toBeTruthy();
    expect(within(sync).queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });

  it("nothing waiting and nothing wrong: no section", () => {
    draw({ ...getDashboard(), syncStatus: null });
    expect(heading("Sync status")).toBeNull();
  });
});

describe("New Listings (review round 4)", () => {
  it("follows Fresh Pulls, each tile with its price and box, opening the card's panel over the dashboard", () => {
    const data = getDashboard();
    draw(data);
    const listings = screen.getByRole("region", { name: "New Listings" });
    expect(before(heading("Fresh Pulls")!, heading("New Listings")!)).toBe(true);
    const links = within(listings).getAllByRole("link");
    expect(links).toHaveLength(data.newListings.length);
    const first = data.newListings[0];
    expect(links[0].getAttribute("href")).toBe(`/demo?detail=${encodeURIComponent(first.id)}&side=inventory`);
    expect(links[0].textContent).toContain(`${first.quantity} in ${first.boxName}`);
    // The demo store prices none of its box lines, and the tiles say so, as the panel does.
    expect(within(listings).getAllByText("No price yet")).toHaveLength(data.newListings.length);
  });

  it("more than six: the rest behind Show all", () => {
    const data = getDashboard();
    const more = Array.from({ length: 7 }, (_, i) => ({ ...data.newListings[i % data.newListings.length], lineId: `listing-${i}` }));
    draw({ ...data, newListings: more });
    const listings = screen.getByRole("region", { name: "New Listings" });
    expect(within(listings).getAllByRole("link")).toHaveLength(6);
    expect(within(listings).getByRole("button", { name: /^Show all 7 new listings/ })).toBeTruthy();
  });

  it("nothing new in a box: no section", () => {
    draw({ ...getDashboard(), newListings: [] });
    expect(heading("New Listings")).toBeNull();
  });

  it("words a price: one copy, several, none", () => {
    expect(priceWords(4500, 1)).toBe("$45.00");
    expect(priceWords(75, 3)).toBe("$0.75 each");
    expect(priceWords(null, 2)).toBe("No price yet");
  });
});

describe("the third shelf (review round 4)", () => {
  const INVENTORY_STARTER = "That to-list pile won't list itself. Add cards to sell";
  const base = bindersOf(getDashboard()).find((b) => !b.checklist)!;
  const many = (n: number): ShelfBinder[] =>
    Array.from({ length: n }, (_, i) => ({ ...base, id: `b${i}`, name: `Binder ${i}`, newCards: [], cardCount: 1 }));
  const spines = () => screen.getAllByRole("button", { name: /^Binder \d+, 1 card, / });

  it("with a box in use, the boxes stand on it, each opening its box on Inventory, and the binders keep two shelves", () => {
    const data = getDashboard();
    draw({ ...data, binders: many(20) });
    expect(heading("Your binders and boxes")).not.toBeNull();
    expect(spines()).toHaveLength(16);
    expect(screen.getByRole("button", { name: "Show all 20 binders" })).toBeTruthy();
    const boxes = screen.getByRole("list", { name: "Shelf 3, boxes" });
    const show = within(boxes).getByRole("link", { name: "Show box, box, 5 cards for sale" });
    expect(show.getAttribute("href")).toBe("/demo/inventory?tab=boxes&b=box-show");
    expect(within(boxes).getAllByRole("link")).toHaveLength(data.shelfBoxes!.length);
    expect(screen.queryByRole("link", { name: INVENTORY_STARTER })).toBeNull();
  });

  it("more boxes than a shelf holds: the last place says how many more, into My Boxes", () => {
    const data = getDashboard();
    const eight = Array.from({ length: 8 }, (_, i) => ({ ...data.shelfBoxes![0], id: `box-${i}`, name: `Box ${i}` }));
    draw({ ...data, shelfBoxes: eight });
    const boxes = screen.getByRole("list", { name: "Shelf 3, boxes" });
    expect(within(boxes).getAllByRole("link", { name: /, box, / })).toHaveLength(5);
    expect(within(boxes).getByRole("link", { name: "3 more boxes on My Boxes" }).getAttribute("href")).toBe(
      "/demo/inventory?tab=boxes",
    );
  });

  it("with no box, binders past two shelves stand on the third, and the to-list pile after them while there is room", () => {
    draw({ ...getDashboard(), shelfBoxes: [], binders: many(20) });
    expect(heading("Your binders")).not.toBeNull();
    expect(spines()).toHaveLength(20);
    const third = screen.getByRole("list", { name: "Shelf 3" });
    expect(within(third).getAllByRole("button")).toHaveLength(4);
    expect(within(third).getByRole("link", { name: INVENTORY_STARTER }).getAttribute("href")).toBe("/demo/inventory?tab=add");
  });

  it("a fuller third shelf has no room left for it", () => {
    draw({ ...getDashboard(), shelfBoxes: [], binders: many(21) });
    expect(within(screen.getByRole("list", { name: "Shelf 3" })).getAllByRole("button")).toHaveLength(5);
    expect(screen.queryByRole("link", { name: INVENTORY_STARTER })).toBeNull();
  });
});
