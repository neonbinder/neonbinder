// NEO-500 (R1): the signed-in Pick List (Inventory → Pick List) lists what sold
// and still sits in a box, so the seller can pull it. A collector stocks a
// minted box through the inventory's Checklists (one copy of card A with a front
// photo, three of card B, and one of the Future Stars insert card I), and a
// BuySportsCards order sells A ×2, B ×1, I ×1, one line
// NB cannot tie to a card and says nothing of, and one NB cannot tie to a card
// but DESCRIBES (NEO-509: set, a card number, players), and one that describes
// too little (players, no card number). On the list, scoped to that order:
//   - A is marked "Last ones" (the sale took the box's only copy) and "Short 1"
//     (it sold two), and its bigger picture is the photo of the very copy sold;
//   - B is a plain row; the stray line waits under "Can't find it";
//   - NEO-522: each row's variant is a tag with its own name ("Base", "Future
//     Stars"), its name stands alone (no team line: the card's picture carries
//     it) with its markers on the same line, the set's run turns from Base to
//     the insert under a 3px rule in the insert's colour (B is Base's last
//     row; By the Box draws none), and the described line carries no
//     "couldn't match" note (its Not in NB chip says where to look);
//   - the described line (#208) is filed inside the 2024 Topps Chrome group
//     between A (#205) and B (#211), wears a "Not in NB" chip and its own
//     words, and is pulled, put back and pulled like any other row; the
//     no-number line stays under "Can't find it" showing its description (never
//     "Unmatched sale (n of m)"); "Only not in NB" keeps those three;
//   - the printed sheet (print media emulated) carries both, the described one
//     under its set with its number and the chip's words;
//   - By the Box names the box, then steps to the "Not in a box" stop (the
//     described line, under its set) and the "Can't find it" stop (the stray and
//     the no-number line); Back steps through all of them to the list;
//   - the stray line's order links to that order on the Sales tab, focused (Back returns);
//   - a pull survives a refresh taken the moment "Pulled …" shows (the line is
//     gone; the notice reads "Saving…" until the server has it), an Undo puts
//     a pull back (the described line's too);
//   - an order that lands while the page is open shows at the bottom, New,
//     and "Pull these 2" (with its confirm) pulls it under an Order filter;
//   - shipping the first order takes its lines off the list.
//
// Orders come from `/testing/seed-pick-order` (support/pick-list.ts): a sale
// cannot be made on cue. The hop records and applies the order exactly as the
// sales poll does and calls no marketplace; it refuses an account that lists
// anywhere, and the suite's accounts never do, so nothing is pushed to one.
//
// R7/R7a: reads the seed's 2024 Topps Chrome Base and its Insert › Future Stars,
// and writes ONLY the signed-in user's own rows: one box `Pick<token>`, its
// copies of #205, #211 and Future Stars #FS-17 (cards no other spec boxes, so
// "Last ones" is this spec's alone; SET-REGISTRY.md), a
// `collectionCopyPhotos` front on #205's copy (its R2 objects expire in the dev
// bucket), and two `marketplaceSales` orders (`<token>a` and `<token>b`), both
// shipped by the end. The described line and the no-number line are part of the
// first order and take no card, box or set row of their own: "208" is a number NO
// spec boxes (the line is never matched), so only its position between #205 and
// #211 matters (SET-REGISTRY.md reserves it).
// Self-cleaning: the sale takes A's and I's only copies, B's last copy is typed
// back to 0 and the box deleted; on a failure the finally block ships whatever order is still
// open, on a second page so the failing one stays as the screenshot saw it (the
// bootstrap's per-user reset clears the rest).
//
// Minted names are single tokens from `env.ATTEMPT_TOKEN`.
import type { Locator, Page } from "@playwright/test";
import { escapeRe } from "../../support/cards";
import {
  TOPPS_CHROME_2024_FUTURE_STARS,
  backToBoxes,
  checklistTitle,
  collectorCascade,
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
  listedLine,
  nameCell,
  pickGroup,
  pickList,
  pickRow,
  pictureButton,
  pulledToggle,
  seedPickOrder,
  seen,
  shipPickOrder,
  unmatchedLine,
  variantTag,
} from "../../support/pick-list";

