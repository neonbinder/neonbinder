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
//      listed box is held. The checklist says why and the + for a card is off.
//      Photo intake (NEO-452) says nothing until a set is picked (the zone is
//      open and not aria-disabled); picking the set shows the same warning once
//      with its "Set a Min price" button, opens Defaults and puts the keyboard
//      on the Min price. Photos dropped then wait in the browser, "waiting on a
//      price", and nothing is uploaded (no run on the URL). Setting the Min
//      price with them still waiting sends them on their own ("Sent 2
//      photos.", a run on the URL; Done closes it), and New run blanks the Min
//      price so a drop waits on the price again; Remove photos empties the tray. This is the only live proof of the warning, because it
//      needs a real listing state (a box that lists, a syncing sign-in, no common
//      price). Setting the common price lifts the checklist's hold. ("Done
//      adding photos" also shows "See what's syncing", but that path needs a
//      real upload through preprocess and Vision, so it is covered by unit tests
//      only.)
//   2c. NEO-432: a photo on a BINDER copy never queues a card. With listing on,
//      they give a third card a copy in their Main binder (Collection), attach a
//      front photo through the copy drawer, swap it to the back and remove it,
//      then remove the copy. Those three photo changes would each queue the
//      card on a listing account if the copy's home were a listed box; a binder
//      is never listed, so step 3's queue holds exactly the box's two cards and
//      NOT this one (asserted by name). The unit tests prove the gate
//      (`copyPhotos.test.ts`); this proves it live, in the queue a collector reads.
//   3. They put one copy each of the first two 2024 Topps Chrome Future Stars
//      cards (Insert › Future Stars) in their box; Sync status queues the two
//      cards; they press the checklist's Sync, follow "See what's syncing" to
//      Sync status (Back returns), and Sync
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
// Waits. A Sync is a live BSC round trip of serial sheet reads, a PUT and a
// read-back, and Sync status ticks each of those off as it lands (a ledger of
// steps: "Read Excellent, done"). So the spec walks the run (`followRunToRest`):
// every wait is the standard 7 s for exactly ONE step to land, never for the
// whole trip or for several steps at once (GUIDE hard rule 3; Jason,
// 2026-11-02), then for the set's result line. Two waits go past 7 s. A BSC read
// or double-check keeps the signed-off ceiling (`bscReadCeiling`, support/
// marketplace-wait.ts). Every other step of the walk (NEO-487) waits 7 s of our
// own time plus the seconds BSC is visibly holding it ("Waiting on
// BuySportsCards...": if BSC took n s, the step gets n + 7 s, never a flat
// bump; `expectAfterMarketplace` records n in the report). The seed hop's
// sign-in when the sign-in is saved again (`saveBscSignIn`) is the other.
//
// Two triggers (NEO-433). A set's sync is set going by the press of the
// checklist's Sync and by the 15-minute sales poll, and the poll can list a
// stocked box before the press lands. Both orders are real product behaviour,
// so the spec neither forces the press to win nor turns the poll off; it keeps
// the slow axe checks out of the window between its last write and the press,
// and holds either order to a hard end state:
//   - press first: the cards are queued until the press, the press sends them
//     (the ledger holds a read, the send, a double-check), the row reads
//     "2 listed, 2 updated" (or "2 listed" when BSC already showed them);
//   - poll first: the Sync status row already reads "2 listed" with its folded
//     "Gathering data" item, and the press is a full read that sends nothing:
//     the row reads "2 listed" and the ledger is exactly "Gathering data" then
//     "Nothing new to send" (a run that sends nothing still holds a check step,
//     "Compare with your boxes", which the finished row folds into the first).
// A run that sent nothing is told apart by the absence of the send step, and
// asserted as such; a missing ledger is red in either order. The in-person
// press has the same two orders (a poll that takes the cards off first).
//
// A press is proven to have RUN before either order is read. The row a poll
// leaves behind looks like a press's own, and the page says "Nothing syncing
// right now." between two runs, so neither the row nor the idle line is evidence.
// The press's queued cards are: the press writes them (its toast comes after),
// and a run's finish clears them in the same write that records its result, but
// only if the run claimed them (a run under way when the press landed leaves
// them, and the set goes round again). So the spec walks step by step until the
// queue holds no card of the set and the platform is idle (`followRunToRest`),
// and only then reads the row and picks the order: a press whose run never
// claims leaves its cards queued and goes red in both orders.
//
// The ledger's steps (convex/listingDrain.ts `bscSheetSteps`; labels in
// inventory/listing/copy.ts): one "Read <conditions>" per BSC sheet, "Send
// changes to BuySportsCards", then one "Double-check <conditions>" per sheet
// the send touched, all listed under Running now while the run is under way.
// Once it has finished, the set's row folds them: the reads become one
// "Gathering data" item, the double-checks are dropped, the send stays. A wait
// for a read or a confirm therefore goes through `readLanded` / `confirmLanded`
// (the running item, or the folded row if the run ended first), never a bare
// `step`. NEO-475: a run reads only the sheets NB needs: the conditions its
// copies sit in now, plus any it has listed in before (so a row NB once pushed
// is still found and zeroed). Every copy this spec makes sits at the default
// condition, Excellent, so a run reads the one Excellent sheet. This spec does
// NOT assert the read count: the finished row folds the reads into "Gathering
// data", which names no condition, and the running ledger can end inside any
// one wait. The count is proven by the unit tests (`listingDrain.test.ts`) and
// the drain's `conditionsRead` telemetry. The live proof here is the flow: the
// copies are listed, then the takedown Sync still finds the Excellent row it
// pushed and zeroes it. Both Syncs assert what every run holds, in order: a
// read, the send, a confirm.
//
// Sync's toast. A press that sets a run going toasts "Syncing <title> now.
// Watch it on Sync status."; both presses assert it before reading the result.
//
// R7/R7a. 2024 Topps Chrome › Insert › Future Stars is a registered real set
// (SET-REGISTRY.md, provisioned by the seed): this spec is the SOLE writer of
// its BSC quantities and writes no card, player, team or variant of the set.
// NEO-475: it moved here from 1988 Topps Base, whose 792-card BSC sheet reads
// ran 6-8 s and drifted past BSC's 30 s gateway; this insert has 20 cards.
// Both are modern on BSC (vintage ends at 1980, convex/lib/bscConditions.ts),
// so the copies still sit at Excellent and a run reads the one Excellent
// sheet. The cards list at a $900 common price (`PRICE`) so no real buyer takes
// one. Its NB writes are the signed-in user's own rows
// (the sign-in removed and saved again, a minted box, two box copies, one
// binder copy with a photo that is removed again, the common price, and every
// other box set to in-person, which is left that way). The
// quantities end at 0 on BSC and the sign-in is saved again, on a pass by the
// steps and the hook, on a failure by the hook on a second page (so the
// failure screenshot keeps the page that failed).
//
// Minted box name: a single token from `env.ATTEMPT_TOKEN`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import {
  TOPPS_CHROME_2024_FUTURE_STARS,
  backToBoxes,
  cardsWord,
  checklistTitle,
  createBox,
  deleteOpenBox,
  clearChecklistCommonPrice,
  drillToCollectorChecklist,
  emptyBoxCards,
  expectNothingSent,
  followRunToRest,
  goViaShell,
  intakeDropzone,
  inventoryTabs,
  nameOf,
  ordinaryBaseRows,
  pickIntakeSet,
  putOtherBoxesInPerson,
  quantityField,
  queueSettled,
  shortNameOf,
  syncRun,
  walkForCleanup,
} from "../../support/collection";
import { removeBscSignIn, saveBscSignIn } from "../../support/credentials";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { bscReadCeiling } from "../../support/marketplace-wait";

