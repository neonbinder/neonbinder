/**
 * The signed-in collector's `/collection` Checklists cascade (group "Sport,
 * year, brand and set"). This is the collector's catalog, a different screen
 * from the admin Set Builder, so the `drillTo*` helpers in `set-builder.ts`
 * do not apply (R3/R9). Used by the `collection/*` specs; one implementation.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { expectAfterMarketplace } from "./marketplace-wait";

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

/**
 * A real set the collector's cascade can be driven to (sport, year, brand,
 * set) and the checklist under it: the set's Base, unless `checklist` names a
 * variant type and the row under it that is the checklist (an insert, a
 * parallel).
 */
export interface CollectorSet {
  sport: string;
  year: string;
  manufacturer: string;
  set: string;
  /**
   * The checklist below the set when it is not the Base: the variant type's
   * title as the Variant Types column lists it ("Insert"), which is also the
   * next column's name, and the row picked there ("Future Stars").
   */
  checklist?: { type: string; name: string };
}

/** The seed's 2024 Topps Chrome (the default of `drillToCollectorBase`). */
export const TOPPS_CHROME_2024: CollectorSet = {
  sport: "Baseball",
  year: "2024",
  manufacturer: "Topps",
  set: "Topps Chrome",
};

/**
 * The seed's 2024 Topps Chrome › Insert › Future Stars (20 cards), the
 * marketplace-seller listing specs' fixture (NEO-475; SET-REGISTRY.md). Its
 * checklist and Sync status both name it "2024 Topps Chrome Future Stars": an
 * insert reads as part of the set's name.
 */
export const TOPPS_CHROME_2024_FUTURE_STARS: CollectorSet = {
  ...TOPPS_CHROME_2024,
  checklist: { type: "Insert", name: "Future Stars" },
};

/**
 * The checklist's own name, as its heading, region and the Add cards "Set:"
 * button read it: "2024 Topps Chrome Base", "2024 Topps Chrome Future Stars".
 */
export function checklistTitle(target: CollectorSet): string {
  return `${target.year} ${target.set} ${target.checklist?.name ?? "Base"}`;
}

/** The set's Base checklist's name ("2024 Topps Chrome Base"), whatever `target.checklist` says. */
export function baseChecklistTitle(target: CollectorSet): string {
  return checklistTitle({ ...target, checklist: undefined });
}

/**
 * From the Checklists tab (Collection or Inventory) down to `target`'s
 * checklist: the set's Base, or the variant type and row its `checklist`
 * names. Returns the checklist's region.
 */
export async function drillToCollectorChecklist(page: Page, target: CollectorSet): Promise<Locator> {
  const { drill } = collectorCascade(page);
  await drill("Sports", target.sport, "Years");
  await drill("Years", target.year, "Brands");
  await drill("Brands", target.manufacturer, "Sets");
  await drill("Sets", target.set, "Variant Types");
  if (target.checklist) {
    // The picked type's rows are the next column, named for the type.
    await drill("Variant Types", target.checklist.type, target.checklist.type);
    await drill(target.checklist.type, target.checklist.name);
  } else {
    await drill("Variant Types", "Base");
  }
  const title = checklistTitle(target);
  const checklist = page.getByRole("region", { name: title });
  await expect(checklist.getByRole("heading", { level: 3, name: title })).toBeVisible();
  return checklist;
}

/**
 * From the Checklists tab to a seeded set's Base checklist (the seed's 2024
 * Topps Chrome unless `target` says otherwise); returns its region.
 */
export async function drillToCollectorBase(page: Page, target: CollectorSet = TOPPS_CHROME_2024): Promise<Locator> {
  return drillToCollectorChecklist(page, { ...target, checklist: undefined });
}

/** Add cards' drop zone, by the name a screen reader hears. */
export function intakeDropzone(page: Page): Locator {
  return page.getByLabel("Drag your card photos here, or browse your files");
}

