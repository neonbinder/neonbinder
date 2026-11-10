// R1: a card that lands in a box shows on the signed-in dashboard under New
// Listings, with how many and NB's price, and opens the card in its box on
// Inventory (NEO-464 review round 4). Listings are NB's own inventory (Jason,
// 2026-11-10: "don't worry about if it has sync'd yet or not"): nothing here
// waits on a marketplace. With a box in use, the boxes stand on the third
// shelf, each one link to the box on Inventory.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`) on one card of the seed's 2024 Topps Chrome Base,
// registered in SET-REGISTRY.md; never the set, its cards, players or teams.
// Its own price on the copy, so it never reads a common price. Self-cleaning:
// the copy is removed and the box deleted through the UI. The box's name is a
// single token minted from `env.ATTEMPT_TOKEN`.
import { createBox, deleteOpenBox, drillToCollectorBase, inventoryTabs, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Dashboard: a card put in a box is a New Listing with its price, opening in its box on Inventory",
  { tag: ["@dashboard"] },
  async ({ page, signIn, env }) => {
    const box = `Listed${env.ATTEMPT_TOKEN}`;
    const greeting = page.getByRole("heading", { level: 1, name: "Welcome back, slugger." });

    await signIn("/inventory?tab=boxes");
    await expect(page.getByRole("list", { name: "Your boxes" })).toBeVisible({ timeout: LAUNCH_GATE });
    await createBox(page, box);

    // --- One copy added into the new box, with its own price ----------------
    await page.goto("/inventory?tab=checklists");
    await expect(inventoryTabs(page).getByRole("link", { name: "Checklists", exact: true })).toHaveAttribute("aria-current", "page");
    const stock = await drillToCollectorBase(page);
    // The third ordinary row: the filed-since-last-visit spec uses the first two on this account.
    const row = ordinaryBaseRows(stock).nth(2);
    await expect(row).toBeVisible();
    const card = await shortNameOf(row);
    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}`),
    });
    await stock.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${card.short}`, exact: true });
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    await addForm.getByRole("combobox", { name: "Where it lives" }).selectOption({ label: `${box} (box, for sale)` });
    await addForm.getByRole("spinbutton", { name: "Price", exact: true }).fill("3");
    await addForm.getByRole("button", { name: "Add to inventory" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${card.short}, Raw, Excellent` })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- The dashboard: a New Listing, and the boxes on the third shelf ------
    await page.goto("/dashboard");
    await expect(greeting).toBeVisible();
    const listings = page.getByRole("region", { name: "New Listings" });
    await expect(listings).toBeVisible();
    // A tile is one link, named by its words: the card's full listing title, the price, how many in which box.
    const tile = listings.getByRole("link", {
      name: new RegExp(
        `^2024 Topps Chrome (?=.*${escapeRegExp(card.player)})(?=.*#${escapeRegExp(card.number)}\\b).*\\$3\\.00 1 in ${escapeRegExp(box)}$`,
      ),
    });
    await expect(tile).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Your binders and boxes", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: /^Shelf \d+, boxes$/ })).toBeVisible();
    await expectAccessible(page, { label: "Dashboard, New Listings and the boxes' shelf" });

    // A real move: the tile opens the card in its box on Inventory, and Back returns to the dashboard.
    await tile.click();
    await expect(page).toHaveURL(/\/inventory\?tab=boxes&b=[^&]+&detail=[^&]+$/);
    await expect(page.getByRole("heading", { level: 2, name: box, exact: true })).toBeVisible();
    await expect(drawer).toBeVisible();
    await page.goBack();
    await expect(greeting).toBeVisible();

    // --- Cleanup through the UI: remove the copy, delete the empty box -------
    await page.goForward();
    await expect(drawer).toBeVisible();
    await yourCopies.getByRole("button", { name: `Remove ${card.short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await deleteOpenBox(page, box);
    await expect(page.getByRole("list", { name: "Your boxes" }).getByLabel(new RegExp(`^${escapeRegExp(box)}, box, `))).toHaveCount(0);
  },
);
