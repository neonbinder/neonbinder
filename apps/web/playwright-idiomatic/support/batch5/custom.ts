/**
 * Batch 5 helpers for the hand-made ("custom") subtree a worker owns:
 *   util-drill-to-custom.yaml / util-drill-to-custom-set.yaml -> drillToCustom
 *   util-add-custom-card.yaml                                 -> addCustomCard
 *   util-cross-list-cards.yaml                                -> crossListCards (see its own spec use)
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { FlowEnv } from "../env";
import {
  columnHeading,
  columnOption,
  columnSearch,
  drillToBaseVariant,
  setBuilderReady,
  syncChecklistButton,
  type Column,
  type DrillTarget,
} from "../set-builder";

const NEXT: Partial<Record<Column, Column>> = {
  Sports: "Years",
  Years: "Manufacturers",
  Manufacturers: "Sets",
  Sets: "Variant Types",
};

const NOUN: Record<Column, string> = {
  Sports: "sport",
  Years: "year",
  Manufacturers: "manufacturer",
  Sets: "set",
  "Variant Types": "variant type",
  Inserts: "insert",
  Parallels: "parallel",
};

/**
 * Make sure `name` exists in `column` (creating it through "+ Custom" when it
 * does not) and return with it selected. Typing a value that already exists
 * selects it (no confirm step), so the form either advances the drill (the
 * `advanced` marker appears) or asks to confirm the create.
 */
export async function ensureAndSelect(
  page: Page,
  column: Column,
  name: string,
  advanced?: Locator,
): Promise<void> {
  const noun = NOUN[column];
  await page.getByRole("button", { name: `Add custom ${column}` }).click();
  await expect(page.getByText("Add Custom Entry")).toBeVisible();
  const value = page.getByPlaceholder("Enter custom value...");
  await value.fill(name);
  await value.press("Enter");
  const create = page.getByRole("button", { name: `Create ${noun}`, exact: true });
  const next = NEXT[column];
  const marker = advanced ?? (next ? columnHeading(page, next) : undefined);
  await expect(marker ? create.or(marker) : create).toBeVisible();
  if (await create.isVisible()) {
    await create.click();
    await expect(page.getByText("Add Custom Entry")).toBeHidden();
    if (columnSearchAvailable(column)) await columnSearch(page, column).fill(name);
    await columnOption(page, column, name).click();
  }
  await expect(page.getByText("Add Custom Entry")).toBeHidden();
}

function columnSearchAvailable(column: Column): boolean {
  return column !== "Variant Types" && column !== "Inserts" && column !== "Parallels";
}

export interface CustomTarget {
  sport: string;
  year: string;
  manufacturer: string;
  set: string;
  variantType?: string;
  variant?: string;
}

/**
 * Drill E2E Test Sport <worker> -> 2026 -> Topps -> <set> -> <variantType>,
 * creating whatever is missing along the way. Returns with the variant type's
 * child column open ("Add custom <VariantType>s" reachable).
 */
export async function drillToCustom(page: Page, t: CustomTarget): Promise<void> {
  await page.goto("/set-selector");
  await expect(setBuilderReady(page)).toBeVisible({ timeout: 20_000 });
  await expect(columnOption(page, "Sports", "Baseball")).toBeVisible({ timeout: 60_000 });

  await ensureAndSelect(page, "Sports", t.sport);
  await expect(columnHeading(page, "Years")).toBeVisible({ timeout: 60_000 });
  await ensureAndSelect(page, "Years", t.year);
  await expect(columnHeading(page, "Manufacturers")).toBeVisible({ timeout: 20_000 });
  await ensureAndSelect(page, "Manufacturers", t.manufacturer);
  await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 20_000 });
  await ensureAndSelect(page, "Sets", t.set);
  await expect(columnHeading(page, "Variant Types")).toBeVisible({ timeout: 30_000 });

  if (t.variantType) {
    const vt = t.variantType;
    await ensureAndSelect(page, "Variant Types", vt, page.getByRole("heading", { name: `${vt}s`, exact: true }));
    await expect(page.getByText("An error occurred. Please refresh the page.")).toBeHidden();
    await expect(page.getByRole("button", { name: `Add custom ${vt}s` })).toBeVisible({ timeout: 15_000 });
  }
}

