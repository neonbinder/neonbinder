/**
 * NEO-464 — the dashboard is ONE screen (Jason, 2026-11-10): every section
 * draws only when the data has something for it, and the one ordering rule
 * is data-driven (an order waiting to ship leads; otherwise the boards do).
 * Drawn on the demo's fake collector, who has every section, then with parts
 * of that data taken away.
 */

import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { bindersOf, getDashboard, type DashboardData } from "../fake-data";
import DashboardScreen, { summary } from "./DashboardScreen";

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
      "Your binders",
      "Could fit your smart binders",
      "The Chase",
      "Fresh Pulls",
      "Binders Filling Up",
      "Odds and Ends",
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
    draw({ ...getDashboard(), sales: null });
    expect(heading("Out the Door")).toBeNull();
    expect(screen.queryByText("All shipped. Nice.")).toBeNull();
    const look = screen.getByRole("region", { name: "Needs a Look" });
    expect(within(look).getByText("15 boxed cards not listed yet")).toBeTruthy();
    expect(screen.queryByText(/to ship\./)).toBeNull();
  });

  it("no data for a section draws no section: no scans, no boxes, no sales", () => {
    draw({ ...getDashboard(), sales: null, intake: NO_INTAKE, unlistedBoxes: [] });
    for (const name of ["Out the Door", "In the Hopper", "Needs a Look"]) {
      expect(heading(name), name).toBeNull();
    }
    expect(heading("Your binders")).not.toBeNull();
    // The trade pile still fills Odds and Ends.
    expect(heading("Odds and Ends")).not.toBeNull();
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
