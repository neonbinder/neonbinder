// Origin: .maestro/flows/set-selector/reconcile-sportlots-twins-keep-their-own-ids.yaml (Maestro suite retired in NEO-341; see git history)
// Read-only: opens the Parallels reconcile on 2024 Topps Chrome, never saves.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { columnHeading, drillToSet, pick, setBuilderReady } from "../../support/set-builder";

const TWIN = "Chrome Update Sapphire";
const TWIN_A = "326059";
const TWIN_B = "323331";
const BR = "Chrome Black Refractor";
const BR_MATCH = "309103";
const BR_OTHER = "305604";

test(
  "Reconcile — SportLots twins show their ids, filter cleanly, make their own sets by id and block Save on one title; the twin that is no parallel of the Base is set aside (NEO-325, read-only)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToSet(page, env);
    await pick(page, "Variant Types", "Parallel", { search: false });
    await expect(columnHeading(page, "Parallels")).toBeVisible();
    const sync = page.getByRole("button", { name: "Sync Parallels" });
    await expect(sync).toBeVisible();

    // Paused: nothing to reconcile against.
    if (env.SL_PAUSED) return;

    await sync.click();
    const dialog = page.getByRole("dialog", { name: "Reconcile Parallels" });
    await expect(dialog).toBeVisible({ timeout: 60_000 });

    const own = (label: string) => dialog.getByLabel(`Make its own set: ${label}`, { exact: true });
    const filterSets = dialog.getByRole("textbox", { name: "Filter NeonBinder sets" });
    const filterBsc = dialog.getByRole("textbox", { name: "Filter BSC items" });
    const searchSl = dialog.getByRole("textbox", { name: "Search SportLots items" });
    const dontMatch = dialog.getByRole("button", { name: /^[0-9]+ that don.t match the Base, SportLots/ });
    const dontMatchGroup = dialog.getByRole("group", { name: /that don.t match the Base/ });

    // ── Filters narrow each column and report their counts ──
    await filterSets.fill("Update Sapphire Black");
    await expect(dialog.getByText(/Ready \(0 of [0-9]+\)/)).toBeVisible();
    await filterBsc.fill("Update Sapphire");
    await expect(dialog.getByText(/BSC \(0 of [0-9]+\)/)).toBeVisible();
    await expect(dialog.getByText(/so you can tell them apart\./)).toBeHidden();

    // ── The Base check: same name, two verdicts, decided by id ──
    await searchSl.fill(BR);
    await expect(
      dialog.getByRole("button", { name: new RegExp(`${BR} \\(#${BR_MATCH}\\).*matches the Base`) }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(own(`${BR} (#${BR_MATCH})`)).toBeVisible();
    await expect(dontMatch).toBeVisible({ timeout: 120_000 });
    await expect(own(`${BR} (#${BR_OTHER})`)).toBeHidden({ timeout: 120_000 });

    await dontMatch.click();
    await expect(dontMatchGroup).toBeVisible();
    await expect(dontMatchGroup.getByText(/Doesn.t match the Base/).first()).toBeVisible();
    await expect(dontMatchGroup.getByLabel(`Make its own set: ${BR} (#${BR_OTHER})`, { exact: true })).toBeVisible();
    await dontMatch.click();
    await expect(dontMatchGroup).toBeHidden();
    await expect(own(`${BR} (#${BR_MATCH})`)).toBeVisible();
    await expect(dontMatch).toBeVisible();
    await expect(own(`${BR} (#${BR_OTHER})`)).toBeHidden();

    // Clearing the search empties the box and keeps the toggle.
    await dialog.getByRole("button", { name: "Clear search sportlots items" }).click();
    await expect(searchSl).toHaveAttribute("placeholder", "Search SportLots items...");
    await expect(searchSl).toHaveValue("");
    await dontMatch.click();
    await expect(dontMatchGroup).toBeVisible();

    // ── The Update Sapphire twins: each shows its own id ──
    await searchSl.fill("Update Sapphire");
    await expect(dontMatchGroup.getByLabel(`Make its own set: ${TWIN} (#${TWIN_A})`, { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await expect(dontMatchGroup.getByLabel(`Make its own set: ${TWIN} (#${TWIN_B})`, { exact: true })).toBeVisible({
      timeout: 120_000,
    });

    // Filtering on a longer name leaves no stale twin behind.
    await searchSl.pressSequentially(" Black");
    await expect(dialog.getByLabel(new RegExp(`^Make its own set: ${TWIN} Black`)).first()).toBeVisible();
    await expect(dialog.getByText(/SportLots \([0-9]+ of [0-9]+\)/)).toBeVisible();
    await expect(dialog.getByLabel(new RegExp(`^Make its own set: ${TWIN} \\(#[0-9]+\\)$`))).toBeHidden();
    await searchSl.fill("Update Sapphire");
    await expect(own(`${TWIN} (#${TWIN_A})`)).toBeVisible();

    // ── Make its own set acts on the row pressed, by id ──
    await own(`${TWIN} (#${TWIN_A})`).click();
    await expect(own(`${TWIN} (#${TWIN_B})`)).toBeVisible();
    await expect(own(`${TWIN} (#${TWIN_A})`)).toBeHidden();
    await expect(dialog.getByLabel(new RegExp(`^Make its own set: ${TWIN} [A-Za-z]`)).first()).toBeVisible();

    await own(`${TWIN} (#${TWIN_B})`).click();
    await expect(dialog.getByLabel(new RegExp(`^Make its own set: ${TWIN} [A-Za-z]`)).first()).toBeVisible();
    await expect(dialog.getByLabel(new RegExp(`^Make its own set: ${TWIN} \\(#[0-9]+\\)$`))).toBeHidden();

    // Both promoted: two Ready sets, each chip naming its own id.
    await filterSets.fill("Update Sapphire");
    await expect(dialog.getByText(/Ready \(2 of [0-9]+\)/)).toBeVisible();
    await expect(dialog.getByLabel(`Remove ${TWIN} (#${TWIN_A}) from ${TWIN} (#${TWIN_A})`, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel(`Remove ${TWIN} (#${TWIN_B}) from ${TWIN} (#${TWIN_B})`, { exact: true })).toBeVisible();

    // ── Two sets with one title block Save ──
    const clash = /Two sets are both named .Chrome Update Sapphire.\. Rename one so you can tell them apart\./;
    const save = dialog.getByRole("button", { name: /^Save [0-9]+ sets$/ });
    await expect(dialog.getByText(clash)).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(save).toHaveAccessibleDescription(clash);

    // Renaming either clears the line and frees Save.
    const nameA = dialog.getByRole("textbox", { name: `NeonBinder set name for ${TWIN} (#${TWIN_A})` });
    await nameA.fill(`${TWIN} Second`);
    await dialog.getByRole("heading", { name: "Reconcile Parallels" }).click();
    await expect(dialog.getByLabel(`Remove ${TWIN} (#${TWIN_B}) from ${TWIN}`, { exact: true })).toBeVisible();
    await expect(dialog.getByLabel(`Remove ${TWIN} (#${TWIN_A}) from ${TWIN} Second`, { exact: true })).toBeVisible();
    await expect(dialog.getByText(/so you can tell them apart\./)).toBeHidden();
    await expect(save).toBeEnabled();

    // ── Cancel out: nothing is written ──
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: /^Discard [0-9]+ set changes?$/ }).click();
    await expect(dialog).toBeHidden();
    await expect(sync).toBeVisible();
  },
);
