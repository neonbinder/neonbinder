// NEO-370 (R1): box counts reach BuySportsCards. With "List on BuySportsCards"
// on, the two cards a collector boxes on the 1988 Topps Base checklist go up on
// BSC when they LEAVE the checklist (nothing waits on a timer), and the
// checklist's listing panel reads "N listed on BuySportsCards." once BSC
// confirms: 2 listed after boxing a copy of each, 1 after one copy is moved to a
// binder (taken off sale), 0 after the other is pulled from the box. Also the
// Sales tab's empty state, with listing off and on.
//
// What "N listed" proves about BSC. The drain reads BSC's seller sheet, plans
// against it, PUTs the rows that differ and READS THEM BACK; a row BSC still
// shows at another quantity becomes a "Can't list on BuySportsCards" problem.
// So the end state of every step is two assertions together: the panel's
// "N listed on BuySportsCards." and no "Can't list on" button. The panel shows
// no BSC quantity of its own and the spec never calls BSC (a product gap if a
// collector should see it).
//
// Waits. The only wait above 7 s is the live BSC round trip a leave sets going
// (sheet reads + PUT + read-back): `BSC_ROUND_TRIP` on the three
// "N listed" assertions, GUIDE hard rule 3's live-marketplace exception. The
// leave itself (My Boxes, then Back) is the user's own action and the
// quantities are confirmed saved (status line, spine count) before it. No
// timer, no cron path: the 15-minute cron is deliberately not exercised.
//
// R7/R7a. 1988 Topps Baseball is a registered real set (SET-REGISTRY.md): this
// spec is the SOLE writer of its BSC quantities; it writes no card, player,
// team or variant of the set. Its NB writes are the signed-in user's own rows
// (a minted box, two box copies, one binder copy, the common price). The
// quantities end at 0 on BSC: on a pass by the steps themselves, on a failure
// by the afterEach hook, which zeroes the cards through the product (quantity
// 0, then leaving the checklist) and switches listing off on a second page, so the failure
// screenshot keeps the page that failed. BSC is never called by the spec.
//
// Minted box name: a single token from `env.ATTEMPT_TOKEN`.
import type { Page } from "@playwright/test";
import {
  TOPPS_1988,
  backToBoxes,
  baseChecklistTitle,
  cardsWord,
  createBox,
  deleteOpenBox,
  drillToCollectorBase,
  inventoryTabs,
  nameOf,
  quantityField,
} from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

/**
 * GUIDE hard rule 3, the live-marketplace exception: a step that directly
 * drives a live BSC round trip. One leave starts: BSC login/refresh, up to four
 * condition sheets read (1988 is after the 1980 vintage cutoff), one PUT, one
 * read-back. NOT YET MEASURED (no deployed backend carried the branch when this
 * was written): the first PR-preview run records the figure beside the
 * registry row, and this number comes down to it if it is far above.
 */
const BSC_ROUND_TRIP = 60_000;

const BSC = "BuySportsCards";
const TITLE = baseChecklistTitle(TOPPS_1988);
/** The status line's promise while a change waits (copy.ts `WHEN_IT_GOES_UP`, as a user reads it). */
const WHEN_IT_GOES_UP = "when you leave this checklist or within 15 minutes";
/** "N listed on BuySportsCards. Synced 2:14 PM. Syncing soon, when you leave…": the last run's count, a change queued. */
const pendingAfter = (listed: number) =>
  new RegExp(`^${listed} listed on ${BSC}\\..* Syncing soon, ${WHEN_IT_GOES_UP}\\.$`);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the failing run needs undone, filled as the flow goes. */
const written: { box?: string; cards?: [string, string]; listingOn: boolean } = { listingOn: false };

/** The panel under the checklist's common price, its status line and its "held back" disclosure. */
function listingPanel(page: Page) {
  const panel = page.getByRole("group", { name: `${BSC} listing` });
  return {
    panel,
    status: panel.getByRole("status"),
    resync: panel.getByRole("button", { name: `Resync ${TITLE} with ${BSC}`, exact: true }),
    heldBack: panel.getByRole("button", { name: /^Can.t list on / }),
  };
}

