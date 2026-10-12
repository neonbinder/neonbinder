/**
 * Set Builder page helpers. Specs: the set-selector drill utils
 *   .maestro/flows/set-selector/util-drill-to-2024-topps-chrome.yaml  -> drillToSet
 *   .maestro/flows/set-selector/util-drill-to-base-variant.yaml       -> drillToBaseVariant
 *   .maestro/flows/set-selector/util-drill-to-cold-real-set.yaml      -> drillToColdManufacturer
 *
 * The cascade (components/SetSelector/EntitySelector.tsx) is accessible by
 * role, one column per entity:
 *   heading  "Years"                     (h2, only while the column is open)
 *   combobox "Search years"              (the column's search box)
 *   listbox  "Years" > option            (rows; an option's name is its whole
 *                                         text, e.g. "Base SL BSC", so pick by
 *                                         the row's own visible text)
 *   button   "Years: 2024 — change"      (the column once it has a selection)
 *   button   "Add custom Years"          (+ Custom)
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { FlowEnv } from "./env";

export type Column =
  | "Sports"
  | "Years"
  | "Manufacturers"
  | "Sets"
  | "Variant Types"
  | "Inserts"
  | "Parallels";

/** The panel's subtitle: the signal that the Set Builder (not the nav) has mounted. */
export function setBuilderReady(page: Page): Locator {
  return page.getByText("Build set parameters using marketplace APIs");
}

export function columnHeading(page: Page, column: Column): Locator {
  return page.getByRole("heading", { name: column, exact: true });
}

export function columnSearch(page: Page, column: Column): Locator {
  return page.getByRole("combobox", { name: `Search ${column.toLowerCase()}` });
}

/** A row of an open column, by its own visible text (exact). */
export function columnOption(page: Page, column: Column, name: string): Locator {
  return page
    .getByRole("listbox", { name: column })
    .getByRole("option")
    .filter({ has: page.getByText(name, { exact: true }) });
}

/** The collapsed column card once `name` is selected ("Sets: Topps Chrome — change"). */
export function columnSelection(page: Page, column: Column, name: string): Locator {
  return page.getByRole("button", { name: `${column}: ${name} — change` });
}

/**
 * Pick `name` in `column`. Types it into the column's search first unless
 * `search: false` (short columns like Sports are tapped directly in the flows).
 */
export async function pick(
  page: Page,
  column: Column,
  name: string,
  { search = true }: { search?: boolean } = {},
): Promise<void> {
  if (search) await columnSearch(page, column).fill(name);
  await columnOption(page, column, name).click();
}

/**
 * Create a row through the column's "+ Custom" form (the paused-SportLots
 * path of the drill utils: the manufacturer cannot come from SportLots).
 */
export async function addCustomManufacturer(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Add custom Manufacturers" }).click();
  await expect(page.getByText("Add Custom Entry")).toBeVisible();
  const value = page.getByPlaceholder("Enter custom value...");
  await value.fill(name);
  await value.press("Enter");
  const create = page.getByRole("button", { name: "Create manufacturer" });
  await expect(create).toBeVisible();
  await create.click();
  await expect(page.getByText("Add Custom Entry")).toBeHidden();
}

export interface DrillTarget {
  sport?: string;
  year?: string;
  manufacturer?: string;
  set?: string;
  /** Paused-SportLots only: create the manufacturer by hand if it is missing. */
  createManufacturer?: boolean;
}

/** Variant types sync live on a set's first visit (the flow's 60 s). */
export const VARIANT_TYPES_SYNC = 60_000;

/**
 * util-drill-to-2024-topps-chrome.yaml: Sport -> Year -> Manufacturer -> Set,
 * leaving the Variant Types column open with "Base" listed. Defaults to
 * Baseball / 2024 / Topps / Topps Chrome.
 */
export async function drillToSet(page: Page, env: FlowEnv, target: DrillTarget = {}): Promise<void> {
  const {
    sport = "Baseball",
    year = "2024",
    manufacturer = "Topps",
    set = "Topps Chrome",
    createManufacturer = false,
  } = target;

  await page.goto("/set-selector");
  await expect(setBuilderReady(page)).toBeVisible({ timeout: 20_000 });

  await pick(page, "Sports", sport, { search: false });
  await expect(columnHeading(page, "Years")).toBeVisible();

  await pick(page, "Years", year);
  await expect(columnHeading(page, "Manufacturers")).toBeVisible();

  if (env.SL_PAUSED) {
    // Nothing syncs the manufacturer list from SportLots: the column either
    // already holds it or says it is empty.
    await expect(page.getByText("Syncing Manufacturer Options")).toBeHidden();
    const option = columnOption(page, "Manufacturers", manufacturer);
    await expect(
      page.getByText("No manufacturers available. Sync from marketplaces to populate.").or(option),
    ).toBeVisible();
    if (createManufacturer && !(await option.isVisible())) {
      await addCustomManufacturer(page, manufacturer);
    }
    await option.click();
  } else {
    await pick(page, "Manufacturers", manufacturer);
  }
  await expect(columnHeading(page, "Sets")).toBeVisible();

  await pick(page, "Sets", set);
  await expect(columnHeading(page, "Variant Types")).toBeVisible();
  await expect(columnOption(page, "Variant Types", "Base")).toBeVisible({
    timeout: VARIANT_TYPES_SYNC,
  });
}

