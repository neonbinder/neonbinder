// NEO-458 (R1): a collector's card of a parallel whose BuySportsCards numbers
// carry a prefix (2026 Bowman Chrome, BSC's `BCV-26`) lists on Sync, and is NOT
// held back as "numbers this card differently". The flow, as the user lives it:
//   1. The admin builds the set the way production did, through the Set Builder:
//      Football -> 2026 -> Bowman -> Bowman -> Base (BSC's base checklist fetched
//      and saved), then Parallel -> Chrome with its Card prefix set to `BCV-`
//      FIRST, and only then "Build from Base" (Chrome's cards are a copy of Base's
//      NB cards, each linked to Chrome's own BSC card by number once the prefix is
//      off BSC's). NB's own numbers stay bare: `#26`, never `#BCV-26`. That is the
//      shape the fix is about (a bare NB number against a prefixed BSC one), so the
//      spec asserts it and cannot silently stop testing it.
//   2. A collector makes a box, stocks one copy each of #26 Dak Prescott and #54
//      Patrick Mahomes II (BSC's BCV-26 and BCV-54, the cards the owner named),
//      puts a common price on the checklist, starts syncing and presses Sync.
//      Sync status reads the set listed, 2 listed, with nothing held back and no
//      "numbers this card differently" line.
//   3. They take both back to 0 and Sync again: both are taken off BSC.
//   4. They stop: the BSC sign-in is removed and saved again WITHOUT listing=on.
//      The afterEach does the same on a failure, after first zeroing the rows.
//
// No negative control for the number guard itself. A card is held for a number
// that really differs only when NB's number or BSC's ref is changed by hand, and
// neither is reachable through the product: the card drawer has no number field
// (the number is a card's identity) and a ref is only ever set by a fetch or a
// build. The guard's "a number that still differs stays held" is pinned by the
// unit tests (`lib/bscSheetPlan.test.ts`, `listingDrain.test.ts`).
//
// What "2 listed" proves about BSC: see the 1988 Topps listing spec. The drain
// reads BSC's seller sheet, plans against it, PUTs the rows that differ and
// reads them back; a card the planner refuses is "held back" with a reason. The
// old planner compared BSC's `BCV-26` with NB's `26` exactly, refused every card
// of the parallel, and Sync status read "0 listed, 2 skipped" and "2 held back".
//
// Waits. The Set Builder's cold drill, the Base fetch and the Chrome build are
// live BSC round trips on data nothing synced yet (GUIDE hard rule 3, first
// exception); each carries the helpers' own ceiling. Sync is walked one ledger
// step at a time within the standard 7 s (`followRunToEnd`). The one other wait
// above 7 s is the seed hop's sign-in when the sign-in is saved again.
//
// R7/R7a. Football -> 2026 -> Bowman is a registered real set (SET-REGISTRY.md):
// this spec is the SOLE writer of its rows (it builds them, in-flow, through the
// Set Builder) and of its BuySportsCards quantities. It is built by the spec, not
// the seed, so the seller jobs' start-clean pass skips it when absent
// (`SELLER_SPEC_SETS`, `builtBySpec`). The BSC rows end at 0 and the sign-in is
// saved again, on a pass by the steps and the hook, on a failure by the hook on a
// second page. The NB tree stays (a rerun on the same seed finds it, and the
// build steps below adopt what is there, asserting the same end state).
//
// Live branch (SportLots unpaused): the Base fetch settles the Match Cards
// dialog and the Parallel column's first visit settles the Reconcile dialog, as
// the seed does for 2024 Topps Chrome. Those branches are written to the seed's
// pattern and were not run against a live SportLots, because it is paused today.
//
// Minted box name: a single token from `env.ATTEMPT_TOKEN`.
import type { Locator, Page } from "@playwright/test";
import type { FlowEnv } from "../../support/env";
import {
  backToBoxes,
  cardsWord,
  collectorCascade,
  createBox,
  deleteOpenBox,
  followRunToEnd,
  inventoryTabs,
  putOtherBoxesInPerson,
  quantityField,
  syncRun,
} from "../../support/collection";
import { removeBscSignIn, saveBscSignIn } from "../../support/credentials";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnOption,
  columnSearch,
  drillToBaseVariant,
  drillToColdManufacturer,
  INSERT_FETCH,
  pick,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";
import { addAsNewStep, advanceToSave, answerStepAsNew, confirmSaveButton, reviewWizard } from "../../support/wizard";

