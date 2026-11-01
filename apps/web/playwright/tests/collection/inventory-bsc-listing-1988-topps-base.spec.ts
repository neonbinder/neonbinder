// NEO-370 Rev 4 (R1): a collector's boxes reach BuySportsCards when they Sync,
// and a box set to in-person takes them off again. The flow, as the user lives
// it:
//   0. They make their box, then set every OTHER box they have (Unsorted
//      included) to in-person: Start walks every card in a listed box, so
//      stock an earlier spec left on this worker must not reach real BSC.
//   1. Profile -> Credentials (BuySportsCards): the consent warning shows, they
//      press "Start listing on BuySportsCards", and the panel reads that they
//      list since today. Saving a sign-in starts nothing; this is the start.
//   2. They put one copy each of the first two 1988 Topps Base cards in their
//      box, and press the checklist's Sync. Inventory -> Sync status
//      then reads the set synced with 2 listed and nothing held back.
//   3. They turn the box's "Listed on marketplaces" off, Sync again, and the
//      set reads 0 listed, with both cards taken to 0.
//   4. Cleanup (afterEach, pass or fail): the touched BSC rows end at 0, then
//      listing STOPS by removing the worker's BSC sign-in on Profile and
//      saving it again. The account ends connected and NOT listing.
//
// What "2 listed" proves about BSC. The drain reads BSC's seller sheet, plans
// against it, PUTs the rows that differ and READS THEM BACK; a row BSC still
// shows at another quantity becomes a held-back card with a reason. So the end
// state of a sync is two things together: the set's "N listed" count line and
// no "held back" line. The spec never calls BSC and shows no BSC quantity of
// its own (a product gap if a collector should see one).
//
// Waits. The only waits above 7 s are the live BSC round trips (GUIDE hard
// rule 3's live-marketplace exception): `BSC_ROUND_TRIP` on the Sync status
// results and the cleanup's idle wait, and the seed hop's sign-in
// (`SEED_SIGN_IN`) when the sign-in is saved again. No timer and no cron path:
// the 15-minute cron is deliberately not exercised.
//
// Sync's toast. A press that sets a run going toasts "Syncing <title> now.
// Watch it on Sync status."; both presses assert it before reading the result.
//
// R7/R7a. 1988 Topps Baseball is a registered real set (SET-REGISTRY.md): this
// spec is the SOLE writer of its BSC quantities and writes no card, player,
// team or variant of the set. Its NB writes are the signed-in user's own rows
// (the listing start, a minted box, two box copies, the common price, and every
// other box set to in-person, which is left that way). The
// quantities end at 0 on BSC and the sign-in is saved again, on a pass by the
// steps and the hook, on a failure by the hook on a second page (so the
// failure screenshot keeps the page that failed).
//
// Minted box name: a single token from `env.ATTEMPT_TOKEN`.
import type { Locator, Page } from "@playwright/test";
import {
  TOPPS_1988,
  backToBoxes,
  baseChecklistTitle,
  cardsWord,
  createBox,
  deleteOpenBox,
  drillToCollectorBase,
  goViaShell,
  inventoryTabs,
  nameOf,
  quantityField,
} from "../../support/collection";
import { removeBscSignIn, saveBscSignIn } from "../../support/credentials";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

/**
 * GUIDE hard rule 3, the live-marketplace exception: a step that directly
 * drives a live BSC round trip. One Sync starts: BSC login/refresh, up to four
 * condition sheets read (1988 is after the 1980 vintage cutoff), one PUT, one
 * read-back. NOT YET MEASURED (no deployed backend carried the branch when this
 * was written): the first CI run records the figure beside the registry row,
 * and this number comes down to it if it is far above.
 */
const BSC_ROUND_TRIP = 60_000;

const BSC = "BuySportsCards";
const TITLE = baseChecklistTitle(TOPPS_1988);
/** The set as Sync status names it: a Base checklist reads as the set alone. */
const SET_LABEL = `${TOPPS_1988.year} ${TOPPS_1988.set}`;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the failing run needs undone, filled as the flow goes. */
const written: { box?: string; cards?: [string, string]; started?: boolean } = {};

/** The key that leaves a quantity field: Tab on a desktop, Enter on a phone. */
const leaveKey = (isMobile: boolean) => (isMobile ? "Enter" : "Tab");

/** The Sync status tab's BuySportsCards section and this set's "Last sync by set" row. */
function syncStatus(page: Page) {
  const platform = page.getByRole("region", { name: BSC, exact: true });
  const row = platform
    .getByRole("list", { name: "Last sync by set" })
    .getByRole("listitem")
    .filter({ hasText: SET_LABEL });
  return { platform, row };
}

