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
//   4. Setup: the weight of a single card set to 3 oz (Enter saves; a reload
//      still shows it), Ships from, "Set me up" where the seller's account has
//      no payment or returns policy (it makes NeonBinder's standard ones on
//      eBay; it never makes shipping policies, NEO-423), then a pick in each of
//      Cards under $20 and $20 and up from the seller's OWN shipping policies
//      (see "Sandbox seller precondition" below), Payment and Returns; the
//      checklist reads "You're all set". The weight stays 3 oz for the listing run.
//
// Sandbox seller precondition (also in SET-REGISTRY.md). NeonBinder no longer
// makes shipping policies (eBay's sandbox refuses every create holding
// Standard Envelope; NEO-423 tracks making them later), so the sandbox seller
// account MUST already hold the fulfillment policy "NB Tracked (USPS Ground
// Advantage)" and "NB Free Shipping" (both left there by earlier runs, when
// Set me up still made them). The spec picks NB Free Shipping for cards under
// $20, the price it lists at: eBay's sandbox cannot rate CALCULATED shipping,
// so a publish against the calculated NB Tracked policy fails 25007 every
// time, while the flat free policy publishes (production sellers use
// calculated shipping). For $20 and up it picks NB Free Shipping and then NB
// Tracked, to prove a changed pick saves (no card here lists at $20 or more,
// so that calculated pick is never published). If either is missing the spec
// fails naming it; add it on the sandbox seller by hand (eBay's business
// policies), never in code.
//
// What this spec cannot prove, and where it is proven instead. Because the
// sandbox seller must hold shipping policies for the listing to go up, the
// page's no-shipping-policies state (the "Make a shipping policy on eBay"
// link and "Check eBay again", with its focus and live line) never shows here;
// it, and "Set me up never makes a shipping policy", are proven by the
// component tests (app/profile/credentials/ebay/*.test.tsx) and the
// createStandardPolicies unit tests (convex/ebayConnect.test.ts) only. The
// sandbox seller already holds payment and returns too, so on CI Set me up is
// not offered and its offered arm below does not run (the not-offered arm
// asserts that, by name). Likewise the 3 oz card weight reaching the package
// eBay prices is unit-only (convex/listingDrainEbay.test.ts, the item's
// packageWeightAndSize): the sandbox does not show the item body back, so
// the spec proves the weight is saved and kept (step 4), not what eBay got.
//   5. They set a common price, then put copies of the first three 1988 Topps
//      Base cards in the box, with a photo on two of them only (eBay listings
//      need one): the FIRST has a plain quick-count copy and then a second line
//      from a scanned pair (NEO-427: the oldest copy WITH photos feeds the
//      listing, so the older photoless line does not hold it; Add cards, a real
//      scan pair read and matched, the card picked by hand, Save; the tile says
//      "Photos are in!", the scans ride on the saved copy with no further
//      action), the SECOND gets a photo by hand in its drawer, the third none.
//      A photo alone sets no line apart (NEO-431): the quick count counts photo
//      lines and no field names another line beside its number, so the first
//      card reads 2 (plain + scanned), the second 1 and the third 1. They press
//      Sync, follow "See what's syncing" (Back returns), and Sync status reads
//      the eBay section's set with 2 listed and 1 skipped: the third card is
//      held back, named, with eBay's no-photo reason. This is the proof the
//      scanner's photos reach eBay: the first card lists on the photos the save
//      put on it.
//   6. They turn the box's "Listed on marketplaces" off, Sync again, and the
//      set reads 0 listed, with the two cards taken to 0 and nothing held back.
//      The Sales tab names eBay (its orders link and its empty state; Back
//      returns).
//   7. They tidy up (cards out of the box: the third by its quantity; the first
//      card's two lines come down by a quick count from 2 to 1, since a lower
//      takes the photoless line before one with photos, so the plain copy goes
//      and the scanned line stays; the two lines with a photo then go through
//      the card drawer's Remove, which also carries the drawer's axe states;
//      the scan run closed with "Done adding photos" (the box is in-person by
//      now, so closing it lists nothing); the common price cleared, the box
//      deleted) and Disconnect eBay (the confirm dialog),
//      which takes down anything NeonBinder put up on eBay and leaves the
//      account not connected. The afterEach does the same on a failure.
//
// What "2 listed" proves about eBay. The drain reads the seller's inventory,
// creates the inventory items and offers, PUBLISHES them and reads the result;
// a card eBay would not take becomes a held-back card with a reason (no photo,
// a missing item detail, a rejection). It uploads no photo here: eBay's
// sandbox has no picture upload (its Media API reference: "This method is not
// supported in Sandbox environment."), so on the sandbox the drain sends each
// item with NB's fixed sandbox test picture instead, as the sandbox refuses an
// item with none (errorId 25717; `EBAY_SANDBOX_TEST_PICTURE_URL`). NB still
// requires the photo: a card without one is held back on both. So the end
// state of a sync is two things together: the set's "N listed" count line and
// the "held back" list (here exactly the one card left without a photo; at the
// end, none). The spec never calls eBay itself and shows no eBay
// listing of its own (a product gap if a collector should see one).
//
// Waits. Every step gets the standard 7 s budget (GUIDE hard rule 3), the
// eBay calls included: reading the seller's policies, "Set me up", saving a
// pick or the ships-from address, the Sync results and the disconnect's
// takedown, and (NEO-427) "Photos are in!" on the scanned save's tile, where
// the server derives both sizes of each side from the scan and files them on
// the copy. A step that needs longer is a finding to report, never a number to
// raise. The longer waits are the seed hop's one full page load (`LAUNCH_GATE`),
// the scan pair's crop and read (`PAIR_PROCESSING`, the placeholder pipeline's own
// exception) and the signed-off "Go live" ceiling at its call. No timer and no
// cron path: the 15-minute poll is deliberately not exercised.
//
// Sync's toast. A press that sets a run going toasts "Syncing <title> now.
// Watch it on Sync status."; both presses assert it before reading the result.
//
// The scanned pair (NEO-427). The two scans are the placeholder pipeline's own
// scanner-bed cards (`public/placeholder-fixtures/01-vorkle-*.jpg`), which the fast
// crop stage takes without waking the heavy model: every intake scan's back
// escalates, so those would queue behind any other spec's heavy call. They name a
// player that means nothing in 1988 Topps Baseball, so the card is picked by hand
// ("Wrong card? Find it"), exactly as the real-scans spec fixes a misread: the pair is
// the INPUT, the card is the first row of the checklist. The scanner app itself
// needs a real scanner, so the run is the Add cards photo drop; the save and the
// photo attach behind it are the same path a scanner run takes.
//
// R7/R7a. 1988 Topps Baseball is a registered real set (SET-REGISTRY.md): this
// spec is the SOLE writer of the sandbox seller account's listings and writes
// no card, player, team or variant of the set. Its NB writes are the signed-in
// user's own rows (the eBay connection and setup, a minted box, copies of three cards
// in a box (a photo on two, one of them from a scan run), an intake run, the common price,
// and every other box set to in-person, which is left that way). It makes NeonBinder's standard payment and returns
// policies on the sandbox seller's eBay account where it has none ("Set me
// up"); those stay on eBay and are found again by the next run. It makes no
// shipping policy. The listings end taken down and the
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
  collectorCascade,
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
/** The second card's hand-added front photo. */
const HAND_PHOTO = "03-bowe-front.jpg";
/** The first card's scanned pair (front, then back), dropped into an Add cards run. */
const SCAN_PAIR_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public", "placeholder-fixtures");
const SCAN_PAIR = ["01-vorkle-front.jpg", "02-vorkle-back.jpg"] as const;
/**
 * The scan pair's crop, read, pairing and match on the preprocess service's
 * FAST path (frame-filling scans; no heavy escalation). The same ceiling
 * pipeline-fast-crops-inset-scans gives six photos on that path; a real model
 * read cannot fit the 7 s budget, so this is the placeholder pipeline's own
 * exception, as the real-scans spec's PIPELINE is. Every collector action
 * around it runs at 7 s. Signed off by Jason, 2026-11-03.
 */