/** The card checklist's fetch control: "Fetch from Marketplaces" when empty, "Refresh" once loaded. */
export function syncChecklistButton(page: Page): Locator {
  return page.getByRole("button", { name: "Sync card checklist" });
}

/**
 * util-drill-to-base-variant.yaml: drillToSet, open Base, and make sure the
 * base set is mapped (confirming the picker's first candidates when it is
 * not). Leaves the card checklist on screen.
 */
export async function drillToBaseVariant(
  page: Page,
  env: FlowEnv,
  target: DrillTarget = {},
): Promise<void> {
  await drillToSet(page, env, target);
  await pick(page, "Variant Types", "Base", { search: false });
  await expect(page.getByText("An error occurred. Please refresh the page.")).toBeHidden();

  // Either the picker opens (base not mapped yet) or the row offers a re-map.
  const picker = page.getByRole("dialog", { name: "Select Base Set" });
  await expect(picker.or(page.getByRole("button", { name: /Re-map Base/ }))).toBeVisible();

  if (await picker.isVisible()) {
    // The candidates are a live marketplace round trip (the flow's 45 s).
    const confirm = picker.getByRole("button", { name: "Confirm Base Set" });
    await expect(confirm).toBeVisible({ timeout: 45_000 });
    const bsc = picker.getByRole("option", { name: /^BSC base candidate: / });
    const sl = picker.getByRole("option", { name: /^SportLots base candidate: / });
    if (!env.SL_PAUSED) {
      await bsc.first().click();
      await sl.first().click();
      await confirm.click();
      await expect(picker).toBeHidden({ timeout: 10_000 });
    } else {
      // Paused: SportLots offers nothing, so the operator cancels and the
      // row stays unmapped.
      await expect(picker.getByText(/^SportLots returned no base set for /)).toBeVisible();
      await expect(bsc.first()).toBeVisible();
      await expect(sl).toHaveCount(0);
      await picker.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByText(/Base mapping cancelled/)).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByText(/Base mapping cancelled/)).toBeHidden();
      await expect(page.getByRole("button", { name: "Map Base Set" })).toBeVisible();
    }
  }

  await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
  await expect(syncChecklistButton(page)).toBeVisible();
}

/** A never-synced level pays a cold marketplace sync (the flow's 150 s). */
export const COLD_SYNC = 150_000;

/**
 * util-drill-to-cold-real-set.yaml: Sport -> Year -> Manufacturer on a path
 * that may never have been synced, paying the cold waits; leaves the Sets
 * column open and synced. `manufacturer: "All Brands"` selects the pinned
 * view (NEO-237) instead of a brand.
 */
export async function drillToColdManufacturer(
  page: Page,
  env: FlowEnv,
  { sport = "Hockey", year = "2024", manufacturer = "Topps" }: DrillTarget = {},
): Promise<void> {
  await page.goto("/set-selector");
  await expect(setBuilderReady(page)).toBeVisible({ timeout: 20_000 });

  await expect(columnSearch(page, "Sports")).toBeVisible({ timeout: 60_000 });
  await pick(page, "Sports", sport);
  await expect(columnHeading(page, "Years")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Syncing Year Options")).toBeHidden({ timeout: COLD_SYNC });
  await expect(page.getByRole("listbox", { name: "Years" })).toBeVisible({ timeout: 60_000 });

  await pick(page, "Years", year);
  await expect(columnHeading(page, "Manufacturers")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Syncing Manufacturer Options")).toBeHidden({ timeout: COLD_SYNC });

  const empty = page.getByText("No manufacturers available. Sync from marketplaces to populate.");
  if (manufacturer === "All Brands") {
    // The pinned view is always listed; with SportLots live the real brands
    // land under it.
    const allBrands = columnOption(page, "Manufacturers", "All Brands");
    if (!env.SL_PAUSED) {
      await expect(allBrands).toBeVisible();
      await expect(empty).toBeHidden({ timeout: 60_000 });
    } else {
      await expect(empty.or(columnOption(page, "Manufacturers", "Unknown"))).toBeVisible();
    }
    await allBrands.click();
  } else if (!env.SL_PAUSED) {
    await columnSearch(page, "Manufacturers").fill(manufacturer);
    const option = columnOption(page, "Manufacturers", manufacturer);
    await expect(option).toBeVisible({ timeout: 60_000 });
    await option.click();
  } else {
    const option = columnOption(page, "Manufacturers", manufacturer);
    await expect(empty.or(option)).toBeVisible();
    if (!(await option.isVisible())) await addCustomManufacturer(page, manufacturer);
    await option.click();
  }
  await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Syncing Sets")).toBeHidden({ timeout: COLD_SYNC });
}
