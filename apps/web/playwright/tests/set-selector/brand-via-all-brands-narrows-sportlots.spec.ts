// Origin: .maestro/flows/set-selector/brand-via-all-brands-narrows-sportlots.yaml (Maestro suite retired in NEO-341; see git history)
// Fresh-only: it creates the "SPx" brand under Hockey / 1997, which then exists.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { columnHeading, columnOption, columnSearch, columnSelection, drillToColdManufacturer, setBuilderReady, drillToCustom } from "../../support/set-builder";

const BRAND = "SPx";
const YEAR = "1997";

test(
  "A brand SportLots has no entry for links through All Brands by set-name prefix — the year-wide sync asks SportLots for every brand of the year, the brand's sets re-home from Unknown, and its SportLots list narrows to the prefix",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // The year-wide view: every brand of the year, synced through All Brands.
    await drillToColdManufacturer(page, env, { sport: "Hockey", year: YEAR, manufacturer: "All Brands" });
    await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 15_000 });
    const skipped = page.getByText("SportLots skipped: no SportLots ids on this path.");
    if (env.SL_PAUSED) {
      await expect(skipped).toBeVisible();
    } else {
      // With SportLots live the sets sync asks it (the flow's 150 s).
      await expect(page.getByRole("button", { name: "Sync Sets" })).toBeVisible({ timeout: 150_000 });
      await expect(skipped).toBeHidden();
    }

    // File a brand SportLots has no entry for, by hand.
    await drillToCustom(page, { sport: "Hockey", year: YEAR });
    await expect(columnOption(page, "Manufacturers", "All Brands")).toBeVisible();
    await page.getByRole("button", { name: "Add custom Manufacturers" }).click();
    await expect(page.getByText("Add Custom Entry")).toBeVisible();
    await page.getByPlaceholder("Enter custom value...").fill(BRAND);
    await page.getByPlaceholder("Enter custom value...").press("Enter");
    await expect(page.getByText(`Create manufacturer '${BRAND}' under Hockey › ${YEAR}?`)).toBeVisible();
    await expect(page.getByText(`Sets in Unknown whose names start with '${BRAND}' move here.`)).toBeVisible();
    await page.getByRole("button", { name: "Create manufacturer", exact: true }).click();
    await expect(page.getByText("Add Custom Entry")).toBeHidden();

    // Back through All Brands: the brand's sets are found by name prefix.
    await drillToColdManufacturer(page, env, { sport: "Hockey", year: YEAR, manufacturer: "All Brands" });
    await expect(columnHeading(page, "Sets")).toBeVisible({ timeout: 15_000 });
    await columnSearch(page, "Sets").fill(BRAND);
    await page
      .getByRole("listbox", { name: "Sets" })
      .getByRole("option", { name: new RegExp(`^${BRAND}( .*)?`, "i") })
      .first()
      .click();
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    // Opening a set through All Brands selects its own brand.
    await expect(columnSelection(page, "Manufacturers", BRAND)).toBeVisible();

    // Its Base set mapping offers candidates from both marketplaces (live, the flow's 60 s).
    const base = columnOption(page, "Variant Types", "Base");
    await expect(base).toBeVisible({ timeout: 60_000 });
    await base.click();
    const picker = page.getByRole("dialog", { name: "Select Base Set" });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("button", { name: "Confirm Base Set" })).toBeVisible({ timeout: 60_000 });
    await expect(picker.getByRole("option", { name: /^BSC base candidate: / }).first()).toBeVisible();
    if (!env.SL_PAUSED) {
      await expect(picker.getByRole("option", { name: /^SportLots base candidate: / }).first()).toBeVisible();
      // The SportLots list is already narrowed to the prefix: no manual search box.
      await expect(page.getByPlaceholder("Search SportLots sets...")).toBeHidden();
    } else {
      await expect(picker.getByText(/^SportLots returned no base set for /)).toBeVisible();
      await expect(picker.getByRole("option", { name: /^SportLots base candidate: / })).toHaveCount(0);
    }
    await picker.getByRole("button", { name: "Cancel" }).click();
    const cancelled = page.getByText(/Base mapping cancelled/);
    await expect(cancelled).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(cancelled).toBeHidden();
    await expect(page.getByRole("button", { name: "Map Base Set" })).toBeVisible();

    // The brand's own view: its sets moved out of Unknown, and its attributes say how SportLots is matched.
    await drillToColdManufacturer(page, env, { sport: "Hockey", year: YEAR, manufacturer: BRAND });
    await expect(columnHeading(page, "Sets")).toBeVisible();
    // TODO(NEO-341): a spec race, not a product bug. The notice exists only if
    // the SPx sets were already under Unknown when the brand was created. The
    // year-wide wait at the top ("Sync Sets" visible, "Syncing Sets" hidden)
    // passes before ensureSelectorOptions writes its "syncing" row, so on a
    // cold year SPx is created while that sync is still fetching BSC. The sync
    // reads the year's brands AFTER its fetch (syncSetsAcrossManufacturers,
    // holder index), sees SPx and files the SPx sets straight under it. They
    // never sit in Unknown, nothing moves, and no notice is written. Maestro
    // was slow enough to miss the race. Fix: before "Add custom Manufacturers",
    // wait for an SPx-prefixed set in the All Brands Sets list.
    await expect(page.getByText(/[0-9]+ sets? moved out of Unknown/)).toBeVisible();
    await page.getByRole("button", { name: "Edit attributes" }).click();
    await expect(page.getByRole("button", { name: "Hide attributes" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Value for Brand" })).toHaveValue(BRAND);
    await expect(page.getByText("SportLots has no brand for this — match its sets by name")).toBeVisible();
    if (env.SL_PAUSED) {
      await expect(page.getByText("This year has no SportLots link to go through")).toBeVisible();
    }
  },
);
