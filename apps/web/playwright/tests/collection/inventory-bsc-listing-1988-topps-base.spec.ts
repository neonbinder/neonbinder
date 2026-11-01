// NEO-370 Rev 4 (R1): a collector's boxes reach BuySportsCards when they Sync,
// and a box set to in-person takes them off again. The flow, as the user lives
// it:
//   0. They name themselves on the public profile (Admin names a collector by
//      it), make their box, then set every OTHER box they have (Unsorted
//      included) to in-person: saving a sign-in walks every card in a listed
//      box, so stock an earlier spec left on this worker must not reach real
//      BSC.
//   1. Not syncing yet (the bootstrap's seed marks the sign-in "not syncing"):
//      the checklist's Sync is inert with its reason, Sync status and Profile
//      both say "Not syncing".
//   2. Rev 5: "if you have credentials you are syncing". They remove the BSC
//      sign-in, and the form shows the consent warning before Connect. They
//      start syncing the way a save does (the seed hop with listing=on) and
//      Profile reads "Listing your boxes on BuySportsCards since ...".
//   2b. The listing gate (price before stocking): with no common price the
//      listed box is held. The checklist says why and the + for a card is off,
//      and photo intake holds its drop zone with the same reason and a "Set a
//      Min price" button (nothing is uploaded). Setting the common price lifts
//      the checklist's hold.
//   3. They put one copy each of the first two 1988 Topps Base cards in their
//      box; Sync status queues the two cards; they press the checklist's Sync,
//      follow "See what's syncing" to Sync status (Back returns), and Sync
//      status reads the set synced with 2 listed, nothing held back.
//      Admin -> Sync Status shows the same set for this collector, read-only.
//   4. They turn the box's "Listed on marketplaces" off, Sync again, and the
//      set reads 0 listed, with both cards taken to 0.
//   5. They stop: the BSC sign-in is removed and saved again WITHOUT listing=on
//      and Profile reads "Not syncing." again. The afterEach does the same on a
//      failure (after first zeroing the touched rows). The account ends
//      connected and NOT syncing.
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
// (the sign-in removed and saved again, a minted box, two box copies, the common price, and every
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
 * read-back. Measured on CI (desktop, 2026-11-01): 9.9 s to "2 listed" and
 * 9.4 s to "2 taken to 0"; the ceiling is about twice that (see the registry row).
 */
const BSC_ROUND_TRIP = 20_000;

const BSC = "BuySportsCards";
const TITLE = baseChecklistTitle(TOPPS_1988);
/** The set as Sync status names it: a Base checklist reads as the set alone. */
const SET_LABEL = `${TOPPS_1988.year} ${TOPPS_1988.set}`;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the failing run needs undone, filled as the flow goes. */
const written: { box?: string; cards?: [string, string]; started?: boolean; removed?: boolean; stopped?: boolean } = {};

/** The key that leaves a quantity field: Tab on a desktop, Enter on a phone. */
const leaveKey = (isMobile: boolean) => (isMobile ? "Enter" : "Tab");

/** What the checklist's inert Sync says when no marketplace sign-in is syncing. */
const NOT_LISTING_LINE = "Nothing to sync to yet. Save a marketplace sign-in on your Profile.";
/** The consent warning beside Connect on the sign-in form (lib/marketplace/listing-copy.ts). */
const CONSENT_HEADING = "Heads up: connecting starts listing";

/** The Sync status screen's BuySportsCards section and this set's "Last sync by set" row, in `scope` (the page, or an admin's collector). */
function syncStatus(scope: Page | Locator) {
  const platform = scope.getByRole("region", { name: BSC, exact: true });
  const row = platform
    .getByRole("list", { name: "Last sync by set" })
    .getByRole("listitem")
    .filter({ hasText: SET_LABEL });
  return { platform, row };
}

/** Profile -> Credentials' "Listing on BuySportsCards" section. */
function listingSection(page: Page) {
  return page.getByRole("region", { name: `Listing on ${BSC}`, exact: true });
}

/**
 * STOP listing (Rev 5: a saved sign-in syncs, so removing it is the stop):
 * remove the worker's sign-in (it also drops the queue), then save it again
 * through the seed hop WITHOUT `listing=on`, so the worker keeps its
 * credentials (R7) but is "Not syncing." The page is signed in already. An
 * account left syncing would put any later spec's boxed cards up for sale on
 * real BSC. `alreadyRemoved`: the sign-in is already gone (the body removed it
 * and failed before saving it again).
 */
