// NEO-500 (R1): the public demo's Pick List (Inventory → Pick List) is the
// seller's pull sheet: every sold copy still in a box, in the order the boxes
// are walked. This spec proves that sheet as a seller uses it:
//   - the pick order: Can't find it on top, one divider per set under its
//     sport (sports A-Z, newest year first), "Sold since you started" last;
//     a sale NB could not tie to a card but the listing describes (NEO-509)
//     sits inline under its set, marked "Not in NB", not under Can't find it;
//     each row says its variant in words (Base, Parallel, Insert, Insert
//     parallel), its markers (Last ones, Short 1, New), and the same card sold
//     on two orders is one ×2 row naming both;
//   - sorting by a column and filtering (an Order pick, the quick filters, "Only
//     not in NB" among them), and Back to default undoing them;
//   - marking a row pulled with a click and with Space, Undo, and "Pull these
//     N" (with its confirm) under a filter;
//   - a thumbnail's bigger picture, closed with Escape;
//   - the printed sheet (print media emulated): a condensed list of every row
//     with a tick for the pulled ones, the screen's table and controls gone;
//   - By the Box: Next box steps (a Back step each), a refresh keeps the box,
//     Box done pulls the box and moves on, then the walk ends on the Not in a
//     box stop (the described sale, by set) and the Can't find it stop.
// The demo is hard-coded data in the browser (demoPickStore.tsx), never
// Convex, so nothing here writes anywhere (R7). Public: signed out (R4).
// A card-less row's name carries its order (", eBay 12-3502"): its title says
// nothing of it, and two orders' strays must not read alike.
// Phone differences (column sort, More filters, row tap) branch on
// `isMobile` and end in hard asserts (GUIDE "Desktop and mobile").
import { test, expect, expectAccessible } from "../../support/fixtures";
import {
  filterBy,
  openMoreFilters,
  pickGroup,
  pickList,
  pickRow,
  pictureButton,
  pulledToggle,
  seen,
  sortBy,
} from "../../support/pick-list";

// The demo's sheet: 30 copies across 28 sale lines (demoPickStore.tsx).
const TOTAL = 30;

// The rows the spec reads, by how each row's name begins.
const TROUT = "#27 Mike Trout, 2026 Topps Series 1";
const SKENES = "#150 Paul Skenes, 2026 Topps Series 1";
const SCHLITTLER = "#111 Cam Schlittler, 2026 Topps Series 1 Gold Foil";
const OHTANI_INSERT = "#8B-7 Shohei Ohtani, 2026 Topps Series 1 8 Bit Ballers";
const JUDGE = "#8B-12 Aaron Judge, 2026 Topps Series 1 8 Bit Ballers Red";
const FIELDS = "#330 Malachi Fields, 2026 Topps";
const WEMBANYAMA = "#136 Victor Wembanyama, 2024-25 Panini Prizm";
const OHTANI_SLAB = "#US1 Shohei Ohtani, 2018 Topps Update, PSA 10";
const SANDERS_SLAB = "#257 Barry Sanders, 1989 Score, SGC 9.5";
const FLAGG = "#1 Cooper Flagg, 2025-26 Topps Chrome";
const WITT = "2026 Topps Heritage Clubhouse Collection Relic Bobby Witt Jr. #CCR-BW";
const BCP = "2025 Bowman Chrome Prospects #BCP-77 Auto";
// NEO-509: no NB card, but the listing says set, number and player, so it files with its set.
// Its title reads set, number, then who ("2024 Score #302 · Malik Nabers"); a toggle's name
// reads that " · " as a comma (support/pick-list.ts).
const NABERS = "2024 Score #302 · Malik Nabers";
const LATHAM = "#7 JC Latham, 2024 Score";

