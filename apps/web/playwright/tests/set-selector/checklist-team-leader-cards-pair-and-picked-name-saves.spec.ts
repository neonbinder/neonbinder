// NEO-343 / NEO-344 (R1): on a real two-marketplace fetch of 2014 Topps
// Football's Base, the Match Cards dialog's NAME DECISION is right, and the
// operator's answer is what the card is saved with.
//
//   (a) NEO-343: BSC sends a team-leader card as "<Team> TL" ("Buffalo Bills
//       TL"), SportLots as "<Team>". BSC's parser strips "TL" as it strips
//       "TC", so the 32 team-leader cards raise no decision. Before the fix
//       the header read 40 name and 38 player conflicts on this set (prod,
//       2026-10-13). STEP 4 bounds both counts at 12 (measured 8 and 7; see
//       below); STEP 5 reads #6a (New England Patriots) in the dialog:
//       matched, bare team name, no name or players conflict; STEP 9 finds the
//       SAVED #6a with the checklist search and reads its team as LINKED, not
//       "(unconfirmed)".
//   (b) NEO-344: a conflict that IS there shows each value bare (Jason,
//       2026-10-13: "I don't want the user swayed by what marketplace the data
//       comes from"), still opens on BSC's value, and the value the operator
//       picks is the one the card is saved with. STEP 6 manufactures the
//       conflict on #442 (unlink it, then link it to a SportLots-only card),
//       STEP 7 saves, STEP 8 reads the saved name back.
//
// One fetch carries both: a second spec would fetch this ~1,000-row real set
// again, and a real set has exactly one writer (R7a).
//
// FIXTURE (SET-REGISTRY.md -> "Football → 2014 — the NEO-343 team-leader
// fixture", approved by Jason 2026-10-13): Football -> 2014 -> Topps > Topps >
// Base. SOLE WRITER of Football -> 2014; not self-cleaning (the run-start
// reset is its cleanup). FRESH-ONLY: a re-run on the same seed finds the
// checklist committed and fails at STEP 3's empty-checklist assert, by name.
// Mints nothing: every review-wizard name is skipped.
//
// MEASURED on PR #335 run 38501127928 (Football 2014 Topps Base, live): the
// dialog opens on "Matched (554)" with 8 name conflicts and 7 player
// conflicts, "BSC only (0)" and "SportLots only (2)": #28 Vernon David ·
// Jumping and #35 Navarro Bowman · Celebrating. EVERY BSC card matched, #442
// included, so #442 is NOT BSC-only (an earlier draft assumed it was and
// failed to find its row in the BSC column).
//
// The conflict is MANUFACTURED from the real fetched halves (as
// checklist-pairing-dialog-cancel's is): #442 is found in the Matched list,
// UNLINKED (its BSC half lands in BSC only: 0 -> 1), and linked to the first
// SportLots-only card, a different person, so a name conflict is guaranteed.
// Both names are read off the screen; nothing is hardcoded but the card
// numbers.
//
// R3: checklist-pairing-dialog-cancel proves the bare pills on Future Stars
// and then CANCELS (its set is read-only); this is the only spec that saves
// through a name decision and reads the answer back, and the only one that
// fetches a team-leader card. checklist-search-narrows-and-clears owns the
// search box itself; this spec only uses it to reach two rows.
//
// NEO-287: paused, nothing is asked of SportLots, so there is no Match Cards
// dialog and no name decision: the feature has no surface. The paused branch
// stops after the drill and proves the pause on the page.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { escapeRe } from "../../support/cards";
import {
  drillToBaseVariant,
  drillToColdManufacturer,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";
import { advanceToSave, confirmSaveButton, reviewWizard } from "../../support/wizard";

const FOOTBALL_2014 = { sport: "Football", year: "2014", manufacturer: "Topps" };
/** One live BSC + SportLots round trip on a ~1,000-row two-sided fetch. */
const CHECKLIST_FETCH = 120_000;
/** The wizard opens behind the entity check's batch (live lookups). */
const WIZARD_OPENS = 60_000;
/** The bulk skip while the batch can still grow (checklist-one-marketplace-skips-match-dialog's ceiling). */
const BATCH_GROWS = 60_000;

/** A row's name with its `#<number> ` prefix and any ` · <variation>` tail dropped. */
function nameFromLabel(label: string): string {
  return label.replace(/^#\S+ /, "").replace(/ · .*$/, "").trim();
}

test(
  "Match Cards on 2014 Topps Football — team-leader cards pair with no conflict, and the name the operator picks is the one saved (NEO-343, NEO-344)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1-2: cold drill to Football / 2014 / Topps, then the flagship
    // set's Base, mapping it on both sides (R9). No other spec opens the year,
    // so every column syncs itself; the helpers pay those marketplace waits.
    await drillToColdManufacturer(page, env, FOOTBALL_2014);
    await drillToBaseVariant(page, env, { ...FOOTBALL_2014, set: "Topps" });

    if (env.SL_PAUSED) {
      // No dialog, so no name decision to prove: the operator is told why.
      await expect(page.getByText("SportLots is on pause.")).toBeVisible();
      await expect(page.getByText(/Match Cards/)).toBeHidden();
      await expectAccessible(page, { label: "2014 Topps Football Base, SportLots on pause" });
      return;
    }

    // ── STEP 3: fetch. The empty checklist makes everything below THIS fetch's.
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await syncChecklistButton(page).click();
    const dialog = page.getByRole("dialog", { name: /^Match Cards/ });
    // Live BSC + SportLots round trip (GUIDE hard rule 3, marketplace exception).
    await expect(dialog).toBeVisible({ timeout: CHECKLIST_FETCH });
    // The dialog OPENING is not the fetch FINISHING: Confirm is "Loading…"
    // (aria-disabled) until the stream resolves. Same live round trip.
    const confirm = dialog.getByRole("button", { name: "Confirm card matches", disabled: false });
    await expect(confirm).toBeVisible({ timeout: CHECKLIST_FETCH });
    await expect(confirm).toHaveText("Confirm");

    // ── STEP 4 (a): at most 12 of each kind of conflict. The Matched toggle's
    // name appends ", N with a player conflict" then ", M with a name
    // conflict" whenever either is non-zero, so one full match bounds both at
    // 0-12. Measured 8 name and 7 player conflicts (PR #335 run 38501127928);
    // unwired, all 32 team-leader cards conflict on both (40 and 38 on prod).
    // Bounded, not pinned: the natural 8 and 7 are live marketplace
    // disagreements (#72, #247, #257, #405 by the catalogues), not this
    // spec's business, so 4 of slack absorbs catalogue drift while a
    // regression on more than 4 of the 32 team-leader cards still fails.
    const upTo12 = "([0-9]|1[0-2])";
    await expect(
      dialog.getByRole("button", {
        name: new RegExp(
          `^(Expand|Collapse) matched cards(, ${upTo12} with a player conflict)?(, ${upTo12} with a name conflict)?$`,
        ),
      }),
    ).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, 2014 Topps Football Base" });

    // ── STEP 5 (a): #6a, a team-leader card, is matched under the bare team
    // name with no decision on it. Matched opens collapsed whenever a column
    // holds a card (BSC's "b" photo variations have no partner) and expanded
    // otherwise: wait for one state, then open it.
    const expandMatched = dialog.getByRole("button", { name: /^Expand matched cards/ });
    const collapseMatched = dialog.getByRole("button", { name: /^Collapse matched cards/ });
    await expect(expandMatched.or(collapseMatched)).toBeVisible();
    if (await expandMatched.isVisible()) await expandMatched.click();
    await expect(collapseMatched).toBeVisible();
    // `Unlink <label>` carries the name the card will be saved with; a full
    // match refuses "New England Patriots TL". `#6a?`: BSC's number is "6a"
    // (the parent of a "6b" photo variation) unless NB normalises it.
    await expect(dialog.getByRole("button", { name: /^Unlink #6a? New England Patriots$/ })).toBeVisible();
    // No decision on it, title or roster (rides on the positive above, R2).
    await expect(dialog.getByRole("group", { name: /^Name conflict on #6a?( .*)?$/ })).toHaveCount(0);
    await expect(dialog.getByRole("group", { name: /^Players conflict on #6a?( .*)?$/ })).toHaveCount(0);

    // ── STEP 6 (b): a conflict on #442, shown bare. Matched is still open
    // from STEP 5. The measured shape (R2): every BSC card matched, so BSC
    // only is empty and #442 sits in the Matched list. Unlink it (the button
    // carries its label, `Unlink #442 <name>`); its BSC half lands in BSC only.
    const bscOnly = (n: number) => dialog.getByRole("heading", { name: `BSC only (${n})`, exact: true });
    await expect(bscOnly(0)).toBeVisible();
    await dialog.getByRole("button", { name: /^Unlink #442 / }).click();
    await expect(bscOnly(1)).toBeVisible();
    // Collapse Matched so the columns are the dialog's working area again.
    await collapseMatched.click();
    await expect(expandMatched).toBeVisible();

    // The BSC half: #442, narrowed to by the column's filter (it matches the
    // row's label). Its name is read off the row before it is selected
    // (selecting renames the row).
    await dialog.getByRole("textbox", { name: "Filter BSC cards" }).fill("#442");
    const bscRow = dialog.getByRole("button", { name: /^Select BSC card #442 / });
    await expect(bscRow).toBeVisible();
    const bscName = nameFromLabel(((await bscRow.getAttribute("aria-label")) ?? "").replace(/^Select BSC card /, ""));

    // The SportLots half: whichever SportLots-only card heads its column (any
    // one will do; measured #28 Vernon David · Jumping, and an unlinked
    // SportLots half of #442, if it had one, is appended AFTER the fetched
    // ones). Its pill shows the NAME, so the number and variation go.
    const slRow = dialog.getByRole("button", { name: /^Link selected BSC card to / }).first();
    await expect(slRow).toBeVisible();
    const slLabel = ((await slRow.getAttribute("aria-label")) ?? "").replace(/^Link selected BSC card to /, "");
    const slName = nameFromLabel(slLabel);
    // The data precondition, stated (R2): two different names, or there is no
    // disagreement to make.
    expect(bscName, "#442's BSC name").not.toBe("");
    expect(slName, "the SportLots card must name someone other than #442").not.toBe(bscName);

    // Link. The SportLots rows are disabled until a BSC row is selected.
    await bscRow.click();
    await expect(dialog.getByRole("button", { name: /^#442 .*, selected\. Press to deselect\.$/ })).toBeVisible();
    await dialog.getByRole("button", { name: `Link selected BSC card to ${slLabel}`, exact: true }).click();

    // The conflict is raised on #442, and the link reopened Matched to show it.
    const nameGroup = dialog.getByRole("group", { name: "Name conflict on #442", exact: true });
    await expect(nameGroup).toBeVisible();
    await expect(collapseMatched).toBeVisible();

    // NEO-344: the warning names no marketplace, and each value is bare,
    // announced (`<value> — use this name for #442`) and shown (the checked
    // pill's `✓ ` is a separate aria-hidden span).
    await expect(
      nameGroup.getByText("Potential names for this card — pick the right one before it is listed."),
    ).toBeVisible();
    await expect(dialog.getByRole("radiogroup", { name: "Name for #442", exact: true })).toBeVisible();
    const pill = (value: string) =>
      dialog.getByRole("radio", { name: `${value} — use this name for #442`, exact: true });
    const bscPill = pill(bscName);
    const slPill = pill(slName);
    await expect(bscPill).toHaveText(new RegExp(`^(✓ )?${escapeRe(bscName)}$`));
    await expect(slPill).toHaveText(new RegExp(`^(✓ )?${escapeRe(slName)}$`));
    // …and no choice, title or roster, names a marketplace. Rides on the
    // positives above (R2).
    await expect(dialog.getByText(/These marketplaces/)).toHaveCount(0);
    await expect(dialog.getByRole("radio", { name: /^(BSC|SportLots|Custom): / })).toHaveCount(0);
    await expect(dialog.getByRole("radio").filter({ hasText: /^(✓ )?(BSC|SportLots|Custom): / })).toHaveCount(0);
    await expectAccessible(page, { within: dialog, label: "Match Cards dialog, name conflict on #442" });

    // BSC's value stays preselected: read on the name the row will be saved
    // with, which its Unlink carries.
    await expect(bscPill).toBeChecked();
    await expect(dialog.getByRole("button", { name: `Unlink #442 ${bscName}`, exact: true })).toBeVisible();

    // Pick the other value, by the value it shows.
    await slPill.click();
    await expect(slPill).toBeChecked();
    await expect(dialog.getByRole("button", { name: `Unlink #442 ${slName}`, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Unlink #442 ${bscName}`, exact: true })).toBeHidden();

    // ── STEP 7: save. Nothing is kept: the unpaired cards are dropped and the
    // matched rows, #442 among them, are saved.
    await confirm.click();
    await expect(dialog).toBeHidden();

    // Two legitimate shapes, named by this gate (R2): the review wizard (names
    // the catalogue does not know — a team-leader card's team is also reported
    // as a PLAYER, the TC rule — or only its teams / titles steps), or the
    // direct commit. The wizard opens behind the entity check's live batch.
    const wizard = reviewWizard(page);
    const saved = page.getByText(/Saved [1-9][0-9]* cards?/);
    await expect(wizard.or(saved).first()).toBeVisible({ timeout: WIZARD_OPENS });
    if (await wizard.isVisible()) {
      await expectAccessible(page, { within: wizard, label: "Tidy up this set wizard, 2014 Topps Football" });
      // The names are not this spec's claim: skip every one in one press,
      // lookups included, creating nothing. The batch can still grow after the
      // wizard opens (a Wikidata career history stages teams), leaving one row
      // undecided, so the press repeats until the names-done footer shows.
      const namesDone = wizard
        .getByRole("button", { name: "Next (Enter)", exact: true })
        .or(confirmSaveButton(page));
      const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
      await expect(async () => {
        if (await skipRemaining.isVisible()) await skipRemaining.click();
        await expect(namesDone).toBeVisible({ timeout: 7_000 });
      }).toPass({ timeout: BATCH_GROWS });
      // Teams and titles are not this spec's claim either: every line stays
      // on its default.
      await advanceToSave(page);
      await confirmSaveButton(page).click();
    }
    // Both shapes end here: our own write, the 7 s bar.
    await expect(saved).toBeVisible();

    // ── STEP 8 (b): the saved name is the one the operator picked. Re-enter
    // the set so the checklist mounts fresh from what was stored (Base is
    // mapped now, so the helper takes the Re-map path and writes nothing): a
    // read-back, not an echo of the dialog's draft. The list is virtualised
    // and runs to ~440 rows, so the checklist search reaches the row.
    await drillToBaseVariant(page, env, { ...FOOTBALL_2014, set: "Topps" });
    const search = page.getByRole("searchbox", { name: "Search cards" });
    const oneFound = page.getByText(/^1 of [0-9]+ cards$/);
    // A number term is a PREFIX match, and 442 is the set's last number.
    await search.fill("442");
    await expect(oneFound).toBeVisible();
    await expect(page.getByRole("button", { name: `Edit card 442, ${slName}`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Edit card 442, ${bscName}`, exact: true })).toHaveCount(0);

    // ── STEP 9 (a): the saved #6a is "New England Patriots" and its team is
    // LINKED. "6a" finds #6a and not #16a or #36a (prefix match).
    await search.fill("6a");
    await expect(oneFound).toBeVisible();
    await expect(page.getByRole("button", { name: /^Edit card 6a?, New England Patriots$/ })).toBeVisible();
    // On a team card the row's name cell and its team sub-line read the same.
    // The sub-line lists the card's LINKED teams by full name (then any
    // ` · <part>`); a typed team with no row reads "New England Patriots
    // (unconfirmed)" and an unlinked card leaves the line blank. So, with the
    // list narrowed to this one card, exactly TWO nodes reading the team (the
    // name and a linked sub-line) is the link. The sub-line arrives on its own
    // per-row read, so it is waited for (a Convex read, 7 s).
    await expect(page.getByText(/^New England Patriots( · .+)?$/)).toHaveCount(2);
    await expect(page.getByText(/New England Patriots \(unconfirmed\)/)).toHaveCount(0);
    await expectAccessible(page, { label: "2014 Topps Football Base checklist, searched to #6a" });
  },
);