async function stopListing(page: Page, alreadyRemoved = false): Promise<void> {
  try {
    if (!alreadyRemoved) {
      await removeBscSignIn(page, LAUNCH_GATE);
      // No sign-in, nothing syncing to describe: the section is gone (the form is up, see the helper).
      await expect(listingSection(page)).toBeHidden();
    }
  } finally {
    await saveBscSignIn(page);
    await expect(listingSection(page).getByRole("status")).toHaveText("Not syncing.");
    await expect(page.getByText(/^Listing your boxes on /)).toBeHidden();
  }
}

/**
 * On the Inventory Checklists tab with the Adding-to box picked: set both cards'
 * quantities in `box` to 0 (only those not already 0). Returns the checklist.
 * Idempotent, for the tidy-up and for the failure hook.
 *
 * `arrival` says how the tab was reached. The Checklists tab link reopens the
 * checklist last open on the same page ("Checklists opens where you left it"),
 * so after a tab change within the page it is already open ("reopened"); a
 * fresh page load starts at the cascade ("fresh") and drills.
 */
async function emptyBox(
  page: Page,
  box: string,
  cards: readonly string[],
  isMobile: boolean,
  arrival: "fresh" | "reopened",
): Promise<Locator> {
  const adding = page.getByRole("combobox", { name: "Adding to" });
  await expect(adding).toBeVisible();
  let checklist: Locator;
  if (arrival === "fresh") {
    checklist = await drillToCollectorBase(page, TOPPS_1988);
  } else {
    checklist = page.getByRole("region", { name: TITLE });
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
  }
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
        const checklist = await emptyBox(clean, written.box, written.cards, isMobile, "fresh");
        await checklist.getByRole("button", { name: `Sync ${TITLE}`, exact: true }).click();
        await clean.goto("/inventory?tab=sync");
        // Live BSC round trip, as above.
        await expect(syncStatus(clean).row.getByText(/^0 listed/)).toBeVisible({ timeout: BSC_ROUND_TRIP });
      }
    } finally {
      // The body already stopped listing on a pass; otherwise it stops here.
      if (!written.stopped) await stopListing(clean, written.removed);
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
    written.removed = false;
    written.stopped = false;
    const boxName = `Bsc${env.ATTEMPT_TOKEN}`;
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const tabs = inventoryTabs(page);
    const boxes = page.getByRole("list", { name: "Your boxes" });
    const boxSpine = (cards: number) =>
      boxes.getByRole("button", { name: `${boxName}, box, ${cardsWord(cards)} for sale`, exact: true });

    // --- A name the admin screen can show: the label of "this worker's collector"
    // The per-user reset leaves no public profile, and Admin names a collector
    // by display name, else @username, else an opaque id. So the spec sets its own.
    const collector = `Seller${env.ATTEMPT_TOKEN}`;
    await signIn("/profile/public");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    await page.getByLabel(/^Username/).fill(env.TEST_USERNAME);
    await page.getByLabel("Display Name").fill(collector);
    await page.getByRole("button", { name: "Save Public Profile" }).click();
    await expect(page.getByText(/^Profile saved/)).toBeVisible();

    // --- 0. A box to stock, and every other box in-person BEFORE syncing starts -----------
    // A full page load, so the launch gate (cold app + Clerk handshake) applies.
    await page.goto("/inventory?tab=boxes");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    await createBox(page, boxName);
    written.box = boxName;
    await backToBoxes(page);
    await expect(boxSpine(0)).toBeVisible();

    // Every other box the worker has: the boxes on the shelf and Unsorted in
    // "Special places" (the Up for Trade pile is not a box that lists). Each is
    // opened and its "Listed on marketplaces" turned off (a box starts on), and
    // each ends unchecked, asserted. They are left in-person afterwards:
    // putting them back would queue their cards.
    const special = page.getByRole("list", { name: "Special places" });
    const spineRe = /^(.+), box, (?!.*up for trade)/;
    const spines = boxes.getByRole("button", { name: spineRe }).or(special.getByRole("button", { name: spineRe }));
    // The shelf has settled when Unsorted is drawn and no box is still "counting"
    // (its spine reads ", box, counting" until its count is known).
    await expect(special.getByRole("button", { name: /^Unsorted, box, / })).toBeVisible();
    await expect(
      boxes.getByRole("button", { name: /, box, counting$/ }).or(special.getByRole("button", { name: /, box, counting$/ })),
    ).toHaveCount(0);
    const boxNameOf = (spineName: string) => spineRe.exec(spineName)![1];
    const readBoxes = async () => {
      const names: string[] = [];
      for (let i = 0, n = await spines.count(); i < n; i++) names.push(await nameOf(spines.nth(i)));
      return names;
    };
    const others = (await readBoxes()).filter((name) => boxNameOf(name) !== boxName);
    // Unsorted is never skipped: it is the box most likely to hold earlier stock.
    expect(others.map(boxNameOf), "the shelf names Unsorted").toContain("Unsorted");
    for (const spineName of others) {
      const box = boxNameOf(spineName);
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
    // Nothing arrived on the shelf while they were handled: a late box fails here, never skipped.
    const handled = new Set([boxName, ...others.map(boxNameOf)]);
    await expect
      .poll(async () => (await readBoxes()).map(boxNameOf).filter((name) => !handled.has(name)))
      .toEqual([]);

    // --- Before syncing: the worker is seeded "not syncing" -----------------------
    // Sync is shown but inert with its reason, Sync status says Not syncing, and
    // the Profile's BuySportsCards panel says so too.
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const checklist = await drillToCollectorBase(page, TOPPS_1988);
    const sync = checklist.getByRole("button", { name: `Sync ${TITLE}`, exact: true });
    // Shown, but inert (aria-disabled keeps it in the tab order): its reason is its description.
    await expect(sync).toBeVisible();
    await expect(sync).toHaveAttribute("aria-disabled", "true");
    await expect(sync).toHaveAccessibleDescription(NOT_LISTING_LINE);
    await expect(checklist.getByRole("switch", { name: /^List on / })).toHaveCount(0);
    await expect(checklist.getByRole("group", { name: `${BSC} listing` })).toBeHidden();
    await expectAccessible(page, { label: "Checklist, Sync inert before syncing" });
    // Pressed from the keyboard, it says why instead of syncing.
    await sync.focus();
    await page.keyboard.press("Enter");
    await expect(said(NOT_LISTING_LINE)).toBeVisible();

    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    const before = syncStatus(page);
    await expect(before.platform.getByRole("heading", { level: 2, name: BSC, exact: true })).toBeVisible();
    await expect(before.platform.getByText("Not syncing", { exact: true })).toBeVisible();
    await expect(before.platform.getByText("Listing", { exact: true })).toBeHidden();
    await expectAccessible(page, { label: "Inventory Sync status, not syncing" });

    // A full page load, so the launch gate (cold app + Clerk handshake) applies.
    await page.goto("/profile/credentials");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(page.getByText(`Connected to ${BSC}`)).toBeVisible();
    const listing = listingSection(page);
    await expect(listing).toBeVisible();
    await expect(listing.getByRole("status")).toHaveText("Not syncing.");
    await expect(listing.getByRole("button")).toHaveCount(0);
    await expectAccessible(page, { label: "Profile, BuySportsCards credentials, not syncing" });

    // --- 1. Connecting starts listing, and the form says so first --------------
    // Remove the sign-in: the form comes back with the consent warning, which
    // describes Connect. (No password is typed: the sign-in comes back by the seed hop.)
    await removeBscSignIn(page, LAUNCH_GATE);
    written.removed = true;
    await expect(listing).toBeHidden();
    await expect(page.getByText(CONSENT_HEADING, { exact: true })).toBeVisible();
    await expect(
      page.getByText(new RegExp(`Connecting lists every card in your boxes on ${BSC} at your box counts.*goes to 0\\.`, "s")),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveAccessibleDescription(
      new RegExp(`^${escapeRegExp(CONSENT_HEADING)}`),
    );
    await expectAccessible(page, { label: "Profile, BuySportsCards sign-in form, listing consent" });

    // Start syncing as a real save does: the seed hop with listing=on.
    written.started = true;
    await saveBscSignIn(page, { listing: true });
    written.removed = false;
    await expect(listing.getByRole("status")).toHaveText(new RegExp(`^Listing your boxes on ${BSC} since .+\\.$`));
    await expect(listing.getByText(/Removing your BuySportsCards sign-in stops listing and sales\./)).toBeVisible();
    await expectAccessible(page, { label: "Profile, BuySportsCards credentials, listing since" });

    // --- Inventory: Sales has no switch ----------------------------------------
    await goViaShell(page, isMobile, "Inventory");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await tabs.getByRole("link", { name: "Sales", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sales/);
    await expect(page.getByRole("heading", { level: 2, name: "What sold" })).toBeVisible();
    // Listing is not a switch any more: it is the saved sign-in and the boxes.
    await expect(page.getByRole("switch", { name: /^List on / })).toHaveCount(0);

    // --- The 1988 Topps Base checklist, adding to the box ----------------------
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const adding = page.getByRole("combobox", { name: "Adding to" });
    await expect(adding).toBeVisible();
    await drillToCollectorBase(page, TOPPS_1988);
    await adding.selectOption({ label: boxName });
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
    const boxList = checklist.getByRole("list", { name: `Quantities in ${boxName}` });
    await expect(boxList.getByRole("textbox").nth(1)).toBeVisible();
    // Syncing has started: Sync is usable now.
    await expect(sync).not.toHaveAttribute("aria-disabled", "true");

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

    // --- The listing gate: no price yet, so the listed box is held -------------
    // A collector who syncs stocks a listed box only with a price on its cards.
    // No common price exists for this checklist (it is cleared at the end of
    // every run), so the checklist says why and the + for a card is off.
    const gateLine = `Price tag first! ${boxName} sells on your marketplaces, so set a common price above before you stock it.`;
    const gateNote = checklist.getByText(gateLine, { exact: true });
    const addOneOfA = checklist.getByRole("button", { name: `Add one ${a} to ${boxName}`, exact: true });
    await expect(gateNote).toBeVisible();
    await expect(addOneOfA).toBeDisabled();
    await expectAccessible(page, { label: "Checklist, listed box held until a common price is set" });

    // Photo intake holds the same box: the drop zone is held with its reason
    // and a button to the missing field. Nothing is uploaded.
    await tabs.getByRole("link", { name: "Add cards", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=add/);
    await page.getByRole("combobox", { name: "Put them in this box" }).selectOption({ label: boxName });
    const intakeLine = `Price tag first! ${boxName} sells on your marketplaces, so give these cards a price in Defaults (or pick a set with a common price) before you send photos.`;
    await expect(page.getByText(intakeLine, { exact: true })).toBeVisible();
    await expect(page.getByText("Set a price, then drop your photos", { exact: true })).toBeVisible();
    const dropzone = page.getByLabel("Drag your card photos here, or browse your files");
    await expect(dropzone).toHaveAttribute("aria-disabled", "true");
    await expect(dropzone).toHaveAccessibleDescription(intakeLine);
    await expectAccessible(page, { label: "Add cards, listed box held until a price is set" });
    // The button opens Defaults with the Min price field focused.
    await page.getByRole("button", { name: "Set a Min price", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Min price", exact: true })).toBeFocused();
    // Back steps to the held checklist, still adding to the box.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
    await expect(gateNote).toBeVisible();

    // --- A common price: the rows have no price of their own -------------------
    // Setting it lifts the hold.
    await checklist.getByRole("button", { name: `Set a common price for ${TITLE}`, exact: true }).click();
    const priceField = checklist.getByRole("textbox", { name: "Common price", exact: true });
    await expect(priceField).toBeFocused();
    await priceField.fill("0.25");
    await page.keyboard.press("Enter");
    await expect(said(`Common price for ${TITLE} is $0.25`)).toBeVisible();
    await expect(checklist.getByText("$0.25", { exact: true })).toBeVisible();
    await expect(gateNote).toBeHidden();
    await expect(addOneOfA).toBeEnabled();

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

    // --- Before Sync: Sync status queues the two cards -------------------------
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    await expect(tabs.getByRole("link", { name: "Sync status", exact: true })).toHaveAttribute("aria-current", "page");
    const { platform, row } = syncStatus(page);
    await expect(platform.getByRole("heading", { level: 2, name: BSC, exact: true })).toBeVisible();
    await expect(platform.getByText("Listing", { exact: true })).toBeVisible();
    await expect(platform.getByRole("heading", { level: 3, name: "Queued for the next sync (2)", exact: true })).toBeVisible();
    const queued = platform.getByRole("list", { name: "Queued for the next sync (2)" }).getByRole("listitem");
    await expect(queued).toHaveCount(2);
    for (const short of [a, b]) {
      const number = escapeRegExp(short.split(" ")[0]);
      await expect(queued.filter({ hasText: new RegExp(`^${number} .* in ${escapeRegExp(SET_LABEL)}`) })).toHaveCount(1);
    }
    await expectAccessible(page, { label: "Inventory Sync status, two cards queued" });

    // --- 2. Sync: BSC takes both, Sync status says 2 listed --------------------
    // Back steps to the checklist the cards were boxed on, quantities as left.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await expect(fieldA).toHaveValue("1");
    await expect(fieldB).toHaveValue("1");
    await sync.click();
    await expect(said(`Syncing ${TITLE} now. Watch it on Sync status.`)).toBeVisible();
    // After the press, a link to the result sits under Sync. It lands on Sync
    // status, and Back steps to the checklist it was pressed on.
    const seeSyncing = checklist.getByRole("link", { name: "See what's syncing", exact: true });
    await expect(seeSyncing).toBeVisible();
    await seeSyncing.click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    await expect(tabs.getByRole("link", { name: "Sync status", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(syncStatus(page).platform.getByRole("heading", { level: 2, name: BSC, exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await expect(fieldA).toHaveValue("1");
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    // Live BSC round trip (BSC_ROUND_TRIP above). The line is the drain's own
    // count: 2 rows on BSC show NB's stock after the read-back (2 updated, or
    // none when BSC already showed them); "skipped" would be a held-back card.
    await expect(row.getByText(/^2 listed(, 2 updated)?$/)).toBeVisible({ timeout: BSC_ROUND_TRIP });
    await expect(row.getByText(/^Synced /)).toBeVisible();
    await expect(row.getByText(/held back/)).toHaveCount(0);
    await expectAccessible(page, { label: "Inventory Sync status, 2 listed" });

    // --- Admin: the same result, read-only, for this collector --------------------
    // (Worker accounts are admins: the admin specs sign in as them.)
    await page.goto("/admin/sync-status");
    await expect(page.getByRole("heading", { level: 2, name: "Sync Status", exact: true })).toBeVisible({ timeout: LAUNCH_GATE });
    const pickCollector = page.getByRole("combobox", { name: "Collector", exact: true });
    await expect(pickCollector.getByRole("option", { selected: true })).toHaveText("Everyone who has connected a marketplace");
    const adminCollector = page.getByRole("region", { name: collector, exact: true });
    // Everyone view: each collector has a LINK to see everything for them.
    const seeAll = adminCollector.getByRole("link", { name: `See everything for ${collector}`, exact: true });
    await seeAll.click();
    await expect(page).toHaveURL(/[?&]owner=[^&]+/);
    await expect(pickCollector.getByRole("option", { selected: true })).toHaveText(collector);
    const admin = syncStatus(adminCollector);
    await expect(admin.platform.getByRole("heading", { level: 4, name: BSC, exact: true })).toBeVisible();
    await expect(admin.row.getByText(/^2 listed(, 2 updated)?$/)).toBeVisible();
    await expect(admin.row.getByText(/held back/)).toHaveCount(0);
    // Look, don't touch: nothing here syncs, starts, removes or links to the collector's Profile.
    await expect(adminCollector.getByRole("button", { name: /^(Sync|Connect|Remove|Clear)/ })).toHaveCount(0);
    await expect(adminCollector.getByRole("link")).toHaveCount(0);
    await expectAccessible(page, { label: "Admin Sync status, one collector, 2 listed" });
    // Back returns to everyone (the link pushed a step); the filter then replaces.
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]owner=/);
    await expect(pickCollector.getByRole("option", { selected: true })).toHaveText("Everyone who has connected a marketplace");
    await expect(seeAll).toBeVisible();
    await pickCollector.selectOption({ label: collector });
    await expect(page).toHaveURL(/[?&]owner=[^&]+/);
    await expect(admin.row.getByText(/^2 listed(, 2 updated)?$/)).toBeVisible();

    // --- 3. The box goes in-person: Sync takes both off BSC --------------------
    await page.goto("/inventory?tab=boxes");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
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
    await sync.click();
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
    // Same page since the drill above: the tab link reopens 1988 Topps Base.
    await emptyBox(page, boxName, [a, b], isMobile, "reopened");
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

    // --- 4. Stop listing: the sign-in goes and comes back not syncing
    // The BSC rows are already 0 (step 3). The hook does this on a failure.
    await stopListing(page);
    written.stopped = true;
  },
);
