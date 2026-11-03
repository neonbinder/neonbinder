// NEO-415 (R1): a collector's boxes reach eBay when they Sync, and a box set to
// in-person takes them down again. The flow, as the user lives it, on eBay's
// SANDBOX (the deployment's eBay wiring is the sandbox's; step 1 refuses to go
// on if it is not):
//   0. Not wired / paused: a deployment with no eBay wiring FAILS this spec
//      loudly, naming the setup it lacks (never a skip, GUIDE hard rule 1). A
//      deployment with eBay paused (`NEONBINDER_PAUSED_PLATFORMS` names ebay,
//      the runner's `PAUSED_PLATFORMS` too) takes the paused branch instead:
//      Profile and Sync status say eBay is on a break and the seed hop
//      connects nothing. Both branches end in hard asserts (R2).
//   1. Profile -> Credentials -> eBay, not connected: the consent warning before Connect, and
//      the sandbox line (the safety assert: nothing here lists for real).
//   2. They make their box and set every OTHER box they have to in-person
//      (a connection that lists walks every card in a listed box), then Sync
//      status says eBay is not connected, with the way to connect (Back
//      returns).
//   3. Connect. eBay's consent screen is a third party's page that no spec can
//      drive, so the connection is made the way the bootstrap saves the other
//      marketplaces: the seed hop (`/testing/seed-credentials?sites=ebay`,
//      `listing=on`), which connects the sandbox seller with the deployment's
//      refresh token. Connected IS listing, but the page says setup is not
//      done (5 to go) and Sync status says "Setup unfinished", with the way
//      back to the page (Back returns).
//   4. Setup: "Set me up" where the seller's account has nothing that fits (it
//      makes NeonBinder's standard shipping, payment and returns policies on
//      eBay), a pick in each of Cards under $20, $20 and up, Payment and
//      Returns, then Ships from; the checklist reads "You're all set".
//   5. They set a common price, put one copy each of the first three 1988 Topps
//      Base cards in the box and attach a photo to the first two only (eBay
//      listings need one), press Sync, follow "See what's syncing" (Back
//      returns), and Sync status reads the eBay section's set with 2 listed and
//      1 skipped: the third card is held back, named, with eBay's no-photo
//      reason.
//   6. They turn the box's "Listed on marketplaces" off, Sync again, and the
//      set reads 0 listed, with the two cards taken to 0 and nothing held back.
//      The Sales tab names eBay (its orders link and its empty state; Back
//      returns).
//   7. They tidy up (cards out of the box, the common price cleared, the box
//      deleted) and Disconnect eBay (the confirm dialog), which takes down
//      anything NeonBinder put up on eBay and leaves the account not
//      connected. The afterEach does the same on a failure.
//
// What "2 listed" proves about eBay. The drain reads the seller's inventory,
// uploads each card's photo, creates the inventory items and offers, PUBLISHES
// them and reads the result; a card eBay would not take becomes a held-back
// card with a reason (no photo, a missing item detail, a rejection). So the end
// state of a sync is two things together: the set's "N listed" count line and
// the "held back" list (here exactly the one card left without a photo; at the
// end, none). The spec never calls eBay itself and shows no eBay
// listing of its own (a product gap if a collector should see one).
//
// Waits. Every step gets the standard 7 s budget (GUIDE hard rule 3), the
// eBay calls included: reading the seller's policies, "Set me up", saving a
// pick or the ships-from address, the Sync results and the disconnect's
// takedown. A step that needs longer is a finding to report, never a number to
// raise. The only longer wait is the seed hop's one full page load
// (`LAUNCH_GATE`). No timer and no cron path: the 15-minute poll is
// deliberately not exercised.
//
// Sync's toast. A press that sets a run going toasts "Syncing <title> now.
// Watch it on Sync status."; both presses assert it before reading the result.
//
// R7/R7a. 1988 Topps Baseball is a registered real set (SET-REGISTRY.md): this
// spec is the SOLE writer of the sandbox seller account's listings and writes
// no card, player, team or variant of the set. Its NB writes are the signed-in
// user's own rows (the eBay connection and setup, a minted box, three box copies
// (a photo on two), the common price, and every other box set to in-person,
// which is left that way). It makes NeonBinder's standard policies on the
// sandbox seller's eBay account where it has none ("Set me up"); those stay on
// eBay and are found again by the next run. The listings end taken down and the
// connection ends removed, on a pass by the steps and on a failure by the hook
// on a second page (so the failure screenshot keeps the page that failed).
//
// Minted box name: a single token from `env.ATTEMPT_TOKEN`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
  TOPPS_1988,
  backToBoxes,
  baseChecklistTitle,
  cardsWord,
  clearChecklistCommonPrice,
  createBox,
  deleteOpenBox,
  drillToCollectorBase,
  emptyBoxCards,
  inventoryTabs,
  nameOf,
  putOtherBoxesInPerson,
  quantityField,
  syncRun,
} from "../../support/collection";
import { expectEbayHookedUp, removeEbayConnection, saveEbayConnection } from "../../support/credentials";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const EBAY = "eBay";
const TITLE = baseChecklistTitle(TOPPS_1988);
/** The set as Sync status and the card drawer name it: a Base checklist reads as the set alone. */
const SET_LABEL = `${TOPPS_1988.year} ${TOPPS_1988.set}`;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Real card scans the intake specs already commit (about 1000 px wide; eBay wants at least 500). */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake");
const PHOTOS = ["01-mcfadden-front.jpg", "03-bowe-front.jpg"] as const;

