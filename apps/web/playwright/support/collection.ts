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

/** A real set the collector's cascade can be driven to: sport, year, brand, set, and its Base. */
export interface CollectorSet {
  sport: string;
  year: string;
  manufacturer: string;
  set: string;
}

/** The seed's 2024 Topps Chrome (the default of `drillToCollectorBase`). */
export const TOPPS_CHROME_2024: CollectorSet = {
  sport: "Baseball",
  year: "2024",
  manufacturer: "Topps",
  set: "Topps Chrome",
};

/**
 * 1988 Topps Baseball (BSC's "1988 Topps", year stripped to the set "Topps"
 * under the brand "Topps"): the BuySportsCards listing spec's fixture
 * (NEO-370), provisioned by `setup.spec.ts`.
 */
export const TOPPS_1988: CollectorSet = {
  sport: "Baseball",
  year: "1988",
  manufacturer: "Topps",
  set: "Topps",
};

/** The checklist's own name: "2024 Topps Chrome Base", "1988 Topps Base". */
export function baseChecklistTitle(target: CollectorSet): string {
  return `${target.year} ${target.set} Base`;
}

/**
 * From the Checklists tab to a seeded set's Base checklist (the seed's 2024
 * Topps Chrome unless `target` says otherwise); returns its region.
 */
export async function drillToCollectorBase(page: Page, target: CollectorSet = TOPPS_CHROME_2024): Promise<Locator> {
  const { drill } = collectorCascade(page);
  await drill("Sports", target.sport, "Years");
  await drill("Years", target.year, "Brands");
  await drill("Brands", target.manufacturer, "Sets");
  await drill("Sets", target.set, "Variant Types");
  await drill("Variant Types", "Base");
  const title = baseChecklistTitle(target);
  const checklist = page.getByRole("region", { name: title });
  await expect(checklist.getByRole("heading", { level: 3, name: title })).toBeVisible();
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

/**
 * On My Boxes (`/inventory?tab=boxes`): every box the worker has EXCEPT
 * `keep` goes in-person, BEFORE a marketplace connection starts listing
 * (saving one walks every card in a listed box, so stock an earlier spec left
 * on this worker must not reach a real marketplace). The boxes on the shelf
 * and Unsorted in "Special places" are each opened and their "Listed on
 * marketplaces" turned off (a box starts on), and each ends unchecked,
 * asserted. They are left in-person afterwards: putting them back would queue
 * their cards. The Up for Trade pile is not a box that lists. Used by the
 * listing specs (BuySportsCards, eBay); one implementation.
 */
export async function putOtherBoxesInPerson(page: Page, keep: string): Promise<void> {
  const boxName = keep;
  const boxes = page.getByRole("list", { name: "Your boxes" });
  const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
  // Every other box the worker has: the boxes on the shelf and Unsorted in
  // "Special places" (the Up for Trade pile is not a box that lists). Each is
  // opened and its "Listed on marketplaces" turned off (a box starts on), and
  // each ends unchecked, asserted. They are left in-person afterwards:
  // putting them back would queue their cards.
  const special = page.getByRole("list", { name: "Special places" });
  const spineRe = /^(.+), box, (?!.*up for trade)/;
  const spines = boxes.getByRole("button", { name: spineRe }).or(special.getByRole("button", { name: spineRe }));
  // The shelf has settled when Unsorted is drawn and no box is still "counting"
  // (its spine reads ", box, counting" until its count is known).
  await expect(special.getByRole("button", { name: /^Unsorted, box, / })).toBeVisible();
  await expect(
    boxes.getByRole("button", { name: /, box, counting$/ }).or(special.getByRole("button", { name: /, box, counting$/ })),
  ).toHaveCount(0);
  const boxNameOf = (spineName: string) => spineRe.exec(spineName)![1];
  const readBoxes = async () => {
    const names: string[] = [];
    for (let i = 0, n = await spines.count(); i < n; i++) names.push(await nameOf(spines.nth(i)));
    return names;
  };
  const others = (await readBoxes()).filter((name) => boxNameOf(name) !== boxName);
  // Unsorted is never skipped: it is the box most likely to hold earlier stock.
  expect(others.map(boxNameOf), "the shelf names Unsorted").toContain("Unsorted");
  for (const spineName of others) {
    const box = boxNameOf(spineName);
    await boxes.getByRole("button", { name: spineName, exact: true }).or(special.getByRole("button", { name: spineName, exact: true })).click();
    await expect(page).toHaveURL(/[?&]b=[^&]+/);
    const toggle = page.getByRole("checkbox", { name: "Listed on marketplaces", exact: true });
    await expect(toggle).toBeVisible();
    if (await toggle.isChecked()) {
      await toggle.uncheck();
      await expect(said(`${box} is in-person only now.`)).toBeVisible();
    }
    await expect(toggle).not.toBeChecked();
    await backToBoxes(page);
  }
  // Nothing arrived on the shelf while they were handled: a late box fails here, never skipped.
  const handled = new Set([boxName, ...others.map(boxNameOf)]);
  await expect
    .poll(async () => (await readBoxes()).map(boxNameOf).filter((name) => !handled.has(name)))
    .toEqual([]);
}

/**
 * On the open checklist `title`: clear its common price (read as `was`
 * first). The listing specs' tidy-up and failure hooks use it, so a rerun
 * starts without one and sees the listing gate's hold.
 */
export async function clearChecklistCommonPrice(page: Page, checklist: Locator, title: string, was: string): Promise<void> {
  await checklist.getByRole("button", { name: `Change the common price for ${title}`, exact: true }).click();
  const priceField = checklist.getByRole("textbox", { name: "Common price", exact: true });
  await expect(priceField).toHaveValue(was);
  await priceField.fill("");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: `Cleared the common price for ${title}` })).toBeVisible();
}