/**
 * On Add cards (NEO-452): pick a set's variant as the run's set through the
 * "Set: ..." button and its cascade; the panel folds back into the button
 * once the variant is picked. A run needs a set before anything starts (photos
 * wait, "Use a scanner" is held), so every spec that starts a run calls this
 * first. By default the variant is the seeded set's Base type itself; a
 * `target` with a `checklist` picks that type's row instead (an insert such as
 * Future Stars); pass `under` for a set whose Base sits inside another type (a
 * hand-made set's `Insert` > `Base`). Returns the title the button now reads
 * ("2024 Topps Chrome Base", "2024 Topps Chrome Future Stars"). Works whether
 * or not a set is already picked (a pick replaces it).
 */
export async function pickIntakeSet(
  page: Page,
  target: CollectorSet = TOPPS_CHROME_2024,
  { under }: { under?: string } = {},
): Promise<string> {
  // `under` is a Base inside a type; a target's own checklist is a row inside one. Never both.
  expect(under && target.checklist, "pickIntakeSet takes `under` or a target checklist, not both").toBeFalsy();
  await page.getByRole("button", { name: /^Set: / }).click();
  const { cascade, drill } = collectorCascade(page, "Sport, year, brand, set and variant");
  await drill("Sports", target.sport, "Years");
  await drill("Years", target.year, "Brands");
  await drill("Brands", target.manufacturer, "Sets");
  await drill("Sets", target.set, "Variant Types");
  // Picking a variant folds the panel back into its button.
  const type = target.checklist?.type ?? under;
  if (type) await drill("Variant Types", type);
  await cascade
    .getByRole("listbox", { name: type ?? "Variant Types" })
    .getByRole("option")
    .filter({ has: page.getByText(target.checklist?.name ?? "Base", { exact: true }) })
    .click();
  const title = checklistTitle(target);
  await expect(page.getByRole("button", { name: `Set: ${title}`, exact: true })).toBeVisible();
  return title;
}

/**
 * The checklist rows that read `#N First Last` (two or more words, one player,
 * no variation; `#FS-5 ...` on an insert too), never #300 (the signed-by spec's
 * Base card). The `Details` button of
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
 * Follow a link of the shell (the top tabs on a desktop, the Menu dialog on a
 * phone) to another screen: "Collection" or "Inventory". The tab is a plain
 * link named for the screen. The logged-out demo (/demo) wears the same shell,
 * so its own "Back to the tour" tab goes through here too.
 */