// A failed run leaves BSC holding whatever the last drain pushed. Zero it through
// the product on a SECOND page (the failing page stays as the screenshot saw
// it): quantity 0 in the box, a Resync (a full read of the checklist, which sets
// every row to what NB holds), then listing off. Idempotent: it does only what the
// run got far enough to need.
test.afterEach(async ({ context, isMobile }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const advance = isMobile ? "Enter" : "Tab";
  const clean = await context.newPage();
  try {
    const tabs = inventoryTabs(clean);
    const switchBsc = clean.getByRole("switch", { name: `List on ${BSC}`, exact: true });
    if (written.cards && written.box) {
      await clean.goto("/inventory?tab=checklists");
      await expect(clean.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
      const adding = clean.getByRole("combobox", { name: "Adding to" });
      const checklist = await drillToCollectorBase(clean, TOPPS_1988);
      await adding.selectOption({ label: written.box });
      const boxList = checklist.getByRole("list", { name: `Quantities in ${written.box}` });
      for (const short of written.cards) {
        const field = quantityField(boxList, short, written.box);
        await expect(field).toBeVisible();
        if ((await field.inputValue()) !== "0") {
          await field.fill("0");
          await clean.keyboard.press(advance);
          await expect(field).toHaveValue("0");
          await expect(
            clean.getByRole("status").filter({ hasText: new RegExp(`^Pulled \\d+ of ${escapeRegExp(short)} from `) }),
          ).toBeVisible();
        }
      }
      // Leaving the checklist flushes the zeroed counts. Resync is not used: it is
      // ignored within 60 s of a previous Resync or while a run holds the lease.
      const { status } = listingPanel(clean);
      await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
      await expect(clean).toHaveURL(/[?&]tab=boxes/);
      await clean.goBack();
      await expect(clean).toHaveURL(/[?&]tab=checklists/);
      // Live BSC round trip (GUIDE hard rule 3), the same constant as the flow.
      await expect(status).toHaveText(new RegExp(`^0 listed on ${BSC}\\.`), { timeout: BSC_ROUND_TRIP });
    }
    if (written.listingOn) {
      await clean.goto("/inventory?tab=sales");
      await expect(switchBsc).toBeChecked({ timeout: LAUNCH_GATE });
      await switchBsc.click();
      await expect(switchBsc).not.toBeChecked();
    }
  } finally {
    await clean.close();
  }
});

test(
  "Inventory: boxing 1988 Topps Base cards lists them on BuySportsCards when you leave the checklist",
  { tag: ["@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    // The hook's record of how far this run got starts empty.
    written.box = undefined;
    written.cards = undefined;
    written.listingOn = false;
    const boxName = `Bsc${env.ATTEMPT_TOKEN}`;
    const advance = isMobile ? "Enter" : "Tab";
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const tabs = inventoryTabs(page);
    const switchBsc = page.getByRole("switch", { name: `List on ${BSC}`, exact: true });
    const boxes = page.getByRole("list", { name: "Your boxes" });
    const boxSpine = (cards: number) =>
      boxes.getByRole("button", { name: `${boxName}, box, ${cardsWord(cards)} for sale`, exact: true });

    // --- Sales tab first: listing is off, and nothing has sold -------------------
    await signIn("/inventory?tab=sales");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(tabs.getByRole("link", { name: "Sales", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: `Selling on ${BSC}` })).toBeVisible();
    // A sign-in saved by the bootstrap: the switch is usable and starts off.
    await expect(switchBsc).toBeEnabled();
    await expect(switchBsc).not.toBeChecked();
    await expect(page.getByRole("heading", { level: 2, name: "What sold" })).toBeVisible();
    await expect(page.getByText(/^No sales yet\./)).toBeVisible();
    await expectAccessible(page, { label: "Inventory Sales, listing off, no sales" });

    // --- A box to stock -------------------------------------------------------
    await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=boxes/);
    await createBox(page, boxName);
    written.box = boxName;
    await backToBoxes(page);
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
    const { panel, status, resync, heldBack } = listingPanel(page);
    await expect(panel).toBeVisible();

    // --- Listing is still off here: the compact switch and the consent line ------
    const panelSwitch = panel.getByRole("switch", { name: `List on ${BSC}`, exact: true });
    await expect(panelSwitch).toBeEnabled();
    await expect(panelSwitch).not.toBeChecked();
    await expect(panel.getByText(/^Switching on sets what you already list on /)).toBeVisible();
    await expect(resync).toBeHidden();
    await expectAccessible(page, { within: panel, label: "Checklist listing panel, listing off" });
    await panelSwitch.click();
    written.listingOn = true;
    await expect(said(new RegExp(`^Listing on ${BSC} is on`))).toBeVisible();
    await expect(resync).toBeVisible();
    await expect(panelSwitch).toBeHidden();

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

    /** Leave the checklist (the collector's flush) and come back with Back; the box spine is the proof the writes landed. */
    const leaveAndReturn = async (cardsInBox: number) => {
      await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=boxes/);
      await expect(boxSpine(cardsInBox)).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/[?&]tab=checklists/);
      await expect(panel).toBeVisible();
    };

    // --- One copy of each into the box ----------------------------------------
    await fieldA.fill("1");
    await page.keyboard.press(advance);
    await expect(fieldB).toBeFocused();
    await fieldB.fill("1");
    await page.keyboard.press(advance);
    const rowOf = (short: string) =>
      boxList
        .getByRole("listitem")
        .filter({ has: page.getByRole("textbox", { name: `Quantity of ${short} in ${boxName}`, exact: true }) });
    await expect(rowOf(a).getByText("Saved")).toBeVisible();
    await expect(rowOf(b).getByText("Saved")).toBeVisible();
    await expect(said(new RegExp(`^Boxed 1 more of ${escapeRegExp(b)}\\.`))).toBeVisible();

    // --- Leave: BSC takes both; the panel says 2 listed, nothing held back ------
    // Until then the change is waiting, and the panel says when it goes up.
    await expect(status).toHaveText(new RegExp(`^Going up to ${BSC} ${WHEN_IT_GOES_UP}\\.$`));
    await leaveAndReturn(2);
    await expect(fieldA).toHaveValue("1");
    await expect(fieldB).toHaveValue("1");
    // GUIDE hard rule 3, live BSC round trip (BSC_ROUND_TRIP above).
    await expect(status).toHaveText(new RegExp(`^2 listed on ${BSC}\\.`), { timeout: BSC_ROUND_TRIP });
    await expect(heldBack).toHaveCount(0);
    await expectAccessible(page, { within: panel, label: "Checklist listing panel, 2 listed" });

    // --- Resync on the happy path: the whole checklist is read and sent again ----
    // The first Resync of the run, so the 60 s throttle does not apply. Its toast
    // comes after the request lands, so the "Synced" line below is the new run's.
    await resync.click();
    await expect(said(`Resyncing ${TITLE} with ${BSC}.`)).toBeVisible();
    // Live BSC round trip (BSC_ROUND_TRIP above). "Synced <time>." with no
    // "Syncing soon" tail: the run is over and nothing waits.
    await expect(status).toHaveText(new RegExp(`^2 listed on ${BSC}\\. Synced [^.]*\\.$`), { timeout: BSC_ROUND_TRIP });
    await expect(resync).toBeEnabled();
    await expect(heldBack).toHaveCount(0);

    // --- Move one copy to a binder (take it off sale): 1 listed ----------------
    await checklist.getByRole("button", { name: `Details for ${a}`, exact: true }).click();
    const yourCopies = page.getByRole("region", { name: `Your copies of ${a}`, exact: true });
    await expect(yourCopies).toBeVisible();
    await yourCopies.getByRole("button", { name: new RegExp(`^Take off sale, ${escapeRegExp(a)}, Raw, `) }).click();
    const offForm = yourCopies.getByRole("form", { name: /off sale$/ });
    await expect(offForm).toBeVisible();
    await offForm.getByRole("combobox", { name: "Back into" }).selectOption({ label: "Main" });
    await offForm.getByRole("button", { name: /^Take (it|1) off sale$/ }).click();
    await expect(offForm).toBeHidden();
    await expect(said(new RegExp(`^Took 1 of ${escapeRegExp(a)} off sale`))).toBeVisible();
    // The copy now lives in Main, a binder: not for sale. Remove it (nothing of ours is left behind).
    const mainLine = yourCopies.getByRole("listitem").filter({ hasText: "Main" });
    await expect(mainLine).toBeVisible();
    await yourCopies.getByRole("button", { name: new RegExp(`^Remove ${escapeRegExp(a)}, Raw, `) }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await page.getByRole("button", { name: "Close card detail" }).click();
    await expect(yourCopies).toBeHidden();
    await expect(fieldA).toHaveValue("0");
    await expect(status).toHaveText(pendingAfter(2));

    await leaveAndReturn(1);
    await expect(status).toHaveText(new RegExp(`^1 listed on ${BSC}\\.`), { timeout: BSC_ROUND_TRIP });
    await expect(heldBack).toHaveCount(0);
    await expectAccessible(page, { within: panel, label: "Checklist listing panel, 1 listed" });

    // --- Pull the other to 0: 0 listed -----------------------------------------
    await expect(fieldB).toHaveValue("1");
    await fieldB.fill("0");
    await page.keyboard.press(advance);
    await expect(said(`Pulled 1 of ${b} from ${boxName}. 0 left.`)).toBeVisible();
    await expect(fieldB).toHaveValue("0");
    await expect(status).toHaveText(pendingAfter(1));

    await leaveAndReturn(0);
    await expect(status).toHaveText(new RegExp(`^0 listed on ${BSC}\\.`), { timeout: BSC_ROUND_TRIP });
    await expect(heldBack).toHaveCount(0);
    await expectAccessible(page, { within: panel, label: "Checklist listing panel, 0 listed" });

    // --- Cleanup through the product: common price, the box, the switch --------
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

    await tabs.getByRole("link", { name: "Sales", exact: true }).click();
    await expect(page).toHaveURL(/[?&]tab=sales/);
    await expect(switchBsc).toBeChecked();
    await expect(page.getByText(/^No sales yet\./)).toBeVisible();
    await expectAccessible(page, { label: "Inventory Sales, listing on, no sales" });
    await switchBsc.click();
    await expect(said(new RegExp(`^Listing on ${BSC} is off`))).toBeVisible();
    await expect(switchBsc).not.toBeChecked();
    written.listingOn = false;
    await expect(page.getByText(/^No sales yet\./)).toBeVisible();
  },
);
