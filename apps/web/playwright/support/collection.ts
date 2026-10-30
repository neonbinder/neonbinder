/**
 * The signed-in collector's `/collection` Checklists cascade (group "Sport,
 * year, brand and set"). This is the collector's catalog, a different screen
 * from the admin Set Builder, so the `drillTo*` helpers in `set-builder.ts`
 * do not apply (R3/R9). Used by the `collection/*` specs; one implementation.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The cascade and a `drill` that picks one option and waits for its summary
 * card. `name` is the cascade's group: Checklists' by default, or the Add
 * cards set pick's ("Sport, year, brand, set and variant").
 */
export function collectorCascade(page: Page, name = "Sport, year, brand and set") {
  const cascade = page.getByRole("group", { name });
  const drill = async (column: string, option: string, next?: string) => {
    await cascade
      .getByRole("listbox", { name: column })
      .getByRole("option")
      .filter({ has: page.getByText(option, { exact: true }) })
      .click();
    // The picked column collapses to its summary.
    await expect(cascade.getByRole("button", { name: `${column}: ${option}, change` })).toBeVisible();
    if (next) {
      // The columns sit in one row that scrolls sideways; on a phone the next
      // one starts off screen. It must be reachable (and on a desktop, it is).
      const nextList = cascade.getByRole("listbox", { name: next });
      await nextList.scrollIntoViewIfNeeded();
      await expect(nextList).toBeInViewport();
    }
  };
  return { cascade, drill };
}

/** From the Checklists tab to the seed's 2024 Topps Chrome Base checklist; returns its region. */
export async function drillToCollectorBase(page: Page): Promise<Locator> {
  const { drill } = collectorCascade(page);
  await drill("Sports", "Baseball", "Years");
  await drill("Years", "2024", "Brands");
  await drill("Brands", "Topps", "Sets");
  await drill("Sets", "Topps Chrome", "Variant Types");
  await drill("Variant Types", "Base");
  const checklist = page.getByRole("region", { name: "2024 Topps Chrome Base" });
  await expect(checklist.getByRole("heading", { level: 3, name: "2024 Topps Chrome Base" })).toBeVisible();
  return checklist;
}

/**
 * The Base rows that read `#N First Last` (two or more words, one player, no
 * variation), never #300 (the signed-by spec's card). The `Details` button of
 * a card with two or more lines carries the line in its name (a comma), so
 * read the names you need BEFORE writing to any of them.
 */
export function ordinaryBaseRows(checklist: Locator): Locator {
  return checklist.getByRole("button", { name: /^Details for #(?!300 )\S+ [^,/\s]+ [^,/]+$/ });
}

/** `#N First Last` off an ordinary row's own accessible name. */
export async function shortNameOf(row: Locator): Promise<{ short: string; number: string; player: string }> {
  const snapshot = await row.ariaSnapshot();
  const short = /button "Details for ([^"]+)"/.exec(snapshot)?.[1] ?? "";
  const parsed = /^#(\S+) (.+)$/.exec(short);
  expect(parsed, `a Base row named "#N First Last" (read: ${short})`).not.toBeNull();
  return { short, number: parsed![1], player: parsed![2] };
}

// ---------------------------------------------------------------------------
// NEO-364: the inventory (`/inventory`), a screen of boxes beside the
// collection's binders. Used by `collection/inventory-*` and the updated
// binders spec; one implementation.
// ---------------------------------------------------------------------------