export async function goViaShell(
  page: Page,
  isMobile: boolean,
  name: "Collection" | "Inventory" | "Back to the tour",
): Promise<void> {
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

/**
 * From anywhere: open My Boxes, open the box with this name and delete it
 * through its "Rename or delete" dialog (an empty box; the spec has emptied it).
 * The box must exist: a hook calls it only for a box whose creation the body saw
 * finish (`createBox` returned), and the click waits for the box like any other.
 * (A "skip it when it is not listed" branch was tried and leaked boxes: a shelf
 * that has painted is no proof that a name is absent.)
 */
export async function deleteBoxNamed(page: Page, name: string): Promise<void> {
  await page.goto("/inventory?tab=boxes");
  const spine = page
    .getByRole("list", { name: "Your boxes" })
    .getByLabel(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, box, `));
  await spine.click();
  await deleteOpenBox(page, name);
  await expect(page.getByRole("list", { name: "Your boxes" })).toBeVisible();
  await expect(spine).toHaveCount(0);
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
 * `cards`' quantities in `box` to 0 (only those not already 0) on `target`'s
 * checklist (its Base, or the row its `checklist` names). Returns the
 * checklist. Idempotent, for the listing specs' tidy-up and failure hooks.
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
  const title = checklistTitle(target);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const adding = page.getByRole("combobox", { name: "Adding to" });
  await expect(adding).toBeVisible();
  let checklist: Locator;
  if (arrival === "fresh") {
    checklist = await drillToCollectorChecklist(page, target);
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

/** The check step a run that sends nothing holds (NEO-433): running label, and what the finished row folds it into. */
export const CHECK_STEP = "Compare with your boxes";
const GATHERING_DATA = "Gathering data";
/** The second folded line of a clean run that sent or changed nothing (NEO-433): the positive proof the press sent nothing. */
export const NOTHING_NEW = "Nothing new to send";

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
 * NEO-433: every finished run has a non-empty ledger. A run that sends nothing
 * (a press that lands after the 15-minute sales poll already listed the stocked
 * box does a full read and sends nothing) holds one step, the check "Compare
 * with your boxes" (`CHECK_STEP`), which the finished row folds into "Gathering
 * data" like a read. So "the run gathered its data" (`readLanded`, `gathered`)
 * is the same wait whether the run read sheets or only compared, and a spec
 * that must tell a sending run from a non-sending one asserts the send (or its
 * absence) itself, never inferring it from this wait.
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
  /** The finished row's folded "Gathering data, done": every read (and the check) of the run, landed. */
  const gathered = (): Locator => last.getByRole("listitem", { name: `${GATHERING_DATA}, done`, exact: true });
  /**
   * BSC: the run's data gathering has landed: the running list's done read or
   * its done check ("Compare with your boxes"), or the finished row's "Gathering
   * data" (a run that ends first, or one that only compared, NEO-433).
   */
  const readLanded = (): Locator =>
    running
      .getByRole("listitem", { name: /^Read .+, done$/ })
      .first()
      .or(running.getByRole("listitem", { name: `${CHECK_STEP}, done`, exact: true }))
      .or(gathered());
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
    gathered,
    /** The "Nothing new to send" line of a finished run's ledger; absent on any run that sent or changed something. */
    nothingNew: (): Locator => last.getByRole("listitem", { name: new RegExp(`^${NOTHING_NEW}`) }),
    confirmLanded,
    /**
     * The new run is visible: its ledger under Running now, or (a run that
     * finished before the spec looked) its own result line. Gate every `step`
     * wait on this, so the last run's finished ledger can never stand in.
     */
    underWay: (resultLine: Locator): Locator => running.or(resultLine).first(),
  };
}

/** A signed-off longer landing ceiling per step label: a label map, or a function for labels that vary (a read's condition). */
export type StepCeilings = Readonly<Record<string, number>> | ((label: string) => number | undefined);

/**
 * One step of a walk lands (`landing`). A step with a signed-off ceiling in
 * `slow` waits that long (GUIDE hard rule 3). Any other step waits 7 s of our
 * own time, and, when the walk names the `marketplace` it talks to (NEO-487),
 * plus every second the "Waiting on <marketplace>..." status was up
 * (`expectAfterMarketplace`): a marketplace that makes a step slow never fails
 * a spec, and a slow step of ours still does. Without `marketplace` it is the
 * plain 7 s.
 */
async function stepLands(
  platform: Locator,
  label: string,
  landing: Locator,
  slow: StepCeilings,
  marketplace: string | undefined,
): Promise<void> {
  const budget = typeof slow === "function" ? slow(label) : slow[label];
  if (budget === undefined && marketplace !== undefined) {
    await expectAfterMarketplace(platform.page(), landing, { platform: marketplace, what: `the step "${label}"` });
    return;
  }
  await expect(landing).toBeVisible(budget === undefined ? undefined : { timeout: budget });
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
 *
 * `slow` gives ONE named step a longer landing budget than the standard 7 s:
 * `{ "Go live": 15_000 }`. Only a ceiling Jason has signed off belongs here,
 * recorded at the call site (GUIDE hard rule 3); every other step keeps the
 * config's budget, and a step not named in `slow` is never given more. `slow`
 * may also be a function of the label (`bscReadCeiling`). `marketplace` (NEO-487,
 * "BuySportsCards") makes every OTHER step wait 7 s plus the time the
 * marketplace's "Waiting on ..." status is up (`expectAfterMarketplace`).
 */
export async function followRunToEnd(
  platform: Locator,
  run: ReturnType<typeof syncRun>,
  until?: Locator,
  slow: StepCeilings = {},
  marketplace?: string,
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
    await stepLands(platform, label, run.step(label).or(run.step(label, "failed")).or(over).first(), slow, marketplace);
  }
  await expect(over).toBeVisible();
}

/**
 * NEO-433: the queued rows a press writes are the evidence that a run which
 * started AFTER the press has finished. A press writes (or touches) the set's
 * queued cards before its toast, and the drain's finish clears them in the very
 * write that records the run's result and releases its lease; a run that
 * claimed before the press cannot clear them (their sequence moved), so the
 * set goes round again. So "nothing queued for this set" on Sync status, with
 * a press already toasted, means a run that read the press's rows has ended,
 * and the set's row (line, ledger) is that run's. Nothing about a stale row
 * left by the sales poll can satisfy it.
 *
 * Visible when the platform's queue holds no card of `setLabel`: the empty
 * queue's "Nothing waiting." line, or a queue list with other sets' cards only.
 */
export function queueSettled(platform: Locator, setLabel: string): Locator {
  const escaped = setLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The row's text is "<card> in <set>queued <when>" (two spans, no space in the
  // DOM; hasNotText reads textContent, not the aria snapshot's spacing), so a
  // sibling whose name starts with this one ("2024 Topps Chrome Future Stars
  // Autographs" beside "2024 Topps Chrome Future Stars") never
  // counts as this set's.
  const ofSet = new RegExp(` in ${escaped}\\s*queued\\s`);
  return platform
    .getByText(/^Nothing waiting\./)
    .or(
      platform
        .getByRole("list", { name: /^Queued for the next sync/ })
        .filter({ hasNotText: ofSet }),
    );
}

/**
 * NEO-433: a failure hook's walk of a run. A live read can stall past one step's
 * budget (the body's red says so), and that must not stop the rest of the tidy-up.
 * Walks again up to `tries` times, then returns the last error for the hook to
 * rethrow once it has finished; `undefined` when the walk got through. Never for
 * a test body: there a stalled step is the failure.
 */
export async function walkForCleanup(walk: () => Promise<void>, tries = 3): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      await walk();
      return undefined;
    } catch (error) {
      last = error;
    }
  }
  return last;
}

/** The most steps `followRunToRest` walks: two runs at the ledger's cap (`MAX_PROGRESS_STEPS` 40) is the ceiling, in practice a set's run is under 25. */
const MAX_REST_PASSES = 45;

/**
 * Walks the set to rest after a press: every wait covers exactly ONE step
 * landing (the standard budget, or what `slow` gives a step with a signed-off
 * longer ceiling, recorded at the call site, GUIDE hard rule 3: a label map, or
 * a function for labels that vary, such as a read's condition), until the
 * press's queued rows are gone (`settled`, from `queueSettled`) and the
 * platform is idle. Unlike `followRunToEnd` it never ends on an idle platform
 * alone: a stale row left by the sales poll shows "Nothing syncing right now."
 * too, and a press during a run goes round again after the first run ends,
 * with an idle moment between the two. The press's rows are what tell the
 * runs apart, so a press whose run never claims leaves them queued and this
 * goes red, whichever way the poll raced it.
 *
 * Call it with the press already toasted, and read the set's row only after
 * it returns: the row is then a run that started after the press, finished.
 *
 * `marketplace` (NEO-487): the platform's name as the screen says it
 * ("BuySportsCards"). Every step not named in `slow` then waits 7 s of our own
 * time plus the seconds "Waiting on <marketplace>..." was showing, with the
 * measured wait in the test report, instead of a flat 7 s.
 */
export async function followRunToRest(
  platform: Locator,
  run: ReturnType<typeof syncRun>,
  settled: Locator,
  slow: StepCeilings = {},
  marketplace?: string,
): Promise<void> {
  const idle = platform.getByText(/^Nothing syncing right now\./);
  const open = run.running.getByRole("listitem", { name: /, (working|waiting)$/ });
  for (let pass = 0; pass < MAX_REST_PASSES; pass++) {
    // Either the press's rows are gone, or a run shows the step it is on (a run
    // not yet claimed shows neither, and 7 s is the whole claim's budget).
    await expect(settled.or(open.first()).first()).toBeVisible();
    if (await settled.isVisible()) break;
    // One look at the open steps that never waits (a compare-only run's one step is
    // gone in a moment): none left means the step landed between the two looks.
    const [text] = await open.allTextContents();
    if (text === undefined) continue;
    const label = text.trim().replace(/, (working|waiting)$/, "");
    await stepLands(platform, label, run.step(label).or(run.step(label, "failed")).or(settled).first(), slow, marketplace);
  }
  await expect(settled).toBeVisible();
  await expect(idle).toBeVisible();
}

/**
 * NEO-433: a finished run that sent and changed nothing (the sales poll got
 * there first, so the press was a full read) shows exactly two folded lines, in
 * this order: "Gathering data, done", then "Nothing new to send". That pair is
 * the positive proof the press sent nothing; a spec's sending branch asserts
 * `run.nothingNew()` absent instead.
 */
export async function expectNothingSent(run: ReturnType<typeof syncRun>): Promise<void> {
  await expect(run.last).toBeVisible();
  await expect(run.last.getByRole("listitem")).toHaveText([
    new RegExp(`^${GATHERING_DATA}, done$`),
    new RegExp(`^${NOTHING_NEW}`),
  ]);
}

// ---------------------------------------------------------------------------
// NEO-377, NEO-431: a copy line's photos. Used by `collection/copy-photos-*`,
// `collection/add-copy-with-photos-*` and `collection/inventory-photo-line-*`.
// ---------------------------------------------------------------------------

// A 50x70 JPEG, inline: no fixture file to keep.
const CARD_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABGADIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCcDccCl8s+1Ef3vwptYxjQp0IznBttvrba3k+5+YjvLPtR5Z9qbRU+1wv/AD6f/gX/AAA1HeWfakKlRk0lOP8Aqx9a0gsPVhPlg00r736ry8w1G0UUV5ox0f3vwptOj+9+FNruq/7rS9ZfoLqFFFFcIwpx/wBWPrTacf8AVj613YT4av8Ahf5oTG0UUVwjHR/e/Cm06P734U2u6r/utL1l+guoUUUVwjCnH/Vj602nH/Vj613YT4av+F/mhMbRRRXCMdH978KbTo/vfhSbG9K9KVGpUwtPki3rLZX7C6iUUuxvSjY3pXN9UxH/AD7l9zHdCU4/6sfWk2N6UrDEYB9a68PQq04VXOLS5XumuqExtFFFeWMM46Ubj6miirjUnFWTYBuPqaNx9TRRVe2qfzP7wDcfU0ZJ6miik6s2rOTAKKKKzA//2Q==",
  "base64",
);

/** A small card-shaped JPEG for a photo file input (`setInputFiles`). */
export const photoFile = (name: string) => ({ name, mimeType: "image/jpeg", buffer: CARD_JPEG });

/**
 * The photo behind a thumbnail or a "full size" link comes back as a picture:
 * the address a new tab would open (a redirect to a short-lived signed URL)
 * answers with a non-empty image. A page cannot be asked "did this decode"
 * by what a user perceives, so this fetches what the user's browser fetches.
 */
export async function expectPhotoServed(page: Page, shown: Locator, attribute: "src" | "href"): Promise<void> {
  await expect(shown).toHaveAttribute(attribute, /\/copy-photo\/[0-9a-f]{32}\/(thumb|image)$/);
  const address = await shown.getAttribute(attribute);
  expect(address, `a ${attribute} to fetch`).not.toBeNull();
  const response = await page.request.get(new URL(address!, page.url()).toString());
  expect(response.ok(), "the photo's address answers").toBe(true);
  expect(response.headers()["content-type"] ?? "", "it answers with a picture").toMatch(/^image\//);
  expect((await response.body()).length, "and the picture is not empty").toBeGreaterThan(100);
}
