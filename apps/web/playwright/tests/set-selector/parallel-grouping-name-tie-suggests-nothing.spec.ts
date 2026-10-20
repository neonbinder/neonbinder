// NEO-339, R1 (Jason 2026-10-10: a tie is never given to the first candidate):
// when two rows read the same name (the grouping's own fold: case and
// punctuation ignored), nothing is suggested under it. On a hand-made set with
// Y, "Y." and "Y Refractor", Group Parallels opens with "Y Refractor" left at
// the top level, unsuggested: "No changes yet", no Accept-all, no "Suggested"
// badge, for the operator to place.
//
// The fixture: the "+ Custom" form folds a name by case only (selecting the
// existing row instead of making a duplicate), so "Gold" and "gold" can never be
// two rows; a trailing period does not fold there, but the grouping's own fold
// ignores punctuation, so "Y" and "Y." tie. Hand-made set, per-attempt, no
// marketplace ids (R7a): `pg-tie-` in SET-REGISTRY.md. Row names are single
// tokens built from ATTEMPT_TOKEN.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, addCustomEntry, drillToCustom } from "../../support/set-builder";

test(
  "Group Parallels — a parent whose name another row shares suggests nothing under it (NEO-339)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    const y = `${env.ATTEMPT_TOKEN}Gold`;
    const twin = `${y}.`;
    const refractor = `${y} Refractor`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustom(page, {
      sport: `E2E Test Sport ${env.WORKER_INDEX}`,
      year: "2026",
      manufacturer: "Topps",
      set: `pg-tie-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`,
      variantType: "Insert",
    });
    for (const name of [y, twin, refractor]) {
      await addCustomEntry(page, "Inserts", name, { confirm: "required" });
    }
    await expect(page.getByText(refractor)).toBeVisible();

    const dialog = page.getByRole("dialog", { name: "Group Parallels" });
    await page.getByRole("button", { name: "Group Parallels" }).click();
    await expect(dialog.getByText(/Drag inserts under a parent/)).toBeVisible();

    // All three stand at the top level (the positive), and nothing is suggested.
    for (const name of [y, twin, refractor]) {
      await expect(dialog.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(dialog.getByText("No changes yet")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Accept all suggestions/ })).toBeHidden();
    await expect(dialog.getByText("Suggested", { exact: true })).toBeHidden();
    await expect(dialog.getByRole("button", { name: /^Remove .* from parallels$/ })).toHaveCount(0);
    await expectAccessible(page, { within: dialog, label: "Group Parallels dialog with a tied parent, nothing suggested" });

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  },
);
