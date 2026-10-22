// Origin: .maestro/flows/set-selector/checklist-pairing-dialog-cancel.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-137/189/220: syncing the real 2024 Topps Chrome Insert > Future Stars
// checklist opens the Match Cards dialog instead of committing; a manual
// cross-link whose two sides name the card differently raises a name-conflict
// choice (BSC's value preselected, SportLots' on request, or a typed third
// name); NEO-344: every choice is the bare value, never which marketplace
// said it, and the warning reads "Potential names/players for this card";
// NEO-339: an unanswered conflict HOLDS Confirm (no pill starts checked, the
// footer says "Hold up — N conflicts still need your pick…", "Go to the next
// conflict" and a press on the held Confirm both move focus to the first open
// one, and answering every conflict releases Confirm); Cancel asks to discard
// and writes nothing.
// READ-ONLY on the shared set: the flow only ever cancels.
//
// SportLots paused (NEO-287): the dialog has no surface (a one-marketplace
// sync commits at once), so the paused branch never syncs; it proves the
// pause on the page instead.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { escapeRe } from "../../support/cards";
import {
  conflictsHoldLine,
  NEXT_CONFLICT,
  releasedConfirm,
  settleMatchCards,
} from "../../support/pairing";
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
    // NEO-339: Confirm is also held while any conflict the live data raised is
    // unanswered. This spec's claim starts from a dialog with none open, so it
    // answers any (Future Stars pairs cleanly, so usually there are none) and
    // reads the released Confirm; the hold itself is proved on the manual link
    // below, where the open count is known.
    const released = await settleMatchCards(page, dialog, { timeout: 90_000 });
    await expect(released).toHaveText("Confirm");
    // The button itself, for the states below where it is held (`released` only
    // matches while it is usable).
    const confirm = dialog.getByRole("button", { name: "Confirm card matches" });
    await expect(conflictsHoldLine(dialog)).toHaveCount(0);
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

    // NEO-344: the pills no longer say which marketplace a value came from,
    // so both names are read where the screen still says which side a card is
    // on: the two unmatched columns. A row's name is `<verb> #<number> <name>`
    // (plus ` · <variation>` on a variation), so stripping the verb and the
    // number leaves the value its pill will show. Read BEFORE the BSC row is
    // selected: selecting renames it to `#FS-1 …, selected. Press to deselect.`.
    // No live value is hardcoded.
    const bscRow = dialog.getByRole("button", { name: /^Select BSC card #FS-1 / });
    const slRow = dialog.getByRole("button", { name: /^Link selected BSC card to #FS-2 / });
    const nameOf = async (row: typeof bscRow, prefix: string) =>
      ((await row.getAttribute("aria-label")) ?? "").replace(prefix, "").replace(/ · .*$/, "").trim();
    await expect(bscRow).toBeVisible();
    await expect(slRow).toBeVisible();
    const bscName = await nameOf(bscRow, "Select BSC card #FS-1 ");
    const slName = await nameOf(slRow, "Link selected BSC card to #FS-2 ");
    // The data precondition, stated (R2): #FS-1 and #FS-2 must be different
    // players for there to be a disagreement at all.
    expect(bscName, "#FS-1's BSC name").not.toBe("");
    expect(slName, "#FS-1 and #FS-2 must name different players").not.toBe(bscName);

    // Cross-link BSC's #FS-1 to SportLots' #FS-2.
    await bscRow.click();
    await expect(dialog.getByRole("button", { name: /^#FS-1 .*, selected\. Press to deselect\.$/ })).toBeVisible();
    await slRow.click();

    // The warning is surfaced AND the section opened itself to show it.
    await expect(dialog.getByRole("button", { name: /^Collapse matched cards, .* with a name conflict$/ })).toBeVisible();
    await expect(dialog.getByText(/name conflict/).first()).toBeVisible();

    // The row: the warning group (exact, or #FS-10 … #FS-19 would answer),
    // its sentence, and the names as a single-select group. NEO-344: the
    // sentence names no marketplace.
    const nameGroup = dialog.getByRole("group", { name: "Name conflict on #FS-1", exact: true });
    await expect(nameGroup).toBeVisible();
    await expect(
      nameGroup.getByText("Potential names for this card — pick the right one before it is listed."),
    ).toBeVisible();
    await expect(dialog.getByRole("radiogroup", { name: "Name for #FS-1", exact: true })).toBeVisible();
    // Each pill is the BARE value, announced and shown: its accessible name is
    // `<value> — use this name for #FS-1` and its text the value (the checked
    // pill's `✓ ` is a separate aria-hidden span).
    const pill = (value: string) =>
      dialog.getByRole("radio", { name: `${value} — use this name for #FS-1`, exact: true });
    const bscPill = pill(bscName);
    const slPill = pill(slName);
    await expect(bscPill).toBeVisible();
    await expect(bscPill).toHaveText(new RegExp(`^(✓ )?${escapeRe(bscName)}$`));
    await expect(slPill).toBeVisible();
    await expect(slPill).toHaveText(new RegExp(`^(✓ )?${escapeRe(slName)}$`));

    // The cross-link puts two different players' rosters on one row, so the
    // players decision is raised too, worded the same way.
    const playersGroup = dialog.getByRole("group", { name: "Players conflict on #FS-1", exact: true });
    await expect(playersGroup).toBeVisible();
    await expect(
      playersGroup.getByText("Potential players for this card — pick the right ones before it is listed."),
    ).toBeVisible();
    await expect(
      dialog.getByRole("radio", { name: /— use these players for #FS-1$/ }).first(),
    ).toBeVisible();

    // …and no marketplace is named anywhere in the conflict UI: not the old
    // sentence, not a prefixed choice name or text, title or roster. These
    // negatives ride on the positives just above (R2).
    const sourcePrefix = /^(BSC|SportLots|Custom): /;
    await expect(dialog.getByText(/These marketplaces/)).toHaveCount(0);
    await expect(dialog.getByRole("radio", { name: sourcePrefix })).toHaveCount(0);
    await expect(dialog.getByRole("radio").filter({ hasText: /^(✓ )?(BSC|SportLots|Custom): / })).toHaveCount(0);

    // NEO-339: nothing is answered yet, so NO pill is checked (BSC's used to
    // look pre-answered) and Confirm is held, with the reason beside it. The
    // merged row still carries BSC's value until the operator picks.
    const namePills = dialog.getByRole("radiogroup", { name: "Name for #FS-1", exact: true });
    const playerPills = dialog.getByRole("radiogroup", { name: "Players for #FS-1", exact: true });
    await expect(namePills.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(playerPills.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(bscPill).not.toBeChecked();
    await expect(slPill).not.toBeChecked();
    await expect(dialog.getByRole("button", { name: `Unlink #FS-1 ${bscName}`, exact: true })).toBeVisible();
    // Two open: this name and this roster (Future Stars pairs cleanly, and any
    // conflict the fetch raised was answered before the cross-link).
    await expect(conflictsHoldLine(dialog)).toHaveText(
      "Hold up — 2 conflicts still need your pick before these cards save.",
    );
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveText("Confirm");
    await expect(releasedConfirm(dialog)).toHaveCount(0);
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, name conflict on a manual link, Confirm held" });

    // "Go to the next conflict" puts focus on the first open conflict's pills:
    // the name on #FS-1 (a row's name is asked before its roster).
    const nextConflict = dialog.getByRole("button", { name: NEXT_CONFLICT, exact: true });
    await nextConflict.click();
    await expect(namePills.getByRole("radio").first()).toBeFocused();
    // Pressing the held Confirm goes to the same place, and saves nothing: it
    // is the keyboard way forward (the button stays focusable while held).
    await confirm.focus();
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(namePills.getByRole("radio").first()).toBeFocused();
    await expect(dialog).toBeVisible();
    await expect(conflictsHoldLine(dialog)).toHaveText(
      "Hold up — 2 conflicts still need your pick before these cards save.",
    );

    // Pressing BSC's value (the one the row already carries) IS an answer: it
    // checks, and the hold now counts one left, singular.
    await bscPill.click();
    await expect(bscPill).toBeChecked();
    await expect(dialog.getByRole("button", { name: `Unlink #FS-1 ${bscName}`, exact: true })).toBeVisible();
    await expect(conflictsHoldLine(dialog)).toHaveText(
      "Hold up — 1 conflict still needs your pick before these cards save.",
    );
    await expect(confirm).toBeDisabled();
    // The next one is the roster.
    await nextConflict.click();
    await expect(playerPills.getByRole("radio").first()).toBeFocused();

    // Answering the last one releases Confirm and takes the hold line away.
    await playerPills.getByRole("radio").first().click();
    await expect(playerPills.getByRole("radio", { checked: true })).toHaveCount(1);
    await expect(conflictsHoldLine(dialog)).toHaveCount(0);
    await expect(nextConflict).toHaveCount(0);
    await expect(releasedConfirm(dialog)).toBeVisible();
    await expect(confirm).toBeEnabled();
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, every conflict answered, Confirm released" });

    // Choosing the other value, by the value it shows, changes the name the
    // card would be saved with.
    await slPill.click();
    await expect(dialog.getByRole("button", { name: `Unlink #FS-1 ${slName}`, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Unlink #FS-1 ${bscName}`, exact: true })).toBeHidden();

    // Neither value is right: the operator types the name, which joins the
    // same group as a third checked option, bare like the others.
    await dialog.getByRole("button", { name: /^Edit name for #FS-1 / }).click();
    const nameField = dialog.getByRole("textbox", { name: "Edit name for #FS-1", exact: true });
    await expect(nameField).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, editing the card name" });
    await nameField.fill("NB Operator Name");
    await nameField.press("Enter");
    const typedPill = pill("NB Operator Name");
    await expect(typedPill).toBeVisible();
    await expect(typedPill).toBeChecked();
    await expect(dialog.getByRole("radio", { name: sourcePrefix })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Unlink #FS-1 NB Operator Name", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Unlink #FS-1 ${slName}`, exact: true })).toBeHidden();
    // Both fetched values stay on offer.
    await expect(bscPill).toBeVisible();
    await expect(slPill).toBeVisible();

    // An ANSWERED conflict does not hold Confirm (the typed name answers it
    // too): 20 - 2 unlinked + 1 re-linked = 19.
    await expect(dialog.getByText(/19 cards will be saved/)).toBeVisible();
    await expect(conflictsHoldLine(dialog)).toHaveCount(0);
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