/**
 * On the Inventory Checklists tab with the Adding-to box picked: set both cards'
 * quantities in `box` to 0 (only those not already 0). Returns the checklist.
 * Idempotent, for the tidy-up and for the failure hook.
 */
async function emptyBox(page: Page, box: string, cards: readonly string[], isMobile: boolean): Promise<Locator> {
  const adding = page.getByRole("combobox", { name: "Adding to" });
  await expect(adding).toBeVisible();
  const checklist = await drillToCollectorBase(page, TOPPS_1988);
  await adding.selectOption({ label: box });
  const boxList = checklist.getByRole("list", { name: `Quantities in ${box}` });
  for (const short of cards) {
    const field = quantityField(boxList, short, box);
    await expect(field).toBeVisible();
    if ((await field.inputValue()) !== "0") {
      await field.fill("0");
      await page.keyboard.press(leaveKey(isMobile));
      await expect(field).toHaveValue("0");
      await expect(
        page.getByRole("status").filter({ hasText: new RegExp(`^Pulled \\d+ of ${escapeRegExp(short)} from `) }),
      ).toBeVisible();
    }
  }
  return checklist;
}

// Pass or fail, the worker ends connected to BSC and NOT listing. On a failure
// the touched BSC rows are first brought to 0 on a SECOND page (the failing page
// stays as the screenshot saw it); then listing is stopped, because there is no
// other way to stop it and an account left listing would put any later spec's
// boxed cards up for sale on real BSC. Idempotent: it does only what the run got
// far enough to need.
test.afterEach(async ({ context, isMobile }, testInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  const clean = await context.newPage();
  try {
    try {
      // The cards are NB's zero from here on: quantities 0 in the box, then a
      // full Sync of the set, and the result waited for. A pass already proved it.
      if (failed && written.started && written.box && written.cards) {
        // A run already under way reads the set as it was: let it finish first,
        // so the Sync below is the one that sees the zeros.
        await clean.goto("/inventory?tab=sync");
        await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
        // Live BSC round trip (GUIDE hard rule 3), the same constant as the flow.
        await expect(clean.getByText(/^Nothing syncing right now\./)).toBeVisible({ timeout: BSC_ROUND_TRIP });
        await clean.goto("/inventory?tab=checklists");
        const checklist = await emptyBox(clean, written.box, written.cards, isMobile);
        await checklist.getByRole("button", { name: `Sync ${TITLE}`, exact: true }).click();
        await clean.goto("/inventory?tab=sync");
        // Live BSC round trip, as above.
        await expect(syncStatus(clean).row.getByText(/^0 listed/)).toBeVisible({ timeout: BSC_ROUND_TRIP });
      }
    } finally {
      // STOP listing: remove the sign-in (it also clears the start), then save
      // it again so the worker keeps its credentials (R7).
      try {
        await removeBscSignIn(clean, LAUNCH_GATE);
      } finally {
        await saveBscSignIn(clean);
        const listing = clean.getByRole("region", { name: `Listing on ${BSC}`, exact: true });
        await expect(listing.getByRole("button", { name: `Start listing on ${BSC}`, exact: true })).toBeVisible();
        await expect(clean.getByText(/^Listing your boxes on /)).toBeHidden();
      }
    }
  } finally {
    await clean.close();
  }
});

