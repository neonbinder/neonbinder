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
