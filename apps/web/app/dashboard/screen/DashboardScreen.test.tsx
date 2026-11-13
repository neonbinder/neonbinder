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
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindersOf, getDashboard, type DashboardData } from "../fake-data";
import DashboardScreen, { summary } from "./DashboardScreen";
import { priceWords } from "./NewListings";
import { HELD_PREVIEW, syncFrame } from "./SyncStatus";
import type { ShelfBinder } from "./shelf-model";
import { boxLabel, spineCssWidth, STARTER_ROOM_NARROW } from "./Shelf";
import { NEED_CHIPS } from "./Boards";
import { intakeCounts, sortedLine } from "./Hopper";

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

const NO_INTAKE: DashboardData["intake"] = {
  total: 0,
  needsYou: 0,
  unidentified: 0,
  uploads: [],
  sortedThisWeek: 0,
  sortedAllTime: 0,
  sortedAllTimeMore: false,
};

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
  type Upload = DashboardData["intake"]["uploads"][number];
  const upload = (over: Partial<Upload> = {}): Upload => ({
    id: "r",
    name: "Main",
    needsYou: 1,
    unidentified: 0,
    side: "collection",
    href: "/collection?tab=add&run=r",
    lastScan: "Last scan 3:42 PM",
    guesses: [],
    ...over,
  });
  const hopper = () => screen.getByRole("region", { name: "In the Hopper" });

  it("leads with the scans to finish, then one block per open run with a Finish this run link to where it is finished", () => {
    draw(getDashboard());
    expect(within(hopper()).getByText("2 scans need your yes · 18 to identify")).toBeTruthy();
    const runs = within(hopper()).getByRole("list", { name: "Runs to finish" });
    const blocks = within(runs).getAllByRole("listitem").filter((li) => li.parentElement === runs);
    expect(blocks).toHaveLength(2);
    expect(within(blocks[0]).getByRole("heading", { level: 3, name: "Garage shoebox on Collection" })).toBeTruthy();
    expect(within(blocks[0]).getByText("2 need your yes · 16 to identify")).toBeTruthy();
    const shoebox = within(blocks[0]).getByRole("link", { name: "Finish this run into Garage shoebox on Collection" });
    expect(shoebox.getAttribute("href")).toBe("/demo/collection?tab=add");
    expect(within(blocks[1]).getByText("2 to identify")).toBeTruthy();
    const show = within(blocks[1]).getByRole("link", { name: "Finish this run into Show pickups on Inventory" });
    expect(show.getAttribute("href")).toBe("/demo/inventory?side=inventory&tab=add");
    // The sorted runs are one line of stats, never rows.
    expect(within(hopper()).getByText("3 runs sorted this week · 14 all-time")).toBeTruthy();
  });

  it("drops the old intake note, the explanation, the processing pile and the progress bars", () => {
    draw(getDashboard());
    expect(within(hopper()).queryByText(/in intake/)).toBeNull();
    expect(within(hopper()).queryByText(/We think we know these/)).toBeNull();
    expect(within(hopper()).queryByText(/processing/)).toBeNull();
    expect(within(hopper()).queryByText(/of \d+ scans? done/)).toBeNull();
    expect(within(hopper()).queryAllByRole("img", { name: "Scan processing", hidden: true })).toHaveLength(0);
  });

  it("a run's best guesses open their card panels, named by title; a Want List guess wears its ring and flag", () => {
    const want = getDashboard().wantList[0];
    const guess = getDashboard().intake.uploads[0].guesses[0];
    draw({
      ...getDashboard(),
      intake: { ...NO_INTAKE, total: 2, needsYou: 2, uploads: [upload({ needsYou: 2, guesses: [guess, want] })] },
    });
    const block = within(hopper()).getAllByRole("listitem")[0];
    expect(within(block).getByText("On your Want List")).toBeTruthy();
    const guesses = within(block).getByRole("list", { name: "Best guesses waiting on your yes" });
    expect(within(guesses).getAllByRole("link")).toHaveLength(2);
    const links = [
      within(guesses).getByRole("link", { name: guess.title }),
      within(guesses).getByRole("link", { name: `${want.title}, on your Want List` }),
    ];
    for (const link of links) expect(link.getAttribute("href")).toMatch(/^\/demo\?detail=[^&]+$/);
    // The pictures name nothing of their own: the title is the one name.
    expect(within(block).queryAllByRole("img")).toHaveLength(0);
  });

  it("two open runs into one binder read apart by their last scan, on screen and in the button's name", () => {
    draw({
      ...getDashboard(),
      intake: {
        ...NO_INTAKE,
        total: 2,
        needsYou: 1,
        unidentified: 1,
        uploads: [
          upload({ id: "a", href: "/collection?tab=add&run=a" }),
          upload({ id: "b", needsYou: 0, unidentified: 1, href: "/collection?tab=add&run=b", lastScan: "Last scan yesterday" }),
          upload({ id: "c", name: "Main", side: "inventory", href: "/inventory?tab=add&run=c", lastScan: "Last scan 2 days ago" }),
        ],
      },
    });
    expect(within(hopper()).getByText("Last scan 3:42 PM")).toBeTruthy();
    expect(within(hopper()).getByRole("link", { name: "Finish this run into Main on Collection, last scan 3:42 PM" }).getAttribute("href")).toBe(
      "/collection?tab=add&run=a",
    );
    expect(within(hopper()).getByRole("link", { name: "Finish this run into Main on Collection, last scan yesterday" }).getAttribute("href")).toBe(
      "/collection?tab=add&run=b",
    );
    // A box of the same name is told apart by its screen: no time.
    expect(within(hopper()).getByRole("link", { name: "Finish this run into Main on Inventory" })).toBeTruthy();
    expect(within(hopper()).queryByText("Last scan 2 days ago")).toBeNull();
  });

  it("with nothing open but a run sorted this week, the hopper is just the stat; with neither, no hopper", () => {
    draw({ ...getDashboard(), intake: { ...NO_INTAKE, sortedThisWeek: 1, sortedAllTime: 1 } });
    expect(within(hopper()).getByText("1 run sorted this week")).toBeTruthy();
    expect(within(hopper()).queryByRole("list")).toBeNull();
    expect(within(hopper()).queryByRole("link")).toBeNull();
  });

  it("all-time on its own does not hold the panel open", () => {
    draw({ ...getDashboard(), intake: { ...NO_INTAKE, sortedAllTime: 9 } });
    expect(heading("In the Hopper")).toBeNull();
  });

  it("the runs' open scans add up to the hopper's total", () => {
    const { intake } = getDashboard();
    expect(intake.uploads.reduce((n, u) => n + u.needsYou + u.unidentified, 0)).toBe(intake.total);
    expect(intake.unidentified + intake.needsYou).toBe(intake.total);
  });
});