const PAIR_PROCESSING = 60_000;

/**
 * The sandbox seller's own shipping policies the spec picks (made by hand or
 * by an earlier NB that still made shipping policies; NB makes none now).
 */
const TRACKED_POLICY = "NB Tracked (USPS Ground Advantage)";
const FREE_POLICY = "NB Free Shipping";
/** Why a missing shipping policy fails the run: a sandbox-account precondition, not a product bug. */
const mustHoldPolicy = (name: string, slot: string) =>
  `the eBay sandbox seller must already hold the shipping policy "${name}" (offered under ${slot}). ` +
  "NeonBinder no longer makes shipping policies (NEO-423), so add it on the sandbox seller's eBay account by hand " +
  "(see the spec header and SET-REGISTRY.md)";

/** At or above eBay's $0.99 floor, and under $20 (the Cards under $20 slot). */
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
const written: { connected?: boolean; disconnected?: boolean; priced?: boolean; runUrl?: string } = {};

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
      // The scan run, closed so it never holds one of the account's active-run slots.
      if (failed && written.runUrl) {
        await clean.goto(written.runUrl);
        await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
        const done = clean.getByRole("button", { name: "Done adding photos" });
        if (await done.isVisible()) await done.click();
        written.runUrl = undefined;
      }
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
    written.runUrl = undefined;
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

    // --- 4. Setup: card weight, ships from, shipping, payment, returns ------------------
    // The weight of a single card, packed: eBay's calculated shipping charges
    // the buyer by it. A fresh connection reads the default, 1 oz (a
    // disconnect clears the setup, and step 3 already proved this one starts
    // from nothing: "5 to go"). Enter on 3 oz saves it, the way a collector
    // whose envelopes always weigh 3 oz would; it stays 3 for the listings.
    const weight = page.getByRole("radiogroup", { name: "Weight of a single card", exact: true });
    const oneOz = weight.getByRole("radio", { name: "1 oz", exact: true });
    const threeOz = weight.getByRole("radio", { name: "3 oz", exact: true });
    await expect(page.getByRole("heading", { level: 3, name: "Packing", exact: true })).toBeVisible();
    await expect(oneOz).toBeChecked();
    await expect(weight.getByRole("radio", { checked: true })).toHaveCount(1);
    await threeOz.focus();
    await page.keyboard.press("Enter");
    await expect(said("Saved. Each card weighs in at 3 oz.")).toBeVisible();
    await expect(threeOz).toBeChecked();
    await expect(threeOz).toBeFocused();
    await expect(weight.getByRole("radio", { checked: true })).toHaveCount(1);
    await expectAccessible(page, { label: "Profile, eBay connected, card weight saved" });
    // Saved for real: a reload (a full page load, so the launch gate applies) still reads 3 oz.
    await page.reload();
    await expect(connectedLine).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(threeOz).toBeChecked();
    await expect(weight.getByRole("radio", { checked: true })).toHaveCount(1);

    // The seller's policies are read from eBay when the page opens (a live round
    // trip). The read has finished when the first of the seller's own policies
    // for Cards under $20 is on screen. The sandbox seller always has shipping
    // policies (the precondition above), so the read landing IS that radio;
    // "Set me up" renders in the same paint, so its presence is settled then.
    const underTwenty = page.getByRole("radiogroup", { name: "Cards under $20", exact: true });
    const setMeUp = page.getByRole("button", { name: "Set me up", exact: true });
    await expect(underTwenty.getByRole("radio").first(), mustHoldPolicy(FREE_POLICY, "Cards under $20")).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Ships from", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Shipping", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Payment and returns", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Offers", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Take Best Offers", exact: true })).toBeChecked();
    // Shipping is the seller's own pick: the page says so, and offers nothing that makes one.
    await expect(
      page.getByText(`Pick two of your own ${EBAY} shipping policies: one for cards under $20, one for $20 and up.`, { exact: true }),
    ).toBeVisible();

    // Ships from comes first on the page. "Set me up" (offered only while the
    // account has no payment or returns policy) waits for nothing: it makes no
    // shipping policy, so it needs no ship-from address.
    const setMeUpOffered = await setMeUp.isVisible();
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

    // "Set me up" is offered only where the seller's account has no payment or
    // no returns policy: it makes NeonBinder's standard ones on eBay (never a
    // shipping policy); once they exist (an earlier run made them) it is gone.
    if (setMeUpOffered) {
      await expect(setMeUp).toBeEnabled();
      await setMeUp.click();
      // A live round trip to eBay per policy (each create takes seconds), so
      // the page ticks each step off as eBay answers: "Set me up, step by
      // step", the account check first, then payment and returns in run order.
      // Each wait below covers exactly ONE step landing, within the standard
      // budget (the sync ledger's pattern, `followRunToEnd`). The ledger is
      // this press's own run: the page never shows an earlier run's.
      const ledger = page.getByRole("list", { name: "Set me up, step by step", exact: true });
      await expect(ledger).toBeVisible();
      const steps = ledger.getByRole("listitem");
      // The answer: "Made N on your eBay account …", or "You already had
      // everything" on a re-run. Both are the success status line, never the error.
      const answer = said(/^(Made \d+ on your eBay account|You already had everything)/);
      // Walked in run order (`nth` is the step's place in the run, which never
      // changes; the steps after the account check appear once it lands). One
      // pass per step, at most three (the check, payment, returns); a step
      // already settled (done, or already on eBay) passes at once.
      for (let i = 0; i < 4; i++) {
        const step = steps.nth(i);
        // Either this step is on the ledger, or every step has landed and the run has answered.
        await expect(step.or(answer).first()).toBeVisible();
        if (await answer.isVisible()) break;
        if (i === 1) {
          // The running ledger (the check landed, a policy under way), checked once.
          await expectAccessible(page, { within: ledger, label: "Profile, eBay Set me up running" });
        }
        // That one step lands: done, eBay said no (the run stops there), or nothing to do.
        await expect(step).toHaveAccessibleName(/, (done|eBay said no|already on eBay|not made)$/);
      }
      await expect(answer).toBeVisible();
      // Every step is made now or was already there, and none of them is shipping.
      await expect(ledger.getByRole("listitem", { name: /, eBay said no$/ })).toHaveCount(0);
      await expect(ledger.getByRole("listitem", { name: /, (working|waiting|not made)$/ })).toHaveCount(0);
      await expect(ledger.getByRole("listitem", { name: new RegExp(`^(${escapeRegExp(TRACKED_POLICY)}|${escapeRegExp(FREE_POLICY)}),`) })).toHaveCount(0);
    } else {
      // The arm CI takes: the sandbox seller already holds payment and returns
      // policies, so nothing is offered to make, and shipping is still theirs
      // to pick. Asserted, not assumed: Set me up is gone, both of the seller's
      // own payment and returns policies are offered, and the page still says
      // shipping is the seller's pick.
      await expect(setMeUp).toBeHidden();
      for (const group of ["Payment", "Returns"]) {
        await expect(page.getByRole("radiogroup", { name: group, exact: true }).getByRole("radio").first()).toBeVisible();
      }
      await expect(
        page.getByText(`Pick two of your own ${EBAY} shipping policies: one for cards under $20, one for $20 and up.`, { exact: true }),
      ).toBeVisible();
    }
    // $20 and up: a tracked policy, picked BY NAME from the seller's own
    // (Standard Envelope only covers cards under $20, so the picker offers no
    // envelope-only policy). Free shipping first, then tracked: a pick that
    // CHANGES the saved one saves, says "Saved.", and the second pick leaves
    // tracked chosen.
    const twentyPlus = page.getByRole("radiogroup", { name: "$20 and up", exact: true });
    const free = twentyPlus.getByRole("radio", { name: FREE_POLICY, exact: true });
    const tracked = twentyPlus.getByRole("radio", { name: TRACKED_POLICY, exact: true });
    await expect(free, mustHoldPolicy(FREE_POLICY, "$20 and up")).toBeVisible();
    await free.click();
    await expect(free).toBeChecked();
    // Saving a pick re-reads the seller's policies on eBay (a live round trip).
    await expect(said(/^Saved\.$/)).toBeVisible();
    await expect(tracked, mustHoldPolicy(TRACKED_POLICY, "$20 and up")).toBeVisible();
    await tracked.click();
    await expect(tracked).toBeChecked();
    await expect(twentyPlus.getByRole("radio", { checked: true })).toHaveCount(1);
    // Cards under $20 (the price this spec lists at): the seller's flat NB
    // Free Shipping policy, picked BY NAME. eBay's sandbox cannot rate
    // CALCULATED shipping, so publishing against the calculated NB Tracked
    // policy fails 25007 every time; production sellers use calculated
    // shipping. Every run starts from an empty setup (a disconnect clears
    // it), so this pick always saves.
    const underTwentyFree = underTwenty.getByRole("radio", { name: FREE_POLICY, exact: true });
    await expect(underTwentyFree, mustHoldPolicy(FREE_POLICY, "Cards under $20")).toBeVisible();
    await underTwentyFree.click();
    await expect(underTwentyFree).toBeChecked();
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

    // --- 5. Stock the box: a price, a scanned pair, one copy each of two more cards, a photo on two ---
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

    // --- The first card gets a plain copy first (NEO-427: oldest copy WITH photos) ---
    // One quick-count copy of the first card, no photo, before the scan run. The
    // scan then saves as a SECOND line of the same card (a scanned save never
    // folds), and the listing has to take its photos from the scanned line, not
    // hold the card for the older line that has none. eBay lists one offer per
    // card and condition at the group's quantity (both copies, 2); no screen
    // shows that number, so the proof is that the card still lists, and the
    // box's count below (copies, not cards).
    const rowOf = (short: string) =>
      boxList
        .getByRole("listitem")
        .filter({ has: page.getByRole("textbox", { name: `Quantity of ${short} in ${boxName}`, exact: true }) });
    await fieldA.fill("1");
    await page.keyboard.press(leaveKey(isMobile));
    await expect(fieldB).toBeFocused();
    await expect(rowOf(a).getByText("Saved")).toBeVisible();
    await expect(said(new RegExp(`^Boxed 1 more of ${escapeRegExp(a)}\\.`))).toBeVisible();

    // --- The first card then comes from a scanned pair (NEO-427) --------------------
    // Add cards, into this box, in this set: the pair is read and matched, the
    // card is picked by hand (the scan names a number and a player that mean
    // nothing in 1988 Topps), and Save puts the scans on the copy it makes.
    // Nothing else is done for the photos; the Sync below lists the card on them.
    // "Done adding photos" waits for the tidy-up: closing a run into a listed box
    // lists its cards at once, and this card is meant to list on the Sync press.
    await tabs.getByRole("link", { name: "Add cards", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=add/);
    await page.getByRole("combobox", { name: "Put them in this box" }).selectOption({ label: boxName });
    await page.getByRole("button", { name: "Set: pick one" }).click();
    const { cascade, drill } = collectorCascade(page, "Sport, year, brand, set and variant");
    await drill("Sports", TOPPS_1988.sport, "Years");
    await drill("Years", TOPPS_1988.year, "Brands");
    await drill("Brands", TOPPS_1988.manufacturer, "Sets");
    await drill("Sets", TOPPS_1988.set, "Variant Types");
    // The Base type is the variant: picking it folds the panel back into its button.
    await cascade
      .getByRole("listbox", { name: "Variant Types" })
      .getByRole("option")
      .filter({ has: page.getByText("Base", { exact: true }) })
      .click();
    await expect(page.getByRole("button", { name: `Set: ${TITLE}`, exact: true })).toBeVisible();
    // The price is set, so the listed box is not held: the zone takes the photos.
    const dropzone = page.getByLabel("Drag your card photos here, or browse your files");
    await expect(dropzone).not.toHaveAttribute("aria-disabled", "true");
    await dropzone.setInputFiles(SCAN_PAIR.map((n) => path.join(SCAN_PAIR_FIXTURES, n)));
    await expect(said("Sent 2 photos.")).toBeVisible();
    await expect(page).toHaveURL(/[?&]run=/);
    written.runUrl = page.url();
    const waiting = page.getByRole("region", { name: /^Needs you, \d+$/ });
    const savedLane = page.getByRole("region", { name: /^Saved, \d+$/ });
    // Read, paired and matched on the fast path (PAIR_PROCESSING, above).
    await expect(waiting).toHaveAccessibleName("Needs you, 1", { timeout: PAIR_PROCESSING });
    await waiting.getByRole("button", { name: /^Review / }).click();
    const review = page.getByRole("dialog");
    await review.getByRole("button", { name: "Wrong card? Find it" }).click();
    const numberOfA = a.split(" ")[0];
    await review.getByRole("combobox", { name: /^Find the card in / }).fill(numberOfA.replace(/^#/, ""));
    await review.getByRole("option", { name: new RegExp(`^${escapeRegExp(numberOfA)} `) }).click();
    await expect(review.getByText("You picked", { exact: true })).toBeVisible();
    await review.getByRole("button", { name: "Save this card" }).click();
    await expect(review).toBeHidden();
    await expect(savedLane).toHaveAccessibleName("Saved, 1");
    // The scans come along: the tile goes from slipping them in to "Photos are in!".
    const scanTile = savedLane.getByRole("listitem").filter({ hasText: "Saved +1" });
    await expect(scanTile).toHaveCount(1);
    await expect(scanTile.getByText("Photos are in!", { exact: true })).toBeVisible();
    // Positive first (above): none of the other four photo lines is on it.
    for (const other of ["Slipping in the photos…", "Photos didn't stick.", "The scans aged out.", "These scans won't cut it."]) {
      await expect(scanTile.getByText(other, { exact: true })).toHaveCount(0);
    }
    await expectAccessible(page, { label: "Add cards, a box run's saved card with its photos in" });
    // To the checklist and Back: the run is on the URL, so Back is the run again.
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=add/);
    await expect(savedLane).toHaveAccessibleName("Saved, 1");
    // The tab reopens the checklist where it was left, adding to the box.
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await adding.selectOption({ label: boxName });
    // The scanned copy is a second line in the box, with its photos. A photo
    // alone sets no line apart (NEO-431), so the quick count counts it with the
    // plain copy (1 + 1) and no other line is named beside the number.
    await expect(fieldA).toHaveValue("2");
    await expect(fieldA).not.toHaveAccessibleDescription(/also here/);

    // --- The other two: one copy each by quick count --------------------------------
    // Once a card's copy has its photo the field still counts it, and names no
    // other line ("also here: ...", the field's description, no longer exists):
    // the first card reads 2 (plain + scanned), the second 1 once its hand-added
    // photo is on, the third 1 without one.
    const expectPhotoCopiesCounted = async () => {
      for (const [field, count] of [[fieldA, "2"], [fieldB, "1"], [fieldC, "1"]] as const) {
        await expect(field).toHaveValue(count);
        await expect(field).not.toHaveAccessibleDescription(/also here/);
      }
    };
    await fieldB.fill("1");
    await page.keyboard.press(leaveKey(isMobile));
    await expect(fieldC).toBeFocused();
    await fieldC.fill("1");
    await page.keyboard.press(leaveKey(isMobile));
    await expect(rowOf(b).getByText("Saved")).toBeVisible();
    await expect(rowOf(c).getByText("Saved")).toBeVisible();
    await expect(said(new RegExp(`^Boxed 1 more of ${escapeRegExp(c)}\\.`))).toBeVisible();

    // A photo on the second copy by hand (the first has the scan's): NB lists on eBay
    // only with one (on the sandbox the photo stays in NB; eBay gets none, see the
    // header). The third copy gets none, on purpose: a card without a photo must be held back, with
    // its reason, on the very Sync that lists the other two. (Why a third card,
    // not a photo added to the held one for a second Sync: a press within a
    // minute of the last stamped press is throttled, and the second press would
    // stamp the set, throttling the in-person Sync that follows it.)
    // The card's drawer, the boxed copy's line, its Photos box. A box row's
    // Details opens the drawer already editing the card's ONE line (the line
    // has no Edit button while its form is up), the same as a click on a
    // collection row does (copy-photos-add-replace-remove). The heading says
    // the card has exactly one line, so this is that case and not another.
    const attachPhoto = async (short: string, photo: string, axeLabel?: string) => {
      const drawer = page.getByRole("dialog", { name: new RegExp(`^${escapeRegExp(SET_LABEL)} ${escapeRegExp(short)}`) });
      await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
      const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}`, exact: true });
      await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)", exact: true })).toBeVisible();
      const editForm = yourCopies.getByRole("form", { name: /^Edit Raw, / });
      await expect(editForm).toBeVisible();
      const panel = editForm.getByRole("region", { name: /^Photos of / });
      await expect(panel.getByText("No front photo yet")).toBeAttached();
      await panel.getByLabel("Front photo file", { exact: true }).setInputFiles(path.join(FIXTURES, photo));
      await expect(panel.getByRole("status")).toHaveText("Front photo saved.");
      if (axeLabel) await expectAccessible(page, { within: drawer, label: axeLabel });
      await drawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(drawer).toBeHidden();
    };
    // The tidy-up's half of the same drawer (step 7): Details opens editing the
    // card's one line, Cancel puts its Edit and Remove back, and Remove takes
    // the copy, photo and all, out of the box.
    const removeOnlyCopy = async (short: string, axe = false) => {
      const drawer = page.getByRole("dialog", { name: new RegExp(`^${escapeRegExp(SET_LABEL)} ${escapeRegExp(short)}`) });
      await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
      const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}`, exact: true });
      await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)", exact: true })).toBeVisible();
      const editForm = yourCopies.getByRole("form", { name: /^Edit Raw, / });
      await expect(editForm).toBeVisible();
      if (axe) await expectAccessible(page, { within: drawer, label: "Card drawer, a boxed copy with its photo, editing" });
      await editForm.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editForm).toBeHidden();
      await yourCopies.getByRole("button", { name: new RegExp(`^Remove ${escapeRegExp(short)}, Raw, `) }).click();
      await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
      if (axe) await expectAccessible(page, { within: drawer, label: "Card drawer, its only copy removed" });
      await drawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(drawer).toBeHidden();
      // Out of the box: nothing counted, nothing named beside the number.
      const field = quantityField(boxList, short, boxName);
      await expect(field).toHaveValue("0");
      await expect(field).not.toHaveAccessibleDescription(/also here/);
    };
    await attachPhoto(b, HAND_PHOTO, "Card drawer, a boxed copy with its front photo");
    await expectPhotoCopiesCounted();
    // The box's quantities with the copies that have photos counted like any other.
    await expectAccessible(page, { within: boxList, label: "Inventory checklist, boxed copies with their photos counted" });

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
    // each within the standard budget except going live (below): the new run is in view (its ledger under
    // Running now, or its own result line if it already finished), then the
    // items, the offers and going live land in turn (no photo uploads: the
    // sandbox has no picture upload, see the header). The
    // line is the drain's own count: the two cards with a photo are listed,
    // the third is the one skipped.
    const run = syncRun(platform, SET_LABEL, EBAY);
    const listedLine = row.getByText(/^2 listed(, \d+ updated)?, 1 skipped$/);
    await expect(run.underWay(listedLine)).toBeVisible();
    // Uploading photos is a step only while a picture has to go up, and on the
    // sandbox none ever does (no picture upload there), so the first step to
    // land is the items. The "Upload photos" alternative is kept so the same
    // line reads right against production eBay, where it is the first step.
    await expect(run.step("Upload photos").or(run.step("List the cards")).first()).toBeVisible();
    await expect(run.step("List the cards")).toBeVisible();
    await expect(run.step("Set prices")).toBeVisible();
    // Going live is the one step with a longer budget, a ceiling Jason signed
    // off on 2026-11-03 (GUIDE hard rule 2). The step is one eBay publishOffer
    // call per offer, all in parallel, so it lasts as long as the slowest call.
    // Measured on the sandbox: 5.1, 9.0, 9.1 and 10.9 s in CI, 6.1 s on dev;
    // our own work in the step is well under a second. Void it if the step
    // gains any work of ours, or if offers stop publishing in parallel.
    await expect(run.step("Go live")).toBeVisible({ timeout: 15_000 });
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
    await expectPhotoCopiesCounted();

    // --- 6. The box goes in-person: Sync takes both down ----------------------------------
    await page.goto("/inventory?tab=boxes");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    // Four copies for sale: the first card's plain and scanned copies, the second's and the third's.
    await expect(boxSpine(4)).toBeVisible();
    await boxSpine(4).click();
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
    // The card with no photo: a quick count to 0.
    await emptyBoxCards(page, TOPPS_1988, boxName, [c], isMobile, "reopened");
    // The first card holds two lines, its plain copy and the scanned one. A
    // lower takes the photoless line first (NEO-431), so a quick count from 2 to
    // 1 pulls the plain copy and leaves the scanned line, with its photos, as the
    // card's only one. The status line says no photos went with it.
    await fieldA.fill("1");
    await page.keyboard.press(leaveKey(isMobile));
    await expect(fieldA).toHaveValue("1");
    await expect(said(new RegExp(`^Pulled 1 of ${escapeRegExp(a)} from ${escapeRegExp(boxName)}\\. 1 left\\.`))).toBeVisible();
    await expect(fieldA).not.toHaveAccessibleDescription(/also here/);
    // The two cards' photo lines: each goes the way a collector removes a copy
    // they photographed, from the card's drawer (the same drawer that added the
    // second's photo), which keeps the drawer's editing and removed states under axe.
    await removeOnlyCopy(a, true);
    await removeOnlyCopy(b);
    await clearChecklistCommonPrice(page, checklist, TITLE, COMMON_PRICE);
    written.priced = false;

    // The scan run is closed ("Done adding photos"); its box is in-person now and
    // its copy is gone, so closing it lists nothing. A full page load, so the launch gate applies.
    await page.goto(written.runUrl!);
    await expect(page.getByRole("button", { name: "Done adding photos" })).toBeVisible({ timeout: LAUNCH_GATE });
    await page.getByRole("button", { name: "Done adding photos" }).click();
    await expect(page.getByText("This run's photos are all in. To add more, start a new run.")).toBeVisible();
    written.runUrl = undefined;

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
