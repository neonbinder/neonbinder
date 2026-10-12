/**
 * util-drill-to-custom.yaml, batch 1's copy: drill the Set Builder cascade to
 * Baseball / 2024 / Topps / <set> / Insert / Base, creating the hand-made set,
 * variant type and entry when they are missing (idempotent), and leave the
 * "Open add card form" control on screen.
 */
import { expect, type Page } from "@playwright/test";
import {
  columnHeading,
  columnOption,
  columnSearch,
  setBuilderReady,
  type Column,
} from "../set-builder";

const NOUN: Partial<Record<Column, string>> = {
  Sets: "set",
  "Variant Types": "variant type",
  Inserts: "insert",
};

async function addCustomEntry(page: Page, column: Column, name: string): Promise<void> {
  await page.getByRole("button", { name: `Add custom ${column}` }).click();
  await expect(page.getByText("Add Custom Entry")).toBeVisible();
  const value = page.getByPlaceholder("Enter custom value...");
  await value.fill(name);
  await value.press("Enter");
  await page.getByRole("button", { name: new RegExp(`^Create ${NOUN[column]}`) }).click();
  await expect(page.getByText("Add Custom Entry")).toBeHidden();
}

async function selectOrCreate(page: Page, column: Column, name: string): Promise<void> {
  await columnSearch(page, column).fill(name);
  const option = columnOption(page, column, name);
  await expect(option.or(page.getByText("No matches found"))).toBeVisible();
  if (!(await option.isVisible())) {
    await addCustomEntry(page, column, name);
    await columnSearch(page, column).fill(name);
  }
  await option.click();
}

export async function drillToHandMadeBaseEntry(page: Page, set: string): Promise<void> {
  await page.goto("/set-selector");
  await expect(setBuilderReady(page)).toBeVisible({ timeout: 20_000 });
  await columnOption(page, "Sports", "Baseball").click({ timeout: 60_000 });
  await expect(columnHeading(page, "Years")).toBeVisible({ timeout: 60_000 });
  await selectOrCreate(page, "Years", "2024");
  await expect(columnHeading(page, "Manufacturers")).toBeVisible({ timeout: 20_000 });
  await selectOrCreate(page, "Manufacturers", "Topps");
  await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 20_000 });
  await selectOrCreate(page, "Sets", set);
  await expect(columnHeading(page, "Variant Types")).toBeVisible({ timeout: 30_000 });
  await selectOrCreate(page, "Variant Types", "Insert");
  await expect(page.getByText("An error occurred. Please refresh the page.")).toBeHidden();
  await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: 15_000 });
  await selectOrCreate(page, "Inserts", "Base");
  await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
}
