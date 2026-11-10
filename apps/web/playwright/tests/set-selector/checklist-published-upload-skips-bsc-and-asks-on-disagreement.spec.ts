// NEO-478 (R1): a publisher's checklist pasted into "Add the publisher's
// checklist" gives a fetch its teams without asking BuySportsCards for each
// card, lists what it could not read, and ASKS the operator where it disagrees
// with the marketplace instead of settling it silently (rule 7: a number that
// matches but a player that does not is a likely misread, never settled).
//
// The flow, as the operator lives it, on a small BSC-only set:
//   1. Paste the checklist in the published line format ("<number> <player> -
//      <team>"), built from the set's own captured BSC answers
//      (fixtures/checklists/1995-hockey-oklahoma-city-blazers-chl-base.csv) with
//      FOUR deliberate changes: two players misspelt (cards #2 and #4), ONE
//      number written twice with a team nobody else uses (card #6), and one line
//      that is no card at all. The preview reads "19 rows" (18 cards plus the
//      repeated number) and lists the junk line under "Skipped lines".
//   2. Use it and Sync. The result line reads "Teams from your checklist: 17 of
//      18 cards": every card but #6 took its answer from the checklist (#2 and #4
//      pair by number and only their players disagree), and #6's number is on two
//      rows, so the checklist cannot say which row is the card (rule 7).
//   3. The review wizard OPENS on "Checklist says otherwise" (it comes before any
//      name step): one group per disagreement ("Disagreement on #2", "#4"), each
//      with "Keep the marketplace's" and "Use the checklist's" radios. Next is held
//      ("Pick a side on every card first", after a blocked press) until both have a side; the bulk name
//      links are hidden there; Back from the first name step ("Back to previous
//      step") returns to it. #2 takes the checklist's spelling and #4 the
//      marketplace's, so each side lands on a card and both are read back.
//   4. D2 (Jason, 2026-11-10): card #6, whose number the checklist could not pin
//      down, is looked up on BSC for just that card. Proof from the user's side:
//      the invented team on its two rows is never offered as a New Team step, and
//      the saved card carries BSC's own team, "Oklahoma City Blazers".
//
// ASSUMPTIONS, written before the UI existed (the names are the contract in
// todos/neo-451-contracts.md; what follows is not): the "Skipped lines" entry
// shows the line's own text; the "N rows" preview count reads "19 rows"; the
// result line shows with the wizard open; both picks are kept when Back returns
// to the step; a name step for the misspelt names, if one is asked, is answered
// by the bulk skip. A red on any of these is the first thing to check against
// the shipped UI.
//
// FIXTURE (SET-REGISTRY.md -> "Hockey -> 1995 -> Oklahoma City Blazers CHL",
// PROPOSED, needs Jason's approval): SOLE WRITER of that set (BSC only, 18 cards,
// reached through the All Brands view); FRESH-ONLY, it commits the checklist, so
// a re-run on the same seed fails at "No cards in this checklist yet." by name.
// Every name is skipped, so no player or team is minted.
//
// Desktop and mobile: one spec, no branch (role and label locators; click()
// scrolls). Axe runs in light and dark on the dialog's preview and on the
// disagreement step.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { editCardButton } from "../../support/cards";
import { expectAfterMarketplace } from "../../support/marketplace-wait";
import {
  CHECKLISTS,
  checklistRows,
  previewRowCount,
  publishersChecklistButton,
  publishersChecklistChip,
  publishersChecklistDialog,
} from "../../support/published-checklist";
import { setBuilderReady, syncChecklistButton } from "../../support/set-builder";
import {
  advanceToSave,
  confirmSaveButton,
  checklistDisagreementHeading,
  disagreementOn,
  expectChecklistDisagreementFirst,
  openOneMarketplaceSetBase,
  reviewWizard,
  pickASideFirst,
  pickDisagreementSide,
} from "../../support/wizard";

