// R1: an account with room on its shelves gets a way in on each empty one
// (NEO-464): the second shelf, while it holds no binder, links to Add cards on
// Collection; the third, until the collector has a box in use (one they made,
// or Unsorted with a card in it), to Add cards on Inventory. Each is one link,
// shown on phones too, and lands on the right Add cards tab.
//
// R7: read-only. Whether each starter stands is this account's own state, and
// other specs on this worker may have filled a shelf or a box first, so the
// spec reads that state and proves the rule both ways: present, it follows the
// link; absent, it shows what put it away (eight binders on the first shelf,
// or a box in use on My Boxes). The unit tests prove both rules on fixed data.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test("Dashboard: empty shelves lead into Add cards on Collection and on Inventory", { tag: ["@dashboard"] }, async ({ page, signIn }) => {
  await signIn("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible({ timeout: LAUNCH_GATE });
  const shelf = page.getByRole("list", { name: "Binders on the shelf" });
  await expect(shelf.getByRole("button", { name: /^Main, \d+ cards?, / })).toBeVisible();

  const toCollection = page.getByRole("link", { name: "Add cards to your collection", exact: true });
  const toInventory = page.getByRole("link", { name: "Add cards to your inventory", exact: true });

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
  if (spines <= 16 && (await toInventory.count()) > 0) {
    await expect(toInventory).toBeVisible();
    await toInventory.click();
    await expect(page).toHaveURL(/\/inventory\?tab=add$/);
    const tabs = page.getByRole("navigation", { name: "Inventory sections" });
    await expect(tabs.getByRole("link", { name: "Add cards", exact: true })).toHaveAttribute("aria-current", "page");
  } else if (spines <= 16) {
    // The third shelf is empty but carries nothing: the collector has a box in use.
    await page.goto("/inventory?tab=boxes");
    const ownBox = page.getByRole("list", { name: "Your boxes" }).getByLabel(/, box, /);
    const fullUnsorted = page.getByLabel(/^Unsorted, box, [1-9]/);
    await expect(ownBox.or(fullUnsorted).first()).toBeVisible();
  } else {
    await expect(toInventory).toHaveCount(0);
  }
});
