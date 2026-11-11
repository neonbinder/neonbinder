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
//      step") returns to it. "Keep the marketplace's on all" answers both at
//      once, then #2 is changed to the checklist's spelling on its own: #2 takes
//      the checklist's and #4 the marketplace's, so each side lands on a card and
//      both are read back.
//   4. D2 (Jason, 2026-11-10): card #6, whose number the checklist could not pin
//      down, is looked up on BSC for just that card. Proof from the user's side:
//      the "17 of 18" line (the other 17 took the checklist's answer, so BSC was
//      asked for no card but #6), the invented team on #6's two rows is never
//      offered as a New Team step, and the saved card #6 carries neither it nor
//      the other row's player. NOT provable from the screen: that BSC's own team
//      then landed on #6. Every name is skipped, so BSC's team (a team NB does
//      not know) is skipped with them, and the teams step names no marketplace
//      value for a grouped card; that needs a team created in the wizard, which is
//      a shared row this spec does not mint. The backend's own log line for the
//      fetch ("calls":1 for 18 cards) is what shows BSC was asked once.
//
// BEFORE THE REAL PASTE the dialog is shown three things that are not the checklist:
//   * a paste that reads as no card: the count's status says "Nothing reads as a
//     card yet. Each line starts with its card number.", pressing Use says
//     "Nothing to use yet", and the dialog stays open (axe on that state);
//   * a paste with a "Card Set" column naming two subsets: the question "Which of
//     these belong to this set?" shows with NOTHING ticked, Use refuses with "Tick
//     at least one subset first", and ticking one subset narrows the preview to
//     that subset's rows (axe on that state);
//   * NEO-489: four of the set's cards with four kinds of team cell. The preview's Teams
//     column reads the team, "No team" (a "No Team" cell is the checklist's claim), and
//     "We'll look it up" (a blank cell is no claim); a "No Team; <team>" line is no row and is
//     listed under Skipped lines with "Says No Team and names a team — pick one." (axe on
//     that state). A throwaway paste: the real one below is unchanged.
// AFTER USING the real paste, "Remove the publisher's checklist" takes the chip
// away (and the button to add one is back); the checklist is then used again for
// the flow below. No plain Sync follows the Remove: that would ask BSC for each of
// the 18 cards live.
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
  pickSideForAllCards,
} from "../../support/wizard";

