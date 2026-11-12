// NEO-520 (R1): an eBay sale of something NeonBinder did not list is shown, not
// swallowed. The seller sells it on eBay (here a seeded order: a real sandbox
// order cannot be made on cue and eBay seller work is paused), and NeonBinder
//   - shows the sold line on the Sales tab under eBay's own title (never called
//     a card), says plainly it did not list it and left the boxes alone, and
//     counts the order in "items", not "cards";
//   - puts it on the Pick List under "Can't find it" with eBay's title and the
//     "NB couldn't match this line" words, wearing NO "Not in NB" chip
//     (Jason's J2: that chip is for a line NB can describe as a card);
//   - never files it by reading the title: the title here names a REAL card
//     that sits in the seller's own box, and the box keeps its copy;
//   - lets the seller pull it (and it stays pulled), and a line eBay sends no
//     title for reads "Sold on eBay, not listed by NeonBinder";
//   - takes it off the list once the order ships.
//
// Orders come from `/testing/seed-pick-order?platform=ebay` (support/pick-list.ts,
// `seedEbayOrder`): a raw eBay Fulfillment order run through the order poll's
// own projection, record and apply code. No marketplace is called, and the hop
// refuses an account that lists anywhere (the suite's accounts never do).
//
// R7/R7a: reads the seed's 2024 Topps Chrome Base and writes ONLY the signed-in
// user's own rows: one box `Ebay<token>`, one copy of #215 Nolan Arenado in it
// (reserved for this spec, SET-REGISTRY.md) and two `marketplaceSales` orders
// (`<token>e` titled, `<token>f` untitled), both shipped by the end.
// Self-cleaning: #215's copy is typed back to 0 and the box deleted; on a
// failure the finally block ships whatever order is still open, on a second
// page so the failing one stays as the screenshot saw it (the bootstrap's
// per-user reset clears the rest).
//
// Minted names are single tokens from `env.ATTEMPT_TOKEN`.
import type { Page } from "@playwright/test";
import {
  backToBoxes,
  createBox,
  deleteOpenBox,
  drillToCollectorBase,
  inventoryTabs,
  quantityField,
} from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  PICK_LIST_PATH,
  ebayOrder,
  filterBy,
  pickGroup,
  pickList,
  pickRow,
  pulledToggle,
  seedEbayOrder,
  seen,
  shipEbayOrder,
} from "../../support/pick-list";

/** A 2024 Topps Chrome Base card no other spec boxes (SET-REGISTRY.md): the eBay title will NAME it. */
const CARD = { no: "215", short: "#215 Nolan Arenado" };
const SET_TITLE = "2024 Topps Chrome";

const WHY_PICK = "NB couldn't match this line. Check the order's photo.";
const WHY_SALES = "NeonBinder didn't list this one, so your boxes stayed put. Pull it by hand.";
const NO_TITLE_NAME = "Sold on eBay, not listed by NeonBinder";

