// R1: the dashboard follows a card as it goes up for sale and comes back down (NEO-464).
// A card added to a binder is a Fresh Pull. Sell it into a box, from its panel over the
// dashboard, and the Fresh Pull is gone (a card for sale is not a pull) while a New Listing
// stands with its price and the box it went into, and the box's end on the shelf counts it.
// Take it off sale and the New Listing is gone and the box counts none; the card does not
// come back as a Fresh Pull, since it was moved and not added to the collection.
//
// R7/R7a: writes only the signed-in user's own rows (`collectionContainers`,
// `collectionCopies`) on one card of the seed's 2024 Topps Chrome Base, registered in
// SET-REGISTRY.md; never the set, its cards, players or teams. The fifth ordinary row (the other
// dashboard specs on this account use the first four). Self-cleaning, and on a failure too: an
// afterEach removes the copy and deletes the box through the UI. The box's name is a single token
// minted from `env.ATTEMPT_TOKEN`.
import { backToBoxes, createBox, deleteBoxNamed, drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import type { Page } from "@playwright/test";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Card = { short: string; number: string; player: string };

/** What the body has written so far, so the failure hook can take it back. */
const written: { box?: string; card?: Card } = {};

/** The card's panel, by its title ("2024 Topps Chrome #<number> <player>..."). */
const drawerOf = (page: Page, card: Card) =>
  page.getByRole("dialog", { name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}`) });

/**
 * Takes the card's copy off the account wherever it ended up (every home is listed on the
 * Collection checklist's panel), then deletes the empty box. Idempotent: the panel settles on
 * "None yet" or on the copy's Remove button, and a box already gone is skipped.
 */
async function tidy(page: Page, card: Card, box: string): Promise<void> {
  await page.goto("/collection?tab=checklists");
  const checklist = await drillToCollectorBase(page);
  await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
  const drawer = drawerOf(page, card);
  await checklist.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
  const yourCopies = drawer.getByRole("region", { name: `Your copies of ${card.short}`, exact: true });
  const none = yourCopies.getByText("None yet. Fill in what you know below and add it.");
  const remove = yourCopies.getByRole("button", { name: `Remove ${card.short}, Raw, Excellent`, exact: true });
  await expect(none.or(remove)).toBeVisible();
  if (await remove.isVisible()) {
    await remove.click();
    await expect(none).toBeVisible();
  }
  await drawer.getByRole("button", { name: "Close card detail" }).click();
  await expect(drawer).toBeHidden();
  await deleteBoxNamed(page, box);
}

test.afterEach(async ({ context }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const { card, box } = written;
  if (!card || !box) {
    if (box) {
      const clean = await context.newPage();
      try {
        await deleteBoxNamed(clean, box);
      } finally {
        await clean.close();
      }
    }
    return;
  }
  const clean = await context.newPage();
  try {
    await tidy(clean, card, box);
  } finally {
    await clean.close();
  }
});

test(
  "Dashboard: a card sold from a binder into a box moves from Fresh Pulls to New Listings, and taking it off sale takes it off the dashboard",
  { tag: ["@dashboard"] },
  async ({ page, signIn, env }) => {
    const box = `Sold${env.ATTEMPT_TOKEN}`;
    const greeting = page.getByRole("heading", { level: 1, name: "Welcome back, slugger." });

    // --- An empty box to sell into ---------------------------------------------------------------------
    await signIn("/inventory?tab=boxes");
    await expect(page.getByRole("list", { name: "Your boxes" })).toBeVisible({ timeout: LAUNCH_GATE });
    await createBox(page, box);
    written.box = box;
    await backToBoxes(page);

    // --- One copy added to the collection (Main) ---------------------------------------------------------
    await page.goto("/collection?tab=checklists");
    const checklist = await drillToCollectorBase(page);
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "All" });
    const row = ordinaryBaseRows(checklist).nth(4);
    await expect(row).toBeVisible();
    const card = await shortNameOf(row);
    written.card = card;
    const drawer = drawerOf(page, card);
    await checklist.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${card.short}`, exact: true });
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    await addForm.getByRole("combobox", { name: "Where it lives" }).selectOption({ label: "Main" });
    await addForm.getByRole("button", { name: "Add to collection" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${card.short}, Raw, Excellent` })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- The dashboard: a Fresh Pull, and not a New Listing ------------------------------------------------
    await page.goto("/dashboard");
    await expect(greeting).toBeVisible();
    const named = new RegExp(
      `^2024 Topps Chrome (?=.*${escapeRegExp(card.player)})(?=.*#${escapeRegExp(card.number)}\\b)`,
    );
    const pull = page.getByRole("region", { name: "Fresh Pulls" }).getByRole("link", { name: named });
    const listings = page.getByRole("region", { name: "New Listings" });
    const listing = listings.getByRole("link", { name: new RegExp(`${named.source}.*\\$5\\.00 1 in ${escapeRegExp(box)}$`) });
    const boxEnd = (cards: number) =>
      page.getByRole("list", { name: /^Shelf \d+, boxes$/ }).getByRole("link", {
        name: `${box}, box, ${cards} ${cards === 1 ? "card" : "cards"} for sale`,
        exact: true,
      });
    await expect(pull).toBeVisible();
    await expect(listing).toHaveCount(0);
    await expect(boxEnd(0)).toBeVisible();

    // --- Sell it from its panel over the dashboard: the dashboard under it follows ---------------------------
    await pull.click();
    await expect(page).toHaveURL(/\/dashboard\?detail=[^&]+$/);
    await expect(drawer).toBeVisible();
    await yourCopies.getByRole("button", { name: `Sell ${card.short}, Raw, Excellent`, exact: true }).click();
    const sellForm = yourCopies.getByRole("form", { name: "Sell Raw, Excellent", exact: true });
    await sellForm.getByRole("combobox", { name: "Into which box" }).selectOption({ label: box });
    await sellForm.getByRole("textbox", { name: "Price", exact: true }).fill("5");
    await sellForm.getByRole("button", { name: "Put it up for sale", exact: true }).click();
    await expect(sellForm).toBeHidden();
    await expect(drawer.getByRole("status").filter({ hasText: `${card.short} is up for sale in ${box} at $5.00.` })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(greeting).toBeVisible();

    // A card for sale is not a pull; it is a New Listing with its price and its box, and the box counts it.
    await expect(listing).toBeVisible();
    await expect(pull).toHaveCount(0);
    await expect(boxEnd(1)).toBeVisible();

    // --- Take it off sale from the New Listing's panel: it leaves the dashboard -------------------------------
    await listing.click();
    await expect(page).toHaveURL(/\/dashboard\?detail=[^&]+&side=inventory$/);
    await expect(drawer).toBeVisible();
    await yourCopies.getByRole("button", { name: `Take off sale, ${card.short}, Raw, Excellent`, exact: true }).click();
    const offForm = yourCopies.getByRole("form", { name: /off sale/i });
    await offForm.getByRole("combobox", { name: "Back into" }).selectOption({ label: "Main" });
    await offForm.getByRole("button", { name: "Take it off sale", exact: true }).click();
    await expect(offForm).toBeHidden();
    await expect(drawer.getByRole("status").filter({ hasText: `Took ${card.short} off sale.` })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(greeting).toBeVisible();

    await expect(listing).toHaveCount(0);
    await expect(boxEnd(0)).toBeVisible();
    // It was moved, not added to the collection: it does not come back as a Fresh Pull.
    await expect(pull).toHaveCount(0);

    // --- Cleanup through the UI: remove the copy, delete the empty box ----------------------------------------
    await tidy(page, card, box);
    written.box = undefined;
    written.card = undefined;
  },
);