/**
 * util-add-custom-card.yaml: drill to the per-worker custom set, make sure the
 * `insertName` entry exists and is open, then add one card through the quick-add
 * form. Returns with the new card's row on the checklist.
 */
export async function addCustomCard(
  page: Page,
  o: {
    setName: string;
    variantType?: string;
    insertName?: string;
    cardNumber: string;
    playerName: string;
    cardName?: string;
    workerIndex: string;
  },
): Promise<void> {
  const variantType = o.variantType ?? "Insert";
  const insertName = o.insertName ?? "Base";
  await drillToCustom(page, {
    sport: `E2E Test Sport ${o.workerIndex}`,
    year: "2026",
    manufacturer: "Topps",
    set: o.setName,
    variantType,
  });
  // The child column: create the entry if it is missing, then open it.
  await ensureAndSelect(page, `${variantType}s` as Column, insertName, page.getByRole("button", { name: "Open add card form" }));

  await page.getByRole("button", { name: "Open add card form" }).click();
  const number = page.getByRole("textbox", { name: "Card number" });
  await expect(number).toBeVisible();
  await number.fill(o.cardNumber);
  await page.getByRole("textbox", { name: "Card name" }).fill(o.cardName ?? o.playerName);
  await page.getByRole("button", { name: "Submit new card" }).click();
  await expect(page.getByRole("textbox", { name: "Card number" })).toBeHidden();
  await expect(editCardButton(page, o.cardNumber)).toBeVisible();
}

export function editCardButton(page: Page, cardNumber: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^Edit card ${escapeRe(cardNumber)}(, .*)?$`) });
}

export function deleteCardButton(page: Page, cardNumber: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^Delete card ${escapeRe(cardNumber)}(, .*)?$`) });
}

