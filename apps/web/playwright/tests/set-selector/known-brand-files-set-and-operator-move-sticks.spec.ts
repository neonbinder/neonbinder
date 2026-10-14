// Origin: .maestro/flows/set-selector/known-brand-files-set-and-operator-move-sticks.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-294, two halves of one placement rule on live marketplace data:
//   1. Sync Sets on a cold year files a BSC set whose name starts with a known
//      brand (CMC, Baseball 1990) under a brand row the sync CREATES for it.
//   2. The operator moves it to Unknown; a FORCED year-wide Sync Sets leaves it
//      exactly where the operator put it.
// Sole writer of Baseball 1990; FRESH-ONLY per deployment (a second run finds
// the set already under Unknown). Every claim is BSC-side, so there is no
// paused branch. The flow deliberately does not move the set back.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnSearch,
  columnSelection,
  drillToColdManufacturer,
  setBuilderReady,
  COLD_SYNC,
  type Column,
} from "../../support/set-builder";
import type { Locator, Page } from "@playwright/test";

const SPORT = "Baseball";
const YEAR = "1990";
const BRAND = "CMC";

/** The first set row in the All Brands view whose name starts with the brand. */
function brandSet(page: Page): Locator {
  return page
    .getByRole("listbox", { name: "Sets" satisfies Column })
    .getByRole("option")
    .filter({ hasText: new RegExp(`^\\s*${BRAND}\\b`, "i") })
    .first();
}

test(
  "A set whose name matches NB's known-brands list is filed under a brand the sync creates for it — and an operator's move out of that brand outlives the next Sync Sets",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: cold drill to Baseball > 1990 > All Brands; the year-wide Sets sync has run.
    await drillToColdManufacturer(page, env, { sport: SPORT, year: YEAR, manufacturer: "All Brands" });
    await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 15_000 });

    // ── STEP 2: the sync created a CMC brand row for the set; picking the set
    // files the cascade under it.
    await columnSearch(page, "Sets").fill(BRAND);
    await brandSet(page).click();
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    await expect(columnSelection(page, "Manufacturers", BRAND)).toBeVisible();
    await expectAccessible(page, { label: "Set filed under the sync-created brand" });
    // The set's first visit fires a cold variant-type sync (the flow's 60 s).
    await expect(page.getByText("Syncing Variant Types")).toBeHidden({ timeout: 60_000 });
    await expect(columnHeading(page, "Variant Types")).toBeVisible();

    // ── STEP 3: the operator moves it to Unknown.
    const panel = page.getByRole("region", { name: "Set attributes panel" });
    await expect(panel.getByRole("button", { name: /^Delete / })).toBeVisible();
    await page.getByRole("button", { name: "Move to another brand" }).click();
    await expect(page.getByText("Move to which brand?")).toBeVisible();
    const brands = page.getByRole("group", { name: `Brands in ${YEAR}` });
    await expect(brands).toBeVisible();
    await expectAccessible(page, { label: "Move to which brand" });
    // Its current brand is never offered.
    await expect(brands.getByRole("button", { name: `Move to ${BRAND}` })).toBeHidden();
    await brands.getByRole("button", { name: "Move to Unknown" }).click();
    const confirm = page.getByRole("dialog", { name: /^Move ".*" to Unknown\?$/ });
    await expect(confirm).toBeVisible();
    await expectAccessible(page, { within: confirm, label: "Move set confirm dialog" });
    await expect(
      confirm.getByText(
        "The set keeps its cards, its variants and its marketplace links — only the brand above it changes. Sync Sets will leave it where you put it.",
      ),
    ).toBeVisible();
    await confirm.getByRole("button", { name: "Yes, move it" }).click();
    await expect(page.getByText("Moved to Unknown")).toBeVisible();
    await expect(page.getByText(new RegExp(`${YEAR} › Unknown › `)).first()).toBeVisible();

    // ── STEP 4: a FORCED year-wide Sync Sets leaves it where the operator put it.
    await drillToColdManufacturer(page, env, { sport: SPORT, year: YEAR, manufacturer: "All Brands" });
    await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 15_000 });
    // STEP 1's year-wide sync can still be running (its first rows list before
    // the SportLots side finishes), and a reload mid-sync shows the "Syncing
    // Sets" panel INSTEAD of the Sync Sets button; the drill's "Syncing Sets
    // hidden" check can pass before the status subscription answers. Wait for
    // that first sync to finish (a cold-sync ceiling: marketplace round trips)
    // so the click below starts a second, forced sync, after the move.
    await expect(page.getByRole("button", { name: "Sync Sets" })).toBeVisible({ timeout: COLD_SYNC });
    await page.getByRole("button", { name: "Sync Sets" }).click();
    await expect(page.getByRole("heading", { name: "Syncing Sets" })).toBeVisible();
    // The whole year again from BSC (the flow's 150 s).
    await expect(page.getByRole("heading", { name: "Syncing Sets" })).toBeHidden({ timeout: COLD_SYNC });
    await expect(page.getByRole("button", { name: "Sync Sets" })).toBeVisible();

    await columnSearch(page, "Sets").fill(BRAND);
    await brandSet(page).click();
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    // Still under Unknown: the stamp outlived the sync.
    await expect(columnSelection(page, "Manufacturers", "Unknown")).toBeVisible();
  },
);
