// NEO-500 (R1): the signed-in Pick List (Inventory → Pick List) lists what sold
// and still sits in a box, so the seller can pull it. A collector stocks a
// minted box through the inventory's Checklists (one copy of card A with a front
// photo, three of card B), and a BuySportsCards order sells A ×2, B ×1 and one
// line NB cannot tie to a card. On the list, scoped to that order:
//   - A is marked "Last ones" (the sale took the box's only copy) and "Short 1"
//     (it sold two), and its bigger picture is the photo of the very copy sold;
//   - B is a plain row; the stray line waits under "Can't find it";
//   - By the Box names the box (Back returns to the list);
//   - a pull survives a refresh (the line is gone), an Undo puts a pull back;
//   - an order that lands while the page is open shows at the bottom, New,
//     and "Pull these 2" (with its confirm) pulls it under an Order filter;
//   - shipping the first order takes its lines off the list.
//
// Orders come from `/testing/seed-pick-order` (support/pick-list.ts): a sale
// cannot be made on cue. The hop records and applies the order exactly as the
// sales poll does and calls no marketplace; it refuses an account that lists
// anywhere, and the suite's accounts never do, so nothing is pushed to one.
//
// R7/R7a: reads the seed's 2024 Topps Chrome Base and writes ONLY the signed-in
// user's own rows: one box `Pick<token>`, its copies of #205 and #211 (cards no
// other spec boxes, so "Last ones" is this spec's alone; SET-REGISTRY.md), a
// `collectionCopyPhotos` front on #205's copy (its R2 objects expire in the dev
// bucket), and two `marketplaceSales` orders (`<token>a` and `<token>b`), both
// shipped by the end. Self-cleaning: B's last copy is typed back to 0 and the
// box deleted; on a failure the finally block ships whatever order is still
// open, on a second page so the failing one stays as the screenshot saw it (the
// bootstrap's per-user reset clears the rest).
//
// Minted names are single tokens from `env.ATTEMPT_TOKEN`.
import { escapeRe } from "../../support/cards";
import {
  backToBoxes,
  createBox,
  deleteOpenBox,
  drillToCollectorBase,
  expectPhotoServed,
  inventoryTabs,
  photoFile,
  quantityField,
} from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  PICK_LIST_PATH,
  bscOrder,
  filterBy,
  pickGroup,
  pickList,
  pickRow,
  pictureButton,
  pulledToggle,
  seedPickOrder,
  seen,
  shipPickOrder,
  unmatchedLine,
} from "../../support/pick-list";

/** Two 2024 Topps Chrome Base cards no other spec puts in a box (SET-REGISTRY.md). */
const CARD_A = { no: "205", short: "#205 Shea Langeliers" };
const CARD_B = { no: "211", short: "#211 Owen White" };

