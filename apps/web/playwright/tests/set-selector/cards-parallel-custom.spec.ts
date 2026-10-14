// Origin: .maestro/flows/set-selector/cards-parallel-custom.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, columnOption, addCustomEntry, drillToCustomSet } from "../../support/set-builder";

test(
  "Add custom Parallel — a hand-added parallel appears in the Parallels column and is selectable",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustomSet(page, env, {
      set: `parallel-feature-${env.WORKER_INDEX}`,
      variantType: "Parallel",
    });

    await addCustomEntry(page, "Parallels", "Prizm Gold");

    // NEO-239: a hand-added row carries no marketplace pills; it is simply in the column.
    const row = columnOption(page, "Parallels", "Prizm Gold");
    await expect(row).toBeVisible();

    // It is a real, selectable entry: selecting it opens its (empty) checklist.
    // `row` is scoped to the Parallels listbox: "Parallel" is a Parallel type by
    // its title (NEO-334), so the Base-parallels section under the columns lists
    // this row too ("Prizm Gold - skipped: not linked to a marketplace yet").
    await row.click();
    // NEO-334: a row under a Parallel type is a parallel of the BASE set, so the
    // empty checklist's Sync slot is the build-from-Base stand-in ("Can't build
    // yet": this set has no Base), not "Fetch from Marketplaces". The empty-state
    // line is the same under either kind and is the proof this spec wants: the
    // row opened its own checklist. (The Parallel kind itself is proved in
    // variant-type-title-is-its-kind.) `.first()`: any one copy of the stand-in.
    await expect(page.getByRole("button", { name: "Can't build yet" }).first()).toBeVisible();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await expectAccessible(page, { label: "Hand-added parallel with its empty checklist" });
  },
);
