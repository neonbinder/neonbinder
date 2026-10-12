// Origin: .maestro/flows/set-selector/checklist-missing-team-fixer-hand-added-card.yaml (NEO-330; Maestro suite retired in NEO-341, see git history)
//
// ONE FEATURE (NEO-330, MissingTeamFixer): a card the operator adds by hand,
// linked to a real player and given no team, has no automatic team source, so
// it is badged "no team on this card yet" straight away (a card with no BSC ref
// has nothing to wait for). In the walker's fixer the player's career is
// OFFERED and NOT PICKED when no stint covers the set's year: the whole-career
// fallback is a list to choose from, never an answer (before NEO-330 it arrived
// preselected with focus on Save, and one Enter wrote a whole career onto a
// one-team card). The operator picks the team through the fixer's own
// TeamPicker and saves; the card's row then prints that team and its badge is
// gone.
//
// THE KEYBOARD SAVE IS NOT DRIVEN here: #314 made Ctrl/Cmd+Enter save from
// anywhere in the fixer, and the shortcut's promise to the operator is asserted
// as copy below. The save is the "Save & Next" button, which calls the same
// save() (the key handling itself is unit-tested in MissingTeamFixer.test.tsx).
//
// NOT REACHED HERE: the listing's era chips ("The listing names ..."). They
// need a BSC team hint on the card, which only the background BSC lookup writes
// on a marketplace-linked card; a hand-added card has none. Unit-tested.
//
// R3: checklist-attention-walker-missing-team owns the walker's three answers
// on cards with NO linked player; this spec owns what a LINKED player adds: the
// career fallback offered unpicked, and a pick of an existing catalogue team.
// set-fill-teams-from-teammate-card owns the header's Fill teams button.
//
// FIXTURE: the reference catalogue (GUIDE; apps/web/scripts/reference-seed).
// Checked read-only on PR #314's preview, 2026-10-12: exactly one `players` row
// "George Brett" (Baseball) with ONE stint, Kansas City Royals 1973-1993;
// exactly one Baseball team "Kansas City Royals" (active 1969-present), so the
// career chip's label is the bare name and the picker's option carries its era.
// Neither row is written: the quick-add and the fixer write the CARD only. It
// needs the catalogue loaded; without it "Add George Brett" never appears.
//
// R7/R7a: WRITES go to a per-worker, per-ATTEMPT hand-made set,
// `mtf-<worker>-<attempt>`, under the REAL Baseball > 2024 > Topps
// (SET-REGISTRY.md, prefix `mtf-`). The real sport is load-bearing: the
// quick-add PlayerPicker and the fixer's TeamPicker search the set's sport,
// which is where the catalogue's Baseball rows live, and the real 2024 year is
// what makes "No 2024 team on file" the fallback. Per-attempt because the
// header count and the walker queue are exact. The card is DELETED at the end;
// the set and its rows stand. No marketplace id is attached to any row.
//
// MINTED NAMES are single tokens: the card name `TeamFixer<token>`, the card
// number `851-<attempt>`, the set `mtf-<worker>-<attempt>`. Nothing searchable
// is minted: the player and the team are the catalogue's.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToCustom, setBuilderReady } from "../../support/set-builder";
import { confirmDeleteCardButton, deleteCardButton, editCardButton } from "../../support/cards";