/** NeonBinder's own policy names on the seller's eBay account (NB_POLICY_NAMES in convex/ebayConnect.ts: what "Set me up" makes). */
const TRACKED_POLICY = "NB Tracked (USPS Ground Advantage)";
const FREE_POLICY = "NB Free Shipping";

/** At or above eBay's $0.99 floor, and under $20 (the Standard Envelope slot). */
const COMMON_PRICE = "1.00";
/** A US address, the page's own example ZIP. */
const SHIPS_FROM = { zip: "53703", city: "Madison", state: "WI" };

// The words the eBay screens say (lib/marketplace/listing-copy.ts, ebay/page.tsx, SyncStatusView).
const CONSENT_HEADING = "Heads up: connecting starts listing";
const SANDBOX_LINE = "Test mode: this NeonBinder talks to eBay's sandbox, so nothing lists for real.";
const PAUSED_LINE = "eBay is on a break. Your changes wait here and go up when it's back.";
const NOT_CONNECTED_NOTE = "eBay isn't connected, so nothing lists there.";
const SETUP_NOTE = "Your eBay setup isn't finished, so nothing goes up there yet.";
const NOT_CONNECTED_MISSING_SETUP =
  "eBay did not connect after the seed hop. Either DEV_EBAY_REFRESH_TOKEN (a sandbox seller's refresh token) " +
  "is unset on this deployment, or eBay is paused here (NEONBINDER_PAUSED_PLATFORMS) while this runner's " +
  "PAUSED_PLATFORMS does not name ebay. This spec never skips for missing setup.";

/** What the failing run needs undone, filled as the flow goes. */
const written: { connected?: boolean; disconnected?: boolean; priced?: boolean } = {};

/** The key that leaves a quantity field: Tab on a desktop, Enter on a phone. */
const leaveKey = (isMobile: boolean) => (isMobile ? "Enter" : "Tab");

/** The Sync status screen's eBay section and this set's "Last sync by set" row. */
function syncStatus(page: Page) {
  const platform = page.getByRole("region", { name: EBAY, exact: true });
  const row = platform
    .getByRole("list", { name: "Last sync by set" })
    .getByRole("listitem")
    .filter({ hasText: SET_LABEL });
  return { platform, row };
}

// Pass or fail, the account ends with eBay NOT connected. On a failure the
// common price the run set is cleared first, and the disconnect takes down
// anything already up on eBay (the same product action the steps end with).
// Idempotent: it does only what the run got far enough to need.
test.afterEach(async ({ context }, testInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  const clean = await context.newPage();
  try {
    try {
      if (failed && written.priced) {
        await clean.goto("/inventory?tab=checklists");
        await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
        const checklist = await drillToCollectorBase(clean, TOPPS_1988);
        await clearChecklistCommonPrice(clean, checklist, TITLE, COMMON_PRICE);
        written.priced = false;
      }
    } finally {
      if (written.connected && !written.disconnected) {
        await removeEbayConnection(clean, { gate: LAUNCH_GATE });
      }
    }
  } finally {
    await clean.close();
  }
});

