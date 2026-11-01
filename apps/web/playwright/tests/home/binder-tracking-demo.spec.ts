// NEO-350 (R1): the signed-out collection demo on the Binder Tracking tour
// opens in place, its three tabs and a binder work, browser Back returns to the
// previous view, and "Back to the tour" leaves it. Light by design: the demo
// is hard-coded marketing data; its depth is covered by unit tests.
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Binder Tracking tour: open the demo binder, switch tabs, open a binder, Back, leave",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    await page.goto("/binder-tracking");
    const tour = page.getByRole("region", { name: "Take it for a spin" });
    await expect(tour).toBeVisible();
    await expectAccessible(page, { within: tour, label: "Binder Tracking tour, Take it for a spin" });

    // Opening the demo swaps the tour for it, in place, and lands focus on the demo notice.
    await tour.getByRole("link", { name: "Open the demo binder" }).click();
    await expect(page).toHaveURL(/\/binder-tracking\?demo=on$/);
    const about = page.getByRole("region", { name: "About this demo" });
    await expect(about).toBeFocused();
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();

    // The three tabs, each on its own view of the URL.
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "My Cards" }).click();
    await expect(page).toHaveURL(/[?&]tab=cards/);
    await expect(page.getByRole("heading", { level: 2, name: "Sets I'm building" })).toBeVisible();
    await expectAccessible(page, { label: "Collection demo, My Cards" });

    await tabs.getByRole("link", { name: "Checklists" }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(page.getByRole("searchbox", { name: "Search every card" })).toBeVisible();

    await tabs.getByRole("link", { name: "My Binders" }).click();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    const binders = page.getByRole("list", { name: "Your binders" });
    await expect(binders).toBeVisible();

    // Open one binder; browser Back returns to the shelf.
    await binders.getByRole("button", { name: /^All Reggie White,/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "All Reggie White" })).toBeVisible();
    await expectAccessible(page, { label: "Collection demo, an open binder" });
    await page.goBack();
    await expect(binders).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "All Reggie White" })).toBeHidden();

    // "Back to the tour" goes straight out, to the tour.
    await page.getByRole("button", { name: "Back to the tour" }).click();
    await expect(page).toHaveURL(/\/binder-tracking$/);
    await expect(tour).toBeVisible();
    await expect(tour.getByRole("link", { name: "Open the demo binder" })).toBeFocused();
  },
);
