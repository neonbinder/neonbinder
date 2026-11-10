// Origin: .maestro/flows/set-selector/custom-entry-survives-resync.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
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
    await expect(columnOption(page, "Sports", "Baseball")).toBeVisible();
    await addCustomEntry(page, "Sports", sport, { confirm: "required" });

    // It is still there after a reload.
    await reload();
    await listed();
    await expectAccessible(page, { label: "Sports column listing the hand-made sport" });

    // ── STEP 2: sync Sports from the marketplaces ──
    await reload();
    await expect(columnOption(page, "Sports", "Baseball")).toBeVisible();
    const syncSports = page.getByRole("button", { name: "Sync Sports" });
    await syncSports.click();
    await expect(page.getByText("Syncing Sport Options")).toBeVisible();
    // The panel stands in for the idle row: the pressed button is gone, so
    // the focus check below proves focus was handed back, not kept.
    await expect(syncSports).toHaveCount(0);
    // A live marketplace Sports sync (the flow's 55 s), not our own server.
    await expect(page.getByText("Syncing Sport Options")).toBeHidden({ timeout: 55_000 });
    // NEO-450 (a11y): the panel replaced the button the operator pressed, so
    // when the sync ends focus goes back to that button rather than <body>.
    await expect(syncSports).toBeFocused();
    if (!env.SL_PAUSED) {
      await expect(page.getByText(PAUSE_NOTICE)).toBeHidden();
    } else {
      await expect(page.getByText(PAUSE_NOTICE)).toBeVisible();
    }
    await expectAccessible(page, { label: "Sports column after a sync" });

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
    await expectAccessible(page, { within: confirm, label: "Delete sport confirmation" });
    await confirm.getByRole("button", { name: "Yes, delete" }).click();
    // Let the delete land before leaving the page.
    await expect(confirm).toBeHidden();
    await expect(page.getByRole("heading", { name: `Attributes for ${sport}` })).toBeHidden();

    await reload();
    await expect(columnOption(page, "Sports", "Baseball")).toBeVisible();
    await columnSearch(page, "Sports").fill(sport);
    await expect(page.getByText("No matches found")).toBeVisible();
  },
);