/** Two 2024 Topps Chrome Base cards no other spec puts in a box (SET-REGISTRY.md). */
const CARD_A = { no: "205", short: "#205 Shea Langeliers" };
const CARD_B = { no: "211", short: "#211 Owen White" };
/**
 * NEO-522: a Future Stars insert card no other spec boxes (the seller specs take the
 * checklist's first rows; SET-REGISTRY.md), so the set's run turns from Base to an insert.
 */
const CARD_I = { no: "FS-17", short: "#FS-17 Triston Casas" };
/** The set's divider, and the card number the described line gives (between #205 and #211, boxed by no spec). */
const SET_TITLE = "2024 Topps Chrome";
const LISTED_NO = "208";

test(
  "Pick List: a sold order lists its cards to pull (Last ones, Short, the sold copy's photo, Can't find it), pulls stick, a new order lands New, shipping clears it",
  { tag: ["@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    const boxName = `Pick${env.ATTEMPT_TOKEN}`;
    // Two order numbers, neither a prefix of the other (row names match by prefix).
    const first = `${env.ATTEMPT_TOKEN}a`;
    const second = `${env.ATTEMPT_TOKEN}b`;
    const advance = isMobile ? "Enter" : "Tab";
    // The described line: a single-token player, so its title is one stable string (R: minted names).
    const listedPlayers = `Listed${env.ATTEMPT_TOKEN}`;
    const listedTitle = listedLine(SET_TITLE, listedPlayers, LISTED_NO);
    // A toggle's name reads the title's " · " joins as pauses.
    const listedName = listedTitle.split(" · ").join(", ");
    // And one with players but NO card number: too little to file, so it stays under Can't find it.
    const nonumPlayers = `Nonum${env.ATTEMPT_TOKEN}`;
    /** The no-number line's toggle: its description names it (the set's words may lead). */
    const nonumToggle = (scope: Locator | Page) =>
      scope.getByRole("button", { name: new RegExp(`^Pulled .*${escapeRe(nonumPlayers)}`) });
    const notInNbWhy = "NB doesn't have this copy. Go by the listing; the order link has the photo.";
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

      // NEO-522: one copy of the Future Stars insert in the same box, so the order's run turns
      // from Base to an insert. Variant Types reopens from its summary; Insert › Future Stars
      // is its own checklist, with its own quantities in the box.
      const { cascade, drill } = collectorCascade(page);
      await cascade.getByRole("button", { name: "Variant Types: Base, change" }).click();
      await drill("Variant Types", "Insert", "Insert");
      await drill("Insert", "Future Stars");
      const insertTitle = checklistTitle(TOPPS_CHROME_2024_FUTURE_STARS);
      const insertList = page.getByRole("region", { name: insertTitle });
      await expect(insertList.getByRole("heading", { level: 3, name: insertTitle })).toBeVisible();
      const fieldI = quantityField(insertList.getByRole("list", { name: `Quantities in ${boxName}` }), CARD_I.short, boxName);
      await expect(fieldI).toHaveValue("0");
      await fieldI.fill("1");
      await page.keyboard.press(advance);
      await expect(said(`Boxed 1 more of ${CARD_I.short}. 1 in ${boxName}.`)).toBeVisible();

      // --- An order sells A ×2, B ×1, a line NB can't tie to a card, and one it can only describe ---
      await seedPickOrder(page, {
        orderNo: first,
        box: boxName,
        // The hop reads the described lines' set from the first card: keep a Base card first.
        cards: { [CARD_A.no]: 2, [CARD_B.no]: 1, [CARD_I.no]: 1 },
        bad: true,
        // Repeated `listed` params, in this order: the described line, then the one with no card number.
        listed: [`${LISTED_NO}:${listedPlayers}`, `:${nonumPlayers}`],
      });
      open.add(first);
      // The hop is a full page load: the launch gate.
      await expect(pick.heading).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(tabs.getByRole("link", { name: "Pick List", exact: true })).toHaveAttribute("aria-current", "page");
      await filterBy(page, isMobile, "Order", bscOrder(first));
      await expect(page).toHaveURL(/[?&]porder=/);
      // A, B, I, the stray line, the described line and the no-number line.
      await expect(pick.matches).toHaveText("6 cards match.");

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
      // NEO-522: the variant is a tag with its own name, between the picture and the number.
      await expect(variantTag(rowA, "Base")).toHaveText("Base");
      await expect(variantTag(rowB, "Base")).toHaveText("Base");
      // The name stands alone: no team line under it (the card's picture carries the team),
      // and A's markers ride the name's own line, in the same cell.
      const nameB = nameCell(rowB, "Owen White", `Base #${CARD_B.no}`);
      await expect(nameB).toHaveCount(1);
      if (!isMobile) await expect(nameB).toHaveAccessibleName("Owen White");
      // A sold two but the box held one: one to pull (no ×2 chip), so a phone's one cell leads with the tag.
      await expect(nameCell(rowA, "Shea Langeliers", `Base #${CARD_A.no}`)).toContainText("Last ones");
      // I: its tag is the insert's own name, the kind read out first.
      const rowI = pickRow(table, CARD_I.short);
      await expect(variantTag(rowI, "Future Stars", "Insert")).toHaveText("Insert: Future Stars");
      // NEO-522: the set's run walks Base (#205, the described #208, #211), then Future Stars.
      // A 3px rule in the insert's colour runs under #211, Base's last row; the Base rows
      // between keep the thin divider, and so does the set's last row. It starts at the
      // Variant column, so it is read off the row's last cell on screen, and #211's tick
      // cell keeps the thin line.
      const ruleUnder = (row: Locator) => seen(row.getByRole("cell")).last();
      await expect(ruleUnder(rowA)).toHaveCSS("border-bottom-width", "1px");
      await expect(ruleUnder(pickRow(table, listedTitle))).toHaveCSS("border-bottom-width", "1px");
      await expect(ruleUnder(rowB)).toHaveCSS("border-bottom-width", "3px");
      await expect(ruleUnder(rowI)).toHaveCSS("border-bottom-width", "1px");
      await expect(rowB.getByRole("cell").first()).toHaveCSS("border-bottom-width", "1px");
      const ruleColour = (row: Locator) => ruleUnder(row).evaluate((td) => getComputedStyle(td).borderBottomColor);
      expect(await ruleColour(rowB)).not.toBe(await ruleColour(rowA));
      // Can't find it holds two lines: the stray (it says nothing) and the one with players but
      // no card number (too little to file), each with why.
      const cantFind = pickGroup(table, "Can't find it");
      await expect(cantFind.getByRole("button", { name: /^Pulled / })).toHaveCount(2);
      await expect(pulledToggle(cantFind, unmatchedLine(first))).toBeVisible();
      await expect(
        seen(
          pickRow(cantFind, unmatchedLine(first)).getByText(
            "NB couldn't match this line. Check the order's photo.",
            { exact: true },
          ),
        ),
      ).toBeVisible();
      // The no-number line keeps its description (the set's words and the players) where the
      // stray's "Unmatched sale" would be, is named for its order, and wears no chip: Can't
      // find it already says as much. It is never filed in the set, and never "Unmatched sale (n of m)".
      await expect(nonumToggle(cantFind)).toHaveCount(1);
      await expect(nonumToggle(cantFind)).toHaveAccessibleName(
        new RegExp(`${escapeRe(nonumPlayers)}.*, ${escapeRe(bscOrder(first))}$`),
      );
      await expect(nonumToggle(cantFind)).toHaveAttribute("aria-pressed", "false");
      const rowNonum = cantFind.getByRole("row").filter({ has: nonumToggle(page) });
      await expect(seen(rowNonum.getByText(new RegExp(escapeRe(nonumPlayers))))).toBeVisible();
      await expect(seen(rowNonum.getByText(/Unmatched sale/))).toHaveCount(0);
      await expect(seen(rowNonum.getByText("Not in NB", { exact: true }))).toHaveCount(0);
      await expect(table.getByRole("button", { name: /^Pulled Unmatched sale \(/ })).toHaveCount(0);
      await expect(nonumToggle(pickGroup(table, SET_TITLE))).toHaveCount(0);
      // The described line: filed in the set's own group, between #205 and #211 (the insert
      // after them), never under Can't find it; it says Not in NB, and the listing's words are its label.
      const inSet = pickGroup(table, SET_TITLE).getByRole("button", { name: /^Pulled / });
      await expect(inSet).toHaveCount(4);
      await expect(inSet.nth(0)).toHaveAccessibleName(new RegExp(`^Pulled ${escapeRe(CARD_A.short)}`));
      await expect(inSet.nth(1)).toHaveAccessibleName(
        new RegExp(`^Pulled ${escapeRe(listedName)}, not in NB, ${escapeRe(bscOrder(first))}$`),
      );
      await expect(inSet.nth(2)).toHaveAccessibleName(new RegExp(`^Pulled ${escapeRe(CARD_B.short)}`));
      await expect(inSet.nth(3)).toHaveAccessibleName(new RegExp(`^Pulled ${escapeRe(CARD_I.short)}`));
      await expect(pulledToggle(cantFind, listedTitle)).toHaveCount(0);
      await expect(pulledToggle(table, listedTitle)).toHaveAttribute("aria-pressed", "false");
      const rowListed = pickRow(table, listedTitle);
      await expect(seen(rowListed.getByText("Not in NB", { exact: true }))).toBeVisible();
      await expect(seen(rowListed.getByTitle(notInNbWhy, { exact: true }))).toBeVisible();
      await expect(seen(rowListed.getByText(listedPlayers, { exact: true }))).toBeVisible();
      await expect(seen(rowListed.getByText(`#${LISTED_NO}`, { exact: true }))).toBeVisible();
      // NEO-522: no "couldn't match" note on a line filed with its set; the chip's title says where to look.
      await expect(rowListed.getByText("NB couldn't match this line. Check the order's photo.")).toHaveCount(0);
      // A matched row wears no such chip.
      await expect(seen(rowB.getByText("Not in NB", { exact: true }))).toHaveCount(0);
      await expectAccessible(page, { label: "Pick List, one order to pull, a described line filed in its set, a no-number line in Can't find it" });

      // --- The printed sheet: the described line under its set with its number, the no-number one without ---
      // Print media emulated (what the Print button and Ctrl/Cmd+P switch on): the screen's
      // table gives way to a condensed sheet of the same six rows, in the same two groups.
      await page.emulateMedia({ media: "print" });
      const sheet = region.getByRole("table", { name: "Pick sheet", exact: true });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("rowheader")).toHaveCount(2);
      await expect(sheet.getByRole("rowheader").filter({ hasText: SET_TITLE })).toHaveCount(1);
      await expect(sheet.getByRole("rowheader").filter({ hasText: "Can't find it" })).toHaveCount(1);
      await expect(sheet.getByRole("row")).toHaveCount(1 + 2 + 6);
      const sheetRow = (text: string) => sheet.getByRole("row").filter({ hasText: text });
      // The described line prints like a card, number and players in their columns, with the chip's words.
      await expect(sheetRow(listedPlayers)).toHaveCount(1);
      await expect(sheetRow(listedPlayers).getByRole("cell", { name: `#${LISTED_NO}`, exact: true })).toBeVisible();
      await expect(sheetRow(listedPlayers).filter({ hasText: "Not in NB" })).toHaveCount(1);
      // The no-number line prints its description, no number and no chip, as the screen shows it.
      await expect(sheetRow(nonumPlayers)).toHaveCount(1);
      await expect(sheetRow(nonumPlayers).getByRole("cell", { name: /^#/ })).toHaveCount(0);
      await expect(sheetRow(nonumPlayers).filter({ hasText: "Not in NB" })).toHaveCount(0);
      await expect(pick.table).toBeHidden();
      await page.emulateMedia({ media: null });
      await expect(pick.table).toBeVisible();
      await expect(sheet).toBeHidden();

      // --- Only not in NB: the three sales NB has no card for, wherever they are filed ---------------
      await pick.onlyNotInNb.click();
      await expect(pick.onlyNotInNb).toHaveAttribute("aria-pressed", "true");
      await expect(page).toHaveURL(/[?&]pnotnb=1(&|$)/);
      await expect(pick.matches).toHaveText("3 cards match.");
      await expect(pulledToggle(table, listedTitle)).toBeVisible();
      await expect(nonumToggle(cantFind)).toBeVisible();
      await expect(pulledToggle(cantFind, unmatchedLine(first))).toBeVisible();
      await expect(pulledToggle(table, CARD_A.short)).toHaveCount(0);
      await expect(pulledToggle(table, CARD_B.short)).toHaveCount(0);
      await expect(pulledToggle(table, CARD_I.short)).toHaveCount(0);
      await pick.onlyNotInNb.click();
      await expect(pick.onlyNotInNb).toHaveAttribute("aria-pressed", "false");
      await expect(page).not.toHaveURL(/[?&]pnotnb=/);
      await expect(pick.matches).toHaveText("6 cards match.");
      await expect(pulledToggle(table, CARD_A.short)).toBeVisible();

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

      // --- By the Box: the box, then Not in a box, then Can't find it; Back steps through all three ---
      await pick.views.getByRole("link", { name: "By the Box", exact: true }).click();
      await expect(page).toHaveURL(/[?&]pv=box(&|$)/);
      const inBox = pick.boxTable(boxName);
      await expect(inBox).toBeVisible();
      const boxHeading = region.getByRole("heading", { level: 3, name: new RegExp(`· ${escapeRe(boxName)} · `) });
      await expect(boxHeading).toBeVisible();
      await expect(pulledToggle(inBox, CARD_A.short)).toBeVisible();
      await expect(pulledToggle(inBox, CARD_B.short)).toBeVisible();
      await expect(pulledToggle(inBox, CARD_I.short)).toBeVisible();
      // NEO-522: a box is one run in slot order, whatever variants it holds: no variant rule.
      for (const short of [CARD_A.short, CARD_B.short, CARD_I.short]) {
        await expect(ruleUnder(pickRow(inBox, short))).toHaveCSS("border-bottom-width", "1px");
      }
      // No box holds the three sales NB has no card for: the first box says they wait after the boxes.
      await expect(
        region.getByText("Plus 3 sales NB couldn't tie to a card. They wait after the boxes.", { exact: true }),
      ).toBeVisible();
      await expectAccessible(page, { label: "Pick List, By the Box" });

      // Not in a box: the described line, by set, with the chip; the stray and the no-number line are not here.
      await region.getByRole("button", { name: "Not in a box (1)", exact: true }).click();
      await expect(page).toHaveURL(/[?&]pbox=not-in-box(&|$)/);
      const notInBoxHeading = region.getByRole("heading", { level: 3, name: "Not in a box · 1 to pull", exact: true });
      await expect(notInBoxHeading).toBeVisible();
      await expect(notInBoxHeading).toBeFocused();
      await expect(
        region.getByText("NB has no copy of these, so no box to check. Go by each listing, set by set.", { exact: true }),
      ).toBeVisible();
      await expect(pick.notInBoxTable).toBeVisible();
      const notInBoxSet = pickGroup(pick.notInBoxTable, SET_TITLE);
      await expect(pulledToggle(notInBoxSet, listedTitle)).toBeVisible();
      await expect(seen(pickRow(notInBoxSet, listedTitle).getByText("Not in NB", { exact: true }))).toBeVisible();
      await expect(pulledToggle(pick.notInBoxTable, unmatchedLine(first))).toHaveCount(0);
      await expect(nonumToggle(pick.notInBoxTable)).toHaveCount(0);
      await expect(region.getByRole("button", { name: "All found", exact: true })).toBeVisible();
      await expectAccessible(page, { label: "Pick List, By the Box, the Not in a box stop" });

      // Can't find it, the last stop: the stray and the no-number line, with their words.
      await region.getByRole("button", { name: "Can't find it (2)", exact: true }).click();
      await expect(page).toHaveURL(/[?&]pbox=cant-find(&|$)/);
      const lastHeading = region.getByRole("heading", { level: 3, name: "Last stop · Can't find it · 2 to pull", exact: true });
      await expect(lastHeading).toBeVisible();
      await expect(region.getByText("These sales don't say enough to file. The order's photo is your best clue.", { exact: true })).toBeVisible();
      await expect(pick.cantFindTable).toBeVisible();
      await expect(pulledToggle(pick.cantFindTable, unmatchedLine(first))).toBeVisible();
      await expect(nonumToggle(pick.cantFindTable)).toBeVisible();
      await expect(pulledToggle(pick.cantFindTable, listedTitle)).toHaveCount(0);
      await expect(region.getByRole("button", { name: "Next box", exact: true })).toBeDisabled();
      await expect(region.getByRole("button", { name: "All found", exact: true })).toBeVisible();
      await expectAccessible(page, { label: "Pick List, By the Box, the Can't find it stop" });

      // Each stop was a Back step: Not in a box, the box, then the list as it was.
      await page.goBack();
      await expect(notInBoxHeading).toBeVisible();
      await expect(page).toHaveURL(/[?&]pbox=not-in-box(&|$)/);
      await page.goBack();
      await expect(boxHeading).toBeVisible();
      await page.goBack();
      await expect(pick.views.getByRole("link", { name: "Whole list", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page).toHaveURL(/[?&]porder=/);
      await expect(pick.matches).toHaveText("6 cards match.");

      // --- The stray line's order opens on the Sales tab, that order focused; Back returns -----
      const toSales = pickRow(cantFind, unmatchedLine(first)).getByRole("link", {
        name: `${bscOrder(first)} on your Sales tab`,
        exact: true,
      });
      await toSales.click();
      await expect(page).toHaveURL(/[?&]tab=sales(&|$)/);
      await expect(page).toHaveURL(/[?&]sorder=/);
      // The tab names the marketplace in full; the order is marked and its heading has the keyboard.
      const saleHeading = page.getByRole("heading", { level: 3, name: `BuySportsCards order ${first}`, exact: true });
      await expect(saleHeading).toBeVisible();
      await expect(saleHeading).toBeFocused();
      await expect(page.getByRole("article", { name: `BuySportsCards order ${first}`, exact: true })).toHaveAttribute(
        "aria-current",
        "true",
      );
      await expectAccessible(page, { label: "Sales, one order opened from the Pick List" });
      await page.goBack();
      await expect(pick.heading).toBeVisible();
      await expect(page).toHaveURL(/[?&]porder=/);
      await expect(pick.matches).toHaveText("6 cards match.");
      await expect(pulledToggle(cantFind, unmatchedLine(first))).toHaveAttribute("aria-pressed", "false");

      // --- Pull B and Undo it; pull the described line and Undo it; pull A -------------------
      // A tick reads "Saving…" on the status line and turns into "Pulled …" only
      // once the server has the pull (the unit tests hold the Saving… state; a
      // fast save would pass it before an assertion could look). Undo's own save
      // posts no notice, so A's pull comes after it: a client's writes land in the
      // order sent, so A's "Pulled …" proves the put-back is saved too.
      await pulledToggle(table, CARD_B.short).click();
      await expect(pulledToggle(table, CARD_B.short)).toHaveAttribute("aria-pressed", "true");
      await expect(pick.notice(`Pulled ${CARD_B.short}.`)).toBeVisible();
      await pick.undo.click();
      await expect(pulledToggle(table, CARD_B.short)).toHaveAttribute("aria-pressed", "false");
      // The described line pulls and puts back like a matched row, under its own words.
      await pulledToggle(table, listedTitle).click();
      await expect(pulledToggle(table, listedTitle)).toHaveAttribute("aria-pressed", "true");
      await expect(pick.notice(`Pulled ${listedTitle}.`)).toBeVisible();
      await pick.undo.click();
      await expect(pulledToggle(table, listedTitle)).toHaveAttribute("aria-pressed", "false");
      await pulledToggle(table, CARD_A.short).click();
      await expect(pulledToggle(table, CARD_A.short)).toHaveAttribute("aria-pressed", "true");
      await expect(pick.notice(`Pulled ${CARD_A.short}.`)).toBeVisible();

      // A refresh straight after that confirmation starts the pull over with what is
      // left (no second tab, no wait on the server): A is gone, B, the described
      // line (both put back), I and the no-number line stay, the described line still
      // in its set and the no-number one still under Can't find it.
      await page.reload();
      await expect(pick.heading).toBeVisible();
      await expect(pick.matches).toHaveText("5 cards match.");
      await expect(pulledToggle(table, CARD_B.short)).toHaveAttribute("aria-pressed", "false");
      await expect(pulledToggle(cantFind, unmatchedLine(first))).toBeVisible();
      await expect(nonumToggle(cantFind)).toHaveAttribute("aria-pressed", "false");
      await expect(pulledToggle(table, CARD_A.short)).toHaveCount(0);
      await expect(pulledToggle(pickGroup(table, SET_TITLE), listedTitle)).toHaveAttribute("aria-pressed", "false");
      await expect(seen(pickRow(table, listedTitle).getByText("Not in NB", { exact: true }))).toBeVisible();
      // Now pull it for good: the notice waits for the server, so a second tab sees it gone below.
      await pulledToggle(table, listedTitle).click();
      await expect(pulledToggle(table, listedTitle)).toHaveAttribute("aria-pressed", "true");
      await expect(pick.notice(`Pulled ${listedTitle}.`)).toBeVisible();

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
      // Saved ("Pulled …" waits for the server): a second tab's list has the first
      // order's B, stray line and no-number line and nothing of the second's (nor of the
      // first's pulled described line).
      await fromServer(async (list) => {
        await expect(pulledToggle(list.table, unmatchedLine(first))).toBeVisible();
        await expect(nonumToggle(list.table)).toBeVisible();
        await expect(pulledToggle(list.table, listedTitle)).toHaveCount(0);
        await expect(pulledToggle(list.table, CARD_B.short)).toHaveCount(1);
        await expect(pulledToggle(list.table, unmatchedLine(second))).toHaveCount(0);
      });
      await pick.backToDefault.click();
      await expect(pulledToggle(table, CARD_B.short).first()).toBeVisible();

      // --- Shipping the first order takes its lines off the list -----------------------------
      // Its B, I, stray line and no-number line were never pulled; once it ships, nothing is left to pull.
      await expect(pulledToggle(cantFind, unmatchedLine(first))).toHaveAttribute("aria-pressed", "false");
      await shipPickOrder(page, first);
      await expect(pick.heading).toBeVisible({ timeout: LAUNCH_GATE });
      open.delete(first);
      await expect(region.getByText("Nothing to pull. Go sell something rad.", { exact: true })).toBeVisible();
      await expect(pulledToggle(region, unmatchedLine(first))).toHaveCount(0);
      await expect(nonumToggle(region)).toHaveCount(0);
      await expect(pulledToggle(region, listedTitle)).toHaveCount(0);
      await expect(pulledToggle(region, CARD_B.short)).toHaveCount(0);
      await expect(pulledToggle(region, CARD_I.short)).toHaveCount(0);
      // The empty state points on: to what sold, and to the inventory.
      const sawSold = region.getByRole("link", { name: "See what sold", exact: true });
      await expect(sawSold).toBeVisible();
      await expect(region.getByRole("link", { name: "open your inventory", exact: true })).toBeVisible();
      await expectAccessible(page, { label: "Pick List, nothing to pull" });
      await sawSold.click();
      await expect(page).toHaveURL(/[?&]tab=sales(&|$)/);
      await expect(page.getByRole("heading", { level: 2, name: "What sold", exact: true })).toBeVisible();
      await page.goBack();
      await expect(pick.heading).toBeVisible();
      await expect(region.getByText("Nothing to pull. Go sell something rad.", { exact: true })).toBeVisible();
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