test(
  "Pick List demo: pick order, markers, sort and filter, mark pulled with Undo, pull a filter, then walk it By the Box",
  { tag: ["@home"] },
  async ({ page, isMobile }) => {
    const pick = pickList(page);
    const { region, table } = pick;

    await page.goto("/binder-tracking?demo=on&side=inventory&tab=pick");
    await expect(pick.heading).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Inventory sections" }).getByRole("link", { name: "Pick List" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(pick.progress(0, TOTAL)).toBeVisible();
    await expect(pick.views.getByRole("link", { name: "Whole list" })).toHaveAttribute("aria-current", "page");

    // --- The pick order ------------------------------------------------------
    // Every divider in walking order: Can't find it first; then each sport A-Z
    // and, inside it, newest year first (a season files under its start year,
    // so 2024-25 is 2024); then what sold mid-pull, at the bottom.
    await expect(table.getByRole("heading", { level: 3 })).toHaveText([
      "Can't find it",
      "2026 Topps Series 1",
      "2022 Topps Heritage",
      "2021 Topps Allen & Ginter Chrome",
      "2021 Topps Gypsy Queen",
      "2018 Topps Update",
      "2024-25 Panini Prizm",
      "2026 Topps",
      "2024 Score",
      "2023 Bowman University Chrome",
      "2020 Panini Mosaic",
      "2019 Donruss Elite",
      "1989 Score",
      "2023-24 Upper Deck Series 1",
      "2024 Topps Garbage Pail Kids",
      "Sold since you started",
    ]);
    // Each set divider carries its sport's name as text, and the copies under it.
    await expect(table.getByRole("rowheader", { name: "Baseball 2026 Topps Series 1 6 cards", exact: true })).toBeVisible();
    await expect(table.getByRole("rowheader", { name: "Basketball 2024-25 Panini Prizm 2 cards", exact: true })).toBeVisible();
    await expect(table.getByRole("rowheader", { name: "Hockey 2023-24 Upper Deck Series 1 2 cards", exact: true })).toBeVisible();
    await expect(table.getByRole("rowheader", { name: "Non-Sport 2024 Topps Garbage Pail Kids 2 cards", exact: true })).toBeVisible();

    // The variant is written out, never colour alone.
    await expect(seen(pickRow(table, TROUT).getByText("Base", { exact: true }))).toBeVisible();
    await expect(seen(pickRow(table, SCHLITTLER).getByText("Parallel", { exact: true }))).toBeVisible();
    await expect(seen(pickRow(table, OHTANI_INSERT).getByText("Insert", { exact: true }))).toBeVisible();
    await expect(seen(pickRow(table, JUDGE).getByText("Insert parallel", { exact: true }))).toBeVisible();

    // Markers: the sale took the last copies; NB held one fewer than sold.
    await expect(seen(pickRow(table, JUDGE).getByText("Last ones", { exact: true }))).toBeVisible();
    await expect(seen(pickRow(table, FIELDS).getByText("Short 1", { exact: true }))).toBeVisible();

    // The same card in the same condition on two orders is ONE row: ×2, both orders.
    await expect(pulledToggle(table, SKENES)).toHaveCount(1);
    const skenesRow = pickRow(table, SKENES);
    await expect(seen(skenesRow.getByText("×2 copies", { exact: true }))).toBeVisible();
    await expect(seen(skenesRow.getByText("BSC 88213", { exact: true }))).toBeVisible();
    await expect(seen(skenesRow.getByText("eBay 12-3456", { exact: true }))).toBeVisible();

    // Can't find it: the listing's own title and why NB could not tie it to a card.
    await expect(pulledToggle(table, WITT)).toBeVisible();
    await expect(pulledToggle(table, WITT)).toHaveAccessibleName(`Pulled ${WITT}, eBay 12-3502`);
    await expect(pulledToggle(table, BCP)).toHaveAccessibleName(`Pulled ${BCP}, BSC 88257`);
    // No Sales tab in the demo: a stray's order is plain text, not a link.
    await expect(pickRow(table, BCP).getByRole("link")).toHaveCount(0);
    await expect(seen(pickRow(table, WITT).getByText("NB has no 2026 Topps Heritage checklist yet.", { exact: true }))).toBeVisible();
    await expect(seen(pickRow(table, BCP).getByText("#BCP-77 fits two cards in that set. Check the photo.", { exact: true }))).toBeVisible();

    // A sale NB could not tie to a card, described by its listing: filed inline under
    // its set (2024 Score, with the card that is tied), marked Not in NB, never under Can't find it.
    const score = pickGroup(table, "2024 Score");
    await expect(table.getByRole("rowheader", { name: "Football 2024 Score 2 cards", exact: true })).toBeVisible();
    await expect(pulledToggle(score, NABERS)).toHaveAccessibleName("Pulled 2024 Score #302, Malik Nabers, not in NB, BSC 88240");
    await expect(pulledToggle(score, LATHAM)).toBeVisible();
    await expect(seen(pickRow(score, NABERS).getByText("Not in NB", { exact: true }))).toBeVisible();
    // The chip says why on hover (the demo has no Sales tab, so no order link to name).
    await expect(seen(pickRow(score, NABERS).getByTitle("NB doesn't have this copy. Go by the listing.", { exact: true }))).toBeVisible();
    await expect(seen(pickRow(score, NABERS).getByText("Malik Nabers", { exact: true }))).toBeVisible();
    await expect(seen(pickRow(score, NABERS).getByText("#302", { exact: true }))).toBeVisible();
    await expect(pulledToggle(pickGroup(table, "Can't find it"), NABERS)).toHaveCount(0);
    await expect(seen(pickRow(score, LATHAM).getByText("Not in NB", { exact: true }))).toHaveCount(0);
    // Can't find it keeps no chip: its heading already says as much.
    await expect(seen(pickRow(table, WITT).getByText("Not in NB", { exact: true }))).toHaveCount(0);
    // Base before Insert in the set: the described Base line leads.
    await expect(score.getByRole("button", { name: /^Pulled / }).first()).toHaveAccessibleName(/^Pulled 2024 Score #302, Malik Nabers/);

    // Sold mid-pull: flagged New, under "Sold since you started".
    await expect(pulledToggle(table, `${FLAGG}, NM, sold since you started`)).toBeVisible();
    await expect(seen(pickRow(table, FLAGG).getByText("New", { exact: true }))).toBeVisible();

    await expectAccessible(page, { label: "Pick List demo, the whole list" });

    // --- More filters (phone) ------------------------------------------------
    // A phone folds Order, Sport, Year, Type and Condition under a disclosure;
    // a wide screen shows them inline.
    const order = region.getByRole("combobox", { name: "Order", exact: true });
    if (isMobile) {
      const more = region.getByRole("button", { name: /^More filters/ });
      await expect(more).toHaveAttribute("aria-expanded", "false");
      await expect(order).toBeHidden();
    }
    await openMoreFilters(page, isMobile);
    await expect(order).toBeVisible();
    // The phone's opened disclosure is a state of its own.
    if (isMobile) await expectAccessible(page, { label: "Pick List demo, More filters open (phone)" });

    // --- Sort a column -------------------------------------------------------
    // Sorted by player, the list is one run (no set dividers) A-Z, then Z-A.
    const firstCard = table.getByRole("button", { name: /^Pulled #/ }).first();
    await sortBy(page, isMobile, "Player", "asc");
    await expect(page).toHaveURL(/[?&]psort=player(&|$)/);
    await expect(table.getByRole("heading", { level: 3, name: "2026 Topps Series 1" })).toHaveCount(0);
    await expect(table.getByRole("heading", { level: 3, name: "Can't find it" })).toBeVisible();
    await expect(firstCard).toHaveAccessibleName(/^Pulled #8B-12 Aaron Judge,/);
    await expect(pick.backToDefault).toBeEnabled();
    await pick.backToDefault.click();
    await expect(page).not.toHaveURL(/[?&]psort=/);
    await expect(table.getByRole("heading", { level: 3, name: "2026 Topps Series 1" })).toBeVisible();
    await sortBy(page, isMobile, "Player", "desc");
    await expect(firstCard).toHaveAccessibleName(/^Pulled #136 Victor Wembanyama,/);
    await pick.backToDefault.click();
    await expect(pick.backToDefault).toBeDisabled();
    await expect(table.getByRole("heading", { level: 3, name: "2026 Topps Series 1" })).toBeVisible();

    // --- Filter: an Order pick -----------------------------------------------
    // BSC 88213 filled 8 copies (Skenes' ×2 row counts whole: it fills that order too).
    await filterBy(page, isMobile, "Order", "BSC 88213");
    await expect(page).toHaveURL(/[?&]porder=/);
    await expect(pick.matches).toHaveText("8 cards match.");
    await expect(pulledToggle(table, TROUT)).toBeVisible();
    await expect(pulledToggle(table, WEMBANYAMA)).toHaveCount(0);
    // Back to default clears it, and the keyboard lands in Find (the button switches off).
    await pick.backToDefault.click();
    await expect(pick.find).toBeFocused();
    await expect(pick.backToDefault).toBeDisabled();
    await expect(order.getByRole("option", { selected: true })).toHaveText("All orders");
    // Still in the accessibility tree (sr-only), just empty.
    await expect(pick.matches).toHaveText("");
    await expect(pulledToggle(table, WEMBANYAMA)).toBeVisible();

    // --- Mark pulled with a click --------------------------------------------
    const trout = pulledToggle(table, TROUT);
    await expect(trout).toHaveAttribute("aria-pressed", "false");
    // The cell that names the player (the wide "Player" column, or a phone's
    // one "Card" cell), not the thumbnail, whose card face prints the name too.
    const troutCell = pickRow(table, TROUT).getByRole("cell", { name: /^(#27 )?Mike Trout/ });
    if (isMobile) {
      // A phone pulls only on the check box: a tap on the row is a scroll, not a pull.
      await troutCell.tap();
      await expect(trout).toHaveAttribute("aria-pressed", "false");
      await expect(pick.progress(0, TOTAL)).toBeVisible();
      await trout.tap();
    } else {
      // A wide screen pulls on a click anywhere on the row.
      await troutCell.click();
    }
    await expect(trout).toHaveAttribute("aria-pressed", "true");
    await expect(pick.progress(1, TOTAL)).toBeVisible();
    await expect(pick.notice("Pulled #27 Mike Trout.")).toBeVisible();

    // --- Mark pulled with the keyboard, then Undo -----------------------------
    // Arrow keys move between rows; Space marks the focused one.
    const skenes = pulledToggle(table, SKENES);
    await trout.focus();
    await page.keyboard.press("ArrowDown");
    await expect(skenes).toBeFocused();
    await page.keyboard.press("Space");
    await expect(skenes).toHaveAttribute("aria-pressed", "true");
    await expect(pick.progress(3, TOTAL)).toBeVisible();
    await expect(pick.notice("Pulled #150 Paul Skenes.")).toBeVisible();
    // Undo takes back that pull only.
    await pick.undo.click();
    await expect(skenes).toHaveAttribute("aria-pressed", "false");
    await expect(trout).toHaveAttribute("aria-pressed", "true");
    await expect(pick.progress(1, TOTAL)).toBeVisible();

    // --- Pull these N, under a quick filter ----------------------------------
    const onlySlabs = pick.quickFilters.getByRole("button", { name: "Only slabs", exact: true });
    await onlySlabs.click();
    await expect(onlySlabs).toHaveAttribute("aria-pressed", "true");
    await expect(pick.matches).toHaveText("2 cards match.");
    await expect(pulledToggle(table, OHTANI_SLAB)).toBeVisible();
    await expect(pulledToggle(table, SANDERS_SLAB)).toBeVisible();
    await expect(pulledToggle(table, TROUT)).toHaveCount(0);
    // More than one card left asks first; the button is its own confirm.
    await region.getByRole("button", { name: "Pull these 2", exact: true }).click();
    const confirm = region.getByRole("button", { name: "Pull these 2?", exact: true });
    await expect(confirm).toBeVisible();
    await expect(region.getByRole("button", { name: "Not yet", exact: true })).toBeVisible();
    await confirm.click();
    await expect(pick.notice("Pulled all 2 that match.")).toBeVisible();
    await expect(pulledToggle(table, OHTANI_SLAB)).toHaveAttribute("aria-pressed", "true");
    await expect(pulledToggle(table, SANDERS_SLAB)).toHaveAttribute("aria-pressed", "true");
    await expect(pick.progress(3, TOTAL)).toBeVisible();
    await pick.backToDefault.click();
    await expect(onlySlabs).toHaveAttribute("aria-pressed", "false");
    await expect(pulledToggle(table, TROUT)).toBeVisible();

    // --- Only not in NB ------------------------------------------------------
    // Every sale with no NB card: the described one filed under its set, and the two under
    // Can't find it. Matched cards leave. Back to default switches it off.
    await pick.onlyNotInNb.click();
    await expect(pick.onlyNotInNb).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/[?&]pnotnb=1(&|$)/);
    await expect(pick.matches).toHaveText("3 cards match.");
    await expect(pulledToggle(table, NABERS)).toBeVisible();
    await expect(pulledToggle(table, WITT)).toBeVisible();
    await expect(pulledToggle(table, BCP)).toBeVisible();
    await expect(pulledToggle(table, TROUT)).toHaveCount(0);
    await expect(pulledToggle(table, LATHAM)).toHaveCount(0);
    await pick.backToDefault.click();
    await expect(pick.onlyNotInNb).toHaveAttribute("aria-pressed", "false");
    await expect(page).not.toHaveURL(/[?&]pnotnb=/);
    await expect(pulledToggle(table, LATHAM)).toBeVisible();

    // --- A thumbnail's bigger picture ----------------------------------------
    const skenesPicture = pictureButton(table, SKENES);
    await skenesPicture.click();
    const bigger = page.getByRole("dialog", { name: "#150 Paul Skenes", exact: true });
    await expect(bigger).toBeVisible();
    await expect(bigger.getByRole("img", { name: "2026 Topps Series 1 #150 Paul Skenes, Pirates", exact: true })).toBeVisible();
    await expectAccessible(page, { within: bigger, label: "Pick List demo, a card's bigger picture" });
    await page.keyboard.press("Escape");
    await expect(bigger).toBeHidden();
    await expect(skenesPicture).toBeFocused();

    // --- The printed sheet ---------------------------------------------------
    // Print media emulated (what the Print button and Ctrl/Cmd+P switch on): the
    // screen's table gives way to a condensed sheet, one line per card, and
    // every control leaves the page. Trout and the two slabs are pulled: ticked.
    await page.emulateMedia({ media: "print" });
    const sheet = region.getByRole("table", { name: "Pick sheet", exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("columnheader")).toHaveText(["Pulled", "Qty", "No.", "Player", "Card", "Cond.", "Order"]);
    // One divider per set group (the sheet carries the same 16 as the screen), one line per sale line.
    await expect(sheet.getByRole("rowheader")).toHaveCount(16);
    await expect(sheet.getByRole("row")).toHaveCount(1 + 16 + 28);
    const sheetRow = (text: string) => sheet.getByRole("row").filter({ hasText: text });
    const troutLine = sheetRow("Mike Trout");
    await expect(troutLine.getByRole("cell", { name: "✓", exact: true })).toBeVisible();
    await expect(troutLine.getByRole("cell", { name: "#27", exact: true })).toBeVisible();
    await expect(sheetRow("Paul Skenes").getByRole("cell", { name: "×2", exact: true })).toBeVisible();
    await expect(sheetRow("Paul Skenes").getByRole("cell", { name: "BSC 88213, eBay 12-3456", exact: true })).toBeVisible();
    await expect(sheetRow("Paul Skenes").getByRole("cell", { name: "✓", exact: true })).toHaveCount(0);
    await expect(sheetRow("Shohei Ohtani").filter({ hasText: "PSA 10" }).getByRole("cell", { name: "✓", exact: true })).toBeVisible();
    // The described line prints like a card, number and player in their columns, marked Unmatched.
    const nabers = sheetRow("Malik Nabers");
    await expect(nabers.getByRole("cell", { name: "#302", exact: true })).toBeVisible();
    await expect(nabers.filter({ hasText: "Not in NB" })).toHaveCount(1);
    // Its next step rides along on paper too (clipped on a phone's narrow sheet, so counted there).
    await expect(nabers.getByText("NB couldn't match this line. Check the order's photo.")).toHaveCount(1);
    // A line NB could not match prints its title and why, under Can't find it.
    const witt = sheetRow("Bobby Witt Jr.");
    await expect(witt.getByRole("cell", { name: /^2026 Topps Heritage Clubhouse Collection Relic Bobby Witt Jr\./ })).toBeVisible();
    const why = witt.getByRole("cell", { name: "NB has no 2026 Topps Heritage checklist yet.", exact: true });
    if (isMobile) {
      // Print emulation keeps the phone's 390px viewport (paper is wider), where the
      // sheet's flexible Card column has no room left: the words are in the sheet, clipped.
      await expect(why).toHaveCount(1);
    } else {
      await expect(why).toBeVisible();
    }
    // The screen's own table, tabs, filters and buttons are off the paper.
    await expect(pick.progress(3, TOTAL)).toBeVisible();
    await expect(pick.table).toBeHidden();
    await expect(pick.views).toBeHidden();
    await expect(pick.find).toBeHidden();
    await expect(pick.quickFilters).toBeHidden();
    await expect(region.getByRole("button", { name: "Print list", exact: true })).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Inventory sections" })).toBeHidden();
    // Back on screen, the sheet is gone and the table is back.
    await page.emulateMedia({ media: null });
    await expect(pick.table).toBeVisible();
    await expect(sheet).toBeHidden();
    await expect(region.getByRole("button", { name: "Print list", exact: true })).toBeVisible();

    // --- By the Box ----------------------------------------------------------
    // Boxes in name order (2026 Baseball, Box 2, Box 10, Slabs, Unsorted; the
    // empty Box 3 is skipped), then Can't find it as the last stop. Trout and
    // the two slabs are already pulled.
    await pick.views.getByRole("link", { name: "By the Box" }).click();
    await expect(page).toHaveURL(/[?&]pv=box(&|$)/);
    await expect(pick.views.getByRole("link", { name: "By the Box" })).toHaveAttribute("aria-current", "page");
    const stop = region.getByRole("heading", { level: 3 });
    await expect(stop).toHaveText("Box 1 of 5 · 2026 Baseball · 5 to pull");
    await expect(pick.boxTable("2026 Baseball")).toBeVisible();
    await expect(region.getByText("Plus 3 sales NB couldn't tie to a card. They wait after the boxes.", { exact: true })).toBeVisible();
    const previous = region.getByRole("button", { name: "Previous box", exact: true });
    const next = region.getByRole("button", { name: "Next box", exact: true });
    await expect(previous).toBeDisabled();
    await expectAccessible(page, { label: "Pick List demo, By the Box" });

    // Next box is a Back step of its own.
    await next.click();
    await expect(stop).toHaveText("Box 2 of 5 · Box 2 · 7 to pull");
    await expect(stop).toBeFocused();
    await expect(page).toHaveTitle(/^Pick List · Box 2 · /);
    await page.goBack();
    await expect(stop).toHaveText("Box 1 of 5 · 2026 Baseball · 5 to pull");
    await expect(pick.boxTable("2026 Baseball")).toBeVisible();

    // A refresh keeps the box (it is on the URL); the demo's pulls start over.
    await next.click();
    await expect(stop).toHaveText("Box 2 of 5 · Box 2 · 7 to pull");
    await next.click();
    await expect(stop).toHaveText("Box 3 of 5 · Box 10 · 9 to pull");
    await page.reload();
    await expect(stop).toHaveText("Box 3 of 5 · Box 10 · 9 to pull");
    await expect(pick.boxTable("Box 10")).toBeVisible();
    await expect(pick.progress(0, TOTAL)).toBeVisible();

    // Box done pulls the box (asking first: two left) and moves on.
    await next.click();
    await expect(stop).toHaveText("Box 4 of 5 · Slabs · 2 to pull");
    await region.getByRole("button", { name: "Box done", exact: true }).click();
    await region.getByRole("button", { name: "Pull all 2 here?", exact: true }).click();
    await expect(stop).toHaveText("Box 5 of 5 · Unsorted · 3 to pull");
    await expect(pick.notice("Pulled 2 from Slabs.")).toBeVisible();
    await expect(pick.progress(2, TOTAL)).toBeVisible();
    await page.goBack();
    await expect(stop).toHaveText("Box 4 of 5 · Slabs · all pulled");
    await page.goForward();
    await expect(stop).toHaveText("Box 5 of 5 · Unsorted · 3 to pull");

    // The last box's Next names the Not in a box stop and how many wait there: the described
    // sale, filed by set (no box holds a card NB does not have).
    await region.getByRole("button", { name: "Not in a box (1)", exact: true }).click();
    await expect(page).toHaveURL(/[?&]pbox=not-in-box(&|$)/);
    // The set's own divider is a level-3 heading too, so this stop is named in full.
    const notInBox = region.getByRole("heading", { level: 3, name: /^Not in a box · / });
    await expect(notInBox).toHaveText("Not in a box · 1 to pull");
    await expect(notInBox).toBeFocused();
    await expect(
      region.getByText("NB has no copy of these, so no box to check. Go by each listing, set by set.", { exact: true }),
    ).toBeVisible();
    await expect(pick.notInBoxTable).toBeVisible();
    await expect(pickGroup(pick.notInBoxTable, "2024 Score")).toBeVisible();
    await expect(pulledToggle(pick.notInBoxTable, NABERS)).toBeVisible();
    await expect(seen(pickRow(pick.notInBoxTable, NABERS).getByText("Not in NB", { exact: true }))).toBeVisible();
    await expect(pulledToggle(pick.notInBoxTable, WITT)).toHaveCount(0);
    await expectAccessible(page, { label: "Pick List demo, By the Box, the Not in a box stop" });

    // All found pulls what is here (one left: no confirm) and moves on to the last stop.
    await region.getByRole("button", { name: "All found", exact: true }).click();
    await expect(pick.notice("Pulled 1 not in NB.")).toBeVisible();
    await expect(pick.progress(3, TOTAL)).toBeVisible();
    // Named, not `stop`: while the walk steps over, the Not in a box set divider is a second level-3 heading.
    const lastStop = region.getByRole("heading", { level: 3, name: /^Last stop · / });
    await expect(lastStop).toHaveText("Last stop · Can't find it · 2 to pull");
    await expect(region.getByText("These sales don't say enough to file. The order's photo is your best clue.", { exact: true })).toBeVisible();
    await expect(pick.cantFindTable).toBeVisible();
    await expect(pulledToggle(pick.cantFindTable, WITT)).toBeVisible();
    await expect(pulledToggle(pick.cantFindTable, BCP)).toBeVisible();
    // The described sale is not here: it had its own stop.
    await expect(pulledToggle(pick.cantFindTable, NABERS)).toHaveCount(0);
    await expect(next).toBeDisabled();
    await expect(region.getByRole("button", { name: "All found", exact: true })).toBeVisible();
    await expectAccessible(page, { label: "Pick List demo, By the Box, the Can't find it stop" });

    // Back returns to the Not in a box stop, its sale ticked.
    await page.goBack();
    await expect(notInBox).toHaveText("Not in a box · all pulled");
    await expect(pulledToggle(pick.notInBoxTable, NABERS)).toHaveAttribute("aria-pressed", "true");
  },
);
