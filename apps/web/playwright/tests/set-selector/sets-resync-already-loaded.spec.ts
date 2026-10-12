// Origin: .maestro/flows/set-selector/sets-resync-already-loaded.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { drillToSet, columnOption, setBuilderReady } from "../../support/set-builder";

test(
  "Variant types persist across sessions; auto-sync guard skips re-sync when present",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // Leave /set-selector so the drill below is a fresh mount, not a same-URL reload.
    await page.goto("/profile/credentials");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible();

    await drillToSet(page, env);

    // The variant types the seed synced persisted across the fresh session.
    for (const type of ["Base", "Insert", "Parallel"]) {
      await expect(columnOption(page, "Variant Types", type)).toBeVisible();
    }

    // With items already present the column must not have entered sync mode;
    // it settles on the idle button.
    await expect(page.getByText("Syncing Variant Types")).toBeHidden();
    await expect(page.getByRole("button", { name: "Sync Variant Types" })).toBeVisible();
  },
);