export function confirmDeleteCardButton(page: Page, cardNumber: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^Confirm delete card ${escapeRe(cardNumber)}(, .*)?$`) });
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** util-drill-to-custom.yaml with a VARIANT: open (creating if missing) the child entry. */
export async function openVariant(page: Page, variantType: string, variant: string): Promise<void> {
  await ensureAndSelect(
    page,
    `${variantType}s` as Column,
    variant,
    page.getByRole("button", { name: "Open add card form" }),
  );
  await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
}

/**
 * util-cross-list-cards.yaml (+ util-pick-cross-list-source.yaml): from an open
 * checklist, link cards printed in another set into it. Leaves the modal open
 * on its "Linked N card(s)" result.
 */
export async function crossListCards(
  page: Page,
  o: {
    sourceSport: string;
    sourceYear?: string;
    sourceManufacturer?: string;
    sourceSet: string;
    sourceVariantType?: string;
    sourceVariant?: string;
    cardNumbers: string;
  },
): Promise<void> {
  const year = o.sourceYear ?? "2026";
  const manufacturer = o.sourceManufacturer ?? "Topps";
  const variantType = o.sourceVariantType ?? "Insert";
  const variant = o.sourceVariant ?? "Base";

  await page.getByRole("button", { name: "Open add cross-release cards form" }).click();
  const modal = page.getByRole("dialog", { name: "Add cross-release cards" });
  await expect(modal).toBeVisible();

  const filter = (level: string) => modal.getByRole("textbox", { name: `Filter ${level} options` });
  const pickRow = (level: string, value: string) =>
    modal.getByRole("button", { name: `Pick ${level} ${value}`, exact: true });
  const changed = (level: string, value: string) =>
    modal.getByRole("button", { name: `Change ${level}` }).filter({ hasText: value });

  // A long list offers a filter; a short one does not.
  const sportFilter = filter("Sport");
  if (await sportFilter.isVisible()) await sportFilter.fill(o.sourceSport);
  await pickRow("Sport", o.sourceSport).click();
  await expect(changed("Sport", o.sourceSport)).toBeVisible();

  await pickRow("Year", year).click();
  await expect(changed("Year", year)).toBeVisible();

  await pickRow("Manufacturer", manufacturer).click();
  await expect(changed("Manufacturer", manufacturer)).toBeVisible();

  const setFilter = filter("Set");
  if (await setFilter.isVisible()) await setFilter.fill(o.sourceSet);
  await pickRow("Set", o.sourceSet).click();
  await expect(changed("Set", o.sourceSet)).toBeVisible();

  await pickRow("Variant", variantType).click();
  await expect(changed("Variant", variantType)).toBeVisible();

  await pickRow("Insert", variant).click();
  await expect(changed("Insert", variant)).toBeVisible();
  await expect(modal.getByText(`Source set: ${variant}`)).toBeVisible();

  const numbers = modal.getByRole("textbox", { name: "Card numbers to cross-list" });
  await numbers.fill(o.cardNumbers);
  await expect(numbers).toHaveValue(o.cardNumbers);
  await modal.getByRole("button", { name: "Link cross-release cards" }).click();
  await expect(modal.getByText(/Linked [0-9]+ card/)).toBeVisible();
}

/**
 * util-fetch-real-set-checklist-to-wizard.yaml: fetch a real set's Base
 * checklist and land in the entity-review wizard (confirming the card matches
 * first when both marketplaces answered).
 */
export async function fetchRealSetChecklistToWizard(
  page: Page,
  env: FlowEnv,
  target: DrillTarget = {},
): Promise<void> {
  await drillToBaseVariant(page, env, { set: "Topps Big League", ...target });
  await syncChecklistButton(page).click();
  if (!env.SL_PAUSED) {
    await expect(page.getByText(/Match Cards/).first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Confirm", { exact: true })).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Confirm card matches" }).click();
  } else {
    await expect(page.getByText(/Kept all [0-9]+ cards? from BSC/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/^Match Cards/)).toBeHidden();
    await expect(page.getByRole("button", { name: "Confirm card matches" })).toBeHidden();
  }
  await expect(page.getByRole("dialog", { name: "Confirm New Players & Teams" })).toBeVisible({
    timeout: 120_000,
  });
}

/** Create a brand-new entry through a column's "+ Custom" form (the name must not exist yet). */
export async function createCustomEntry(page: Page, column: Column, name: string): Promise<void> {
  await page.getByRole("button", { name: `Add custom ${column}` }).click();
  await expect(page.getByText("Add Custom Entry")).toBeVisible();
  const value = page.getByPlaceholder("Enter custom value...");
  await value.fill(name);
  await value.press("Enter");
  await page.getByRole("button", { name: `Create ${NOUN[column]}`, exact: true }).click();
  await expect(page.getByText("Add Custom Entry")).toBeHidden();
}

/**
 * admin/util-add-player-by-hand.yaml: on /admin/players (already loaded),
 * filter to nothing under `sport`, then add a player by hand.
 */
export async function addPlayerByHand(page: Page, name: string, sport: string): Promise<void> {
  await page.getByRole("textbox", { name: "Filter players" }).fill("zzzznotaplayer");
  await expect(page.getByText("No players match that filter.")).toBeVisible();
  const sportSelect = page.getByRole("combobox", { name: "Sport" });
  await sportSelect.selectOption(sport);
  await expect(sportSelect.getByRole("option", { selected: true })).toHaveText(sport);
  await expect(page.getByText("0 matches", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Add player" }).click();
  await page.getByRole("textbox", { name: "New player name" }).fill(name);
  await page.getByRole("button", { name: `Create player ${name}` }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByText(`Added ${name}`)).toBeVisible();
  await expect(page.getByText(`Sport: ${sport}`).first()).toBeVisible();
}