/**
 * On the Inventory Checklists tab with the Adding-to box picked: set the
 * `cards`' quantities in `box` to 0 (only those not already 0) on the Base
 * checklist of `target`. Returns the checklist. Idempotent, for the listing
 * specs' tidy-up and failure hooks.
 *
 * `arrival` says how the tab was reached. The Checklists tab link reopens the
 * checklist last open on the same page ("Checklists opens where you left it"),
 * so after a tab change within the page it is already open ("reopened"); a
 * fresh page load starts at the cascade ("fresh") and drills.
 */
export async function emptyBoxCards(
  page: Page,
  target: CollectorSet,
  box: string,
  cards: readonly string[],
  isMobile: boolean,
  arrival: "fresh" | "reopened",
): Promise<Locator> {
  const title = baseChecklistTitle(target);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const adding = page.getByRole("combobox", { name: "Adding to" });
  await expect(adding).toBeVisible();
  let checklist: Locator;
  if (arrival === "fresh") {
    checklist = await drillToCollectorBase(page, target);
  } else {
    checklist = page.getByRole("region", { name: title });
    await expect(checklist.getByRole("heading", { level: 3, name: title })).toBeVisible();
  }
  await adding.selectOption({ label: box });
  const boxList = checklist.getByRole("list", { name: `Quantities in ${box}` });
  for (const short of cards) {
    const field = quantityField(boxList, short, box);
    await expect(field).toBeVisible();
    if ((await field.inputValue()) !== "0") {
      await field.fill("0");
      // The key that leaves a quantity field: Tab on a desktop, Enter on a phone.
      await page.keyboard.press(isMobile ? "Enter" : "Tab");
      await expect(field).toHaveValue("0");
      await expect(
        page.getByRole("status").filter({ hasText: new RegExp(`^Pulled \\d+ of ${escape(short)} from `) }),
      ).toBeVisible();
    }
  }
  return checklist;
}

/**
 * NEO-415: Sync status's step ledger for one set on one marketplace, so a spec
 * waits on each step of a live round trip (the standard 7 s each) instead of on
 * the whole trip. `platform` is the platform's region on Sync status;
 * `platformName` is how the screen names it ("BuySportsCards", "eBay").
 *
 * A run's steps live in one of two lists, never both: "Sync steps for <set> on
 * <platform>" under Running now while the run is under way (every step, one
 * item each), "Last sync steps for <set> on <platform>" on the set's row once
 * it has finished. The finished BuySportsCards row FOLDS: every `Read ...`
 * becomes one "Gathering data" item at the first read's place, the
 * `Double-check ...` steps are dropped (unless one failed), and the update
 * steps (`Upload photos`, `Send changes to ...`) stay. eBay's finished row is
 * unchanged. So:
 *  - `step` matches the same label in either list: right for the steps both
 *    lists hold (the send, eBay's steps), WRONG for a BSC read or confirm,
 *    which the finished row no longer has;
 *  - `readLanded` / `confirmLanded` (BSC) are the right waits for those two:
 *    each is satisfied by the running list's done item, or by the finished
 *    row's folded form, so a run that ends before the spec looks cannot hang
 *    them.
 *
 * Stale ledgers: the row keeps the PREVIOUS run's finished steps until the
 * next run claims the set (the claim empties them, and the row draws none while
 * the set is running). A spec therefore calls `underWay` first, with the new
 * run's own result line, before it trusts any step: after that, the running
 * list is the new run's, and a finished row can only be the new run's too.
 */
