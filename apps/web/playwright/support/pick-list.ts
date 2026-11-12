/**
 * NEO-500 — the Pick List (Inventory → Pick List): the public demo's today
 * (`home/demo-pick-list`), the signed-in seller's once its Convex store lands.
 * Both stores sit behind one UI, so one set of handles serves both specs.
 *
 * Everything here is what a user perceives (GUIDE hard rule 2): the "Pick
 * List" region, its "Cards to pull" table, each row's `Pulled <row>` toggle
 * and `Bigger picture of <row>` button, the set and group headings, the
 * filter bar's labelled controls and the page's status line with Undo.
 *
 * Phone vs wide screen (GUIDE "Desktop and mobile"): a phone hides the
 * column headers (it sorts from "Sort by" instead) and folds Order, Sport,
 * Year, Type and Condition under "More filters". The helpers that touch
 * those take the project's `isMobile` and end in hard asserts either way.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** A run-time name, safe inside a regex (support/... "runtime names need escaping"). */
function escapeRegex(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
}

/**
 * Only the copy a user can see. The table draws each row twice, the wide
 * columns and a phone's one "Card" cell, and hides whichever does not fit, so
 * a text inside a row resolves to two elements, one of them hidden.
 */
export function seen(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

/** The Pick List region, its parts, and the status line it reports on. */
export function pickList(page: Page) {
  const region = page.getByRole("region", { name: "Pick List" });
  return {
    region,
    heading: region.getByRole("heading", { level: 2, name: "Pick List" }),
    /** "3 of 29 cards pulled". */
    progress: (got: number, total: number) =>
      region.getByText(`${got} of ${total} ${total === 1 ? "card" : "cards"} pulled`, { exact: true }),
    /** The whole list's table; By the Box has one per stop (`boxTable`). */
    table: region.getByRole("table", { name: "Cards to pull" }),
    boxTable: (boxName: string) => region.getByRole("table", { name: `Cards to pull from ${boxName}`, exact: true }),
    views: region.getByRole("navigation", { name: "Pick List views" }),
    /** The list's own filter count ("4 cards match."), always mounted, empty when unfiltered. */
    matches: region.getByRole("status"),
    find: region.getByRole("textbox", { name: "Find a card" }),
    quickFilters: region.getByRole("group", { name: "Quick filters" }),
    backToDefault: region.getByRole("button", { name: "Back to default", exact: true }),
    /** The page's status line (outside the region): a pull says so here, with Undo. */
    notice: (message: string) => page.getByRole("status").filter({ hasText: message }),
    undo: page.getByRole("button", { name: "Undo", exact: true }),
  };
}

/**
 * A row's Pulled toggle. `row` is how the row's name begins: "#150 Paul
 * Skenes, 2026 Topps Series 1" (a card), or the listing's own title (a sale
 * NB could not tie to a card). The full name adds the condition, serial or
 * grade, slot and order, so a prefix is the stable handle.
 */
export function pulledToggle(scope: Locator, row: string): Locator {
  return scope.getByRole("button", { name: escapeRegex(`Pulled ${row}`) });
}

/** The table row that carries `row`'s Pulled toggle. */
export function pickRow(scope: Locator, row: string): Locator {
  return scope.getByRole("row").filter({ has: scope.page().getByRole("button", { name: escapeRegex(`Pulled ${row}`) }) });
}

/** A row's "Bigger picture of …" button (only a row with a card has one). */
export function pictureButton(scope: Locator, row: string): Locator {
  return scope.getByRole("button", { name: escapeRegex(`Bigger picture of ${row}`) });
}

/**
 * Opens "More filters" on a phone (Order, Sport, Year, Type and Condition
 * live under it); a wide screen shows them inline and has no such button.
 */
export async function openMoreFilters(page: Page, isMobile: boolean): Promise<void> {
  const { region } = pickList(page);
  const more = region.getByRole("button", { name: /^More filters/ });
  const order = region.getByRole("combobox", { name: "Order", exact: true });
  if (isMobile) {
    if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
  } else {
    await expect(more).toBeHidden();
  }
  await expect(order).toBeVisible();
}

/** Picks `option` (its visible text) in one of the filter bar's selects: "Order", "Sport", "Year", "Type", "Condition". */
export async function filterBy(page: Page, isMobile: boolean, label: string, option: string): Promise<void> {
  await openMoreFilters(page, isMobile);
  const select = pickList(page).region.getByRole("combobox", { name: label, exact: true });
  await select.selectOption({ label: option });
  await expect(select.getByRole("option", { selected: true })).toHaveText(option);
}

/** The sortable columns, as their header buttons and the phone's "Sort by" read. */
export type PickSortColumn = "Qty" | "No." | "Player" | "Condition" | "Serial" | "Order";

/**
 * Sorts the whole list by a column, starting from the pick order. A wide
 * screen presses the column's header button (once ascending, twice
 * descending) and the header says so (`aria-sort`); a phone picks it from
 * "Sort by".
 */
export async function sortBy(page: Page, isMobile: boolean, column: PickSortColumn, dir: "asc" | "desc"): Promise<void> {
  const { region, table } = pickList(page);
  if (isMobile) {
    const select = region.getByRole("combobox", { name: "Sort by", exact: true });
    const option = `${column}, ${dir === "asc" ? "low to high" : "high to low"}`;
    await select.selectOption({ label: option });
    await expect(select.getByRole("option", { selected: true })).toHaveText(option);
    return;
  }
  const button = table.getByRole("button", { name: column, exact: true });
  const header = table.getByRole("columnheader").filter({ has: page.getByRole("button", { name: column, exact: true }) });
  await expect(header).toHaveAttribute("aria-sort", "none");
  await button.click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  if (dir === "desc") {
    await button.click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
  }
}

// ---------------------------------------------------------------------------
// The signed-in Pick List (`collection/inventory-pick-list`): its orders are
// seeded through the test hop, since a sale cannot be made on cue (the seller
// accounts are shared and a real order needs a real buyer).
// ---------------------------------------------------------------------------

/** The Pick List's own page in the signed-in app. */
export const PICK_LIST_PATH = "/inventory?tab=pick";

/** How the list names a BuySportsCards order: "BSC <order number>" (its Order filter option and a row's order). */
export function bscOrder(orderNo: string): string {
  return `BSC ${orderNo}`;
}

/**
 * How the toggle of a line NB could not tie to a card begins: "Unmatched sale,
 * BSC <order>" (the row's own title says nothing of its order, so the name
 * adds it). An order holding more than one such line reads "Unmatched sale
 * (n of m), BSC <order>"; the specs seed one per order.
 */
export function unmatchedLine(orderNo: string): string {
  return `Unmatched sale, ${bscOrder(orderNo)}`;
}

/**
 * Seeds one BuySportsCards order over the signed-in user's own box
 * (`/testing/seed-pick-order`, testing deployments only): it is recorded and
 * applied as the sales poll would, taking the copies from `box`, and lands on
 * `redirect` (the Pick List by default). `cards` maps a card number in the
 * box to the copies sold; `bad` adds one line NB cannot tie to a card and says
 * nothing of (it stays under Can't find it). `listed` (NEO-509,
 * `"<card number>:<players>"`) adds one more unmatched line that DESCRIBES a
 * card of the first card's set, so it files inline under that set with an
 * "Unmatched" chip; its toggle reads `Pulled <set> · <players> · #<number>,
 * unmatched, BSC <order>` (`listedLine`). The
 * hop refuses an account that lists on a marketplace, so no copy it lowers
 * reaches one. `orderNo` must be one token. Re-seeding a number replays the
 * stored order. Opens `page` on the hop, so the browser does a full load
 * (callers gate on the destination with `LAUNCH_GATE`).
 */
export async function seedPickOrder(
  page: Page,
  order: { orderNo: string; box: string; cards: Readonly<Record<string, number>>; bad?: boolean; listed?: string },
  redirect = PICK_LIST_PATH,
): Promise<void> {
  const cards = Object.entries(order.cards)
    .map(([no, qty]) => `${no}:${qty}`)
    .join(",");
  const query = new URLSearchParams({ order: order.orderNo, box: order.box, cards, redirect });
  if (order.bad) query.set("bad", "1");
  if (order.listed) query.set("listed", order.listed);
  await page.goto(`/testing/seed-pick-order?${query.toString()}`);
}

/**
 * How a described unmatched line (`seedPickOrder`'s `listed`) is titled, and
 * so how its toggle begins: "2024 Topps Chrome · Listed<token> · #208". The
 * set is the one the card number is filed under, a Base variant is not written.
 */
export function listedLine(setTitle: string, players: string, cardNumber: string): string {
  return `${setTitle} · ${players} · #${cardNumber}`;
}

/** Marks a seeded order shipped (the hop's `ship=1`): its lines leave the Pick List. */
export async function shipPickOrder(page: Page, orderNo: string, redirect = PICK_LIST_PATH): Promise<void> {
  const query = new URLSearchParams({ order: orderNo, ship: "1", redirect });
  await page.goto(`/testing/seed-pick-order?${query.toString()}`);
}

/** The table's group (a set, Can't find it, Sold since you started) under the heading `title`. */
export function pickGroup(table: Locator, title: string): Locator {
  return table.getByRole("rowgroup").filter({ has: table.page().getByRole("heading", { level: 3, name: title, exact: true }) });
}