/** The Send step's label. */
const SEND = "Send changes to BuySportsCards";
const BSC = "BuySportsCards";
const FUTURE_STARS = TOPPS_CHROME_2024_FUTURE_STARS;
const TITLE = checklistTitle(FUTURE_STARS);
/**
 * The set as Sync status and the card drawer name it. An insert reads as part of
 * the set's name (`setAndVariantLabel` in convex/lib/listingLabels.ts,
 * `cardLabel` in app/collection/final/data/labels.ts), so it is the checklist's
 * own title: "2024 Topps Chrome Future Stars".
 */
const SET_LABEL = TITLE;
/**
 * The common price the cards list at, as typed, as the toast and the line read it,
 * and as the field reads it once saved. These are real cards on a real seller
 * account, and a killed run can leave them for sale until a later run takes them
 * down, so the price is far above what any buyer pays and under BSC's $999
 * ceiling (`checkBscPrice`, `BSC_MAX_PRICE_CENTS`); Jason, 2026-11-09, as the
 * 2026 Bowman Chrome prefix spec does. The Add cards Min price (2b) uses it too:
 * that run saves nothing, but a copy it did save would list at it.
 */
const PRICE = "900";
const PRICE_SHOWN = "$900.00";
const PRICE_IN_FIELD = "900.00";
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A committed intake scan (about 1000 px wide), attached through the copy drawer's Photos box. It is never listed: its copy lives in a binder. */
const BINDER_PHOTO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake", "05-bell-front.jpg");