export function syncRun(platform: Locator, setLabel: string, platformName: string) {
  const running = platform.getByRole("list", { name: `Sync steps for ${setLabel} on ${platformName}`, exact: true });
  const last = platform.getByRole("list", { name: `Last sync steps for ${setLabel} on ${platformName}`, exact: true });
  const steps = running.or(last);
  /**
   * A step in `state` ("done" unless said), by its label: the whole label as a
   * string, or a pattern for the label alone (the state is appended to it).
   */
  const step = (label: string | RegExp, state: "done" | "working" | "waiting" | "failed" = "done"): Locator =>
    typeof label === "string"
      ? steps.getByRole("listitem", { name: `${label}, ${state}`, exact: true })
      : steps.getByRole("listitem", { name: new RegExp(`${label.source.replace(/\$$/, "")}, ${state}$`, label.flags) });
  /** BSC: a sheet read has landed: the running list's done read, or the finished row's "Gathering data". */
  const readLanded = (): Locator =>
    running
      .getByRole("listitem", { name: /^Read .+, done$/ })
      .first()
      .or(last.getByRole("listitem", { name: "Gathering data, done", exact: true }));
  /**
   * BSC: a confirm has landed: the running list's done `Double-check ...`, or the
   * finished row (which no longer lists confirms) once its send is done.
   */
  const confirmLanded = (): Locator =>
    running
      .getByRole("listitem", { name: /^Double-check .+, done$/ })
      .first()
      .or(last.getByRole("listitem", { name: /^Send changes to .+, done$/ }));
  return {
    running,
    last,
    steps,
    step,
    readLanded,
    confirmLanded,
    /**
     * The new run is visible: its ledger under Running now, or (a run that
     * finished before the spec looked) its own result line. Gate every `step`
     * wait on this, so the last run's finished ledger can never stand in.
     */
    underWay: (resultLine: Locator): Locator => running.or(resultLine).first(),
  };
}

/**
 * Walks the set's run under way one step at a time: every wait covers exactly
 * ONE step landing, within the standard budget, so a run of many serial sheet
 * reads is never held to one 7 s window. Each pass waits for the step the run
 * is on (the first working or waiting item of the running list) to reach done
 * (or failed: the run goes on past a snag), then looks again.
 *
 * Used where a spec does not know how many steps a run holds: a throttled
 * press reads fewer sheets, a failure hook cleans up whatever is in flight, and
 * a run that has already ended (its finished, folded row) needs no walking.
 * It returns when the platform says "Nothing syncing right now." or, if given,
 * when `until` is visible (e.g. the send's done item, after which the spec
 * waits for the confirm and the result line itself). A bounded loop, one pass
 * per step (a modern set's longest plan is ten steps).
 */
export async function followRunToEnd(
  platform: Locator,
  run: ReturnType<typeof syncRun>,
  until?: Locator,
): Promise<void> {
  const idle = platform.getByText(/^Nothing syncing right now\./);
  const over = until ? idle.or(until).first() : idle;
  const open = run.running.getByRole("listitem", { name: /, (working|waiting)$/ });
  for (let pass = 0; pass < 12; pass++) {
    // Either the walk is over, or the run shows the step it is on.
    await expect(over.or(open.first()).first()).toBeVisible();
    if (await over.isVisible()) return;
    const label = ((await open.first().textContent()) ?? "").trim().replace(/, (working|waiting)$/, "");
    // That one step lands (or snags), or the run ends, or the walk's goal is reached.
    await expect(run.step(label).or(run.step(label, "failed")).or(over).first()).toBeVisible();
  }
  await expect(over).toBeVisible();
}
