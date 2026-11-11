// R1: cards filed into a binder between two dashboard visits show on the
// signed-in dashboard as news: the summary line under the greeting reads
// "N cards filed since your last visit." and the binder's spine carries
// "2 new since your last visit" (NEO-464). Any way cards arrive in a binder is
// filing (Jason, 2026-11-10), so the spec files one card each way: one moved
// in (added for sale on the Inventory, then taken off sale into a new binder),
// one added straight into it. Fresh Pulls is only cards new to the collection,
// never a move (Jason, round 2): the card added straight in stands there, the
// moved one does not.
//
// A new visit needs thirty minutes away from the dashboard, so the spec moves
// its last open back with /testing/backdate-dashboard-visit
// (`backdateMyDashboardVisit`, caller-scoped, refused off testing deployments).
// That puts the new visit's "new" thirty minutes back, so anything this account
// filed in that window counts too: the summary is read as a number, and the
// exact claim is made on this run's own binder.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`, the profile's dashboard visit) on two cards of the seed's
// 2024 Topps Chrome Base, registered in SET-REGISTRY.md; never the set, its
// cards, players or teams. The moved card passes through Unsorted (its own
// price on it, so it never waits on a common price) only until it is taken off
// sale. Self-cleaning: the copies are removed and the binder deleted through
// the UI. The binder's name is a single token minted from `env.ATTEMPT_TOKEN`.
import { drillToCollectorBase, inventoryTabs, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test(
  "Dashboard: cards filed into a binder since the last visit, moved or added, are news; only the added one is a Fresh Pull",
  { tag: ["@smoke", "@dashboard"] },
  async ({ page, signIn, env }) => {
    const binder = `Filed${env.ATTEMPT_TOKEN}`;
    const greeting = page.getByRole("heading", { level: 1, name: "Welcome back, slugger." });

    // --- The visit before: open the dashboard (stamps the visit) ------------
    await signIn("/dashboard");
    await expect(greeting).toBeVisible({ timeout: LAUNCH_GATE });

    // --- A new binder, through the Collection's New binder dialog ----------
    await page.goto("/collection?tab=binders");
    const shelf = page.getByRole("list", { name: "Your binders" });
    await shelf.getByRole("button", { name: "New binder", exact: true }).click();
    const newDialog = page.getByRole("dialog", { name: "New binder", exact: true });
    await newDialog.getByRole("textbox", { name: "Binder name" }).fill(binder);
    await newDialog.getByRole("button", { name: "Put it on the shelf" }).click();
    await expect(newDialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 2, name: binder, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to the shelf" }).click();
    await expect(shelf.getByRole("button", { name: `${binder}, 0 cards`, exact: true })).toBeVisible();

    // --- One copy added for sale on the Inventory, then taken off sale into the binder (a move) ---
    await page.goto("/inventory?tab=checklists");
    await expect(inventoryTabs(page).getByRole("link", { name: "Checklists", exact: true })).toHaveAttribute("aria-current", "page");
    const stock = await drillToCollectorBase(page);
    const row = ordinaryBaseRows(stock).first();
    await expect(row).toBeVisible();
    const card = await shortNameOf(row);
    const added = await shortNameOf(ordinaryBaseRows(stock).nth(1));

    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}`),
    });
    await stock.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${card.short}`, exact: true });
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    await expect(
      addForm.getByRole("combobox", { name: "Where it lives" }).getByRole("option", { selected: true }),
    ).toHaveText("Unsorted (box, for sale)");
    await addForm.getByRole("spinbutton", { name: "Price", exact: true }).fill("1");
    await addForm.getByRole("button", { name: "Add to inventory" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${card.short}, Raw, Excellent` })).toBeVisible();

    await yourCopies.getByRole("button", { name: `Take off sale, ${card.short}, Raw, Excellent`, exact: true }).click();
    const offForm = yourCopies.getByRole("form", { name: /off sale/i });
    await offForm.getByRole("combobox", { name: "Back into" }).selectOption({ label: binder });
    await offForm.getByRole("button", { name: "Take it off sale", exact: true }).click();
    await expect(offForm).toBeHidden();
    await expect(drawer.getByRole("status").filter({ hasText: `Took ${card.short} off sale.` })).toBeVisible();
    const line = yourCopies.getByRole("listitem").filter({ has: page.getByText("Raw, Excellent", { exact: true }) });
    await expect(line.getByText(binder)).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- A second copy added straight into the binder, on the Collection ----
    await page.goto("/collection?tab=checklists");
    const checklist = await drillToCollectorBase(page);
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    const addedDrawer = page.getByRole("dialog", {
      name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(added.number)} ${escapeRegExp(added.player)}`),
    });
    await checklist.getByRole("button", { name: `Details for ${added.short}`, exact: true }).click();
    const addedCopies = addedDrawer.getByRole("region", { name: `Your copies of ${added.short}`, exact: true });
    await expect(addedCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const straightIn = addedDrawer.getByRole("form", { name: "Add a copy", exact: true });
    await straightIn.getByRole("combobox", { name: "Where it lives" }).selectOption({ label: binder });
    await straightIn.getByRole("button", { name: "Add to collection" }).click();
    await expect(addedDrawer.getByRole("status").filter({ hasText: `Added ${added.short}, Raw, Excellent` })).toBeVisible();
    await addedDrawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(addedDrawer).toBeHidden();

    // --- Away for the visit gap, then back: the filing is news --------------
    await page.goto("/testing/backdate-dashboard-visit");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(greeting).toBeVisible();
    await expect(page.getByText(/\b[\d,]+ cards? filed since your last visit\./)).toBeVisible();
    const spine = page
      .getByRole("list", { name: "Binders on the shelf" })
      .getByRole("button", { name: `${binder}, 2 cards, 2 new since your last visit`, exact: true });
    await expect(spine).toBeVisible();

    // Fresh Pulls is the card added straight in, never the one moved in. Each tile is a
    // link named by the card's full listing title (the player, then the number).
    const pulls = page.getByRole("region", { name: "Fresh Pulls" });
    await expect(pulls).toBeVisible();
    const tile = (c: typeof card) =>
      pulls.getByRole("link", {
        name: new RegExp(`^2024 Topps Chrome (?=.*${escapeRegExp(c.player)})(?=.*#${escapeRegExp(c.number)}\\b)`),
      });
    await expect(tile(added).first()).toBeVisible();
    await expect(tile(card)).toHaveCount(0);
    await expectAccessible(page, { label: "Dashboard, cards filed since the last visit" });

    // A pull opens its card panel over the dashboard (a Back step), its copy in the binder listed there;
    // Back closes it with the keyboard on the pull.
    await tile(added).first().click();
    await expect(page).toHaveURL(/\/dashboard\?detail=[^&]+$/);
    await expect(addedDrawer).toBeVisible();
    await expect(addedCopies.getByRole("button", { name: `Edit ${added.short}, Raw, Excellent`, exact: true })).toBeVisible();
    await page.goBack();
    await expect(addedDrawer).toBeHidden();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(tile(added).first()).toBeFocused();

    // --- Cleanup through the UI: remove the copy, delete the empty binder ---
    await page.goto("/collection?tab=checklists");
    const again = await drillToCollectorBase(page);
    await again.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    await again.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    await yourCopies.getByRole("button", { name: `Remove ${card.short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await again.getByRole("button", { name: `Details for ${added.short}`, exact: true }).click();
    await addedCopies.getByRole("button", { name: `Remove ${added.short}, Raw, Excellent`, exact: true }).click();
    await expect(addedCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await addedDrawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(addedDrawer).toBeHidden();

    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "My Binders", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=binders/);
    await shelf.getByRole("button", { name: `${binder}, 0 cards`, exact: true }).click();
    await page.getByRole("button", { name: "Binder settings", exact: true }).click();
    await page.getByRole("button", { name: `Rename or delete ${binder}`, exact: true }).click();
    await page
      .getByRole("dialog", { name: `Rename or delete ${binder}`, exact: true })
      .getByRole("button", { name: "Delete this binder" })
      .click();
    const confirm = page.getByRole("dialog", { name: `Delete ${binder}?`, exact: true });
    await confirm.getByRole("button", { name: "Yes, delete it" }).click();
    await expect(confirm).toBeHidden();
    await expect(shelf.getByRole("button", { name: new RegExp(`^${escapeRegExp(binder)},`) })).toHaveCount(0);
  },
);