test(
  "Inventory: connecting eBay and finishing its setup lists a box's 1988 Topps Base cards on the eBay sandbox, and an in-person box takes them down",
  { tag: ["@collection", "@marketplace-seller"] },
  async ({ page, signIn, env, isMobile }) => {
    // The hook's record of how far this run got starts empty.
    written.connected = false;
    written.disconnected = false;
    written.priced = false;
    const boxName = `Ebay${env.ATTEMPT_TOKEN}`;
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const tabs = inventoryTabs(page);
    const boxes = page.getByRole("list", { name: "Your boxes" });
    const boxSpine = (cards: number) =>
      boxes.getByRole("button", { name: `${boxName}, box, ${cardsWord(cards)} for sale`, exact: true });
    const connectButton = page.getByRole("button", { name: "Connect eBay", exact: true });
    const disconnectButton = page.getByRole("button", { name: "Disconnect eBay", exact: true });
    const connectedLine = page.getByText(/^Rockin' on eBay as .+ since .+\.$/);
    const checklistSteps = page.getByRole("status").filter({ hasText: /to go\. Nothing lists on eBay until they're done\.$/ });
    const allSet = page.getByRole("heading", { level: 3, name: "You're all set", exact: true });

    // --- 1. Profile -> Credentials -> eBay, before anything: wired, sandbox, not connected -------------
    await signIn("/profile/ebay");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    // Fails loudly, naming the setup, when this deployment has no eBay wiring.
    await expectEbayHookedUp(page);
    await expect(page.getByRole("heading", { level: 2, name: EBAY, exact: true })).toBeVisible();

    if (env.EBAY_PAUSED) {
      // --- Paused: the operator's switch stops all contact with eBay -------------------
      // The seed hop skips a paused platform, so nothing connects; Profile and
      // Sync status both say eBay is on a break.
      await saveEbayConnection(page, { listing: true, gate: LAUNCH_GATE });
      await expect(page.getByText(PAUSED_LINE, { exact: true })).toBeVisible();
      await expect(connectedLine).toBeHidden();
      await expect(connectButton).toBeHidden();
      await expectAccessible(page, { label: "Profile, eBay on a break" });

      await page.goto("/inventory?tab=sync");
      await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
      const paused = syncStatus(page).platform;
      await expect(paused.getByRole("heading", { level: 2, name: EBAY, exact: true })).toBeVisible();
      await expect(paused.getByText("On a break", { exact: true })).toBeVisible();
      await expect(paused.getByText(PAUSED_LINE, { exact: true })).toBeVisible();
      await expectAccessible(page, { label: "Inventory Sync status, eBay on a break" });
      return;
    }

    // The safety assert: this deployment talks to eBay's sandbox, never the real thing.
    await expect(
      page.getByText(SANDBOX_LINE, { exact: true }),
      "the eBay listing spec lists real cards; it runs only on a deployment wired to eBay's SANDBOX (EBAY_ENVIRONMENT=sandbox)",
    ).toBeVisible();
    await expect(page.getByText("Sandbox", { exact: true })).toBeVisible();
    // Not connected: the consent warning that describes Connect, said before it is pressed.
    await expect(connectedLine).toBeHidden();
    await expect(page.getByText("Connect your eBay seller account.", { exact: true })).toBeVisible();
    await expect(page.getByText(CONSENT_HEADING, { exact: true })).toBeVisible();
    await expect(page.getByText(/Connecting lists every raw card in your boxes on eBay at your box counts, once your setup is done/)).toBeVisible();
    await expect(connectButton).toHaveAccessibleDescription(new RegExp(`^${escapeRegExp(CONSENT_HEADING)}`));
    await expectAccessible(page, { label: "Profile, eBay not connected, listing consent" });

    // --- 2. A box to stock, every other box in-person BEFORE connecting -----------------
    // A full page load, so the launch gate (cold app + Clerk handshake) applies.
    await page.goto("/inventory?tab=boxes");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    await createBox(page, boxName);
    await backToBoxes(page);
    await expect(boxSpine(0)).toBeVisible();
    await putOtherBoxesInPerson(page, boxName);

    // Sync status: eBay is not connected, and says where to connect.
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    const before = syncStatus(page).platform;
    await expect(before.getByRole("heading", { level: 2, name: EBAY, exact: true })).toBeVisible();
    await expect(before.getByText("Not connected", { exact: true })).toBeVisible();
    await expect(before.getByText(NOT_CONNECTED_NOTE)).toBeVisible();
    await expect(before.getByText("Listing", { exact: true })).toBeHidden();
    await expectAccessible(page, { label: "Inventory Sync status, eBay not connected" });
    // The way there is a link; Back steps to Sync status.
    await before.getByRole("link", { name: "Connect eBay in Profile → Credentials", exact: true }).click();
    await expect(page).toHaveURL(/\/profile\/credentials\?platform=ebay$/);
    await expect(connectButton).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    await expect(before.getByText("Not connected", { exact: true })).toBeVisible();

    // --- 3. Connect: the seed hop makes the connection eBay's consent screen would ------
    // Starts listing as a collector's own Connect does (`listing=on`). Recorded
    // BEFORE the hop: the hop may connect and still fail on the way back.
    written.connected = true;
    await saveEbayConnection(page, { listing: true, gate: LAUNCH_GATE });
    await expect(connectedLine, NOT_CONNECTED_MISSING_SETUP).toBeVisible();
    await expect(page.getByText(SANDBOX_LINE, { exact: true })).toBeVisible();
    await expect(disconnectButton).toBeVisible();
    // Connected IS listing, but nothing goes up until the setup is done.
    await expect(
      page.getByText("Nothing goes up until your setup below is done. Then every raw card in a listed box lists at its box count."),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Finish these and your boxes go up", exact: true })).toBeVisible();
    await expect(checklistSteps).toHaveText("5 to go. Nothing lists on eBay until they're done.");
    await expect(allSet).toBeHidden();

    // Sync status agrees, and links back to the page. Back steps to Sync status.
    // (A full page load, so the launch gate applies.)
    await page.goto("/inventory?tab=sync");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    const unfinished = syncStatus(page).platform;
    await expect(unfinished.getByText("Setup unfinished", { exact: true })).toBeVisible();
    await expect(unfinished.getByText(SETUP_NOTE)).toBeVisible();
    await expect(unfinished.getByText("Not connected", { exact: true })).toBeHidden();
    await expectAccessible(page, { label: "Inventory Sync status, eBay setup unfinished" });
    const finishSetup = unfinished.getByRole("link", { name: "Finish your eBay setup", exact: true });
    await finishSetup.click();
    await expect(page).toHaveURL(/\/profile\/credentials\?platform=ebay$/);
    await expect(connectedLine).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    await expect(unfinished.getByText("Setup unfinished", { exact: true })).toBeVisible();
    await finishSetup.click();
    await expect(page).toHaveURL(/\/profile\/credentials\?platform=ebay$/);

    // --- 4. Setup: ships from, shipping, payment, returns --------------------------------
    // The seller's policies are read from eBay when the page opens (a live round
    // trip). The read has finished when either "Set me up" (the account has
    // nothing that fits a slot) or the first of the seller's own policies for
    // Cards under $20 is on screen; only then is it decided which arm runs.
    const underTwenty = page.getByRole("radiogroup", { name: "Cards under $20", exact: true });
    const setMeUp = page.getByRole("button", { name: "Set me up", exact: true });
    await expect(setMeUp.or(underTwenty.getByRole("radio").first()).first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Ships from", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Shipping", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Payment and returns", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Offers", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Take Best Offers", exact: true })).toBeChecked();

    // Ships from comes first: eBay prices each buyer's shipping from its ZIP, so
    // "Set me up" waits for it (reachable but aria-disabled, and the server
    // refuses too). Where Set me up is offered, it says so until the location
    // is saved.
    const setMeUpOffered = await setMeUp.isVisible();
    if (setMeUpOffered) {
      await expect(setMeUp).toBeDisabled();
      await expect(page.getByText(/^Save where you ship from first, up in Ships from\./)).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Save location", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "ZIP code", exact: true }).fill(SHIPS_FROM.zip);
    await page.getByRole("textbox", { name: "City", exact: true }).fill(SHIPS_FROM.city);
    const stateField = page.getByRole("textbox", { name: "State", exact: true });
    await stateField.fill(SHIPS_FROM.state);
    // Enter in the last field saves (the form is a form).
    await page.keyboard.press("Enter");
    // Saving the address makes the seller's inventory location on eBay (a live round trip).
    await expect(said("Saved. Your cards ship from here.")).toBeVisible();
    // The location is done; the four policy slots are still to do.
    await expect(checklistSteps).toHaveText("4 to go. Nothing lists on eBay until they're done.");
    await expect(allSet).toBeHidden();
    // The form stays mounted through the save and the query catching up: the
    // keyboard is still in the field it saved from, and the line is still said.
    await expect(stateField).toBeFocused();
    await expect(said("Saved. Your cards ship from here.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "ZIP code", exact: true })).toHaveValue(SHIPS_FROM.zip);
    await expectAccessible(page, { label: "Profile, eBay connected, location saved, policies still to pick" });

    // "Set me up" is offered only where the seller's account has nothing that
    // fits a slot: on a fresh sandbox seller it makes NeonBinder's standard
    // policies on eBay; once they exist (an earlier run made them) it is gone
    // and the seller's own policies are picked below. Both arms end by naming
    // NeonBinder's tracked and free policies for the $20 and up slot.
    if (setMeUpOffered) {
      await expect(setMeUp).toBeEnabled();
      await setMeUp.click();
      // A live round trip to eBay: opt in, make the policies, read them back.
      // Set me up makes Standard Envelope last, and eBay's sandbox turns that
      // one down (it lists the service but refuses it in a policy), so the
      // usual answer here is the partial one: "Made N on your eBay account …
      // eBay wouldn't make a Standard Envelope policy, so pick one of yours
      // for cards under $20." On a re-run, where the rest already exists and
      // the envelope never got made, it is "You already had the rest. …". All
      // of these are the success status line, never the error. Cards under $20
      // is then picked by hand in the loop below, as the line asks.
      await expect(said(/^(Made \d+ on your eBay account|You already had everything|You already had the rest)/)).toBeVisible();
    } else {
      // The policies are already there: the seller's own are offered for the cheap cards.
      await expect(underTwenty.getByRole("radio").first()).toBeVisible();
    }
    // $20 and up: a tracked policy, picked BY NAME (Standard Envelope only
    // covers cards under $20, so the picker offers none). NeonBinder's own
    // policy names are the ones "Set me up" makes (NB_POLICY_NAMES in
    // convex/ebayConnect.ts). Free shipping first, then tracked: a pick that
    // CHANGES the saved one saves (whatever "Set me up" picked), says "Saved.",
    // and the second pick leaves tracked chosen.
    const twentyPlus = page.getByRole("radiogroup", { name: "$20 and up", exact: true });
    const free = twentyPlus.getByRole("radio", { name: FREE_POLICY, exact: true });
    const tracked = twentyPlus.getByRole("radio", { name: TRACKED_POLICY, exact: true });
    await expect(free, `NeonBinder's "${FREE_POLICY}" policy is on the sandbox seller (Set me up makes it)`).toBeVisible();
    await free.click();
    await expect(free).toBeChecked();
    // Saving a pick re-reads the seller's policies on eBay (a live round trip).
    await expect(said(/^Saved\.$/)).toBeVisible();
    await expect(tracked, `NeonBinder's "${TRACKED_POLICY}" policy is on the sandbox seller (Set me up makes it)`).toBeVisible();
    await tracked.click();
    await expect(tracked).toBeChecked();
    await expect(twentyPlus.getByRole("radio", { checked: true })).toHaveCount(1);
    // Cards under $20 (the price this spec lists at): NeonBinder's tracked
    // policy, picked BY NAME. The sandbox turns Standard Envelope down, so Set
    // me up leaves this slot to the collector, and an under-$20 slot takes any
    // policy. Picking it every run (a click on the picked one changes nothing)
    // means the listing below always goes up under a tracked policy, whatever
    // an earlier run left chosen.
    const underTwentyTracked = underTwenty.getByRole("radio", { name: TRACKED_POLICY, exact: true });
    await expect(underTwentyTracked, `NeonBinder's "${TRACKED_POLICY}" policy is offered for cards under $20`).toBeVisible();
    await underTwentyTracked.click();
    await expect(underTwentyTracked).toBeChecked();
    await expect(underTwenty.getByRole("radio", { checked: true })).toHaveCount(1);
    // The other two slots: the first of the seller's own policies, where
    // "Set me up" has not already picked one (a click on the picked one changes nothing).
    for (const group of ["Payment", "Returns"]) {
      const radios = page.getByRole("radiogroup", { name: group, exact: true }).getByRole("radio");
      await expect(radios.first()).toBeVisible();
      await radios.first().click();
      await expect(page.getByRole("radiogroup", { name: group, exact: true }).getByRole("radio", { checked: true })).toHaveCount(1);
    }
    // The last pick finishes the setup: the checklist folds to "You're all set".
    await expect(allSet).toBeVisible();
    await expect(checklistSteps).toBeHidden();
    await expect(page.getByRole("heading", { level: 3, name: "Finish these and your boxes go up", exact: true })).toBeHidden();
    await expect(page.getByText("Everything in a listed box lists on eBay at your count.", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Every raw card in a listed box goes up at its box count, and sales land in Inventory, under Sales. Disconnecting stops both."),
    ).toBeVisible();
    await expectAccessible(page, { label: "Profile, eBay connected and set up" });

    // --- 5. Stock the box: a price, one copy each of two cards, a photo each ------------
    // A full page load, so the launch gate applies.
    await page.goto("/inventory?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    const adding = page.getByRole("combobox", { name: "Adding to" });
    await expect(adding).toBeVisible();
    const checklist = await drillToCollectorBase(page, TOPPS_1988);
    const sync = checklist.getByRole("button", { name: `Sync ${TITLE}`, exact: true });
    await adding.selectOption({ label: boxName });
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
    const boxList = checklist.getByRole("list", { name: `Quantities in ${boxName}` });
    await expect(boxList.getByRole("textbox").nth(1)).toBeVisible();
    // Connected and set up: Sync is usable.
    await expect(sync).toBeVisible();
    await expect(sync).not.toHaveAttribute("aria-disabled", "true");

    // Three fixed cards: the first three rows of the checklist. The third is the
    // one that gets NO photo (below); see the note at the Sync.
    const shortOf = async (n: number) => {
      const name = await nameOf(boxList.getByRole("textbox").nth(n));
      const m = new RegExp(`^Quantity of (.+) in ${escapeRegExp(boxName)}$`).exec(name);
      expect(m, `a quantity field named "Quantity of <card> in ${boxName}" (read: ${name})`).not.toBeNull();
      return m![1];
    };
    const a = await shortOf(0);
    const b = await shortOf(1);
    const c = await shortOf(2);
    expect(new Set([a, b, c]).size, "three different cards").toBe(3);

    // A common price: a listed box is held until its cards have one.
    await checklist.getByRole("button", { name: `Set a common price for ${TITLE}`, exact: true }).click();
    const priceField = checklist.getByRole("textbox", { name: "Common price", exact: true });
    await expect(priceField).toBeFocused();
    written.priced = true;
    await priceField.fill(COMMON_PRICE);
    await page.keyboard.press("Enter");
    await expect(said(`Common price for ${TITLE} is $${COMMON_PRICE}`)).toBeVisible();
    await expect(checklist.getByText(`$${COMMON_PRICE}`, { exact: true })).toBeVisible();
    await expect(checklist.getByRole("button", { name: `Add one ${a} to ${boxName}`, exact: true })).toBeEnabled();

    const fieldA = quantityField(boxList, a, boxName);
    const fieldB = quantityField(boxList, b, boxName);
    await expect(fieldA).toHaveValue("0");
    await expect(fieldB).toHaveValue("0");
    const fieldC = quantityField(boxList, c, boxName);
    await expect(fieldC).toHaveValue("0");
    await fieldA.fill("1");
    await page.keyboard.press(leaveKey(isMobile));
    await expect(fieldB).toBeFocused();
    await fieldB.fill("1");
    await page.keyboard.press(leaveKey(isMobile));
    await expect(fieldC).toBeFocused();
    await fieldC.fill("1");
    await page.keyboard.press(leaveKey(isMobile));
    const rowOf = (short: string) =>
      boxList
        .getByRole("listitem")
        .filter({ has: page.getByRole("textbox", { name: `Quantity of ${short} in ${boxName}`, exact: true }) });
    await expect(rowOf(a).getByText("Saved")).toBeVisible();
    await expect(rowOf(b).getByText("Saved")).toBeVisible();
    await expect(rowOf(c).getByText("Saved")).toBeVisible();
    await expect(said(new RegExp(`^Boxed 1 more of ${escapeRegExp(c)}\\.`))).toBeVisible();

    // A photo on the first two copies: eBay listings need one. The third copy
    // gets none, on purpose: a card without a photo must be held back, with
    // its reason, on the very Sync that lists the other two. (Why a third card,
    // not a photo added to the held one for a second Sync: a press within a
    // minute of the last stamped press is throttled, and the second press would
    // stamp the set, throttling the in-person Sync that follows it.)
    // The card's drawer, the boxed copy's line, its Photos box.
    const attachPhoto = async (short: string, photo: string, axeLabel?: string) => {
      const drawer = page.getByRole("dialog", { name: new RegExp(`^${escapeRegExp(SET_LABEL)} ${escapeRegExp(short)}`) });
      await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
      const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}`, exact: true });
      await yourCopies.getByRole("button", { name: new RegExp(`^Edit ${escapeRegExp(short)}, Raw, `) }).click();
      const panel = yourCopies.getByRole("form", { name: /^Edit Raw, / }).getByRole("region", { name: "Photos", exact: true });
      await expect(panel.getByText("No front photo yet")).toBeAttached();
      await panel.getByLabel("Front photo file", { exact: true }).setInputFiles(path.join(FIXTURES, photo));
      await expect(panel.getByRole("status")).toHaveText("Front photo saved.");
      if (axeLabel) await expectAccessible(page, { within: drawer, label: axeLabel });
      await drawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(drawer).toBeHidden();
    };
    await attachPhoto(a, PHOTOS[0], "Card drawer, a boxed copy with its front photo");
    await attachPhoto(b, PHOTOS[1]);
    await expect(fieldA).toHaveValue("1");
    await expect(fieldB).toHaveValue("1");
    await expect(fieldC).toHaveValue("1");

    // --- Sync: eBay takes the two with photos and holds the third back ---------------------------------
    await sync.click();
    await expect(said(`Syncing ${TITLE} now. Watch it on Sync status.`)).toBeVisible();
    // After the press, a link to the result sits under Sync. It lands on Sync
    // status, and Back steps to the checklist it was pressed on.
    const seeSyncing = checklist.getByRole("link", { name: "See what's syncing", exact: true });
    await expect(seeSyncing).toBeVisible();
    await seeSyncing.click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    const { platform, row } = syncStatus(page);
    await expect(platform.getByRole("heading", { level: 2, name: EBAY, exact: true })).toBeVisible();
    await expect(platform.getByText("Listing", { exact: true })).toBeVisible();
    // The live eBay round trip, step by step (the run's ledger on Sync status),
    // each within the standard budget: the new run is in view (its ledger under
    // Running now, or its own result line if it already finished), then the
    // photo uploads, the items, the offers and going live land in turn. The
    // line is the drain's own count: the two cards with a photo are listed,
    // the third is the one skipped.
    const run = syncRun(platform, SET_LABEL, EBAY);
    const listedLine = row.getByText(/^2 listed(, \d+ updated)?, 1 skipped$/);
    await expect(run.underWay(listedLine)).toBeVisible();
    // Uploading photos is a step only while a picture has to go up (a rerun on
    // the same account may reuse the last run's), so the first step to land is
    // either it or the items that follow it.
    await expect(run.step("Upload photos").or(run.step("List the cards")).first()).toBeVisible();
    await expect(run.step("List the cards")).toBeVisible();
    await expect(run.step("Set prices")).toBeVisible();
    await expect(run.step("Go live")).toBeVisible();
    await expect(listedLine).toBeVisible();
    await expect(row.getByText(/^Synced /)).toBeVisible();
    // Held back is exactly that one card, with the reason a collector can act on
    // (the copy is problemCopy("ebay").noPhoto in inventory/listing/copy.ts).
    await expect(row.getByText("1 held back:", { exact: true })).toBeVisible();
    const heldBack = row.getByRole("listitem").filter({ hasText: "eBay listings need a photo. Add one to a copy of this card and it goes up." });
    await expect(heldBack).toHaveCount(1);
    await expect(heldBack).toContainText(c.split(" ")[0]);
    // Finished, the set's row keeps the run's steps, in run order (so the axe
    // check below has the ledger showing).
    await expect(run.last).toBeVisible();
    await expect(run.last.getByRole("listitem")).toContainText([/^List the cards, done$/, /^Set prices, done$/, /^Go live, done$/]);
    await expectAccessible(page, { label: "Inventory Sync status, eBay 2 listed, the run's steps done and a card held back for no photo" });
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await expect(fieldA).toHaveValue("1");
    await expect(fieldB).toHaveValue("1");
    await expect(fieldC).toHaveValue("1");

    // --- 6. The box goes in-person: Sync takes both down ----------------------------------
    await page.goto("/inventory?tab=boxes");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(boxSpine(3)).toBeVisible();
    await boxSpine(3).click();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    const listed = page.getByRole("checkbox", { name: "Listed on marketplaces", exact: true });
    // On by default.
    await expect(listed).toBeChecked();
    await listed.uncheck();
    await expect(said(`${boxName} is in-person only now.`)).toBeVisible();
    await expect(listed).not.toBeChecked();

    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await drillToCollectorBase(page, TOPPS_1988);
    await sync.click();
    await expect(said(`Syncing ${TITLE} now. Watch it on Sync status.`)).toBeVisible();
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    // The live eBay round trip, step by step: the set was 2 listed a minute ago,
    // so the row still shows the LAST run's finished steps until this one claims
    // the set; gate on the new run (its ledger, or its own result line).
    const takeDown = syncRun(platform, SET_LABEL, EBAY);
    const takenLine = row.getByText(/^0 listed(, \d+ updated)?, 2 taken to 0$/);
    await expect(takeDown.underWay(takenLine)).toBeVisible();
    await expect(takeDown.step("Take down cards at 0")).toBeVisible();
    await expect(takenLine).toBeVisible();
    await expect(row.getByText(/held back/)).toHaveCount(0);

    // The Sales tab names eBay: its orders page is one link away. (No order has
    // come in: the poll is a timer this spec does not wait for.) Back steps to Sync status.
    await tabs.getByRole("link", { name: "Sales", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sales/);
    await expect(page.getByRole("heading", { level: 2, name: "What sold" })).toBeVisible();
    const ordersLink = page.getByRole("list", { name: "Orders pages" }).getByRole("link", { name: /^Open eBay orders/ });
    await expect(ordersLink).toBeVisible();
    // The sandbox's own orders page, never the real one.
    await expect(ordersLink).toHaveAttribute("href", "https://www.sandbox.ebay.com/sh/ord");
    // This spec creates no sale (the 15-minute poll is a timer it does not wait
    // for), so the empty state is the branch: it names eBay. How an eBay ORDER
    // renders (platform label, status words, the Seller Hub link, its lines) is
    // covered by SalesTab.test.tsx.
    await expect(
      page.getByText(/^No sales yet\. When a card sells on .*eBay.*, the order shows up here within about 15 minutes\.$/),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Orders, newest first" })).toHaveCount(0);
    await expectAccessible(page, { label: "Inventory Sales, eBay named" });
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    await expect(row.getByText(/^0 listed(, \d+ updated)?, 2 taken to 0$/)).toBeVisible();

    // --- 7. Tidy up through the product: the box's cards, the price, the box, eBay --------
    // Zero before deleting, so no copy falls into the Unsorted box. Same page
    // since the drill above: the tab link reopens 1988 Topps Base.
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await emptyBoxCards(page, TOPPS_1988, boxName, [a, b, c], isMobile, "reopened");
    await clearChecklistCommonPrice(page, checklist, TITLE, COMMON_PRICE);
    written.priced = false;

    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(boxSpine(0)).toBeVisible();
    await boxSpine(0).click();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    await deleteOpenBox(page, boxName);
    await expect(boxes.getByRole("button", { name: new RegExp(`^${escapeRegExp(boxName)},`) })).toHaveCount(0);

    // Disconnect: takes down what NeonBinder put up on eBay and leaves the account not connected.
    // A full page load, so the launch gate applies.
    await page.goto("/profile/ebay");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(connectedLine).toBeVisible();
    await disconnectButton.click();
    const confirm = page.getByRole("dialog", { name: "Disconnect eBay?", exact: true });
    await expect(confirm).toBeVisible();
    await expectAccessible(page, { within: confirm, label: "Profile, Disconnect eBay confirm" });
    await confirm.getByRole("button", { name: "Yes, disconnect" }).click();
    // The takedown reads eBay's listings and withdraws what is live (a live round trip).
    await expect(connectButton).toBeVisible();
    written.disconnected = true;
    await expect(confirm).toBeHidden();
    await expect(connectedLine).toBeHidden();
    await expect(page.getByText(CONSENT_HEADING, { exact: true })).toBeVisible();
  },
);
