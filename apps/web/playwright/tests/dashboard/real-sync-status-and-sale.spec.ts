// R1: the sync status stands at the top of the signed-in dashboard while
// cards wait for the next sync or a set's latest sync failed (NEO-464 review
// round 4, Jason: "only show errors that have not had a successful sync of
// that card/set later. Also show pending syncs there"), and an order waiting
// to ship puts Out the Door up. Clear them and both are gone.
//
// Neither can be made on demand from a marketplace (a sale arrives from an
// order poll, a sync problem from a real sync), so the spec seeds NB's own
// records of them with /testing/seed-dashboard (`seedMyTestSale`,
// `seedMyTestSync`, `clearMyTestDashboardSeeds`: the caller's own rows only,
// refused off testing deployments; the sale on a marketplace NB neither lists
// on nor polls for this account, the sync records on every listing
// marketplace, a waiting card only where NB does not list them). No
// marketplace is called.
//
// R7/R7a: writes only the signed-in user's own rows: a box and one copy in it
// on one card of the seed's 2024 Topps Chrome Base (registered in
// SET-REGISTRY.md), and the marked test rows the seeds write. Self-cleaning:
// the seeds are cleared, the copy removed and the box deleted through the UI.
// The box's name is a single token minted from `env.ATTEMPT_TOKEN`.
import { createBox, deleteOpenBox, drillToCollectorBase, inventoryTabs, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The seeded failure, as the dashboard says it. */
const TEST_FAILURE = "(Test) The marketplace didn't answer, so this set didn't sync. NB tries again on the next sync.";

test(
  "Dashboard: cards waiting to sync and a failed sync stand at the top, an order puts Out the Door up, and clearing them takes both away",
  { tag: ["@dashboard"] },
  async ({ page, signIn, env }) => {
    const box = `Synced${env.ATTEMPT_TOKEN}`;
    const greeting = page.getByRole("heading", { level: 1, name: "Welcome back, slugger." });

    // --- A box with one card in it: what the seeds hang on -------------------
    // Any seeds a broken earlier run left are cleared first (the page then forwards to the dashboard).
    await signIn("/testing/seed-dashboard?clear=1");
    await expect(greeting).toBeVisible({ timeout: LAUNCH_GATE });
    await page.goto("/inventory?tab=boxes");
    await expect(page.getByRole("list", { name: "Your boxes" })).toBeVisible();
    await createBox(page, box);
    await page.goto("/inventory?tab=checklists");
    await expect(inventoryTabs(page).getByRole("link", { name: "Checklists", exact: true })).toHaveAttribute("aria-current", "page");
    const stock = await drillToCollectorBase(page);
    // The fourth ordinary row: the other dashboard specs on this account use the first three.
    const row = ordinaryBaseRows(stock).nth(3);
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
    await addForm.getByRole("spinbutton", { name: "Price", exact: true }).fill("2");
    await addForm.getByRole("button", { name: "Add to inventory" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${card.short}, Raw, Excellent` })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- Seed a sale, a card waiting to sync and a failed sync, then the dashboard ---
    await page.goto("/testing/seed-dashboard?sale=1&syncPending=1&syncError=1");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(greeting).toBeVisible();

    const sync = page.getByRole("region", { name: "Sync status" });
    await expect(sync).toBeVisible();
    await expect(sync.getByText(/^\d+\+? cards? waiting for the next sync\.$/).first()).toBeVisible();
    // The failed set names its marketplace for a reader. The seed writes one on every listing marketplace
    // (this account has no eBay sync record of its own for the set to hold eBay's back), so eBay's stands there.
    const ebaySet = sync.getByRole("article").filter({ has: page.getByRole("heading", { level: 3, name: / on eBay$/ }) });
    await expect(ebaySet.getByText(TEST_FAILURE)).toBeVisible();
    // It stands at the top: above Out the Door, which the order put up.
    const outTheDoor = page.getByRole("region", { name: "Out the Door" });
    await expect(outTheDoor.getByRole("heading", { level: 3, name: / order #TEST-[0-9A-F]+$/ })).toBeVisible();
    const [syncBox, doorBox] = [await sync.boundingBox(), await outTheDoor.boundingBox()];
    expect(syncBox!.y).toBeLessThan(doorBox!.y);
    await expectAccessible(page, { label: "Dashboard, sync status and an order to ship" });

    // Held-back cards lead the set: this card, with its reason, comes before the failure sentence.
    const heldBack = ebaySet
      .getByRole("link", { name: /No price yet\./ })
      .filter({ hasText: card.player })
      .filter({ hasText: `#${card.number}` });
    await expect(heldBack).toBeVisible();
    const [cardBox, failureBox] = [await heldBack.boundingBox(), await ebaySet.getByText(TEST_FAILURE).boundingBox()];
    expect(cardBox!.y).toBeLessThan(failureBox!.y);

    // A real move: the held-back card opens its own card panel on Inventory, where its price is fixed;
    // Back returns to the dashboard.
    await heldBack.click();
    await expect(page).toHaveURL(/\/inventory\?tab=cards&detail=[^&]+$/);
    await expect(drawer).toBeVisible();
    await yourCopies.getByRole("button", { name: `Edit ${card.short}, Raw, Excellent`, exact: true }).click();
    await expect(drawer.getByRole("spinbutton", { name: "Price", exact: true })).toBeVisible();
    await page.goBack();
    await expect(greeting).toBeVisible();
    await sync.getByRole("link", { name: "Open Sync status", exact: true }).click();
    await expect(page).toHaveURL(/\/inventory\?tab=sync$/);

    // On Sync status too, every held-back card is a way to its fix (so cards past what the dashboard
    // names are reachable): the row, its reason beside it, opens the card's panel; Back returns here.
    const ebayStatus = page.getByRole("region", { name: "eBay", exact: true });
    const statusRow = ebayStatus.getByRole("link", {
      name: new RegExp(`^#${escapeRegExp(card.number)} ${escapeRegExp(card.player)} .*price`, "i"),
    });
    await expect(statusRow).toBeVisible();
    await expectAccessible(page, { label: "Inventory Sync status, held-back cards as links" });
    await statusRow.click();
    await expect(page).toHaveURL(/\/inventory\?tab=cards&detail=[^&]+$/);
    await expect(drawer).toBeVisible();
    await expect(yourCopies.getByRole("button", { name: `Edit ${card.short}, Raw, Excellent`, exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/inventory\?tab=sync$/);
    await expect(statusRow).toBeVisible();

    // --- Clear the seeds: the order and the sync problems are gone -----------
    await page.goto("/testing/seed-dashboard?clear=1");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(greeting).toBeVisible();
    await expect(page.getByText(TEST_FAILURE)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 3, name: / order #TEST-[0-9A-F]+$/ })).toHaveCount(0);

    // --- Cleanup through the UI: remove the copy, delete the empty box -------
    await page.goto("/inventory?tab=checklists");
    const again = await drillToCollectorBase(page);
    await again.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    await yourCopies.getByRole("button", { name: `Remove ${card.short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await page.goto("/inventory?tab=boxes");
    await page.getByRole("list", { name: "Your boxes" }).getByLabel(new RegExp(`^${escapeRegExp(box)}, box, `)).click();
    await deleteOpenBox(page, box);
    await expect(page.getByRole("list", { name: "Your boxes" }).getByLabel(new RegExp(`^${escapeRegExp(box)}, box, `))).toHaveCount(0);
  },
);
