// NEO-500 (R1): the public demo's Pick List (Inventory → Pick List) is the
// seller's pull sheet: every sold copy still in a box, in the order the boxes
// are walked. This spec proves that sheet as a seller uses it:
//   - the pick order: Can't find it on top, one divider per set under its
//     sport (sports A-Z, newest year first), "Sold since you started" last;
//     each row says its variant in words (Base, Parallel, Insert, Insert
//     parallel), its markers (Last ones, Short 1, New), and the same card sold
//     on two orders is one ×2 row naming both;
//   - sorting by a column and filtering (an Order pick, a quick filter), and
//     Back to default undoing both;
//   - marking a row pulled with a click and with Space, Undo, and "Pull these
//     N" (with its confirm) under a filter;
//   - a thumbnail's bigger picture, closed with Escape;
//   - By the Box: Next box steps (a Back step each), a refresh keeps the box,
//     Box done pulls the box and moves on, and the walk ends on Can't find it.
// The demo is hard-coded data in the browser (demoPickStore.tsx), never
// Convex, so nothing here writes anywhere (R7). Public: signed out (R4).
// Phone differences (column sort, More filters, row tap) branch on
// `isMobile` and end in hard asserts (GUIDE "Desktop and mobile").
import { test, expect, expectAccessible } from "../../support/fixtures";
import {
  filterBy,
  openMoreFilters,
  pickList,
  pickRow,
  pictureButton,
  pulledToggle,
  seen,
  sortBy,
} from "../../support/pick-list";

// The demo's sheet: 29 copies across 27 sale lines (demoPickStore.tsx).
const TOTAL = 29;

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
    await expect(seen(pickRow(table, WITT).getByText("NB has no 2026 Topps Heritage checklist yet.", { exact: true }))).toBeVisible();
    await expect(seen(pickRow(table, BCP).getByText("#BCP-77 fits two cards in that set. Check the photo.", { exact: true }))).toBeVisible();

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
    await expect(region.getByText("Plus 2 sales NB couldn't tie to a card. They're the last stop, after the boxes.", { exact: true })).toBeVisible();
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

    // The last box's Next names the last stop and how many wait there.
    await region.getByRole("button", { name: "Can't find it (2)", exact: true }).click();
    await expect(stop).toHaveText("Last stop · Can't find it · 2 to pull");
    await expect(region.getByRole("table", { name: "Sales NB couldn't tie to a card", exact: true })).toBeVisible();
    await expect(pulledToggle(region, WITT)).toBeVisible();
    await expect(pulledToggle(region, BCP)).toBeVisible();
    await expect(next).toBeDisabled();
    await expect(region.getByRole("button", { name: "All found", exact: true })).toBeVisible();
  },
);