const SPORT = "Football";
const YEAR = "2026";
const BRAND = "Bowman";
const SET = "Bowman";
const PARALLEL = "Chrome";
const PREFIX = "BCV-";
/** The set's variant type, and the checklist's own name and how Sync status names it. */
const VARIANT_TYPE = "Parallel";
const TITLE = `${YEAR} ${SET} ${PARALLEL}`;
const SET_LABEL = TITLE;
/** The two cards the owner named: BSC's BCV-26 and BCV-54. NB holds them as #26 and #54. */
const CARD_A = "#26 Dak Prescott";
const CARD_B = "#54 Patrick Mahomes II";
const SEND = "Send changes to BuySportsCards";
const BSC = "BuySportsCards";
/**
 * GUIDE hard rule 3, first exception: a step that directly drives a live BSC
 * round trip on data nothing synced yet (the Base fetch and its review, the
 * Chrome build). The GUIDE's one number for it. Measured 13 s for the fetch, 15 s
 * to saved, 4 s for the build (SET-REGISTRY.md), so it is room, not a need.
 */
const LIVE_BSC = 60_000;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the failing run needs undone, filled as the flow goes. */
const written: {
  box?: string;
  started?: boolean;
  removed?: boolean;
  stopped?: boolean;
  priced?: boolean;
} = {};

/** The key that leaves a quantity field: Tab on a desktop, Enter on a phone. */
const leaveKey = (isMobile: boolean) => (isMobile ? "Enter" : "Tab");

/** The Sync status screen's BuySportsCards section and this set's "Last sync by set" row. */
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
 * STOP listing: remove the worker's sign-in, then save it again through the
 * seed hop WITHOUT `listing=on`, so the worker keeps its credentials (R7) but
 * is "Not syncing." `alreadyRemoved`: the body removed it and failed before
 * saving it again.
 */
async function stopListing(page: Page, alreadyRemoved = false): Promise<void> {
  try {
    if (!alreadyRemoved) {
      await removeBscSignIn(page, LAUNCH_GATE);
      await expect(listingSection(page)).toBeHidden();
    }
  } finally {
    await saveBscSignIn(page);
    await expect(listingSection(page).getByRole("status")).toHaveText("Not syncing.");
    await expect(page.getByText(/^Listing your boxes on /)).toBeHidden();
  }
}

/**
 * The collector's Checklists cascade down to the Chrome parallel: Sport, Year,
 * Brand, Set, the variant type, then the parallel's own column. Returns the
 * checklist's region. (`drillToCollectorBase` stops at Base; this set's cards
 * live one level lower.)
 */
async function drillToChrome(page: Page): Promise<Locator> {
  const { drill } = collectorCascade(page);
  await drill("Sports", SPORT, "Years");
  await drill("Years", YEAR, "Brands");
  await drill("Brands", BRAND, "Sets");
  await drill("Sets", SET, "Variant Types");
  await drill("Variant Types", VARIANT_TYPE, VARIANT_TYPE);
  await drill(VARIANT_TYPE, PARALLEL);
  const checklist = page.getByRole("region", { name: TITLE, exact: true });
  await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
  return checklist;
}

/** On the open Chrome checklist: set both cards' quantities in `box` to 0 (only those not already 0). */
async function emptyBox(page: Page, checklist: Locator, box: string, isMobile: boolean): Promise<void> {
  const adding = page.getByRole("combobox", { name: "Adding to" });
  await adding.selectOption({ label: box });
  const search = checklist.getByRole("searchbox", { name: "Search this checklist" });
  for (const short of [CARD_A, CARD_B]) {
    await search.fill(short.split(" ").slice(1).join(" "));
    const field = quantityField(checklist.getByRole("list", { name: `Quantities in ${box}` }), short, box);
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
  await search.fill("");
}

/** The common price the spec sets, and clearing it. */
async function clearCommonPrice(page: Page, checklist: Locator, was: string): Promise<void> {
  await checklist.getByRole("button", { name: `Change the common price for ${TITLE}`, exact: true }).click();
  const priceField = checklist.getByRole("textbox", { name: "Common price", exact: true });
  await expect(priceField).toHaveValue(was);
  await priceField.fill("");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: `Cleared the common price for ${TITLE}` })).toBeVisible();
}