/** Two committed intake scans (a front and its back): dropped on Add cards to wait for a price. They are removed from the tray, never sent. */
const HELD_PHOTOS = ["01-mcfadden-front.jpg", "02-mcfadden-back.jpg"].map((n) =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake", n),
);


/**
 * NEO-432. On the Collection Checklists tab with the Main binder picked: click
 * the card's row, which opens the drawer already editing its one line, and
 * return the drawer's pieces (the form's Photos box included). `short` is the
 * row's `#N First Last`.
 */
async function openBinderLine(checklist: Locator, short: string) {
  const page = checklist.page();
  await checklist.getByText(`#${/^#(\S+)/.exec(short)![1]}`, { exact: true }).click();
  const drawer = page.getByRole("dialog", { name: new RegExp(`^${escapeRegExp(SET_LABEL)} ${escapeRegExp(short)}`) });
  const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}`, exact: true });
  const form = yourCopies.getByRole("form", { name: "Edit Raw, Excellent", exact: true });
  await expect(form).toBeVisible();
  return { drawer, yourCopies, form, panel: form.getByRole("region", { name: /^Photos of / }) };
}

/** NEO-432: remove the card's one binder copy through its open drawer (Escape closes the form first, as a collector does), then close the drawer. */
async function removeBinderLine(checklist: Locator, short: string, line: Awaited<ReturnType<typeof openBinderLine>>): Promise<void> {
  const { drawer, yourCopies, form } = line;
  await form.getByRole("textbox", { name: "Notes" }).focus();
  await checklist.page().keyboard.press("Escape");
  await expect(form).toBeHidden();
  await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Excellent`, exact: true }).click();
  await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
  await drawer.getByRole("button", { name: "Close card detail" }).click();
  await expect(drawer).toBeHidden();
}

/**
 * The finished set row's "Last sync steps" list, folded: "Gathering data" (all
 * the sheet reads, or the check of a run that sent nothing), then the update
 * steps in run order. The positive asserts come first, so the negative ones
 * below cannot pass on a missing list. `sent` false is a run that sent nothing
 * (NEO-433, the poll listed first): its ledger is exactly "Gathering data" then
 * "Nothing new to send" and has no send; a sending run has no such line.
 */
async function expectFoldedLastRun(run: ReturnType<typeof syncRun>, sent = true): Promise<void> {
  await expect(run.last).toBeVisible();
  if (sent) {
    await expect(run.last.getByRole("listitem")).toContainText([
      /^Gathering data, done$/,
      new RegExp(`^${escapeRegExp(SEND)}, done$`),
    ]);
    await expect(run.nothingNew()).toHaveCount(0);
  } else {
    await expectNothingSent(run);
  }
  await expect(run.last.getByRole("listitem", { name: /^(Read|Double-check) / })).toHaveCount(0);
}

/** What the failing run needs undone, filled as the flow goes. */
const written: {
  box?: string;
  cards?: [string, string];
  /** NEO-432: the card whose Main-binder copy still stands (cleared when the body removed it). */
  binderCard?: string;
  started?: boolean;
  removed?: boolean;
  stopped?: boolean;
  priced?: boolean;
  /** NEO-452: the Add cards run the held photos started, until the body closes it. */
  runUrl?: string;
} = {};

/** The key that leaves a quantity field: Tab on a desktop, Enter on a phone. */
const leaveKey = (isMobile: boolean) => (isMobile ? "Enter" : "Tab");

/** What the checklist's inert Sync says when no marketplace sign-in is syncing. */
const NOT_LISTING_LINE = "Nothing to sync to yet. Connect a marketplace on your Profile.";
/** The consent warning beside Connect on the sign-in form (lib/marketplace/listing-copy.ts). */
const CONSENT_HEADING = "Heads up: connecting starts listing";