test(
  "Pick List: a sold order lists its cards to pull (Last ones, Short, the sold copy's photo, Can't find it), pulls stick, a new order lands New, shipping clears it",
  { tag: ["@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    const boxName = `Pick${env.ATTEMPT_TOKEN}`;
    // Two order numbers, neither a prefix of the other (row names match by prefix).
    const first = `${env.ATTEMPT_TOKEN}a`;
    const second = `${env.ATTEMPT_TOKEN}b`;
    const advance = isMobile ? "Enter" : "Tab";
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const pick = pickList(page);
    const { region, table } = pick;
    const tabs = inventoryTabs(page);
    /**
     * The list as the server has it: a second tab (same sign-in) opened on the
     * Pick List, its own first answer and live updates, then closed. `check`'s
     * assertions wait the usual 7 s for a write still on its way.
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
      // --- A box, stocked from the Checklists: A ×1, B ×3 ----------------------------------
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
      const boxList = checklist.getByRole("list", { name: `Quantities in ${boxName}` });
      const fieldA = quantityField(boxList, CARD_A.short, boxName);
      const fieldB = quantityField(boxList, CARD_B.short, boxName);
      await expect(fieldA).toHaveValue("0");
      await expect(fieldB).toHaveValue("0");
      await fieldA.fill("1");
      await page.keyboard.press(advance);
      await expect(said(`Boxed 1 more of ${CARD_A.short}. 1 in ${boxName}.`)).toBeVisible();
      await fieldB.fill("3");
      await page.keyboard.press(advance);
      await expect(said(`Boxed 3 more of ${CARD_B.short}. 3 in ${boxName}.`)).toBeVisible();

      // A's one copy gets a front photo: Details opens the drawer already editing that line.
      await checklist.getByRole("button", { name: `Details for ${CARD_A.short}`, exact: true }).click();
      const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 Topps Chrome ${escapeRe(CARD_A.short)}`) });
      const form = drawer
        .getByRole("region", { name: `Your copies of ${CARD_A.short}` })
        .getByRole("form", { name: "Edit Raw, Excellent", exact: true });
      await expect(form).toBeVisible();
      const photos = form.getByRole("region", { name: /^Photos of / });
      await photos.getByLabel("Front photo file", { exact: true }).setInputFiles(photoFile("front.jpg"));
      await expect(photos.getByRole("status")).toHaveText("Front photo saved.");
      await drawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(drawer).toBeHidden();
      await expect(fieldA).toHaveValue("1");

      // --- An order sells A ×2, B ×1 and a line NB can't tie to a card ---------------------
      await seedPickOrder(page, { orderNo: first, box: boxName, cards: { [CARD_A.no]: 2, [CARD_B.no]: 1 }, bad: true });
      open.add(first);
      // The hop is a full page load: the launch gate.
      await expect(pick.heading).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(tabs.getByRole("link", { name: "Pick List", exact: true })).toHaveAttribute("aria-current", "page");
      await filterBy(page, isMobile, "Order", bscOrder(first));
      await expect(page).toHaveURL(/[?&]porder=/);
      await expect(pick.matches).toHaveText("3 cards match.");

      // A: the sale took the box's last copy, and NB held one fewer than sold.
      const rowA = pickRow(table, CARD_A.short);
      await expect(pulledToggle(table, CARD_A.short)).toHaveAttribute("aria-pressed", "false");
      await expect(seen(rowA.getByText("Last ones", { exact: true }))).toBeVisible();
      await expect(seen(rowA.getByText("Short 1", { exact: true }))).toBeVisible();
      // B: a plain row, neither marker.
      const rowB = pickRow(table, CARD_B.short);
      await expect(pulledToggle(table, CARD_B.short)).toHaveAttribute("aria-pressed", "false");
      await expect(seen(rowB.getByText(bscOrder(first), { exact: true }))).toBeVisible();
      await expect(seen(rowB.getByText("Last ones", { exact: true }))).toHaveCount(0);
      await expect(seen(rowB.getByText(/^Short \d/))).toHaveCount(0);
      // The stray line: under Can't find it, with why.
      const cantFind = pickGroup(table, "Can't find it");
      await expect(pulledToggle(cantFind, unmatchedLine(first))).toBeVisible();
      await expect(
        seen(
          pickRow(cantFind, unmatchedLine(first)).getByText(
            `NB couldn't match this line. Open order ${bscOrder(first)} to see the card.`,
            { exact: true },
          ),
        ),
      ).toBeVisible();
      await expectAccessible(page, { label: "Pick List, one order to pull" });

      // A's bigger picture is the photo of the copy that sold, and it really loads.
      await pictureButton(table, CARD_A.short).click();
      const bigger = page.getByRole("dialog", { name: CARD_A.short, exact: true });
      await expect(bigger).toBeVisible();
      const soldPhoto = bigger.getByRole("img", { name: new RegExp(`^The copy that sold: ${escapeRe(CARD_A.short)}, `) });
      await expect(soldPhoto).toBeVisible();
      await expectPhotoServed(page, soldPhoto, "src");
      await expectAccessible(page, { within: bigger, label: "Pick List, the sold copy's photo" });
      await page.keyboard.press("Escape");
      await expect(bigger).toBeHidden();

      // --- By the Box: the box is a stop, with both cards; Back returns to the list ----------
      await pick.views.getByRole("link", { name: "By the Box", exact: true }).click();
      await expect(page).toHaveURL(/[?&]pv=box(&|$)/);
      const inBox = pick.boxTable(boxName);
      await expect(inBox).toBeVisible();
      await expect(region.getByRole("heading", { level: 3, name: new RegExp(`· ${escapeRe(boxName)} · `) })).toBeVisible();
      await expect(pulledToggle(inBox, CARD_A.short)).toBeVisible();
      await expect(pulledToggle(inBox, CARD_B.short)).toBeVisible();
      await expectAccessible(page, { label: "Pick List, By the Box" });
      await page.goBack();
      await expect(pick.views.getByRole("link", { name: "Whole list", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page).toHaveURL(/[?&]porder=/);
      await expect(pick.matches).toHaveText("3 cards match.");

      // --- Pull A; pull B and Undo it -------------------------------------------------------
      await pulledToggle(table, CARD_A.short).click();
      await expect(pulledToggle(table, CARD_A.short)).toHaveAttribute("aria-pressed", "true");
      await expect(pick.notice(`Pulled ${CARD_A.short}.`)).toBeVisible();
      await pulledToggle(table, CARD_B.short).click();
      await expect(pulledToggle(table, CARD_B.short)).toHaveAttribute("aria-pressed", "true");
      await expect(pick.notice(`Pulled ${CARD_B.short}.`)).toBeVisible();
      await pick.undo.click();
      await expect(pulledToggle(table, CARD_B.short)).toHaveAttribute("aria-pressed", "false");
      await expect(pulledToggle(table, CARD_A.short)).toHaveAttribute("aria-pressed", "true");

      // Both marks are saved, not just ticked: a second tab, which starts from the
      // server's list, has B (put back) and not A. The ticks are optimistic and the
      // page has no "saved" state to wait for, so this is what makes the refresh
      // below read the saved list rather than race the writes.
      await fromServer(async (list) => {
        await expect(pulledToggle(list.table, CARD_B.short)).toBeVisible();
        await expect(pulledToggle(list.table, CARD_A.short)).toHaveCount(0);
      });
      // A refresh starts the pull over with what is left: A is gone, B (put back) stays.
      await page.reload();
      await expect(pick.heading).toBeVisible();
      await expect(pick.matches).toHaveText("2 cards match.");
      await expect(pulledToggle(table, CARD_B.short)).toHaveAttribute("aria-pressed", "false");
      await expect(pulledToggle(cantFind, unmatchedLine(first))).toBeVisible();
      await expect(pulledToggle(table, CARD_A.short)).toHaveCount(0);

      // --- A second order lands while the page is open: at the bottom, New -----------------
      await pick.backToDefault.click();
      await expect(page).not.toHaveURL(/[?&]porder=/);
      const seedTab = await page.context().newPage();
      await seedPickOrder(seedTab, { orderNo: second, box: boxName, cards: { [CARD_B.no]: 1 }, bad: true });
      open.add(second);
      await expect(pickList(seedTab).heading).toBeVisible({ timeout: LAUNCH_GATE });
      await seedTab.close();
      const fresh = pickGroup(table, "Sold since you started");
      await expect(pulledToggle(fresh, `${CARD_B.short}, `)).toBeVisible();
      await expect(table.getByRole("heading", { level: 3 }).last()).toHaveText("Sold since you started");
      await expect(table.getByRole("button", { name: /^Pulled / }).last()).toHaveAccessibleName(
        new RegExp(`^Pulled ${escapeRe(CARD_B.short)}, .*, sold since you started$`),
      );
      await expect(seen(pickRow(fresh, CARD_B.short).getByText("New", { exact: true }))).toBeVisible();
      await expectAccessible(page, { label: "Pick List, an order sold mid-pull" });

      // --- Pull these 2: the new order, with its confirm ------------------------------------
      await filterBy(page, isMobile, "Order", bscOrder(second));
      await expect(pick.matches).toHaveText("2 cards match.");
      await region.getByRole("button", { name: "Pull these 2", exact: true }).click();
      const confirm = region.getByRole("button", { name: "Pull these 2?", exact: true });
      await expect(confirm).toBeVisible();
      await expect(region.getByRole("button", { name: "Not yet", exact: true })).toBeVisible();
      await confirm.click();
      await expect(pick.notice("Pulled all 2 that match.")).toBeVisible();
      await expect(pulledToggle(table, unmatchedLine(second))).toHaveAttribute("aria-pressed", "true");
      // Saved: the server's list has the first order's B and stray line and
      // nothing of the second's.
      await fromServer(async (list) => {
        await expect(pulledToggle(list.table, unmatchedLine(first))).toBeVisible();
        await expect(pulledToggle(list.table, CARD_B.short)).toHaveCount(1);
        await expect(pulledToggle(list.table, unmatchedLine(second))).toHaveCount(0);
      });
      await pick.backToDefault.click();
      await expect(pulledToggle(table, CARD_B.short).first()).toBeVisible();

      // --- Shipping the first order takes its lines off the list -----------------------------
      // Its B and stray line were never pulled; once it ships, nothing is left to pull.
      await expect(pulledToggle(cantFind, unmatchedLine(first))).toHaveAttribute("aria-pressed", "false");
      await shipPickOrder(page, first);
      await expect(pick.heading).toBeVisible({ timeout: LAUNCH_GATE });
      open.delete(first);
      await expect(region.getByText("Nothing to pull. Go sell something rad.", { exact: true })).toBeVisible();
      await expect(pulledToggle(region, unmatchedLine(first))).toHaveCount(0);
      await expect(pulledToggle(region, CARD_B.short)).toHaveCount(0);
      await expectAccessible(page, { label: "Pick List, nothing to pull" });
      await shipPickOrder(page, second);
      await expect(pick.heading).toBeVisible({ timeout: LAUNCH_GATE });
      open.delete(second);

      // --- Clean up (R7): B's last copy back to 0, the box deleted ---------------------------
      await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=checklists/);
      await adding.selectOption({ label: boxName });
      const again = await drillToCollectorBase(page);
      const left = quantityField(again.getByRole("list", { name: `Quantities in ${boxName}` }), CARD_B.short, boxName);
      // Three boxed, one sold on each order.
      await expect(left).toHaveValue("1");
      await left.fill("0");
      await page.keyboard.press(advance);
      await expect(said(`Pulled 1 of ${CARD_B.short} from ${boxName}. 0 left.`)).toBeVisible();
      await tabs.getByRole("link", { name: "My Boxes", exact: true }).click();
      const spine = page.getByRole("list", { name: "Your boxes" }).getByRole("button", { name: `${boxName}, box, 0 cards for sale`, exact: true });
      await spine.click();
      await expect(page.getByRole("heading", { level: 2, name: boxName, exact: true })).toBeVisible();
      await deleteOpenBox(page, boxName);
      await expect(said(`${boxName} is off the shelf.`)).toBeVisible();
    } finally {
      // An order the body left open would sit on this worker's list. Shipped on a
      // second page, so the failing page stays as the screenshot saw it.
      if (open.size > 0) {
        const clean = await page.context().newPage();
        const leftovers: unknown[] = [];
        for (const orderNo of open) {
          try {
            await shipPickOrder(clean, orderNo);
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
    }
  },
);