/**
 * The Set Builder half, as the admin does it. Ends on the Chrome row with its
 * Card prefix saved as `BCV-` and its cards built from Base. Adopts a tree an
 * earlier run (or the same seed's other project) left, and asserts the same end
 * state either way.
 */
async function buildFixture(page: Page, env: FlowEnv): Promise<void> {
  const wizard = reviewWizard(page);
  const pairing = page.getByRole("dialog", { name: /^Match Cards/ });
  const noCards = page.getByText("No cards in this checklist yet.");
  const someCard = page.getByText(/^#[0-9]/).first();

  // --- Football -> 2026 -> Bowman -> Bowman: BSC's year-wide sets, filed under the brand ---
  // A cold drill pays its live BSC round trips (the helper's ceilings). Under a
  // SportLots pause the brand is hand-made, like 1988 Topps' and Bowman's.
  await drillToColdManufacturer(page, env, { sport: SPORT, year: YEAR, manufacturer: BRAND, expectSets: true });
  await drillToBaseVariant(page, env, { sport: SPORT, year: YEAR, manufacturer: BRAND, set: SET });

  // --- Base: BSC's checklist, fetched and saved (the parallel is built from it) ---
  await expect(noCards.or(someCard)).toBeVisible();
  if (await noCards.isVisible()) {
    // Base is empty: fetch it. A live fetch of data nothing synced yet (the seed's ceilings).
    await syncChecklistButton(page).click();
    await expect(pairing.or(wizard).or(page.getByText(/Kept all [0-9]+ cards? from BSC/)).first()).toBeVisible({
      timeout: LIVE_BSC,
    });
    if (await pairing.isVisible()) {
      // SportLots live: two sides to pair. Keep every card only one side has, then confirm.
      const confirm = pairing.getByRole("button", { name: "Confirm card matches", disabled: false });
      await expect(confirm).toBeVisible({ timeout: LIVE_BSC });
      for (const side of ["BSC", "SportLots"]) {
        const unmatched = pairing.getByRole("heading", { name: new RegExp(`^${side} only \\([1-9][0-9]*\\)$`) });
        if (await unmatched.isVisible()) await pairing.getByRole("button", { name: `Keep all ${side}-only cards` }).click();
      }
      await confirm.click();
      await expect(pairing).toBeHidden();
    }
    await expect(wizard).toBeVisible({ timeout: LIVE_BSC });
    // The names the catalogue does not know: added as new, in bulk, then any
    // team, league or pick step one at a time (the seed's walk).
    await wizard.getByRole("button", { name: /^Add remaining players as new/ }).click();
    const pickStep = wizard.getByRole("heading", { level: 3, name: /^Which .* is this\?$/ });
    const namesDone = wizard.getByRole("button", { name: /^Next \(Enter\)$|Confirm & Save/ });
    const firstCandidate = wizard
      .getByRole("list", { name: "Players already filed under this name" })
      .getByRole("button", { name: /^Link to / })
      .first();
    for (let i = 0; i < 40; i++) {
      await expect(addAsNewStep(page).or(pickStep).or(namesDone).first()).toBeVisible({ timeout: LIVE_BSC });
      if (await namesDone.isVisible()) break;
      if (await pickStep.isVisible()) {
        const step = ((await pickStep.textContent()) ?? "").trim();
        await firstCandidate.click();
        await expect(wizard.getByRole("heading", { level: 3, name: step, exact: true })).toBeHidden();
      } else {
        await answerStepAsNew(page);
      }
    }
    await advanceToSave(page);
    await confirmSaveButton(page).click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible({ timeout: LIVE_BSC });
  }
  await expect(someCard).toBeVisible();

  // --- Parallel -> Chrome ---
  // Base is selected, so its column is the collapsed card: reopen it, then pick the Parallel type.
  await page.getByRole("button", { name: "Variant Types: Base — change" }).click();
  await pick(page, "Variant Types", VARIANT_TYPE, { search: false });
  const reconcile = page.getByRole("dialog", { name: "Reconcile Parallels" });
  const chrome = columnOption(page, "Parallels", PARALLEL);
  await expect(reconcile.or(page.getByRole("listbox", { name: "Parallels" })).first()).toBeVisible({ timeout: INSERT_FETCH });
  if (await reconcile.isVisible()) {
    // SportLots live: the column's first visit reconciles BSC's and SportLots' sets; save every ready one.
    await reconcile.getByRole("button", { name: /^Save [0-9]+ sets/ }).click();
    await expect(reconcile).toBeHidden();
  }
  await columnSearch(page, "Parallels").fill(PARALLEL);
  await expect(chrome).toBeVisible();
  await chrome.click();
  await expect(page.getByRole("button", { name: `Parallels: ${PARALLEL} — change` })).toBeVisible();

  // --- The Card prefix, BEFORE the build ---
  const edit = page.getByRole("button", { name: "Edit attributes" });
  const hide = page.getByRole("button", { name: "Hide attributes" });
  await expect(edit.or(hide)).toBeVisible();
  if (await edit.isVisible()) await edit.click();
  await expect(hide).toBeVisible();
  const prefix = page.getByRole("textbox", { name: "Value for Card prefix" });
  await expect(prefix).toBeVisible();
  // The checklist has settled into one of its two states: cards, or the empty message.
  await expect(noCards.or(someCard).first()).toBeVisible();
  const built = await someCard.isVisible();
  if ((await prefix.inputValue()) !== PREFIX) {
    await prefix.fill(PREFIX);
    await prefix.press("Enter");
    await expect(page.getByText(/Saved Card prefix/)).toBeVisible();
  }
  await expect(prefix).toHaveValue(PREFIX);

  // --- Then the cards: Chrome is a copy of Base's, each linked to Chrome's own BSC card ---
  if (!built) {
    await expect(noCards).toBeVisible();
    await page.getByRole("button", { name: "Build from Base", exact: true }).click();
    // One BSC read; the checklist fills when the build lands.
    await expect(page.getByRole("status").filter({ hasText: /^Chrome — Built [0-9]+ cards/ })).toBeVisible({ timeout: LIVE_BSC });
  }
  await expect(someCard).toBeVisible();
  await expectAccessible(page, { label: "Set Builder, Chrome built from Base with its Card prefix" });
}

// Pass or fail, the worker ends connected to BSC and NOT listing. On a failure
// the touched BSC rows are first brought to 0 on a SECOND page (the failing page
// stays as the screenshot saw it); then listing is stopped, because an account
// left listing would put any later spec's boxed cards up for sale on real BSC.
// Idempotent: it does only what the run got far enough to need.
test.afterEach(async ({ context, isMobile }, testInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  const clean = await context.newPage();
  try {
    try {
      if (failed && written.started && written.box) {
        // A run already under way reads the set as it was: let it finish first,
        // so the Sync below is the one that sees the zeros.
        await clean.goto("/inventory?tab=sync");
        await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
        const before = syncStatus(clean);
        await followRunToEnd(before.platform, syncRun(before.platform, SET_LABEL, BSC));
        await clean.goto("/inventory?tab=checklists");
        await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
        const checklist = await drillToChrome(clean);
        await emptyBox(clean, checklist, written.box, isMobile);
        await checklist.getByRole("button", { name: `Sync ${TITLE}`, exact: true }).click();
        // A missing toast means the zeroing press was answered "just synced", so no run is coming.
        await expect(
          clean.getByRole("status").filter({ hasText: `Syncing ${TITLE} now. Watch it on Sync status.` }),
          'no "Syncing ... now" toast: the zeroing press was answered "just synced", so no run is coming',
        ).toBeVisible();
        await clean.goto("/inventory?tab=sync");
        const zeroing = syncStatus(clean);
        const zeroingRun = syncRun(zeroing.platform, SET_LABEL, BSC);
        const zeroed = zeroing.row.getByText(/^0 listed/);
        await expect(zeroingRun.underWay(zeroed)).toBeVisible();
        await followRunToEnd(zeroing.platform, zeroingRun);
        await expect(zeroed).toBeVisible();
      }
    } finally {
      try {
        // A common price the run set and did not clear: clear it (after the zeroing above, which needs it set).
        if (failed && written.priced) {
          await clean.goto("/inventory?tab=checklists");
          await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
          const checklist = await drillToChrome(clean);
          await clearCommonPrice(clean, checklist, "0.25");
          written.priced = false;
        }
      } finally {
        // The body already stopped listing on a pass; otherwise it stops here.
        if (!written.stopped) await stopListing(clean, written.removed);
      }
    }
  } finally {
    await clean.close();
  }
});

test(
  "Inventory: Sync lists a card of a parallel whose BuySportsCards numbers carry a prefix (2026 Bowman Chrome, BCV-) and holds nothing back",
  { tag: ["@collection", "@marketplace-seller"] },
  async ({ page, signIn, env, isMobile }) => {
    // The hook's record of how far this run got starts empty.
    written.box = undefined;
    written.started = false;
    written.removed = false;
    written.stopped = false;
    written.priced = false;
    const boxName = `Bsc${env.ATTEMPT_TOKEN}`;
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const tabs = inventoryTabs(page);
    const boxes = page.getByRole("list", { name: "Your boxes" });
    const boxSpine = (cards: number) =>
      boxes.getByRole("button", { name: `${boxName}, box, ${cardsWord(cards)} for sale`, exact: true });

    // --- 1. The set, built through the Set Builder: prefix first, then the cards ---
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await buildFixture(page, env);

    // --- 2. A box to stock, and every other box in-person BEFORE syncing starts ---
    // A full page load, so the launch gate (cold app + Clerk handshake) applies.
    await page.goto("/inventory?tab=boxes");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    await createBox(page, boxName);
    written.box = boxName;
    await backToBoxes(page);
    await expect(boxSpine(0)).toBeVisible();
    await putOtherBoxesInPerson(page, boxName);

    // --- 3. Start syncing, as a real save does: the sign-in goes and comes back with listing on ---
    await page.goto("/profile/credentials");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(page.getByText(`Connected to ${BSC}`)).toBeVisible();
    const listing = listingSection(page);
    await removeBscSignIn(page, LAUNCH_GATE);
    written.removed = true;
    await expect(listing).toBeHidden();
    written.started = true;
    await saveBscSignIn(page, { listing: true });
    written.removed = false;
    await expect(listing.getByRole("status")).toHaveText(new RegExp(`^Listing your boxes on ${BSC} since .+\\.$`));

    // --- 4. The Chrome checklist: bare numbers, a common price, one copy each of the two cards ---
    await page.goto("/inventory?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    const checklist = await drillToChrome(page);
    const adding = page.getByRole("combobox", { name: "Adding to" });
    await adding.selectOption({ label: boxName });
    await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
    const boxList = checklist.getByRole("list", { name: `Quantities in ${boxName}` });
    const search = checklist.getByRole("searchbox", { name: "Search this checklist" });

    // The numbers NB holds are bare (the prefix is a BSC spelling NB never stores
    // on this parallel). The two cards are found by number and player, and NO row
    // reads BCV-: the positive first, so a dead list cannot satisfy the negative.
    const sync = checklist.getByRole("button", { name: `Sync ${TITLE}`, exact: true });
    await expect(sync).not.toHaveAttribute("aria-disabled", "true");
    await search.fill("Dak Prescott");
    await expect(quantityField(boxList, CARD_A, boxName)).toBeVisible();
    await search.fill("Patrick Mahomes");
    await expect(quantityField(boxList, CARD_B, boxName)).toBeVisible();
    await search.fill(PREFIX);
    await expect(checklist.getByText("No cards match.", { exact: true })).toBeVisible();
    await search.fill("");

    // The listing gate: a listed box is stocked only with a price on its cards.
    await checklist.getByRole("button", { name: `Set a common price for ${TITLE}`, exact: true }).click();
    const priceField = checklist.getByRole("textbox", { name: "Common price", exact: true });
    await expect(priceField).toBeFocused();
    await priceField.fill("0.25");
    await page.keyboard.press("Enter");
    await expect(said(`Common price for ${TITLE} is $0.25`)).toBeVisible();
    written.priced = true;

    // One copy of each into the box.
    for (const [short, word] of [
      [CARD_A, "Dak Prescott"],
      [CARD_B, "Patrick Mahomes"],
    ]) {
      await search.fill(word);
      const field = quantityField(boxList, short, boxName);
      await expect(field).toHaveValue("0");
      await field.fill("1");
      await page.keyboard.press(leaveKey(isMobile));
      await expect(
        boxList
          .getByRole("listitem")
          .filter({ has: page.getByRole("textbox", { name: `Quantity of ${short} in ${boxName}`, exact: true }) })
          .getByText("Saved"),
      ).toBeVisible();
    }
    await search.fill("");

    // --- 5. Before Sync: Sync status queues the two cards ----------------------------
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    const { platform, row } = syncStatus(page);
    await expect(platform.getByRole("heading", { level: 2, name: BSC, exact: true })).toBeVisible();
    await expect(platform.getByText("Listing", { exact: true })).toBeVisible();
    await expect(platform.getByRole("heading", { level: 3, name: "Queued for the next sync (2)", exact: true })).toBeVisible();
    const queued = platform.getByRole("list", { name: "Queued for the next sync (2)" }).getByRole("listitem");
    await expect(queued).toHaveCount(2);
    for (const short of [CARD_A, CARD_B]) {
      const [number] = short.split(" ");
      await expect(queued.filter({ hasText: new RegExp(`^${escapeRegExp(number)} .* in ${escapeRegExp(SET_LABEL)}`) })).toHaveCount(1);
    }
    await expectAccessible(page, { label: "Inventory Sync status, two Chrome cards queued" });

    // Back steps to the checklist the cards were boxed on, quantities as left.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await search.fill("Dak Prescott");
    await expect(quantityField(boxList, CARD_A, boxName)).toHaveValue("1");
    await search.fill("");

    // --- 6. Sync: BSC takes both, nothing is held back -------------------------------
    await sync.click();
    await expect(said(`Syncing ${TITLE} now. Watch it on Sync status.`)).toBeVisible();
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    // The live BSC round trip, one step per wait: the new run is in view (its
    // ledger under Running now, or its own result line if it already finished);
    // the walk then waits 7 s for the step the run is on to land until the send
    // is done; the confirm is one more step; then the result line.
    const run = syncRun(platform, SET_LABEL, BSC);
    const resultLine = row.getByText(/^\d+ listed/);
    await expect(run.underWay(resultLine)).toBeVisible();
    await followRunToEnd(platform, run, run.step(SEND));
    await expect(run.readLanded()).toBeVisible();
    await expect(run.step(SEND)).toBeVisible();
    await expect(run.confirmLanded()).toBeVisible();
    await expect(resultLine).toBeVisible();
    // THE FEATURE. The old planner refused both cards for a number BSC spells
    // with a prefix and NB without ("0 listed, 2 skipped", "2 held back"). Said
    // by name first, so the red run reads as the hold it is.
    await expect(
      row.getByText(/numbers this card differently/),
      "a Chrome card was held back as numbered differently: BSC's BCV-26 against NB's 26",
    ).toHaveCount(0);
    await expect(row.getByText(/^2 listed(, 2 updated)?$/)).toBeVisible();
    await expect(row.getByText(/^Synced /)).toBeVisible();
    await expect(row.getByText(/held back/)).toHaveCount(0);
    await expect(row.getByText(/skipped/)).toHaveCount(0);
    await expectAccessible(page, { label: "Inventory Sync status, 2 Chrome cards listed, none held back" });

    // --- 7. Take both back to 0 and Sync: BSC loses them (the rows are NB's zero again) ---
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await expect(checklist.getByRole("heading", { level: 3, name: TITLE })).toBeVisible();
    await emptyBox(page, checklist, boxName, isMobile);
    await sync.click();
    await expect(said(`Syncing ${TITLE} now. Watch it on Sync status.`)).toBeVisible();
    await tabs.getByRole("link", { name: "Sync status", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sync/);
    const takeDown = syncRun(platform, SET_LABEL, BSC);
    const takenLine = row.getByText(/^0 listed(, \d+ updated)?, 2 taken to 0$/);
    await expect(takeDown.underWay(takenLine)).toBeVisible();
    await followRunToEnd(platform, takeDown, takeDown.step(SEND));
    // A run that sent nothing means BSC already showed both at 0: not this
    // spec's takedown (the seller account is shared), so a red that says so.
    await expect(
      takeDown.step(SEND),
      "the takedown run found no stock of the two cards to take to 0, so it sent nothing (something else zeroed them first?)",
    ).toBeVisible();
    await expect(takeDown.confirmLanded()).toBeVisible();
    await expect(takenLine).toBeVisible();
    await expect(row.getByText(/held back/)).toHaveCount(0);

    // --- Tidy up through the product: the common price, then the box ----------------
    await page.goBack();
    await expect(page).toHaveURL(/[?&]tab=checklists/);
    await clearCommonPrice(page, checklist, "0.25");
    written.priced = false;
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(boxSpine(0)).toBeVisible();
    await boxSpine(0).click();
    await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
    await deleteOpenBox(page, boxName);
    await expect(boxes.getByRole("button", { name: new RegExp(`^${escapeRegExp(boxName)},`) })).toHaveCount(0);
    written.box = undefined;

    // --- 8. Stop listing: the sign-in goes and comes back not syncing ----------------
    await stopListing(page);
    written.stopped = true;
  },
);