/**
 * The Sync status screen's BuySportsCards section and this set's "Last sync by
 * set" row, in `scope` (the page, or an admin's collector). Since NEO-415 the
 * screen has an eBay section too, saying the same things ("Nothing syncing
 * right now."), so every read of it goes through this section.
 */
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
 * On the open checklist: clear its common price (read as `was` first). Used by
 * the tidy-up and by the failure hook, so a rerun starts without one and sees
 * the listing gate's hold.
 */
const clearCommonPrice = (page: Page, checklist: Locator, was: string) =>
  clearChecklistCommonPrice(page, checklist, TITLE, was);

/** On the Inventory Checklists tab: set both cards' quantities in `box` to 0 (see `emptyBoxCards`). */
const emptyBox = (page: Page, box: string, cards: readonly string[], isMobile: boolean, arrival: "fresh" | "reopened") =>
  emptyBoxCards(page, FUTURE_STARS, box, cards, isMobile, arrival);

// Pass or fail, the worker ends connected to BSC and NOT listing. On a failure
// the touched BSC rows are first brought to 0 on a SECOND page (the failing page
// stays as the screenshot saw it); then listing is stopped, because there is no
// other way to stop it and an account left listing would put any later spec's
// boxed cards up for sale on real BSC. Idempotent: it does only what the run got
// far enough to need.
test.afterEach(async ({ context, isMobile }, testInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  const clean = await context.newPage();
  let cleanupFailure: unknown;
  try {
    try {
      // NEO-452: the Add cards run the held photos started, closed so it never holds
      // one of the account's two active-batch slots. The body clears `runUrl` the
      // moment it has pressed Done, so a run still named here is open: its Done
      // button is the one thing to wait for (7 s) and press.
      if (failed && written.runUrl) {
        await clean.goto(written.runUrl);
        await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
        await clean.getByRole("button", { name: "Done adding photos" }).click();
        await expect(clean.getByText("This run's photos are all in. To add more, start a new run.")).toBeVisible();
        written.runUrl = undefined;
      }
      // The cards are NB's zero from here on: quantities 0 in the box, then a
      // full Sync of the set, and the result waited for. A pass already proved it.
      if (failed && written.started && written.box && written.cards) {
        // No waiting on a run already under way: it can stall on a live read, and
        // the box must still empty. A press during a run is taken, and its queued
        // cards outlive that run, so the run that sees the zeros still comes.
        await clean.goto("/inventory?tab=checklists");
        await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
        const checklist = await emptyBox(clean, written.box, written.cards, isMobile, "fresh");
        await checklist.getByRole("button", { name: `Sync ${TITLE}`, exact: true }).click();
        // The press was taken before we leave the page: a missing toast means the
        // zeroing press was answered "just synced", so no run is coming.
        await expect(
          clean.getByRole("status").filter({ hasText: `Syncing ${TITLE} now. Watch it on Sync status.` }),
          'no "Syncing ... now" toast: the zeroing press was answered "just synced", so no run is coming',
        ).toBeVisible();
        await clean.goto("/inventory?tab=sync");
        // The zeroing run walked to rest, then its result line. This order matters:
        // removing the sign-in below drops the queue without withdrawing anything,
        // so a zero not sent by then stays unsent, and the hook says so at its end.
        const zeroing = syncStatus(clean);
        const zeroingRun = syncRun(zeroing.platform, SET_LABEL, BSC);
        cleanupFailure = await walkForCleanup(async () => {
          await followRunToRest(zeroing.platform, zeroingRun, queueSettled(zeroing.platform, SET_LABEL), bscReadCeiling, BSC);
          await expect(zeroing.row.getByText(/^0 listed/)).toBeVisible();
        });
      }
    } finally {
      try {
        // NEO-432: the Main-binder copy the body made and did not get to remove.
        if (failed && written.binderCard) {
          await clean.goto("/collection?tab=checklists");
          await expect(clean.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
          const binderList = await drillToCollectorChecklist(clean, FUTURE_STARS);
          await binderList.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
          await removeBinderLine(binderList, written.binderCard, await openBinderLine(binderList, written.binderCard));
          written.binderCard = undefined;
        }
      } finally {
        try {
          // A common price the run set and did not clear would hide the gate's
          // hold from the next run: clear it (after the zeroing above, which
          // needs it still set).
          if (failed && written.priced) {
            await clean.goto("/inventory?tab=checklists");
            await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
            const checklist = await drillToCollectorChecklist(clean, FUTURE_STARS);
            await clearCommonPrice(clean, checklist, PRICE_IN_FIELD);
            written.priced = false;
          }
        } finally {
          // The body already stopped listing on a pass; otherwise it stops here.
          if (!written.stopped) await stopListing(clean, written.removed);
          if (cleanupFailure) {
            throw new Error(`The hook's zeros may not have reached ${BSC}: ${String(cleanupFailure)}`);
          }
        }
      }
    }
  } finally {
    await clean.close();
  }
});

test(
  "Inventory: Sync lists a box's 2024 Topps Chrome Future Stars cards on BuySportsCards and an in-person box takes them off",
  { tag: ["@collection", "@marketplace-seller"] },
  async ({ page, signIn, env, isMobile }) => {
    // The hook's record of how far this run got starts empty.
    written.box = undefined;
    written.cards = undefined;
    written.binderCard = undefined;
    written.started = false;
    written.removed = false;
    written.stopped = false;
    written.priced = false;
    written.runUrl = undefined;
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

    // Every other box the worker has goes in-person BEFORE syncing starts (see the helper).
    await putOtherBoxesInPerson(page, boxName);

    // --- Before syncing: the worker is seeded "not syncing" -----------------------
    // Sync is shown but inert with its reason, Sync status says Not syncing, and
    // the Profile's BuySportsCards panel says so too.
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const checklist = await drillToCollectorChecklist(page, FUTURE_STARS);
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

    // --- 2c. NEO-432: a photo on a BINDER copy never queues a card ---------------
    // Listing is on now, so a photo change on a copy in a LISTED box would queue
    // its card. A third card gets a copy in the Main binder (a binder never
    // lists) and takes a front photo, a swap and a removal: the three photo
    // changes. Step 3 then reads the queue and finds only the box's two cards.
    // (The row choice is the LAST ordinary row of the Collection checklist, so
    // it cannot be one of the box's cards, which are the first two rows of the
    // Inventory checklist; the guard below re-checks once those are read.)
    await goViaShell(page, isMobile, "Collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
    await page.getByRole("navigation", { name: "Collection sections" }).getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const binderList = await drillToCollectorChecklist(page, FUTURE_STARS);
    const { short: binderCard } = await shortNameOf(ordinaryBaseRows(binderList).last());
    await binderList.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
    const haveBinderOff = binderList.getByRole("button", { name: `Have ${binderCard}`, exact: true, pressed: false });
    await expect(haveBinderOff).not.toHaveAttribute("aria-disabled", "true");
    await haveBinderOff.click();
    await expect(binderList.getByRole("button", { name: `Have ${binderCard}, Raw, Excellent`, exact: true, pressed: true })).toBeVisible();
    written.binderCard = binderCard;
    const binderLine = await openBinderLine(binderList, binderCard);
    const binderPhotos = binderLine.panel;
    await expect(binderPhotos.getByText("No front photo yet")).toBeAttached();
    await binderPhotos.getByLabel("Front photo file", { exact: true }).setInputFiles(BINDER_PHOTO);
    await expect(binderPhotos.getByRole("status")).toHaveText("Front photo saved.");
    await expectAccessible(page, { within: binderLine.drawer, label: "Card drawer, binder copy with a photo" });
    await binderPhotos.getByRole("button", { name: "Swap front and back", exact: true }).click();
    await expect(binderPhotos.getByRole("status")).toHaveText("Front and back swapped.");
    await expect(binderPhotos.getByText("No front photo yet")).toBeAttached();
    await binderPhotos.getByRole("button", { name: "Remove back", exact: true }).click();
    await expect(binderPhotos.getByRole("status")).toHaveText("Back photo removed.");
    await expect(binderPhotos.getByText("No back photo yet")).toBeAttached();
    await removeBinderLine(binderList, binderCard, binderLine);
    written.binderCard = undefined;
    await expect(binderList.getByRole("button", { name: `Have ${binderCard}`, exact: true, pressed: false })).toBeVisible();

    // --- Inventory: Sales has no switch ----------------------------------------
    await goViaShell(page, isMobile, "Inventory");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible();
    await tabs.getByRole("link", { name: "Sales", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sales/);
    await expect(page.getByRole("heading", { level: 2, name: "What sold" })).toBeVisible();
    // Listing is not a switch any more: it is the saved sign-in and the boxes.
    await expect(page.getByRole("switch", { name: /^List on / })).toHaveCount(0);

    // --- The 2024 Topps Chrome Future Stars checklist, adding to the box -------
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    const adding = page.getByRole("combobox", { name: "Adding to" });
    await expect(adding).toBeVisible();
    await drillToCollectorChecklist(page, FUTURE_STARS);
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
    expect([a, b], "the binder card (2c) is a third card, not one of the box's two").not.toContain(binderCard);

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

    // Photo intake (NEO-452): with no set picked there is no price to ask for,
    // so the box says nothing yet and the zone is open.
    await tabs.getByRole("link", { name: "Add cards", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=add/);
    await page.getByRole("combobox", { name: "Put them in this box" }).selectOption({ label: boxName });
    await expect(page.getByRole("button", { name: "Set: pick one", exact: true })).toBeVisible();
    const dropzone = intakeDropzone(page);
    await expect(dropzone).toBeVisible();
    await expect(dropzone).not.toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText(/^Price tag first!/)).toHaveCount(0);
    // Picking the set shows the warning once, opens Defaults and focuses the Min price.
    await pickIntakeSet(page, FUTURE_STARS);
    const intakeLine = `Price tag first! ${boxName} sells on your marketplaces and ${TITLE} has no price yet. Set one in Defaults and your photos go up.`;
    // The note is the zone's description (the sr-only copy in the status line is
    // a second match for the text, so the note is read through what points at it).
    await expect(dropzone).toHaveAccessibleDescription(new RegExp(escapeRegExp(intakeLine)));
    await expect(page.getByRole("button", { name: "Set a Min price", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Defaults: / })).toHaveAttribute("aria-expanded", "true");
    const minPrice = page.getByRole("textbox", { name: "Min price", exact: true });
    await expect(minPrice).toBeFocused();
    await expect(minPrice).toHaveAccessibleDescription(new RegExp(escapeRegExp(intakeLine)));
    await expectAccessible(page, { label: "Add cards, listed box with no price, Defaults open on Min price" });
    // Photos dropped now wait for the price: a tray says so, and nothing goes up.
    await dropzone.setInputFiles(HELD_PHOTOS);
    const waitingTray = said("2 photos waiting on a price.");
    await expect(waitingTray).toBeVisible();
    // The zone's description holds the hint too, so the words are read inside it.
    await expect(dropzone).toHaveAccessibleDescription(new RegExp(escapeRegExp(`${intakeLine} 2 photos waiting on a price.`)));
    await expect(page.getByText("Sending your photos…")).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]run=/);
    await expectAccessible(page, { label: "Add cards, photos waiting on a price" });
    // The central promise: the price is set with the photos still waiting, and
    // they go up on their own (no Start button): the tray empties, the status line
    // says "Sent 2 photos." and the run is on the URL.
    await minPrice.fill(PRICE);
    await page.keyboard.press("Enter");
    await expect(said("Sent 2 photos.")).toBeVisible();
    await expect(page).toHaveURL(/[?&]run=/);
    written.runUrl = page.url();
    await expect(waitingTray).toHaveCount(0);
    // Close the run so its batch slot frees (its photos keep being read; nothing is saved).
    await page.getByRole("button", { name: "Done adding photos" }).click();
    written.runUrl = undefined;
    await expect(page.getByText("This run's photos are all in. To add more, start a new run.")).toBeVisible();
    // New run: the Min price is blank again, and a drop waits on the price again.
    await page.getByRole("button", { name: "New run", exact: true }).click();
    await expect(page).not.toHaveURL(/[?&]run=/);
    const defaultsButton = page.getByRole("button", { name: /^Defaults: / });
    // The button's name carries the Min price when there is one: none is left.
    await expect(defaultsButton).toHaveAccessibleName(/^Defaults: [^,]+$/);
    await dropzone.setInputFiles(HELD_PHOTOS);
    await expect(waitingTray).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]run=/);
    // Remove photos empties the tray, and the keyboard lands on the drop zone.
    await page.getByRole("button", { name: "Remove photos", exact: true }).click();
    await expect(waitingTray).toHaveCount(0);
    await expect(dropzone).toBeFocused();
    // Back to the checklist through the tab, which reopens it where it was left.
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await adding.selectOption({ label: boxName });
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
    await expect(gateNote).toBeVisible();

    // --- A common price: the rows have no price of their own -------------------
    // Setting it lifts the hold.
    await checklist.getByRole("button", { name: `Set a common price for ${TITLE}`, exact: true }).click();
    const priceField = checklist.getByRole("textbox", { name: "Common price", exact: true });
    await expect(priceField).toBeFocused();
    await priceField.fill(PRICE);
    await page.keyboard.press("Enter");
    await expect(said(`Common price for ${TITLE} is ${PRICE_SHOWN}`)).toBeVisible();
    await expect(checklist.getByText(PRICE_SHOWN, { exact: true })).toBeVisible();
    written.priced = true;
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
    const run = syncRun(platform, SET_LABEL, BSC);
    await expect(platform.getByRole("heading", { level: 2, name: BSC, exact: true })).toBeVisible();
    await expect(platform.getByText("Listing", { exact: true })).toBeVisible();
    // Either the two cards wait for the next sync, or the 15-minute poll has
    // already listed them (the header's two orders). The poll's own result is
    // the row reading 2 listed with its folded "Gathering data" item.
    const queuedHeading = platform.getByRole("heading", { level: 3, name: "Queued for the next sync (2)", exact: true });
    const polledLine = row.getByText(/^2 listed(, 2 updated)?$/);
    await expect(queuedHeading.or(polledLine).first()).toBeVisible();
    if (await queuedHeading.isVisible()) {
      const queuedList = platform.getByRole("list", { name: "Queued for the next sync (2)" });
      const queued = queuedList.getByRole("listitem");
      await expect(queued).toHaveCount(2);
      for (const short of [a, b]) {
        const number = escapeRegExp(short.split(" ")[0]);
        await expect(queued.filter({ hasText: new RegExp(`^${number} .* in ${escapeRegExp(SET_LABEL)}`) })).toHaveCount(1);
      }
      // NEO-432: the binder card took three photo changes (2c) and is NOT queued:
      // a photo only queues a card whose copy sits in a listed box. The count of 2
      // above and this absence by name are the proof (the two rows above keep it
      // from passing on a dead list).
      await expect(queued.filter({ hasText: new RegExp(`^${escapeRegExp(binderCard.split(" ")[0])} `) })).toHaveCount(0);
      // Only the queued list: the whole-page check on this screen runs after the press (below),
      // so the poll has no slow check to win its window against.
      await expectAccessible(page, { within: queuedList, label: "Inventory Sync status, two cards queued" });
    } else {
      // The poll listed them first: its finished row, with its folded ledger.
      await expect(polledLine).toBeVisible();
      await expect(row.getByText(/^Synced /)).toBeVisible();
      await expect(run.gathered()).toBeVisible();
      await expectAccessible(page, { within: row, label: "Inventory Sync status, the poll already listed the two cards" });
    }

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
    await expectAccessible(page, { label: "Checklist, See what's syncing after Sync" });
    await seeSyncing.click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    await expect(tabs.getByRole("link", { name: "Sync status", exact: true })).toHaveAttribute("aria-current", "page");
    // Arriving by the link puts the keyboard on the screen's first heading
    // (the link it came from is gone).
    const platformHeading = syncStatus(page).platform.getByRole("heading", { level: 2, name: BSC, exact: true });
    await expect(platformHeading).toBeVisible();
    await expect(platformHeading).toBeFocused();
    await expectAccessible(page, { label: "Inventory Sync status, arrived by See what's syncing" });
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await expect(fieldA).toHaveValue("1");
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    // The live BSC round trip, one step per wait (see "Waits" above): the walk
    // waits for the step the run is on to land, again and again, until the
    // press's queued cards are gone and the platform is idle (header: a press
    // proven to have run). Only then is the set's row read, and it is a run
    // that started after the press, finished.
    // The line is the drain's own count: 2 rows on BSC show NB's stock after the
    // read-back (2 updated, or none when BSC already showed them); "skipped"
    // would be a held-back card.
    const listedLine = row.getByText(/^2 listed(, 2 updated)?$/);
    const listedNoSend = row.getByText("2 listed", { exact: true });
    await followRunToRest(platform, run, queueSettled(platform, SET_LABEL), bscReadCeiling, BSC);
    // The ledger is asserted BEFORE the branch (R2), so a row with none is red in either order.
    await expect(run.last).toBeVisible();
    await expect(run.gathered()).toBeVisible();
    await expect(listedLine).toBeVisible();
    await expect(row.getByText(/^Synced /)).toBeVisible();
    await expect(row.getByText(/held back/)).toHaveCount(0);
    // Press first: the send step is in the finished ledger. Poll first: the poll
    // listed the two cards and the press, a full read, sent nothing.
    const sent = await run.last.getByRole("listitem", { name: `${SEND}, done`, exact: true }).isVisible();
    if (sent) {
      // The double-check and the folded ledger (reads, then the send).
      await expect(run.readLanded()).toBeVisible();
      await expect(run.confirmLanded()).toBeVisible();
      // Finished, the set's row folds the run (see "The ledger's steps"): the
      // reads are one "Gathering data", then the update steps in run order (an
      // "Upload photos" may sit before the send); no read or confirm item is left.
      await expectFoldedLastRun(run);
    } else {
      // The row says "2 listed" with no "updated", and its ledger is the one
      // "Gathering data" item, with no send step.
      await expect(listedNoSend).toBeVisible();
      await expectFoldedLastRun(run, false);
    }
    await expectAccessible(page, { label: "Inventory Sync status, 2 listed, the run's steps done" });

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
    await drillToCollectorChecklist(page, FUTURE_STARS);
    await sync.click();
    await expect(said(`Syncing ${TITLE} now. Watch it on Sync status.`)).toBeVisible();
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    // The live BSC round trip, step by step. The set was 2 listed a minute ago,
    // so the row still shows the LAST run's finished steps until this one
    // claims the set: the walk ends only when the press's queued cards are gone
    // and the platform is idle, so the row read next is a run that started after
    // the press, finished. The reads fold into one data-gathering step on the
    // finished row (see "The ledger's steps" above), so that is the assertion.
    const takeDown = syncRun(platform, SET_LABEL, BSC);
    const takenLine = row.getByText(/^0 listed(, \d+ updated)?, 2 taken to 0$/);
    await followRunToRest(platform, takeDown, queueSettled(platform, SET_LABEL), bscReadCeiling, BSC);
    // The ledger is asserted BEFORE the branch (R2), so a row with none is red in either order.
    await expect(takeDown.last).toBeVisible();
    await expect(takeDown.gathered()).toBeVisible();
    await expect(row.getByText(/held back/)).toHaveCount(0);
    // Press first: the run sent the two zeros (the send step is in the finished
    // ledger). Poll first (the header's two orders): the poll already took the
    // cards off, and the press, a full read, sent nothing. Each side is asserted
    // hard: a send needs its double-check and folded ledger (and no "Nothing new
    // to send"), a run that sent nothing is "Gathering data" then "Nothing new to
    // send". Accepted limit (Jason, NEO-433): a takedown that sent nothing cannot
    // tell the poll taking the cards down first from anything else having zeroed
    // them on the seller account. CI's seller queue runs these specs one at a
    // time, so the poll is the only other writer there; locally, do not run this
    // spec while another session uses the shared seller. The line is this run's
    // count, so it says "2 taken to 0" only when this run sent them; a full read
    // that found nothing to zero reads "0 listed".
    const tookDown = await takeDown.last.getByRole("listitem", { name: `${SEND}, done`, exact: true }).isVisible();
    if (tookDown) {
      await expect(takenLine).toBeVisible();
      await expect(takeDown.readLanded()).toBeVisible();
      await expect(takeDown.confirmLanded()).toBeVisible();
      await expectFoldedLastRun(takeDown);
    } else {
      await expect(row.getByText(/^0 listed$/)).toBeVisible();
      await expectFoldedLastRun(takeDown, false);
    }

    // --- Tidy up through the product: the box's cards, the common price, the box
    // Zero before deleting, so no copy falls into the Unsorted box (a listed one).
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    // Same page since the drill above: the tab link reopens Future Stars.
    await emptyBox(page, boxName, [a, b], isMobile, "reopened");
    await clearCommonPrice(page, checklist, PRICE_IN_FIELD);
    written.priced = false;

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