test(
  "Missing-team fixer — a hand-added card offers its player's whole career with nothing picked, and the team the operator picks lands on the card",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const num = `851-${A}`;
    const cardNameText = `TeamFixer${env.ATTEMPT_TOKEN}`;
    const badge = page.getByRole("img", {
      name: new RegExp(`^Card ${num}(, .*)? needs attention: no team on this card yet$`),
    });
    const fixThem = page.getByRole("button", { name: /^Fix cards needing attention one at a time/ });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: drill to the hand-made set's Insert > Base checklist (R9) ──
    await drillToCustom(page, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: `mtf-${env.WORKER_INDEX}-${A}`,
      variantType: "Insert",
      variant: "Base",
    });

    // ── STEP 2: add the card by hand: the catalogue's George Brett, NO team ──
    await page.getByRole("button", { name: "Open add card form" }).click();
    const cardName = page.getByRole("textbox", { name: "Card name", exact: true });
    await expect(cardName).toBeVisible();
    await page.getByRole("textbox", { name: "Card number", exact: true }).fill(num);
    await cardName.fill(cardNameText);

    await page.getByRole("button", { name: "Add a player to the new card" }).click();
    const findPlayer = page.getByRole("textbox", { name: "Find a player for the new card" });
    await findPlayer.fill("George Brett");
    // The catalogue row, picked: "Add <name>". Full match, so another player
    // whose name merely contains "Brett" cannot answer.
    await page.getByRole("option", { name: "Add George Brett", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove player George Brett" })).toBeVisible();
    // Close the player popover before reaching for Submit (focusing a field commits nothing).
    await cardName.click();
    await expect(findPlayer).toBeHidden();

    // The Team row is left EMPTY: that is the card this spec is about.
    await page.getByRole("button", { name: "Submit new card" }).click();
    await expect(cardName).toBeHidden();
    await expect(editCardButton(page, num)).toBeVisible();

    // R2(a): badged at once (no BSC ref, so no automatic source to wait for), and
    // the header counts it.
    await expect(badge).toBeVisible();
    await expect(page.getByText("1 need attention")).toBeVisible();
    await expectAccessible(page, { label: "Checklist with a hand-added card needing a team" });

    // ── STEP 3: open the walker on this card (R2b) ──
    await fixThem.click();
    const walker = page.getByRole("dialog", { name: "Cards Needing Attention" });
    await expect(walker).toBeVisible();
    // The walker is on THIS card (its Skip control names the number), its own
    // counter agrees with the header, and the fixer shows the linked player.
    await expect(walker.getByRole("button", { name: `Skip card ${num} for now` })).toBeVisible();
    await expect(walker.getByText(/1 card needs attention . 0 fixed/)).toBeVisible();
    await expect(walker.getByText("Players: George Brett")).toBeVisible();

    // ── STEP 4: the career is OFFERED, NOTHING is picked (R2c, d) ──
    // The heading renders only once the suggestion query has answered, so it is
    // the gate for the "nothing picked" read.
    await expect(
      walker.getByText(/No 2024 team on file — here.s the whole career\. Pick the one on the card\./),
    ).toBeVisible();
    await expect(walker.getByLabel(/^Kansas City Royals . George Brett played here$/)).toBeVisible();
    // THE CLAIM. This hint renders only while zero teams are chosen; a
    // preselected fallback chip would read "Saves 1 team on this card. ..." instead.
    await expect(walker.getByText("Pick at least one team, or record that this card has none.")).toBeVisible();
    await expect(walker.getByText(/Saves [0-9]+ teams? on this card/)).toBeHidden();
    await expectAccessible(page, { within: walker, label: "Missing-team fixer, career offered and nothing picked" });

    // ── STEP 5: the operator picks the team in the fixer's picker, and saves (R2e, f) ──
    await walker.getByRole("button", { name: "Add team" }).click();
    const search = page.getByRole("textbox", { name: "Search teams" });
    await search.fill("Kansas City Royals");
    // The option names the row with its era (middot and en dash matched loosely).
    await page.getByRole("option", { name: /^Add Kansas City Royals . 1969.present$/ }).click();
    await expect(walker.getByRole("button", { name: "Remove team Kansas City Royals" })).toBeVisible();
    // One team chosen, and the shortcut the operator is told about (Ctrl on
    // Linux CI, Cmd on a Mac).
    await expect(walker.getByText(/Saves 1 team on this card\. (Ctrl|Cmd)\+Enter saves from anywhere\./)).toBeVisible();
    await expectAccessible(page, { within: walker, label: "Missing-team fixer, team picked" });

    // Close the picker's popover (a click outside it), then Save & Next.
    await walker.getByRole("heading").first().click();
    await expect(search).toBeHidden();
    await walker.getByRole("button", { name: /Save & Next/ }).click();

    await expect(walker.getByText("All clear — nothing on this checklist needs attention.")).toBeVisible();
    await expect(walker.getByText(/0 cards need attention . 1 fixed/)).toBeVisible();
    await walker.getByRole("button", { name: "Done (Esc)" }).click();
    await expect(walker).toBeHidden();

    // ── STEP 6: the row shows the team, the badge is gone (R2g) ──
    // The sub-line is a query-rendered read of the stored team ids, not a draft
    // echo; this card's only fact is its team, so the full match is the team's name.
    await expect(page.getByText("Kansas City Royals", { exact: true })).toBeVisible();
    await expect(badge).toBeHidden();
    await expect(fixThem).toBeHidden();
    // A positive after the negatives (a dead page passes every hidden check).
    await expect(editCardButton(page, num)).toBeVisible();

    // ── CLEANUP (R7): delete this attempt's card ──
    await deleteCardButton(page, num).click();
    await confirmDeleteCardButton(page, num).click();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    await expect(page.getByText(cardNameText, { exact: true })).toBeHidden();
  },
);
