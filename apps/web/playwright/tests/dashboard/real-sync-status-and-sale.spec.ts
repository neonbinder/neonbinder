// R1: the sync status stands at the top of the signed-in dashboard while
// cards wait for the next sync or a set's latest sync failed (NEO-464 review
// round 4, Jason: "only show errors that have not had a successful sync of
// that card/set later. Also show pending syncs there"), and an order waiting
// to ship puts Out the Door up. A held-back card opens its card panel over
// the dashboard, where its price is fixed (and undone). A set whose failed sync
// a later sync put right is not there any more ("only show errors that have not
// had a successful sync of that card/set later"), the waiting cards still are.
// Clear the seeds and both are gone.
//
// Neither can be made on demand from a marketplace (a sale arrives from an
// order poll, a sync problem from a real sync), so the spec seeds NB's own
// records of them with /testing/seed-dashboard (`seedMyTestSale`,
// `seedMyTestSync`, `clearMyTestDashboardSeeds`: the caller's own rows only,
// refused off testing deployments; the sale on a marketplace NB neither lists
// on nor polls for this account, the sync records on every listing
// marketplace, a waiting card only for a boxed card and only where NB
// does not list them). Nothing seeded makes NB call a marketplace: the order
// poll leaves a seeded order out, and a seeded failed set claims no success.
// The recovered set (`syncRecovered=1`) is the same record after the later clean
// sync: one record per set and marketplace, so the later run replaces the failed one.
//
// R7/R7a: writes only the signed-in user's own rows: a box and one copy in it
// on one card of the seed's 2024 Topps Chrome Base (registered in
// SET-REGISTRY.md), and the marked test rows the seeds write. Self-cleaning:
// the seeds are cleared, the copy removed and the box deleted through the UI,
// and an afterEach does the same on a failure (clear first: a seed left behind
// would show on this account's dashboard to every spec that follows). The box's
// name is a single token minted from `env.ATTEMPT_TOKEN`.
import { createBox, deleteBoxNamed, deleteOpenBox, drillToCollectorBase, inventoryTabs, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import type { Page } from "@playwright/test";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The seeded failure, as the dashboard says it. */
const TEST_FAILURE = "(Test) The marketplace didn't answer, so this set didn't sync. NB tries again on the next sync.";

/** What the body has written so far, so the failure hook can take it back. */
const written: { box?: string; card?: { short: string; number: string; player: string } } = {};

/** The card's panel, by its title ("2024 Topps Chrome #<number> <player>..."). */
const drawerOf = (page: Page, card: { number: string; player: string }) =>
  page.getByRole("dialog", { name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}`) });

// A failed run must not leave its seeds on this account's dashboard (the next spec on this worker would
// meet a sync problem and an order it never made), nor its copy and box. Each step runs even when an
// earlier one fails, and the first failure is rethrown at the end.
test.afterEach(async ({ context }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const clean = await context.newPage();
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    await attempt(async () => {
      await clean.goto("/testing/seed-dashboard?clear=1");
      await expect(clean).toHaveURL(/\/dashboard$/);
      await expect(clean.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
    });
    const { card, box } = written;
    if (card) {
      await attempt(async () => {
        await clean.goto("/inventory?tab=checklists");
        const stock = await drillToCollectorBase(clean);
        const drawer = drawerOf(clean, card);
        await stock.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
        const yourCopies = drawer.getByRole("region", { name: `Your copies of ${card.short}`, exact: true });
        const none = yourCopies.getByText("None yet. Fill in what you know below and add it.");
        const remove = yourCopies.getByRole("button", { name: `Remove ${card.short}, Raw, Excellent`, exact: true });
        // The body added one copy, or died before it did: the panel settles on one of the two.
        await expect(none.or(remove)).toBeVisible();
        if (await remove.isVisible()) {
          await remove.click();
          await expect(none).toBeVisible();
        }
        await drawer.getByRole("button", { name: "Close card detail" }).click();
        await expect(drawer).toBeHidden();
      });
    }
    if (box) await attempt(() => deleteBoxNamed(clean, box));
  } finally {
    await clean.close();
    written.box = undefined;
    written.card = undefined;
  }
  if (failures.length > 0) throw failures[0];
});

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
    written.box = box;
    await page.goto("/inventory?tab=checklists");
    await expect(inventoryTabs(page).getByRole("link", { name: "Checklists", exact: true })).toHaveAttribute("aria-current", "page");
    const stock = await drillToCollectorBase(page);
    // The fourth ordinary row: the other dashboard specs on this account use the first three.
    const row = ordinaryBaseRows(stock).nth(3);
    await expect(row).toBeVisible();
    const card = await shortNameOf(row);
    written.card = card;
    const drawer = drawerOf(page, card);
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

    // The held-back card opens its own card panel OVER the dashboard (a Back step), carrying why it was
    // held back: the panel says so above Your copies and opens the box copy's Edit form with the keyboard
    // on its Price, the fix. The price saved there shows at once on New Listings under it; Back closes the
    // panel with the keyboard on the card, and the status line's Undo still takes the price back.
    await heldBack.click();
    await expect(page).toHaveURL(/\/dashboard\?detail=[^&]+&side=inventory&held=ebay\.noPrice$/);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText(/^Held back from eBay: no price yet\./)).toBeVisible();
    const editForm = drawer.getByRole("form", { name: "Edit Raw, Excellent", exact: true });
    const price = editForm.getByRole("spinbutton", { name: "Price", exact: true });
    await expect(price).toBeFocused();
    await expectAccessible(page, { label: "Dashboard, a held-back card's panel open over it" });
    await price.fill("4");
    await editForm.getByRole("button", { name: "Save copy" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Saved ${card.short}` })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(drawer).toBeHidden();
    await expect(heldBack).toBeFocused();
    const listing = page
      .getByRole("region", { name: "New Listings" })
      .getByRole("link")
      .filter({ hasText: card.player })
      .filter({ hasText: `#${card.number}` });
    await expect(listing).toContainText("$4.00");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Undone." })).toBeVisible();
    await expect(listing).toContainText("$2.00");
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

    // --- A later sync puts the set right: it is not on the dashboard any more ---
    // (Jason: only errors "that have not had a successful sync of that card/set later".) The seed
    // records the later clean sync on the same set, which replaces the failed record; the cards
    // still waiting for the next sync and the order to ship are not that set's, so they stay.
    await page.goto("/testing/seed-dashboard?syncRecovered=1");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(greeting).toBeVisible();
    await expect(sync).toBeVisible();
    await expect(sync.getByText(/^\d+\+? cards? waiting for the next sync\.$/).first()).toBeVisible();
    await expect(outTheDoor.getByRole("heading", { level: 3, name: / order #TEST-[0-9A-F]+$/ })).toBeVisible();
    await expect(sync.getByRole("article")).toHaveCount(0);
    await expect(page.getByText(TEST_FAILURE)).toHaveCount(0);
    await expect(sync.getByRole("link", { name: /No price yet\./ })).toHaveCount(0);
    await expectAccessible(page, { label: "Dashboard, the sync status once a failed set has recovered" });

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
