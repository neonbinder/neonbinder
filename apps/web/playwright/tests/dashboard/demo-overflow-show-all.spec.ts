// R1: every run the dashboard folds behind a "Show all N" opens in place and folds back
// (NEO-464): New Listings, a set's held-back cards on Sync status, and a Fresh Pulls batch. A
// card behind the fold is a real card: it opens its card panel, and the panel's Next card
// steps into the hidden run even while it is folded. The public demo's fake collector has
// more of each than the dashboard shows at first (15 new listings, 8 held back in one set, a
// 34-card batch), so every fold is there to press. Signed out, fake data, read-only (R7).
// The folding itself is a disclosure kept on the address (`open=`) that replaces the entry:
// opening a panel from it and Back come home with it still open. The expanded states and the
// panels they open are checked for accessibility, since that is where a keyboard or
// screen-reader user spends their time (a folded page is checked by the one-screen spec).
import { test, expect, expectAccessible } from "../../support/fixtures";

test(
  "Dashboard demo: Show all opens the new listings, held-back cards and pulls behind each fold, and Show fewer folds them back",
  { tag: ["@smoke", "@dashboard"] },
  async ({ page }) => {
    // Signed out: every test starts in a fresh browser context (R4).
    await page.goto("/demo");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
    const panel = page.getByRole("dialog");

    // --- New Listings: six tiles, then all of them ----------------------------------------------------
    const listings = page.getByRole("region", { name: "New Listings" });
    const tiles = listings.getByRole("link");
    const showAll = listings.getByRole("button", { name: /^Show all \d+ new listings$/ });
    await expect(showAll).toBeVisible();
    await expect(showAll).toHaveAttribute("aria-expanded", "false");
    const total = Number(/^Show all (\d+)/.exec((await showAll.textContent()) ?? "")?.[1]);
    expect(total, "more listings than the six shown at first").toBeGreaterThan(6);
    await expect(tiles).toHaveCount(6);

    // Folded, the sixth tile's panel already walks the whole run: Next card steps into the hidden part.
    await tiles.nth(5).click();
    await expect(page).toHaveURL(/\/demo\?(.*&)?detail=[^&]+&side=inventory$/);
    await expect(panel.getByText(new RegExp(`^Card 6 of ${total}\\b`))).toBeVisible();
    const sixth = new URL(page.url()).searchParams.get("detail");
    await panel.getByRole("button", { name: "Next card" }).click();
    await expect(panel.getByText(new RegExp(`^Card 7 of ${total}\\b`))).toBeVisible();
    expect(new URL(page.url()).searchParams.get("detail")).not.toBe(sixth);
    // The listing's panel holds the copies in a box, as the tile it stepped to would say.
    await expect(panel.getByRole("region", { name: /^Your copies of / })).toBeVisible();
    // One Back closes the panel, however far it stepped.
    await page.goBack();
    await expect(panel).toBeHidden();
    await expect(page).toHaveURL(/\/demo$/);
    await expect(tiles).toHaveCount(6);
    await expect(tiles.nth(5)).toBeFocused();

    // Show all: every tile stands, the button flips to Show fewer, and the fold rides on the address.
    await showAll.click();
    const fewer = listings.getByRole("button", { name: "Show fewer new listings", expanded: true });
    await expect(fewer).toBeVisible();
    await expect(tiles).toHaveCount(total);
    await expect(page).toHaveURL(/[?&]open=([^&]*,)?listings(,|&|$)/);
    await expectAccessible(page, { within: listings, label: "Dashboard demo, every new listing showing" });

    // A tile that was behind the fold opens its panel: the last one, with its box in it.
    const last = tiles.last();
    const box = (await last.innerText()).match(/\d+ in (.+)$/m)?.[1];
    expect(box).toBeTruthy();
    await last.click();
    await expect(page).toHaveURL(/[?&]detail=[^&]+&side=inventory$/);
    await expect(panel.getByText(new RegExp(`^Card ${total} of ${total}\\b`))).toBeVisible();
    await expect(panel.getByText(box!, { exact: false }).first()).toBeVisible();
    await expectAccessible(page, { label: "Dashboard demo, a New Listing's card panel open" });
    await page.goBack();
    await expect(panel).toBeHidden();
    // The fold is as it was left: still open, the keyboard on the tile that opened the panel.
    await expect(tiles).toHaveCount(total);
    await expect(tiles.last()).toBeFocused();

    await fewer.click();
    await expect(listings.getByRole("button", { name: `Show all ${total} new listings`, expanded: false })).toBeVisible();
    await expect(tiles).toHaveCount(6);
    await expect(page).not.toHaveURL(/open=/);

    // --- Sync status: a set holds back more cards than it shows ----------------------------------------
    const sync = page.getByRole("region", { name: "Sync status" });
    const finest = sync.getByRole("article", { name: "1993 Topps Finest Base on eBay" });
    const held = finest.getByRole("link", { name: /(No price yet|need a photo)/ });
    const showHeld = finest.getByRole("button", { name: /^Show all \d+ held back in 1993 Topps Finest Base on eBay$/ });
    await expect(showHeld).toBeVisible();
    const heldTotal = Number(/^Show all (\d+)/.exec((await showHeld.textContent()) ?? "")?.[1]);
    expect(heldTotal, "more held-back cards than the six shown at first").toBeGreaterThan(6);
    await expect(held).toHaveCount(6);
    await showHeld.click();
    await expect(finest.getByRole("button", { name: /^Show fewer held back in 1993 Topps Finest Base on eBay$/, expanded: true })).toBeVisible();
    await expect(held).toHaveCount(heldTotal);
    await expectAccessible(page, { within: finest, label: "Dashboard demo, every held-back card of a set showing" });

    // A card past the fold opens its panel on the reason it was held back (its own, set by the demo's data), with the keyboard on the fix.
    const revealed = held.nth(6);
    await expect(revealed).toContainText("No price yet.");
    await revealed.click();
    await expect(page).toHaveURL(/\/demo\?(.*&)?detail=[^&]+&side=inventory&held=ebay\.noPrice$/);
    await expect(panel.getByText(/^Held back from eBay: no price yet\./)).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "Price", exact: true }).or(panel.getByRole("spinbutton", { name: "Price", exact: true }))).toBeFocused();
    await expectAccessible(page, { label: "Dashboard demo, a revealed held-back card's panel open" });
    // Next card carries the next card's own reason with it (the one after is held for want of a photo).
    await panel.getByRole("button", { name: "Next card" }).click();
    await expect(page).toHaveURL(/[?&]held=ebay\.noPhoto$/);
    await expect(panel.getByText(/^Held back from eBay: /)).not.toContainText("no price yet");
    await page.goBack();
    await expect(panel).toBeHidden();
    await expect(held).toHaveCount(heldTotal);
    await expect(revealed).toBeFocused();

    await finest.getByRole("button", { name: /^Show fewer held back in 1993 Topps Finest Base on eBay$/ }).click();
    await expect(showHeld).toBeVisible();
    await expect(held).toHaveCount(6);

    // --- Fresh Pulls: a 34-card batch, six at first ---------------------------------------------------
    const batch = page.getByRole("region", { name: "Fresh Pulls" }).getByRole("article", { name: /^Tuesday: \d+ cards into \d+ binders$/ });
    const pulls = batch.getByRole("link");
    const showPulls = batch.getByRole("button", { name: /^Show all \d+ cards from Tuesday$/ });
    await expect(showPulls).toBeVisible();
    const pullTotal = Number(/^Show all (\d+)/.exec((await showPulls.textContent()) ?? "")?.[1]);
    expect(pullTotal, "more pulls in the batch than the six shown at first").toBeGreaterThan(6);
    await expect(pulls).toHaveCount(6);
    await showPulls.click();
    await expect(batch.getByRole("button", { name: "Show fewer cards from Tuesday", expanded: true })).toBeVisible();
    await expect(pulls).toHaveCount(pullTotal);
    // A pull that was behind the fold opens its panel as that place in the batch's run.
    await pulls.nth(10).click();
    await expect(page).toHaveURL(/\/demo\?(.*&)?detail=[^&]+$/);
    await expect(panel.getByText(new RegExp(`^Card 11 of ${pullTotal}\\b`))).toBeVisible();
    await page.goBack();
    await expect(panel).toBeHidden();
    await expect(pulls).toHaveCount(pullTotal);
    // The batch's last card is also a New Listing, whose panel was stepped through above. It still
    // opens as the end of THIS run: a card link's own run is the one the panel walks, never the
    // run of the last panel that was open.
    await pulls.last().click();
    await expect(page).toHaveURL(/\/demo\?(.*&)?detail=[^&]+$/);
    await expect(panel.getByText(new RegExp(`^Card ${pullTotal} of ${pullTotal}\\b`))).toBeVisible();
    await page.goBack();
    await expect(panel).toBeHidden();
    await expect(pulls).toHaveCount(pullTotal);
    await batch.getByRole("button", { name: "Show fewer cards from Tuesday" }).click();
    await expect(pulls).toHaveCount(6);
    await expect(showPulls).toBeVisible();
  },
);