const SET = "Oklahoma City Blazers CHL";
/** Every card of the set is on this club on BSC (the captured file). */
const BSC_TEAM = "Oklahoma City Blazers";
const JUNK_LINE = "Page 1 of 1 - checklist continues on the back of the card";

/** Swap the first pair of different neighbouring letters after the first two of a surname: a misspelling no matcher takes for the same name. */
function misspell(name: string): string {
  const parts = name.split(" ");
  const surname = [...parts[parts.length - 1]];
  for (let i = 2; i < surname.length - 1; i++) {
    if (surname[i] !== surname[i + 1]) {
      [surname[i], surname[i + 1]] = [surname[i + 1], surname[i]];
      break;
    }
  }
  parts[parts.length - 1] = surname.join("");
  return parts.join(" ");
}

test(
  "Checklist — a pasted publisher's checklist gives a fetch its teams without asking BSC per card, lists what it could not read, and asks where it disagrees with the marketplace (NEO-478)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const bogusTeam = `Dup${env.ATTEMPT_TOKEN}`;
    const rows = checklistRows(CHECKLISTS.oklahomaCityBlazers);
    expect(rows, "the captured file holds the set's 18 cards").toHaveLength(18);
    const at = (n: number) => rows.find((r) => r.number === String(n))!;
    const [two, four, six, eight] = [at(2), at(4), at(6), at(8)];
    const typoTwo = misspell(two.player);
    const typoFour = misspell(four.player);
    expect(typoTwo, "the misspelling changed the name").not.toBe(two.player);
    expect(typoFour, "the misspelling changed the name").not.toBe(four.player);

    // The paste: the published line format, one line per card, with the changes above.
    const lines = rows.map((r) => {
      if (r.number === "2") return `${r.number} ${typoTwo} - ${r.team}`;
      if (r.number === "4") return `${r.number} ${typoFour} - ${r.team}`;
      if (r.number === "6") return `${r.number} ${r.player} - ${bogusTeam}`;
      return `${r.number} ${r.player} - ${r.team}`;
    });
    // Card #6's number again, on another player, with the same invented team.
    lines.splice(6, 0, `6 ${eight.player} - ${bogusTeam}`);
    lines.unshift(JUNK_LINE);
    const rowCount = rows.length + 1;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await openOneMarketplaceSetBase(page, env, { set: SET });
    // The precondition for a FIRST fetch (fresh-only): a re-run fails here, by name.
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();

    // ── 1. Paste, and read the preview ──
    await publishersChecklistButton(page).click();
    const dialog = publishersChecklistDialog(page);
    await expect(dialog).toBeVisible();
    // Escape cancels and hands focus back to the button that opened it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(publishersChecklistButton(page)).toBeFocused();
    await publishersChecklistButton(page).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Paste the checklist" }).fill(lines.join("\n"));
    await expect(previewRowCount(dialog, rowCount)).toBeVisible();
    // The line that is no card is listed, not dropped silently.
    await expect(dialog.getByText("Skipped lines")).toBeVisible();
    await expect(dialog.getByText(JUNK_LINE, { exact: false })).toBeVisible();
    // The misspellings are in the preview as pasted (the checklist is read, not corrected).
    await expect(dialog.getByText(typoTwo).first()).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Publisher's checklist dialog, preview with a skipped line" });
    await dialog.getByRole("button", { name: "Use this checklist" }).click();
    await expect(dialog).toBeHidden();
    await expect(publishersChecklistChip(page, rowCount)).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove the publisher's checklist" })).toBeVisible();

    // ── 2. Sync: BSC is asked for the bulk checklist, and for no card one by one ──
    await syncChecklistButton(page).click();
    await expectAfterMarketplace(page, page.getByText(/Kept all [0-9]+ cards? from BSC/), {
      platform: "BuySportsCards",
      what: "the solo fetch's kept-cards line",
    });
    const wizard = reviewWizard(page);
    await expect(wizard).toBeVisible();
    // 17 of 18: every card but #6 took its answer from the checklist. #2 and #4 count
    // (their numbers pair; only their players disagree), #6 does not (its number is on
    // two rows, so the checklist cannot say which row is the card: rule 7).
    await expect(page.getByText("Teams from your checklist: 17 of 18 cards").first()).toBeVisible();

    // ── 3. The step that asks comes first, one group per disagreement ──
    await expectChecklistDisagreementFirst(page);
    const onTwo = disagreementOn(page, "2");
    const onFour = disagreementOn(page, "4");
    await expect(onTwo).toBeVisible();
    await expect(onFour).toBeVisible();
    // Card #6 is a repeated number, not a disagreement: the checklist cannot speak for it.
    await expect(disagreementOn(page, "6")).toHaveCount(0);
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, Checklist says otherwise" });
    // Each group shows both spellings, so the operator sees what each side says.
    await expect(onTwo.getByText(typoTwo).first()).toBeVisible();
    await expect(onTwo.getByText(two.player).first()).toBeVisible();
    // Next is held until every card has a side: the Enter shortcut the footer names is
    // refused with a status (shown only after the blocked press), and the next pick replaces it.
    await page.keyboard.press("Enter");
    await expect(pickASideFirst(page)).toBeVisible();
    await expect(checklistDisagreementHeading(page)).toBeVisible();
    await pickDisagreementSide(page, "2", "Use the checklist's");
    await expect(page.getByText("Picked 1 of 2 cards").first()).toBeVisible();
    await expect(pickASideFirst(page)).toBeHidden();
    await pickDisagreementSide(page, "4", "Keep the marketplace's");
    await expect(page.getByText("Picked 2 of 2 cards. All answered — hit Next!").first()).toBeVisible();

    // On to the name steps (every name skipped), then Back lands on this step with both picks kept.
    const next = wizard.getByRole("button", { name: "Next (Enter)", exact: true });
    await next.click();
    await expect(checklistDisagreementHeading(page)).toBeHidden();
    await wizard.getByRole("button", { name: "Back to previous step" }).click();
    await expect(checklistDisagreementHeading(page)).toBeVisible();
    await expect(onTwo.getByRole("radio", { name: "Use the checklist's", exact: true })).toBeChecked();
    await expect(onFour.getByRole("radio", { name: "Keep the marketplace's", exact: true })).toBeChecked();
    await next.click();
    await expect(checklistDisagreementHeading(page)).toBeHidden();
    const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
    await expect(skipRemaining.or(next).first()).toBeVisible();
    if (await skipRemaining.isVisible()) await skipRemaining.click();

    // ── 4. D2: the repeated number's card was asked of BSC; the invented team was never offered ──
    await advanceToSave(page);
    await expect(wizard.getByText(bogusTeam)).toHaveCount(0);
    await expect(confirmSaveButton(page)).toBeVisible();
    await confirmSaveButton(page).click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible();
    await expect(wizard).toBeHidden();
    // The result line stays on screen after the save too.
    await expect(page.getByText("Teams from your checklist: 17 of 18 cards").first()).toBeVisible();

    // ── 5. Each side landed on its card; BSC's team is on the repeated number's card ──
    // A fresh load of the set (the commit leaves its virtualised list at the first
    // streamed batch); the picker reopens on every visit while SportLots is unmapped.
    await openOneMarketplaceSetBase(page, env, { set: SET });
    const drawer = page.getByRole("dialog");
    const cardName = drawer.getByRole("textbox", { name: "Card name" });
    await editCardButton(page, "2").click();
    await expect(cardName).toHaveValue(typoTwo);
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
    await editCardButton(page, "4").click();
    await expect(cardName).toHaveValue(four.player);
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
    await editCardButton(page, "6").click();
    await expect(cardName).toHaveValue(six.player);
    await expect(drawer.getByRole("button", { name: `Remove team ${BSC_TEAM}` })).toBeVisible();
    await expect(drawer.getByRole("button", { name: `Remove team ${bogusTeam}` })).toHaveCount(0);
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
  },
);