test(
  "Inventory: Sync lists a box's 1988 Topps Base cards on BuySportsCards and an in-person box takes them off",
  { tag: ["@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    // The hook's record of how far this run got starts empty.
    written.box = undefined;
    written.cards = undefined;
    written.started = false;
    const boxName = `Bsc${env.ATTEMPT_TOKEN}`;
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const tabs = inventoryTabs(page);
    const boxes = page.getByRole("list", { name: "Your boxes" });
    const boxSpine = (cards: number) =>
      boxes.getByRole("button", { name: `${boxName}, box, ${cardsWord(cards)} for sale`, exact: true });

    // --- 0. A box to stock, and every other box in-person BEFORE Start -----------
    await signIn("/inventory?tab=boxes");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    await createBox(page, boxName);
    written.box = boxName;
    await backToBoxes(page);
    // The shelf has settled once the new box shows on it.
    await expect(boxSpine(0)).toBeVisible();

    // Every other box the worker has: the boxes on the shelf and Unsorted in
    // "Special places" (the Up for Trade pile is not a box that lists). Names
    // are read first, then each box is opened and its "Listed on marketplaces"
    // turned off (a box starts on); each ends unchecked, asserted. They are left
    // in-person afterwards: putting them back would queue their cards.
    const special = page.getByRole("list", { name: "Special places" });
    const spineRe = /^(.+), box, (?!.*up for trade)/;
    const spines = boxes.getByRole("button", { name: spineRe }).or(special.getByRole("button", { name: spineRe }));
    const others: string[] = [];
    for (let i = 0, n = await spines.count(); i < n; i++) {
      const name = await nameOf(spines.nth(i));
      if (!name.startsWith(`${boxName}, box, `)) others.push(name);
    }
    for (const spineName of others) {
      const box = spineRe.exec(spineName)![1];
      await boxes.getByRole("button", { name: spineName, exact: true }).or(special.getByRole("button", { name: spineName, exact: true })).click();
      await expect(page).toHaveURL(/[?&]b=[^&]+/);
      const toggle = page.getByRole("checkbox", { name: "Listed on marketplaces", exact: true });
      await expect(toggle).toBeVisible();
      if (await toggle.isChecked()) {
        await toggle.uncheck();
        await expect(said(`${box} is in-person only now.`)).toBeVisible();
      }
      await expect(toggle).not.toBeChecked();
      await backToBoxes(page);
    }

    // --- 1. Profile: the consent warning, then Start --------------------------
    // A full page load, so the launch gate (cold app + Clerk handshake) applies.
    await page.goto("/profile/credentials");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    // A sign-in saved by the bootstrap: connected, and (saving starts nothing) not listing.
    await expect(page.getByText(`Connected to ${BSC}`)).toBeVisible();
    const listing = page.getByRole("region", { name: `Listing on ${BSC}`, exact: true });
    await expect(listing).toBeVisible();
    const start = listing.getByRole("button", { name: `Start listing on ${BSC}`, exact: true });
    await expect(start).toBeVisible();
    await expect(listing.getByText(/Heads up before you start/)).toBeVisible();
    await expect(listing.getByText(new RegExp(`Starting sets every card you already list on ${BSC}.*goes to 0\\.`, "s"))).toBeVisible();
    await expect(listing.getByText(/^Listing your boxes on /)).toBeHidden();
    await expectAccessible(page, { label: "Profile, BuySportsCards credentials, consent warning" });

    written.started = true;
    await start.click();
    await expect(listing.getByRole("status")).toHaveText(new RegExp(`^You're live on ${BSC}\\.`));
    await expect(listing.getByText(new RegExp(`^Listing your boxes on ${BSC} since .+\\.$`))).toBeVisible();
    await expect(start).toBeHidden();
    await expectAccessible(page, { label: "Profile, BuySportsCards credentials, listing since" });

    // --- Inventory: Sales has no switch ----------------------------------------
    await goViaShell(page, isMobile, "Inventory");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await tabs.getByRole("link", { name: "Sales", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sales/);
    await expect(page.getByRole("heading", { level: 2, name: "What sold" })).toBeVisible();
    // Listing is not a switch any more: it is the Profile's Start and the boxes.
    await expect(page.getByRole("switch", { name: /^List on / })).toHaveCount(0);

    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    await expect(boxSpine(0)).toBeVisible();

    // --- The 1988 Topps Base checklist, adding to the box ----------------------
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const adding = page.getByRole("combobox", { name: "Adding to" });
    await expect(adding).toBeVisible();
    const checklist = await drillToCollectorBase(page, TOPPS_1988);
    await adding.selectOption({ label: boxName });
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
    const boxList = checklist.getByRole("list", { name: `Quantities in ${boxName}` });
    await expect(boxList.getByRole("textbox").nth(1)).toBeVisible();
    // The checklist carries Sync and no listing status or switch.
    const sync = checklist.getByRole("button", { name: `Sync ${TITLE}`, exact: true });
    await expect(sync).toBeVisible();
    await expect(checklist.getByRole("switch", { name: /^List on / })).toHaveCount(0);
    await expect(checklist.getByRole("group", { name: `${BSC} listing` })).toBeHidden();

    // --- A common price: the rows have no price of their own -------------------
    await checklist.getByRole("button", { name: `Set a common price for ${TITLE}`, exact: true }).click();
    const priceField = checklist.getByRole("textbox", { name: "Common price", exact: true });
    await expect(priceField).toBeFocused();
    await priceField.fill("0.25");
    await page.keyboard.press("Enter");
    await expect(said(`Common price for ${TITLE} is $0.25`)).toBeVisible();
    await expect(checklist.getByText("$0.25", { exact: true })).toBeVisible();

    // --- Two fixed cards: the first two rows of the checklist ------------------
    const shortOf = async (n: number) => {
      const name = await nameOf(boxList.getByRole("textbox").nth(n));
      const m = new RegExp(`^Quantity of (.+) in ${escapeRegExp(boxName)}$`).exec(name);
      expect(m, `a quantity field named "Quantity of <card> in ${boxName}" (read: ${name})`).not.toBeNull();
      return m![1];
    };
    const a = await shortOf(0);
    const b = await shortOf(1);
    expect(a, "two different cards").not.toBe(b);
    written.cards = [a, b];
    const fieldA = quantityField(boxList, a, boxName);
    const fieldB = quantityField(boxList, b, boxName);
    await expect(fieldA).toHaveValue("0");
    await expect(fieldB).toHaveValue("0");

    // --- One copy of each into the box ----------------------------------------
    await fieldA.fill("1");
    await page.keyboard.press(leaveKey(isMobile));
    await expect(fieldB).toBeFocused();
    await fieldB.fill("1");
    await page.keyboard.press(leaveKey(isMobile));
    const rowOf = (short: string) =>
      boxList
        .getByRole("listitem")
        .filter({ has: page.getByRole("textbox", { name: `Quantity of ${short} in ${boxName}`, exact: true }) });
    await expect(rowOf(a).getByText("Saved")).toBeVisible();
    await expect(rowOf(b).getByText("Saved")).toBeVisible();
    await expect(said(new RegExp(`^Boxed 1 more of ${escapeRegExp(b)}\\.`))).toBeVisible();

    // --- 2. Sync: BSC takes both, Sync status says 2 listed --------------------
    await sync.click();
    await expect(said(`Syncing ${TITLE} now. Watch it on Sync status.`)).toBeVisible();
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    await expect(tabs.getByRole("link", { name: "Sync status", exact: true })).toHaveAttribute("aria-current", "page");
    const { platform, row } = syncStatus(page);
    await expect(platform.getByRole("heading", { level: 2, name: BSC, exact: true })).toBeVisible();
    await expect(platform.getByText("Listing", { exact: true })).toBeVisible();
    // Live BSC round trip (BSC_ROUND_TRIP above). The line is the drain's own
    // count: 2 rows on BSC show NB's stock after the read-back (2 updated, or
    // none when BSC already showed them); "skipped" would be a held-back card.
    await expect(row.getByText(/^2 listed(, 2 updated)?$/)).toBeVisible({ timeout: BSC_ROUND_TRIP });
    await expect(row.getByText(/^Synced /)).toBeVisible();
    await expect(row.getByText(/held back/)).toHaveCount(0);
    await expectAccessible(page, { label: "Inventory Sync status, 2 listed" });

    // Back steps to the checklist the Sync was pressed on, quantities as left.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await expect(fieldA).toHaveValue("1");
    await expect(fieldB).toHaveValue("1");

    // --- 3. The box goes in-person: Sync takes both off BSC --------------------
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    await expect(boxSpine(2)).toBeVisible();
    await boxSpine(2).click();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    const listed = page.getByRole("checkbox", { name: "Listed on marketplaces", exact: true });
    // On by default.
    await expect(listed).toBeChecked();
    await expect(page.getByText("Everything in this box lists on the marketplaces you sell on.")).toBeVisible();
    await expectAccessible(page, { label: "My Boxes, box listed on marketplaces" });
    await listed.uncheck();
    await expect(said(`${boxName} is in-person only now.`)).toBeVisible();
    await expect(listed).not.toBeChecked();
    await expect(page.getByText(/^In-person only\. Nothing in this box lists online/)).toBeVisible();
    await expectAccessible(page, { label: "My Boxes, box in-person only" });

    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await drillToCollectorBase(page, TOPPS_1988);
    await checklist.getByRole("button", { name: `Sync ${TITLE}`, exact: true }).click();
    await expect(said(`Syncing ${TITLE} now. Watch it on Sync status.`)).toBeVisible();
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    // Live BSC round trip (BSC_ROUND_TRIP above): the set was 2 listed a minute ago.
    await expect(row.getByText(/^0 listed(, \d+ updated)?, 2 taken to 0$/)).toBeVisible({ timeout: BSC_ROUND_TRIP });
    await expect(row.getByText(/held back/)).toHaveCount(0);

    // --- Tidy up through the product: the box's cards, the common price, the box
    // Zero before deleting, so no copy falls into the Unsorted box (a listed one).
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await emptyBox(page, boxName, [a, b], isMobile);
    await checklist.getByRole("button", { name: `Change the common price for ${TITLE}`, exact: true }).click();
    await expect(priceField).toHaveValue("0.25");
    await priceField.fill("");
    await page.keyboard.press("Enter");
    await expect(said(`Cleared the common price for ${TITLE}`)).toBeVisible();

    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(boxSpine(0)).toBeVisible();
    await boxSpine(0).click();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    await deleteOpenBox(page, boxName);
    await expect(boxes.getByRole("button", { name: new RegExp(`^${escapeRegExp(boxName)},`) })).toHaveCount(0);
    written.box = undefined;
    // The hook now stops listing: the sign-in is removed and saved again.
  },
);
