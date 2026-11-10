// R1: an account with room on its shelves gets a way in on each empty one
// (NEO-464): the second shelf, while it holds no binder, carries the shoebox,
// a link to Add cards on Collection; the third, until the collector has a box
// in use (one they made, or Unsorted with a card in it), the to-list pile, a
// link to Add cards on Inventory. Each is one link named by its own words
// (WCAG 2.5.3), shown on phones too, and lands on the right Add cards tab.
//
// R7: read-only. Whether each starter stands is this account's own state, and
// other specs on this worker may have filled a shelf or a box first, so the
// spec reads that state and proves the rule both ways: present, it follows the
// link; absent, it shows what put it away (eight binders on the first shelf;
// a box in use, which stands on the third shelf instead and opens on My Boxes;
// or a third shelf with no room left). The unit tests prove the rules on fixed data.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Dashboard: empty shelves lead into Add cards on Collection and on Inventory", { tag: ["@dashboard"] }, async ({ page, signIn }) => {
  await signIn("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible({ timeout: LAUNCH_GATE });
  const shelf = page.getByRole("list", { name: "Binders on the shelf" });
  await expect(shelf.getByRole("button", { name: /^Main, \d+ cards?, / })).toBeVisible();

  const toCollection = page.getByRole("link", { name: "We all have a shoebox. Sort it into binders", exact: true });
  const toInventory = page.getByRole("link", { name: "That to-list pile won't list itself. Add cards to sell", exact: true });

  // --- Shelf 2: Collection -------------------------------------------------
  const spines = await shelf.getByRole("button", { name: /^.+, \d+ cards?, / }).count();
  if (spines <= 8) {
    await expect(toCollection).toBeVisible();
    await expectAccessible(page, { label: "Dashboard, shelf starters" });
    await toCollection.click();
    await expect(page).toHaveURL(/\/collection\?tab=add$/);
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await expect(tabs.getByRole("link", { name: "Add cards", exact: true })).toHaveAttribute("aria-current", "page");
    // A real move: Back returns to the dashboard.
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard$/);
  } else {
    await expect(shelf.getByRole("list", { name: "Shelf 2" })).toBeVisible();
    await expect(toCollection).toHaveCount(0);
  }

  // --- Shelf 3: Inventory --------------------------------------------------
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
  // With no box in use the starter stands on shelf 3, after any binders there while the row has room
  // (review round 4); with one, the boxes stand there instead, and the binders keep two shelves.
  const boxShelf = page.getByRole("list", { name: /^Shelf \d+, boxes$/ });
  if ((await toInventory.count()) > 0) {
    await expect(toInventory).toBeVisible();
    await expectAccessible(page, { label: "Dashboard, Inventory shelf starter" });
    await toInventory.click();
    await expect(page).toHaveURL(/\/inventory\?tab=add$/);
    const tabs = page.getByRole("navigation", { name: "Inventory sections" });
    await expect(tabs.getByRole("link", { name: "Add cards", exact: true })).toHaveAttribute("aria-current", "page");
  } else if ((await boxShelf.count()) > 0) {
    // A box in use: its box end stands on the shelf, and opens it on My Boxes.
    expect(spines).toBeLessThanOrEqual(16);
    await expect(page.getByRole("heading", { level: 2, name: "Your binders and boxes" })).toBeVisible();
    const box = boxShelf.getByRole("link", { name: /, box, / }).first();
    await expect(box).toBeVisible();
    await box.click();
    await expect(page).toHaveURL(/\/inventory\?tab=boxes&b=[^&]+$/);
  } else {
    // A third shelf full of binders: no room left for the starter.
    await expect(toInventory).toHaveCount(0);
  }
});