/** "1 card", "12 cards": how the app spells a count of cards. */
export function cardsWord(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "card" : "cards"}`;
}

/** A count off a name ("1,204"), as a number. */
export function numberOf(text: string | undefined): number {
  return Number((text ?? "0").replace(/,/g, ""));
}

/**
 * The accessible name of a button, link, textbox or combobox, read off its
 * ARIA snapshot (YAML writes an apostrophe as '' ; undone here). For counts a
 * test reads before it writes: the name is what a screen reader hears.
 */
export async function nameOf(control: Locator): Promise<string> {
  await expect(control).toBeVisible();
  const snapshot = await control.ariaSnapshot();
  return (/(?:button|link|textbox|combobox) "([^"]+)"/.exec(snapshot)?.[1] ?? "").replace(/''/g, "'");
}

/** The first capture group of a control's name, as a number; fails loudly when the name is not what was expected. */
export async function countOf(control: Locator, re: RegExp): Promise<number> {
  const name = await nameOf(control);
  const m = re.exec(name);
  expect(m, `a control named like ${re} (read: ${name})`).not.toBeNull();
  return numberOf(m![1]);
}

/**
 * Follow a link of the signed-in shell (the top tabs on a desktop, the Menu
 * dialog on a phone) to another screen: "Collection" or "Inventory". The tab
 * is a plain link named for the screen.
 */
export async function goViaShell(page: Page, isMobile: boolean, name: "Collection" | "Inventory"): Promise<void> {
  if (isMobile) {
    await page.getByRole("button", { name: "Open menu" }).click();
    const menu = page.getByRole("dialog", { name: "Menu" });
    await expect(menu).toBeVisible();
    await menu.getByRole("link", { name, exact: true }).click();
    await expect(menu).toBeHidden();
  } else {
    await page.getByRole("link", { name, exact: true }).click();
  }
}

/**
 * My Boxes' headline, the whole stock for sale (every box, Unsorted
 * included): "N cards for sale in K boxes." or, with none, "Nothing for sale
 * yet.". My Boxes has no long box to count it (the Inventory tab is the list),
 * so this is the number to measure against.
 */
export function myBoxesStock(page: Page, cards: number): Locator {
  if (cards === 0) return page.getByText("Nothing for sale yet.", { exact: true });
  const words = cardsWord(cards).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByText(new RegExp(`^${words} for sale in \\d+ box(?:es)?\\.$`));
}

/** The count off My Boxes' headline (`myBoxesStock`), read once it has settled. */
export async function forSaleOnMyBoxes(page: Page): Promise<number> {
  const headline = page.getByText(/^(?:[\d,]+ cards? for sale in \d+ box(?:es)?|Nothing for sale yet)\.$/);
  await expect(headline).toBeVisible();
  const text = (await headline.textContent()) ?? "";
  return /^Nothing/.test(text) ? 0 : numberOf(/^([\d,]+)/.exec(text)?.[1]);
}

/** The Inventory page's tab strip ("Inventory sections"). */
export function inventoryTabs(page: Page): Locator {
  return page.getByRole("navigation", { name: "Inventory sections" });
}

/**
 * On My Boxes (`/inventory?tab=boxes`): make a box and land in it (the
 * dialog's submit opens the new box). `onDialog` runs while the dialog is
 * showing, for the spec's axe check. Returns the box's heading.
 */
export async function createBox(page: Page, name: string, onDialog?: (dialog: Locator) => Promise<void>): Promise<Locator> {
  await page.getByRole("list", { name: "Your boxes" }).getByRole("button", { name: "New box", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New box", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Box name" })).toBeVisible();
  if (onDialog) await onDialog(dialog);
  await dialog.getByRole("textbox", { name: "Box name" }).fill(name);
  await dialog.getByRole("button", { name: "Put it on the shelf" }).click();
  await expect(dialog).toBeHidden();
  const heading = page.getByRole("heading", { level: 2, name, exact: true });
  await expect(heading).toBeVisible();
  await expect(page).toHaveURL(/[?&]b=[^&]+/);
  return heading;
}

/** From an open box back to the My Boxes shelf. */
export async function backToBoxes(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back to the shelf" }).click();
  await expect(page.getByRole("list", { name: "Your boxes" })).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]b=/);
}

/**
 * Delete an open box through its "Rename or delete" dialog and confirm.
 * `confirmed` runs on the confirm dialog while it shows (copy, axe); the box
 * is deleted after it. Returns when the confirm has closed.
 */
export async function deleteOpenBox(
  page: Page,
  name: string,
  confirmed?: (confirm: Locator) => Promise<void>,
): Promise<void> {
  await page.getByRole("button", { name: `Rename or delete ${name}`, exact: true }).click();
  await page
    .getByRole("dialog", { name: `Rename or delete ${name}`, exact: true })
    .getByRole("button", { name: "Delete this box" })
    .click();
  const confirm = page.getByRole("dialog", { name: `Delete ${name}?`, exact: true });
  await expect(confirm).toBeVisible();
  if (confirmed) await confirmed(confirm);
  await confirm.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(confirm).toBeHidden();
}

/** A checklist row's quantity field on the inventory side: "Quantity of <card> in <box>". */
export function quantityField(scope: Locator, short: string, box: string): Locator {
  return scope.getByRole("textbox", { name: `Quantity of ${short} in ${box}`, exact: true });
}

/**
 * The Inventory list's filters (the filter box, "Sort by", "Sport", the
 * "Only show" chips): on a phone they fold behind a "Filters" button, so open
 * it first (a no-op on a desktop, where there is no such button). Open once per
 * visit to the list: a second click would fold them again.
 */
export async function openListFilters(page: Page, isMobile: boolean): Promise<void> {
  if (!isMobile) return;
  const button = page.getByRole("button", { name: /^Filters/ });
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
}