describe("Out the Door", () => {
  it("with orders to ship, links to the Pick List where they are pulled", () => {
    draw(getDashboard());
    const ship = screen.getByRole("region", { name: "Out the Door" });
    const pick = within(ship).getByRole("link", { name: "Pull them on the Pick List" });
    expect(pick.getAttribute("href")).toBe("/demo/inventory?tab=pick");
  });

  it("all shipped: no Pick List link", () => {
    const data = getDashboard();
    draw({ ...data, sales: { ...data.sales!, unshipped: [] } });
    expect(screen.getByText("All shipped. Nice.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Pull them on the Pick List" })).toBeNull();
  });
});

describe("the hopper's words", () => {
  it("counts what is left: a zero part left out, the lead line with its noun", () => {
    expect(intakeCounts({ needsYou: 7, unidentified: 1 }, "scan")).toBe("7 scans need your yes · 1 to identify");
    expect(intakeCounts({ needsYou: 1, unidentified: 0 }, "scan")).toBe("1 scan needs your yes");
    expect(intakeCounts({ needsYou: 0, unidentified: 1 }, "scan")).toBe("1 scan to identify");
    expect(intakeCounts({ needsYou: 5, unidentified: 1 })).toBe("5 need your yes · 1 to identify");
    expect(intakeCounts({ needsYou: 1, unidentified: 0 })).toBe("1 needs your yes");
    expect(intakeCounts({ needsYou: 0, unidentified: 2 })).toBe("2 to identify");
  });

  it("says the runs sorted: a zero part left out, all-time only when it adds something, a floor as N+", () => {
    const line = (week: number, all: number, more = false) =>
      sortedLine({ sortedThisWeek: week, sortedAllTime: all, sortedAllTimeMore: more });
    expect(line(6, 42)).toBe("6 runs sorted this week · 42 all-time");
    expect(line(1, 1)).toBe("1 run sorted this week");
    expect(line(20, 20, true)).toBe("20 runs sorted this week · 20+ all-time");
    expect(line(0, 42)).toBe("42 runs sorted all-time");
    expect(line(0, 1)).toBe("1 run sorted all-time");
    expect(line(0, 18, true)).toBe("18+ runs sorted all-time");
    expect(line(0, 0)).toBeNull();
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
    // It carries why it was held back, so the panel says it and opens on the fix.
    expect(first.code).toBe("noPhoto");
    expect(link.getAttribute("href")).toBe(`/demo?detail=${encodeURIComponent(first.card.id)}&side=inventory&held=ebay.noPhoto`);
    expect(link.textContent).toContain(first.reason);
  });

  it("the frame says how bad it is: danger for a failed sync, warning for held-back cards, plain for cards waiting", () => {
    const data = getDashboard();
    const status = data.syncStatus!;
    expect(syncFrame(status)).toBe("warn");
    expect(syncFrame({ ...status, problems: [{ ...status.problems[0], failure: "It didn't go through." }] })).toBe("danger");
    expect(syncFrame({ ...status, problems: [] })).toBe("plain");
    draw(data);
    const sync = screen.getByRole("region", { name: "Sync status" });
    expect(sync.className).toContain("border-notice-warn-rule");
    expect(sync.className).not.toContain("border-notice-danger-rule");
  });

  it("one held-back card is told to fix it; several, each one", () => {
    const data = getDashboard();
    draw(data);
    const sync = screen.getByRole("region", { name: "Sync status" });
    expect(within(sync).getByText("1 card held back from eBay. Fix it on the card and it goes up next sync:")).toBeTruthy();
    const finest = data.syncStatus!.problems[1];
    expect(
      within(sync).getByText(`${finest.heldBack} cards held back from eBay. Fix each one on its card and it goes up next sync:`),
    ).toBeTruthy();
  });

  it(`the demo holds more of one set back than it shows before Show all, its heading in its cards' own words`, () => {
    const data = getDashboard();
    const finest = data.syncStatus!.problems.find((p) => p.cards.length > HELD_PREVIEW)!;
    expect(finest).toBeTruthy();
    for (const { card } of finest.cards) expect(card.title.startsWith(finest.setLabel.replace(/ Base$/, ""))).toBe(true);
    draw(data);
    const sync = screen.getByRole("region", { name: "Sync status" });
    expect(within(sync).getByRole("button", { name: `Show all ${finest.cards.length} held back in ${finest.setLabel} on eBay` })).toBeTruthy();
  });

  it("a set whose last sync failed says so after its held-back cards; the cards it does not name open on Sync status", () => {
    const data = getDashboard();
    const set = { ...data.syncStatus!.problems[0], failure: "The marketplace didn't answer.", heldBack: 5 };
    draw({ ...data, syncStatus: { pending: [], problems: [set], more: true } });
    const sync = screen.getByRole("region", { name: "Sync status" });
    const failure = within(sync).getByText("The marketplace didn't answer.");
    expect(within(sync).getByText("5 cards held back from eBay. Fix each one on its card and it goes up next sync:")).toBeTruthy();
    expect(sync.className).toContain("border-notice-danger-rule");
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
    // The words on it lead its name; the "(+3)" it shows is seen, not read (WCAG 2.5.3).
    const showAll = within(sync).getByRole("button", { name: `Show all ${cards.length} held back in ${set.setLabel} on eBay` });
    expect(showAll.textContent).toMatch(/^Show all 9 \(\+3\) held back in /);
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
    // Six tiles; the rest of the demo's box lines wait behind Show all.
    const shown = data.newListings.slice(0, 6);
    expect(data.newListings.length).toBeGreaterThan(6);
    const links = within(listings).getAllByRole("link");
    expect(links).toHaveLength(shown.length);
    const first = data.newListings[0];
    expect(links[0].getAttribute("href")).toBe(`/demo?detail=${encodeURIComponent(first.id)}&side=inventory`);
    expect(links[0].textContent).toContain(`${first.quantity} in ${first.boxName}`);
    // Each tile says its own price, as the panel does: the demo leaves a few box lines unpriced.
    shown.forEach((listing, i) => expect(links[i].textContent).toContain(priceWords(listing.priceCents, listing.quantity)));
    const unpriced = shown.filter((l) => l.priceCents === null).length;
    expect(unpriced).toBeGreaterThan(0);
    expect(within(listings).getAllByText("No price yet")).toHaveLength(unpriced);
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
    const inShow = data.shelfBoxes!.find((b) => b.id === "box-show")!.cardCount;
    expect(inShow).toBe(18);
    const show = within(boxes).getByRole("link", { name: `Show box, ${inShow} cards for sale` });
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

describe("audit fixes (NEO-464)", () => {
  const base = bindersOf(getDashboard()).find((b) => !b.checklist)!;
  const many = (n: number): ShelfBinder[] =>
    Array.from({ length: n }, (_, i) => ({ ...base, id: `b${i}`, name: `Binder ${i}`, newCards: [], cardCount: 1 }));
  const INVENTORY_STARTER = "That to-list pile won't list itself. Add cards to sell";
  /** A phone-width screen, as the shelf asks `matchMedia`. */
  const phone = () =>
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({ matches: query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
  afterEach(() => vi.restoreAllMocks());

  it("a box end's name leads with the name it shows, and a name that says box is not told so twice", () => {
    const box = getDashboard().shelfBoxes![0];
    expect(boxLabel({ ...box, name: "Show box", cardCount: 11 })).toBe("Show box, 11 cards for sale");
    expect(boxLabel({ ...box, name: "Unsorted", cardCount: 1 })).toBe("Unsorted, box, 1 card for sale");
    expect(boxLabel({ ...box, name: "Shoebox", cardCount: 2 })).toBe("Shoebox, box, 2 cards for sale");
  });

  it("every spine is capped at an eighth of its shelf, wide screens too, so eight always stand", () => {
    expect(spineCssWidth(62, false)).toBe("min(calc(62px * var(--spine-scale, 1)), calc((100cqw - 42px) / 8))");
    expect(spineCssWidth(38, true)).toBe("min(38px, calc((100cqw - 28px) / 8))");
  });

  it(`on a phone the third shelf carries its starter beside ${STARTER_ROOM_NARROW} binders at most`, () => {
    phone();
    const { unmount } = draw({ ...getDashboard(), shelfBoxes: [], binders: many(16 + STARTER_ROOM_NARROW) });
    expect(screen.getByRole("link", { name: INVENTORY_STARTER })).toBeTruthy();
    unmount();
    draw({ ...getDashboard(), shelfBoxes: [], binders: many(16 + STARTER_ROOM_NARROW + 1) });
    expect(screen.queryByRole("link", { name: INVENTORY_STARTER })).toBeNull();
  });

  it(`a board names its first ${NEED_CHIPS} needs again as rows of their own, for a phone's thumb, then how many more`, () => {
    const data = getDashboard();
    draw(data);
    const board = screen.getAllByRole("article").find((a) => a.textContent?.includes("Need:"))!;
    const rows = within(board).getByRole("list");
    const chips = within(rows).getAllByRole("link");
    expect(chips).toHaveLength(NEED_CHIPS);
    expect(chips[0].className).toContain("min-h-11");
    // The same cards as the wider line's first needs, opening the same panels.
    const line = within(board).getAllByRole("link").filter((l) => !rows.contains(l) && l.getAttribute("href")?.includes("detail="));
    expect(chips.map((c) => c.getAttribute("href"))).toEqual(line.slice(0, NEED_CHIPS).map((l) => l.getAttribute("href")));
    expect(rows.parentElement!.className).toContain("sm:hidden");
  });

  it("card links read as links at rest: underlined before any hover", () => {
    draw(getDashboard());
    const board = screen.getAllByRole("article").find((a) => a.textContent?.includes("Need:"))!;
    const need = within(board).getAllByRole("link").find((l) => l.getAttribute("href")?.includes("detail="))!;
    expect(need.className).toMatch(/(^| )underline( |$)/);
    const order = within(screen.getByRole("region", { name: "Out the Door" }))
      .getAllByRole("link")
      .find((l) => !l.getAttribute("aria-hidden") && l.getAttribute("href")?.includes("detail="))!;
    expect(order.className).toMatch(/(^| )underline( |$)/);
  });
});