const SET = "Oklahoma City Blazers CHL";
/** The dialog's own words for a paste that reads as no card, a Use with nothing to use, and a Use with no subset ticked. */
const NOTHING_READS = "Nothing reads as a card yet. Each line starts with its card number.";
const NOTHING_TO_USE = "Nothing to use yet — paste lines that start with a card number.";
const PICK_A_SUBSET = "Tick at least one subset first — then use it.";
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
    const paste = dialog.getByRole("textbox", { name: "Paste the checklist" });
    const useButton = dialog.getByRole("button", { name: "Use this checklist" });

    // A paste that reads as no card: said at once, refused on Use, the dialog stays.
    await paste.fill("hello there\nnothing in this paste starts with a card number");
    await expect(dialog.getByRole("status").filter({ hasText: NOTHING_READS })).toBeVisible();
    await expect(dialog.getByText(/Try a line like/)).toBeVisible();
    // Use is aria-disabled while there is nothing to use, so click() would wait it out (GUIDE): the
    // press is made from the keyboard, which the product answers with its reason.
    await useButton.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status").filter({ hasText: NOTHING_TO_USE })).toBeVisible();
    await expect(dialog).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Publisher's checklist dialog, a paste that reads as no card" });

    // A paste naming two subsets: asked before anything is used, none ticked to start.
    const base = rows.slice(0, 4);
    const insert = rows.slice(4, 6);
    await paste.fill(
      [
        "Card Set,Card #,Player,Team",
        ...base.map((r) => `Base,${r.number},${r.player},${r.team}`),
        ...insert.map((r) => `Insert,${r.number},${r.player},${r.team}`),
      ].join("\n"),
    );
    const subsetQuestion = dialog.getByRole("group", { name: "Which of these belong to this set?" });
    await expect(subsetQuestion).toBeVisible();
    const baseBox = subsetQuestion.getByRole("checkbox", { name: "Base", exact: true });
    const insertBox = subsetQuestion.getByRole("checkbox", { name: "Insert", exact: true });
    await expect(baseBox).not.toBeChecked();
    await expect(insertBox).not.toBeChecked();
    const previewRowsShown = dialog.getByRole("table", { name: "Preview of the rows the sync will use" }).getByRole("row");
    await expect(dialog.getByText("Tick the subsets that belong to this set, and their rows show up here.")).toBeVisible();
    await useButton.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status").filter({ hasText: PICK_A_SUBSET })).toBeVisible();
    await expect(dialog).toBeVisible();
    // Ticking one subset narrows the preview to its rows (the header row is one of the table's rows).
    await insertBox.check();
    await expect(previewRowsShown).toHaveCount(insert.length + 1);
    await expect(dialog.getByText("Tick the subsets that belong to this set, and their rows show up here.")).toBeHidden();
    await expectAccessible(page, { within: dialog, label: "Publisher's checklist dialog, one of two subsets ticked" });
    await baseBox.check();
    await expect(previewRowsShown).toHaveCount(base.length + insert.length + 1);

    // NEO-489 (Jason, 2026-11-11): what the preview's Teams column says for each kind of team cell.
    // A throwaway paste, read and replaced by the real one below, so the fetch's own arithmetic
    // ("17 of 18") and its BSC lookups are untouched: four of the set's own cards, each with a
    // different team cell. A named team reads as itself; "No Team" is the checklist's CLAIM that
    // the card shows no team, so it reads "No team"; a blank cell makes no claim, so it reads
    // "We'll look it up"; "No Team" beside a team contradicts itself, so that line is not a row
    // and is listed under Skipped lines with the parser's own reason.
    const [teamed, claimed, blank, both] = rows.slice(0, 4);
    await paste.fill(
      [
        "number,player,team",
        `${teamed.number},${teamed.player},${teamed.team}`,
        `${claimed.number},${claimed.player},No Team`,
        `${blank.number},${blank.player},`,
        `${both.number},${both.player},No Team; ${both.team}`,
      ].join("\n"),
    );
    await expect(subsetQuestion).toBeHidden();
    await expect(previewRowCount(dialog, 3)).toBeVisible();
    const previewTable = dialog.getByRole("table", { name: "Preview of the rows the sync will use" });
    const teamCell = (player: string, text: string) =>
      previewTable.getByRole("row").filter({ hasText: player }).getByRole("cell", { name: text, exact: true });
    await expect(teamCell(teamed.player, teamed.team)).toBeVisible();
    await expect(teamCell(claimed.player, "No team")).toBeVisible();
    await expect(teamCell(blank.player, "We'll look it up")).toBeVisible();
    // The contradicting line is no row of the preview, and is listed with the reason, not dropped.
    await expect(previewTable.getByRole("row").filter({ hasText: both.player })).toHaveCount(0);
    const contradiction = dialog.getByRole("listitem").filter({ hasText: both.player });
    await expect(contradiction).toBeVisible();
    await expect(contradiction).toContainText("Says No Team and names a team — pick one.");
    await expectAccessible(page, { within: dialog, label: "Publisher's checklist dialog, preview with No Team, a blank team and a contradiction" });

    // The real paste: the published line format, no subsets.
    await paste.fill(lines.join("\n"));
    await expect(subsetQuestion).toBeHidden();
    await expect(previewRowCount(dialog, rowCount)).toBeVisible();
    // The line that is no card is listed, not dropped silently.
    await expect(dialog.getByText("Skipped lines")).toBeVisible();
    // Read it off its own list item: the pasted text sits in the textarea too, so a bare text match finds two.
    const skipped = dialog.getByRole("listitem").filter({ hasText: JUNK_LINE });
    await expect(skipped).toBeVisible();
    await expect(skipped).toContainText("No card number at the start");
    // The misspellings are in the preview as pasted (the checklist is read, not corrected).
    await expect(dialog.getByText(typoTwo).first()).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Publisher's checklist dialog, preview with a skipped line" });
    await dialog.getByRole("button", { name: "Use this checklist" }).click();
    await expect(dialog).toBeHidden();
    await expect(publishersChecklistChip(page, rowCount)).toBeVisible();
    const removeChecklist = page.getByRole("button", { name: "Remove the publisher's checklist" });
    await expect(removeChecklist).toBeVisible();

    // ── 1b. Remove: the chip goes and the button to add one is back ──
    // (Not followed by a plain Sync: that would ask BSC for each of the 18 cards live, a burst
    // that has met BSC's 429 for the next spec. Use it again for the flow below.)
    await removeChecklist.click();
    await expect(publishersChecklistChip(page, rowCount)).toBeHidden();
    await expect(publishersChecklistButton(page)).toBeVisible();
    await publishersChecklistButton(page).click();
    await expect(dialog).toBeVisible();
    await paste.fill(lines.join("\n"));
    await expect(previewRowCount(dialog, rowCount)).toBeVisible();
    await useButton.click();
    await expect(dialog).toBeHidden();
    await expect(publishersChecklistChip(page, rowCount)).toBeVisible();

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
    // Next is held until every card has a side: Enter on it is refused with a status (shown
    // only after the blocked press), and the next pick replaces it. (Focus arrives on the
    // first card's radio, where Enter picks it, so the press is made from Next itself.)
    const next = wizard.getByRole("button", { name: "Next (Enter)", exact: true });
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(pickASideFirst(page)).toBeVisible();
    await expect(checklistDisagreementHeading(page)).toBeVisible();
    await pickDisagreementSide(page, "2", "Use the checklist's");
    await expect(page.getByText("Picked 1 of 2 cards").first()).toBeVisible();
    await expect(pickASideFirst(page)).toBeHidden();
    // The bulk answer sets every card at once (it overrides #2's pick), and each card can be changed on its own.
    await pickSideForAllCards(page, "Keep the marketplace's", ["2", "4"]);
    await expect(page.getByText("Picked 2 of 2 cards. All answered — hit Next!").first()).toBeVisible();
    await pickDisagreementSide(page, "2", "Use the checklist's");
    await expect(onFour.getByRole("radio", { name: "Keep the marketplace's", exact: true })).toBeChecked();
    await expect(page.getByText("Picked 2 of 2 cards. All answered — hit Next!").first()).toBeVisible();

    // On to the name steps (every name skipped), then Back lands on this step with both picks kept.
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

    // ── 5. Each side landed on its card; the repeated number's card kept its own name and no invented team ──
    // A fresh load of the set (the commit leaves its virtualised list at the first
    // streamed batch); the picker reopens on every visit while SportLots is unmapped.
    await openOneMarketplaceSetBase(page, env, { set: SET });
    const drawer = page.getByRole("dialog");
    const cardName = drawer.getByRole("textbox", { name: "Card name" });
    // The list opens where its first streamed batch left it (#9 here), so each card is found by
    // its name in the search box, as a collector would.
    const search = page.getByRole("searchbox", { name: "Search cards" });
    await search.fill(typoTwo);
    await editCardButton(page, "2").click();
    await expect(cardName).toHaveValue(typoTwo);
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
    await search.fill(four.player);
    await editCardButton(page, "4").click();
    await expect(cardName).toHaveValue(four.player);
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
    await search.fill(six.player);
    await editCardButton(page, "6").click();
    await expect(cardName).toHaveValue(six.player);
    await expect(drawer.getByRole("button", { name: `Remove team ${bogusTeam}` })).toHaveCount(0);
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
  },
);
