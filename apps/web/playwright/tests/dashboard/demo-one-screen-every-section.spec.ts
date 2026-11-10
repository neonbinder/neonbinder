// R1: the dashboard is ONE screen (NEO-464, Jason 2026-11-10): it shows every
// section the collector's data fills, with no dealer/collector switch. The
// public demo draws that same screen on a fake collector who has a bit of
// everything, so every section shows, an order waiting to ship leads, and the
// Hopper's processing scans link each run to the Add cards tab that finishes
// it (here, the demo's Inventory side). Signed out, fake data, read-only (R7).
// The panels the screen opens (a binder's pocket page, an order's cards) are
// checked for accessibility OPEN, as well as the closed page: the open state is
// what a keyboard or screen-reader user spends their time in. Needs a Look has
// nothing to open (a plain list), so there is no open state of it to check.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Dashboard demo: one screen with every section, and a hopper run opens Add cards where it is finished",
  { tag: ["@smoke", "@dashboard"] },
  async ({ page }) => {
    // Signed out: every test starts in a fresh browser context (R4).
    await page.goto("/demo");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();

    // One screen: no "Viewing as" switch beside the demo's own Light / Dark control.
    const controls = page.getByRole("region", { name: "Demo controls" });
    await expect(controls).toBeVisible();
    await expect(controls.getByRole("radiogroup", { name: "Viewing as" })).toHaveCount(0);

    // Every section the fake collector's data fills.
    const section = (name: string) => page.getByRole("heading", { level: 2, name, exact: true });
    for (const name of ["Out the Door", "In the Hopper", "Needs a Look", "On the Bubble", "Your binders", "Odds and Ends"]) {
      await expect(section(name), name).toBeVisible();
    }

    // The one ordering rule: orders are waiting to ship, so Out the Door comes before the boards.
    const sections = page.getByRole("heading", { level: 2 });
    const order = await sections.allInnerTexts();
    expect(order.indexOf("Out the Door")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("Out the Door")).toBeLessThan(order.indexOf("On the Bubble"));

    // The hopper says "processing", never "still being identified".
    const hopper = page.getByRole("region", { name: "In the Hopper" });
    await expect(hopper.getByRole("heading", { level: 3, name: /^\d+ scans? processing$/ })).toBeVisible();
    await expect(hopper.getByText(/still being identified/)).toHaveCount(0);
    await expectAccessible(page, { label: "Dashboard demo" });

    // A run going into a box is finished on Inventory's Add cards tab, and Back comes home.
    const run = hopper.getByRole("link", { name: /^Show pickups \d+ of \d+ scans? done Finish on Inventory$/ });
    await expect(hopper.getByRole("link", { name: /^Garage shoebox \d+ of \d+ scans? done Finish on Collection$/ })).toBeVisible();
    await run.click();
    await expect(page).toHaveURL(/\/demo\/inventory\?(.*&)?tab=add/);
    await expect(page.getByLabel("Put them in this box")).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/demo$/);
    await expect(hopper).toBeVisible();

    // An order opens to every card on it: check the opened order.
    const orders = page.getByRole("region", { name: "Out the Door" });
    const showCards = orders.getByRole("button", { name: /^Show all \d+ cards? in .+ order / }).first();
    await showCards.click();
    // The button's words flip with the state, so the open one is found by its new name.
    await expect(orders.getByRole("button", { name: /^Hide the cards/, expanded: true }).first()).toBeVisible();
    await expectAccessible(page, { within: orders, label: "Dashboard demo, an order opened" });

    // A binder opens to a pocket page: check the opened page.
    const shelf = page.getByRole("list", { name: "Binders on the shelf" });
    const spine = shelf.getByRole("button", { name: /^.+, \d+ cards?, / }).first();
    await spine.click();
    await expect(spine).toHaveAttribute("aria-expanded", "true");
    const pocketPage = page.getByRole("list", { name: /, page 1 of \d+$/ });
    await expect(pocketPage).toBeVisible();
    await expectAccessible(page, { within: pocketPage, label: "Dashboard demo, a binder's pocket page open" });
  },
);
