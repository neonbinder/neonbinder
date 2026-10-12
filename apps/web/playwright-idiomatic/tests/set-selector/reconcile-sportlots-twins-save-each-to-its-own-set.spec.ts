// Spec: .maestro/flows/set-selector/reconcile-sportlots-twins-save-each-to-its-own-set.yaml
// Fresh-only: the reconcile Save writes the two City Connect Swatch Relics sets.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { columnOption, columnSearch, drillToSet, setBuilderReady } from "../../support/set-builder";
import { readAttachedTwinId } from "../../support/batch4/twins";
import type { Page } from "@playwright/test";

const TWIN = "City Connect Swatch Collection";
const S1_ID = "299607";
const S2_ID = "307437";
const ONE = "City Connect Swatch Collection Relics (Series One)";
const TWO = "City Connect Swatch Collection Relics (Series Two)";
const TWINS = [
  { insertQuery: "Swatch Collection Relics (Series One)", insertRow: ONE, attachedId: S1_ID, otherId: S2_ID },
  { insertQuery: "Swatch Collection Relics (Series Two)", insertRow: TWO, attachedId: S2_ID, otherId: S1_ID },
];

/** The reconcile dialog's controls. */
function reconcile(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Reconcile Inserts" });
  return {
    dialog,
    filterSets: dialog.getByRole("textbox", { name: "Filter NeonBinder sets" }),
    filterBsc: dialog.getByRole("textbox", { name: "Filter BSC items" }),
    searchSl: dialog.getByRole("textbox", { name: "Search SportLots items" }),
    showAllSl: dialog.getByRole("checkbox", { name: "Show all SportLots items" }),
    ready: (n: string) => dialog.getByRole("heading", { name: new RegExp(`^Ready \\(${n} of [0-9]+\\)`) }),
    bsc: (n: string) => dialog.getByText(new RegExp(`BSC \\(${n} of [0-9]+\\)`)),
    ownSet: (id: string) => dialog.getByRole("button", { name: `Make its own set: ${TWIN} (#${id})` }),
    save: dialog.getByRole("button", { name: /^Save [0-9]+ sets/ }),
  };
}

test(
  "Reconcile — two SportLots sets with one name are each saved to their own NeonBinder set and stay linked by id through a re-sync (NEO-325, 2024 Topps City Connect)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToSet(page, env, { set: "Topps" });
    const insert = columnOption(page, "Variant Types", "Insert");
    await expect(insert).toBeVisible();

    if (env.SL_PAUSED) {
      // Nothing to reconcile against without SportLots: the Variant Types column is all there is.
      await expect(page.getByRole("heading", { name: "Variant Types", exact: true })).toBeVisible();
      return;
    }

    await insert.click();
    // The year's inserts come from both marketplaces live (the flow's 240 s).
    const r = reconcile(page);
    await expect(r.dialog).toBeVisible({ timeout: 240_000 });

    // The two SportLots twins start unpaired: each can be made its own set.
    await r.filterSets.fill("Swatch Collection Relics (Series");
    await expect(r.ready("0")).toBeVisible();
    await r.filterSets.fill("Swatch Collection Relics (Series Two)");
    await expect(r.ready("0")).toBeVisible();
    await r.filterBsc.fill("Swatch Collection Relics (Series");
    await expect(r.bsc("2")).toBeVisible();
    await r.showAllSl.check();
    await r.searchSl.fill(TWIN);
    await expect(r.ownSet(S1_ID)).toBeVisible();
    await expect(r.ownSet(S2_ID)).toBeVisible();

    // Pair Series One with twin #1, Series Two with twin #2.
    await r.dialog.getByRole("button", { name: `BSC ${ONE}` }).click();
    await r.dialog.getByRole("button", { name: new RegExp(`\\(#${S1_ID}\\)$`) }).first().click();
    await expect(r.bsc("1")).toBeVisible();
    await expect(r.ownSet(S2_ID)).toBeVisible();
    await expect(r.ownSet(S1_ID)).toBeHidden();

    await r.dialog.getByRole("button", { name: `BSC ${TWO}` }).click();
    await r.dialog.getByRole("button", { name: new RegExp(`\\(#${S2_ID}\\)$`) }).first().click();
    await expect(r.bsc("0")).toBeVisible();
    await expect(r.dialog.getByRole("button", { name: new RegExp(`^Make its own set: ${TWIN} \\(#[0-9]+\\)$`) })).toHaveCount(0);

    // Both land as their own Ready sets, each remembering its twin's id.
    await r.filterSets.fill("Swatch Collection Relics (Series");
    await expect(r.ready("2")).toBeVisible();
    await expect(
      r.dialog.getByRole("button", { name: `Remove ${TWIN} (#${S1_ID}) from ${ONE}` }),
    ).toBeVisible();
    await expect(
      r.dialog.getByRole("button", { name: `Remove ${TWIN} (#${S2_ID}) from ${TWO}` }),
    ).toBeVisible();
    await expect(r.dialog.getByText(/so you can tell them apart\./)).toBeHidden();

    await r.save.click();
    await expect(r.dialog).toBeHidden();

    // Each saved set holds only its own SportLots twin.
    for (const t of TWINS) await readAttachedTwinId(page, env, { set: "Topps", twin: TWIN, ...t });

    // A re-sync keeps both linked by id, and offers nothing new to pair.
    await drillToSet(page, env, { set: "Topps" });
    await insert.click();
    await page.getByRole("button", { name: "Sync Inserts" }).click();
    await expect(r.dialog).toBeVisible({ timeout: 240_000 });
    await r.filterSets.fill("Swatch Collection Relics (Series");
    await expect(r.ready("2")).toBeVisible();
    await expect(
      r.dialog.getByRole("button", { name: `Remove ${TWIN} (#${S1_ID}) from ${ONE}` }),
    ).toBeVisible();
    await expect(
      r.dialog.getByRole("button", { name: `Remove ${TWIN} (#${S2_ID}) from ${TWO}` }),
    ).toBeVisible();
    await r.filterSets.fill("Swatch Collection Relics (Series Three)");
    await expect(r.ready("0")).toBeVisible();
    await r.showAllSl.check();
    await r.searchSl.fill(TWIN);
    // The remaining SportLots twins are told apart by their own set name, never a bare id.
    await expect(
      r.dialog.getByRole("button", { name: new RegExp(`^Make its own set: ${TWIN} .+ \\(#[0-9]+\\)$`) }).first(),
    ).toBeVisible();
    await expect(
      r.dialog.getByRole("button", { name: new RegExp(`^Make its own set: ${TWIN} \\(#[0-9]+\\)$`) }),
    ).toHaveCount(0);
    await expect(r.dialog.getByText(/so you can tell them apart\./)).toBeHidden();
    await r.save.click();
    await expect(r.dialog).toBeHidden();

    // The saved rows are listed once each, and the bare twin name is not a row.
    await drillToSet(page, env, { set: "Topps" });
    await insert.click();
    await columnSearch(page, "Inserts").fill("City Connect Swatch");
    await expect(columnOption(page, "Inserts", ONE)).toBeVisible();
    await expect(columnOption(page, "Inserts", TWO)).toBeVisible();
    await expect(columnOption(page, "Inserts", ONE)).toHaveCount(1);
    await expect(columnOption(page, "Inserts", TWO)).toHaveCount(1);
    await expect(columnOption(page, "Inserts", TWIN)).toBeHidden();

    for (const t of TWINS) await readAttachedTwinId(page, env, { set: "Topps", twin: TWIN, ...t });
  },
);
