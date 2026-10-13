// Origin: .maestro/flows/set-selector/checklist-pairing-dialog-cancel.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-137/189/220: syncing the real 2024 Topps Chrome Insert > Future Stars
// checklist opens the Match Cards dialog instead of committing; a manual
// cross-link whose two sides name the card differently raises a name-conflict
// choice (BSC by default, SportLots on request, or a typed third name);
// a conflict does not block Confirm; Cancel asks to discard and writes nothing.
// READ-ONLY on the shared set: the flow only ever cancels.
//
// SportLots paused (NEO-287): the dialog has no surface (a one-marketplace
// sync commits at once), so the paused branch never syncs; it proves the
// pause on the page instead.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnOption,
  columnSearch,
  drillToSet,
  pick,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";

test(
  "Checklist — the card-pairing dialog opens instead of committing, flags a marketplace name disagreement on a manual link, and cancelling writes nothing",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── Drill to the pre-synced 2024 Topps Chrome > Insert > Future Stars.
    await drillToSet(page, env);
    await pick(page, "Variant Types", "Insert", { search: false });
    await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: 20_000 });
    // The inserts are already reconciled, so the search box is the expected state.
    await expect(columnSearch(page, "Inserts")).toBeVisible({ timeout: 60_000 });
    await columnSearch(page, "Inserts").fill("Future Stars");
    const futureStars = columnOption(page, "Inserts", "Future Stars");
    await expect(futureStars).toBeVisible({ timeout: 15_000 });
    await futureStars.click();

    if (env.SL_PAUSED) {
      // Nothing is synced (read-only on this set). The rows are BSC-only cards
      // with no SportLots ref, and the operator is told why.
      await expect(page.getByText(/#FS-[0-9]/).first()).toBeVisible();
      await expect(page.getByText("BSC", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("BSC only", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("SL", { exact: true })).toBeHidden();
      await expect(page.getByText("SportLots is on pause.")).toBeVisible();
      await expect(
        page.getByText(
          "Syncs roll on with BuySportsCards only. Your SportLots links stay put — nothing gets unlinked.",
        ),
      ).toBeVisible();
      await expect(page.getByText(/Match Cards/)).toBeHidden();
      await expect(page.getByText("Sync cancelled — no cards saved.")).toBeHidden();
      await expectAccessible(page, { label: "Future Stars checklist, SportLots on pause" });
      return;
    }

    // ── STEP 1: sync must NOT commit; it opens the pairing dialog (a live
    // BSC + SportLots round trip, the flow's 90 s).
    await syncChecklistButton(page).click();
    const dialog = page.getByRole("dialog", { name: /Match Cards/ });
    await expect(dialog).toBeVisible({ timeout: 90_000 });

    // ── STEP 2: it names the set and states what it will save. Every Future
    // Stars card pairs, so the matched list opens expanded (rows carry Unlink).
    await expect(dialog.getByRole("heading", { name: /Match Cards — Future Stars/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Unlink / }).first()).toBeVisible();
    await expect(dialog.getByText(/[0-9]+ cards? will be saved/)).toBeVisible();

    // ── STEP 3: NEO-189. Wait for the stream to finish (Confirm replaces
    // "Loading…"): a live round trip, the flow's 90 s.
    const confirm = dialog.getByRole("button", { name: "Confirm card matches" });
    await expect(confirm).toHaveText("Confirm", { timeout: 90_000 });
    await expect(dialog.getByRole("button", { name: "Confirm card matches", disabled: false })).toBeVisible();
    const matched = (n: number) => dialog.getByText(new RegExp(`Matched \\(${n}\\)`));
    await expect(matched(20)).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, all cards matched" });

    // Unlink two pairs so there is something to mis-pair.
    await dialog.getByRole("button", { name: /^Unlink #FS-1 / }).click();
    await expect(matched(19)).toBeVisible();
    await dialog.getByRole("button", { name: /^Unlink #FS-2 / }).click();
    await expect(matched(18)).toBeVisible();

    // Collapse Matched so the columns are on screen, and so the auto-expand on
    // a new disagreement has something to prove.
    await dialog.getByRole("button", { name: /^Collapse matched cards/ }).click();
    await expect(dialog.getByRole("button", { name: /^Expand matched cards/ })).toBeVisible();
    await expect(dialog.getByText(/BSC only \(2\)/)).toBeVisible();

    // Cross-link BSC's #FS-1 to SportLots' #FS-2.
    await dialog.getByRole("button", { name: /^Select BSC card #FS-1 / }).click();
    await expect(dialog.getByRole("button", { name: /^#FS-1 .*, selected\. Press to deselect\.$/ })).toBeVisible();
    await dialog.getByRole("button", { name: /^Link selected BSC card to #FS-2 / }).click();

    // The warning is surfaced AND the section opened itself to show it.
    await expect(dialog.getByRole("button", { name: /^Collapse matched cards, .* with a name conflict$/ })).toBeVisible();
    await expect(dialog.getByText(/name conflict/).first()).toBeVisible();

    // The row: warning region, the explanation, and the two names as a group.
    await expect(dialog.getByRole("group", { name: "Name conflict on #FS-1" })).toBeVisible();
    await expect(dialog.getByText(/These marketplaces name this card differently/)).toBeVisible();
    await expect(dialog.getByRole("radiogroup", { name: "Name for #FS-1" })).toBeVisible();
    const bscPill = dialog.getByRole("radio", { name: /^BSC: .* — use this name for #FS-1$/ });
    const slPill = dialog.getByRole("radio", { name: /^SportLots: .* — use this name for #FS-1$/ });
    await expect(bscPill).toBeVisible();
    await expect(slPill).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, name conflict on a manual link" });

    // Both names are read off the screen, so no live value is hardcoded.
    const bscName = ((await bscPill.getAttribute("aria-label")) ?? "")
      .replace(/^BSC: /, "")
      .replace(/ — use this name for #FS-1$/, "")
      .trim();
    const slName = ((await slPill.getAttribute("aria-label")) ?? "")
      .replace(/^SportLots: /, "")
      .replace(/ — use this name for #FS-1$/, "")
      .trim();
    // #FS-1 and #FS-2 must be different players for there to be a disagreement.
    expect(slName).not.toBe(bscName);

    // BSC is the default: the merged row is saved with BSC's name.
    await expect(dialog.getByRole("button", { name: `Unlink #FS-1 ${bscName}`, exact: true })).toBeVisible();

    // Choosing SportLots changes the name the card would be saved with.
    await slPill.click();
    await expect(dialog.getByRole("button", { name: `Unlink #FS-1 ${slName}`, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Unlink #FS-1 ${bscName}`, exact: true })).toBeHidden();

    // Neither marketplace is right: the operator types the name, which joins
    // the same group as a third checked option.
    await dialog.getByRole("button", { name: /^Edit name for #FS-1 / }).click();
    const nameField = dialog.getByRole("textbox", { name: "Edit name for #FS-1" });
    await expect(nameField).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, editing the card name" });
    await nameField.fill("NB Operator Name");
    await nameField.press("Enter");
    await expect(dialog.getByRole("radio", { name: /^Custom: NB Operator Name.* — use this name for #FS-1$/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Unlink #FS-1 NB Operator Name/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Unlink #FS-1 ${slName}`, exact: true })).toBeHidden();
    // Both marketplace names stay on offer.
    await expect(bscPill).toBeVisible();
    await expect(slPill).toBeVisible();

    // A conflict does not block Confirm: 20 - 2 unlinked + 1 re-linked = 19.
    await expect(dialog.getByText(/19 cards will be saved/)).toBeVisible();
    await expect(confirm).toHaveText("Confirm");
    await expect(confirm).toBeEnabled();
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, custom name chosen" });

    // ── STEP 4: Cancel asks to discard (NEO-220) and writes nothing.
    await dialog.getByRole("button", { name: "Cancel card matching" }).click();
    const discard = page.getByRole("button", { name: /^Discard / });
    await expect(discard).toBeVisible();
    await expectAccessible(page, { label: "Match Cards dialog, discard confirm" });
    await discard.click();
    await expect(page.getByText(/Match Cards/)).toBeHidden({ timeout: 10_000 });
    await expect(page.getByText("Sync cancelled — no cards saved.")).toBeVisible();

    // The set is untouched: Sync is available for a retry and no entity-review
    // wizard opened.
    await expect(page.getByText("Tidy up this set")).toBeHidden();
    await expect(syncChecklistButton(page)).toBeVisible();
    await expectAccessible(page, { label: "Future Stars checklist after the sync was cancelled" });
  },
);