test(
  "Sales and Pick List: an eBay sale NeonBinder did not list shows under eBay's title, unmatched, with no Not in NB chip, and the box keeps its card",
  { tag: ["@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    const boxName = `Ebay${env.ATTEMPT_TOKEN}`;
    // Two order numbers, neither a prefix of the other (row names match by prefix).
    const titled = `${env.ATTEMPT_TOKEN}e`;
    const untitled = `${env.ATTEMPT_TOKEN}f`;
    // The title names a real card in the seller's box on purpose: NB must never read a title to find a card.
    const title = `${SET_TITLE} ${CARD.short} Thing${env.ATTEMPT_TOKEN}`;
    const advance = isMobile ? "Enter" : "Tab";
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const pick = pickList(page);
    const { region, table } = pick;
    const tabs = inventoryTabs(page);
    /** The Sales tab's article for an eBay order (the tab names the marketplace in full). */
    const saleOrder = (orderNo: string) => page.getByRole("article", { name: `eBay order ${orderNo}`, exact: true });
    /**
     * The list as the server has it: a second tab (same sign-in) opened on the
     * Pick List, its own first answer and live updates, then closed.
     */
    const fromServer = async (check: (list: ReturnType<typeof pickList>) => Promise<void>) => {
      const tab = await page.context().newPage();
      await tab.goto(PICK_LIST_PATH);
      const list = pickList(tab);
      await expect(list.heading).toBeVisible({ timeout: LAUNCH_GATE });
      await check(list);
      await tab.close();
    };
    /** Orders seeded and not yet shipped, for the finally block. */
    const open = new Set<string>();

    try {
      // --- A box holding ONE copy of the card the eBay title will name ---------------------------
      await signIn("/inventory?tab=boxes");
      await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
      await createBox(page, boxName);
      await backToBoxes(page);
      await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=checklists/);
      const adding = page.getByRole("combobox", { name: "Adding to" });
      await adding.selectOption({ label: boxName });
      await expect(adding.getByRole("option", { selected: true })).toHaveText(boxName);
      const checklist = await drillToCollectorBase(page);
      const field = quantityField(checklist.getByRole("list", { name: `Quantities in ${boxName}` }), CARD.short, boxName);
      await expect(field).toHaveValue("0");
      await field.fill("1");
      await page.keyboard.press(advance);
      await expect(said(`Boxed 1 more of ${CARD.short}. 1 in ${boxName}.`)).toBeVisible();

      // --- An eBay order for something NeonBinder never listed, titled like that card ----------
      await seedEbayOrder(page, { orderNo: titled, lines: [{ quantity: 1, title }] });
      open.add(titled);
      // The hop is a full page load: the launch gate.
      await expect(pick.heading).toBeVisible({ timeout: LAUNCH_GATE });
      await filterBy(page, isMobile, "Order", ebayOrder(titled));
      await expect(page).toHaveURL(/[?&]porder=/);
      await expect(pick.matches).toHaveText("1 card matches.");

      // --- Pick List: under Can't find it, eBay's title, the unmatched words, no chip ---------------
      const cantFind = pickGroup(table, "Can't find it");
      await expect(pulledToggle(cantFind, title)).toBeVisible();
      await expect(pulledToggle(cantFind, title)).toHaveAttribute("aria-pressed", "false");
      const row = pickRow(cantFind, title);
      await expect(seen(row.getByText(title, { exact: true }))).toBeVisible();
      await expect(seen(row.getByText(WHY_PICK, { exact: true }))).toBeVisible();
      await expect(seen(row.getByText("Not in NB", { exact: true }))).toHaveCount(0);
      await expect(table.getByText("Not in NB", { exact: true })).toHaveCount(0);
      // The title is never read: the real card it names is not on the list, and nothing is filed in its set.
      await expect(pulledToggle(table, CARD.short)).toHaveCount(0);
      await expect(pickGroup(table, SET_TITLE).getByRole("button", { name: /^Pulled / })).toHaveCount(0);
      await expectAccessible(page, { label: "Pick List, an eBay sale NeonBinder did not list, under Can't find it" });

      // --- Its order opens on the Sales tab, that order focused; Back returns ---------------------
      await row.getByRole("link", { name: `${ebayOrder(titled)} on your Sales tab`, exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=sales(&|$)/);
      await expect(page).toHaveURL(/[?&]sorder=/);
      const heading = page.getByRole("heading", { level: 3, name: `eBay order ${titled}`, exact: true });
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      const sale = saleOrder(titled);
      await expect(sale).toHaveAttribute("aria-current", "true");
      // It is "1 item", not "1 card": the line may not be a card at all.
      await expect(sale.getByText(/^1 item(,|$)/)).toBeVisible();
      await expect(sale.getByText(/^1 card/)).toHaveCount(0);
      const line = sale.getByRole("listitem").filter({ hasText: title });
      await expect(line).toHaveCount(1);
      await expect(line).toContainText(`1× ${title}`);
      await expect(line.getByText(WHY_SALES, { exact: true })).toBeVisible();
      await expect(sale.getByText(NO_TITLE_NAME)).toHaveCount(0);
      await expectAccessible(page, { label: "Sales, an eBay order NeonBinder did not list" });
      await page.goBack();
      await expect(pick.heading).toBeVisible();
      await expect(page).toHaveURL(/[?&]porder=/);
      await expect(pick.matches).toHaveText("1 card matches.");
      await expect(pulledToggle(cantFind, title)).toBeVisible();

      // --- Pull it: the pull sticks ---------------------------------------------------------------
      await pulledToggle(cantFind, title).click();
      await expect(pulledToggle(cantFind, title)).toHaveAttribute("aria-pressed", "true");
      await expect(pick.notice(`Pulled ${title}.`)).toBeVisible();
      // "Pulled …" waits for the server; a second tab's list no longer holds the line.
      await fromServer(async (list) => {
        await expect(list.region.getByText("Nothing to pull. Go sell something rad.", { exact: true })).toBeVisible();
        await expect(pulledToggle(list.region, title)).toHaveCount(0);
      });

      // --- An eBay line that sends no title reads in plain words, on the Sales tab and the Pick List ---
      await seedEbayOrder(page, { orderNo: untitled, lines: [{ quantity: 1 }] }, "/inventory?tab=sales");
      open.add(untitled);
      const bare = saleOrder(untitled);
      await expect(bare).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(bare.getByText(/^1 item(,|$)/)).toBeVisible();
      const bareLine = bare.getByRole("listitem").filter({ hasText: NO_TITLE_NAME });
      await expect(bareLine).toHaveCount(1);
      await expect(bareLine).toContainText(`1× ${NO_TITLE_NAME}`);
      await expect(bareLine.getByText(WHY_SALES, { exact: true })).toBeVisible();
      await tabs.getByRole("link", { name: "Pick List", exact: true }).click();
      await expect(pick.heading).toBeVisible();
      await filterBy(page, isMobile, "Order", ebayOrder(untitled));
      await expect(pick.matches).toHaveText("1 card matches.");
      // No title to show: the row is "Unmatched sale", named for its order (as a BuySportsCards stray is).
      const bareName = `Unmatched sale, ${ebayOrder(untitled)}`;
      const bareToggle = pulledToggle(cantFind, bareName);
      await expect(bareToggle).toHaveCount(1);
      await expect(bareToggle).toHaveAttribute("aria-pressed", "false");
      await expect(seen(pickRow(cantFind, bareName).getByText(WHY_PICK, { exact: true }))).toBeVisible();
      await expect(table.getByText("Not in NB", { exact: true })).toHaveCount(0);

      // --- Shipping takes the line off the list ---------------------------------------------------
      await shipEbayOrder(page, untitled);
      await expect(pick.heading).toBeVisible({ timeout: LAUNCH_GATE });
      open.delete(untitled);
      await expect(region.getByText("Nothing to pull. Go sell something rad.", { exact: true })).toBeVisible();
      await expect(bareToggle).toHaveCount(0);
      await shipEbayOrder(page, titled);
      await expect(pick.heading).toBeVisible({ timeout: LAUNCH_GATE });
      open.delete(titled);

      // --- The box still holds exactly its one copy, then tidy up (R7) -----------------------------
      await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=checklists/);
      await adding.selectOption({ label: boxName });
      const again = await drillToCollectorBase(page);
      const left = quantityField(again.getByRole("list", { name: `Quantities in ${boxName}` }), CARD.short, boxName);
      await expect(left).toHaveValue("1");
      await left.fill("0");
      await page.keyboard.press(advance);
      await expect(said(`Pulled 1 of ${CARD.short} from ${boxName}. 0 left.`)).toBeVisible();
      await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
      const spine = page
        .getByRole("list", { name: "Your boxes" })
        .getByRole("button", { name: `${boxName}, box, 0 cards for sale`, exact: true });
      await spine.click();
      await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
      await deleteOpenBox(page, boxName);
      await expect(said(`${boxName} is off the shelf.`)).toBeVisible();
    } finally {
      // An order the body left open would sit on this worker's list. Shipped on a
      // second page, so the failing page stays as the screenshot saw it.
      if (open.size > 0) await shipLeftovers(page, open);
    }
  },
);

/** Ships every order still open on a second page; a failure to ship is noted, never thrown over the body's own. */
async function shipLeftovers(page: Page, open: ReadonlySet<string>): Promise<void> {
  const clean = await page.context().newPage();
  const leftovers: unknown[] = [];
  for (const orderNo of open) {
    try {
      await shipEbayOrder(clean, orderNo);
      await expect(pickList(clean).heading).toBeVisible({ timeout: LAUNCH_GATE });
    } catch (error) {
      leftovers.push(error);
    }
  }
  await clean.close();
  for (const error of leftovers) {
    test.info().annotations.push({ type: "cleanup", description: `an order was left open: ${String(error)}` });
  }
}
