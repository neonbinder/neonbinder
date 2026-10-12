// Origin: .maestro/flows/set-selector/custom-entry-survives-resync.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { columnOption, columnSearch, setBuilderReady, addCustomEntry } from "../../support/set-builder";

const PAUSE_NOTICE = "SportLots is on pause: nothing from SportLots was asked for or changed.";

test(
  "Custom Entry Survives Re-Sync",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const sport = `TestCustomSport-${env.ATTEMPT_ID}`;
    const reload = async () => {
      await page.goto("/set-selector");
      await expect(setBuilderReady(page)).toBeVisible();
    };
    const listed = async () => {
      await columnSearch(page, "Sports").fill(sport);
      await expect(columnOption(page, "Sports", sport)).toBeVisible();
    };

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: add a hand-made sport once the Sports column has loaded ──
    await expect(columnOption(page, "Sports", "Baseball")).toBeVisible({ timeout: 60_000 });
    await addCustomEntry(page, "Sports", sport, { confirm: "required" });

    // It is still there after a reload.
    await reload();
    await listed();

    // ── STEP 2: sync Sports from the marketplaces ──
    await reload();
    await expect(columnOption(page, "Sports", "Baseball")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Sync Sports" }).click();
    await expect(page.getByText("Syncing Sport Options")).toBeVisible();
    await expect(page.getByText("Syncing Sport Options")).toBeHidden({ timeout: 55_000 });
    if (!env.SL_PAUSED) {
      await expect(page.getByText(PAUSE_NOTICE)).toBeHidden();
    } else {
      await expect(page.getByText(PAUSE_NOTICE)).toBeVisible();
    }

    // ── STEP 3: the hand-made row survived the sync ──
    await reload();
    await listed();
    await reload();
    await expect(columnOption(page, "Sports", "Baseball")).toBeVisible();
    await listed();

    // ── STEP 4: remove it again, which keeps the flow self-cleaning ──
    await columnOption(page, "Sports", sport).click();
    await expect(page.getByRole("heading", { name: `Attributes for ${sport}` })).toBeVisible();
    await page.getByRole("button", { name: `Delete ${sport}`, exact: true }).click();
    const confirm = page.getByRole("dialog", { name: `Delete Sport "${sport}"?` });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText("Nothing is below it. This cannot be undone.")).toBeVisible();
    await confirm.getByRole("button", { name: "Yes, delete" }).click();
    // Let the delete land before leaving the page.
    await expect(confirm).toBeHidden();
    await expect(page.getByRole("heading", { name: `Attributes for ${sport}` })).toBeHidden();

    await reload();
    await expect(columnOption(page, "Sports", "Baseball")).toBeVisible({ timeout: 30_000 });
    await columnSearch(page, "Sports").fill(sport);
    await expect(page.getByText("No matches found")).toBeVisible();
  },
);
