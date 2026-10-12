// Origin: .maestro/flows/set-selector/checklist-wizard-past-era-team-link-commits.yaml (NEO-330; Maestro suite retired in NEO-341, see git history)
//
// ONE FEATURE (NEO-307, re-fixtured in NEO-330): a retro card can show a
// team's PAST. On a 2025 set, a club the reference catalogue holds ONCE, in an
// era that ended long ago, links on its own; a club it holds in SEVERAL past
// eras, none covering 2025, comes to the operator as one team step that offers
// every era by its label, and the era the operator picks is the team the
// commit writes onto that club's cards. Jason, 2026-10-10: the operator's
// past-era link belongs where the catalogue holds several same-name clubs and
// none covers the set's year; a club held once links by itself.
//
// Fixture: Baseball > 2025 > Topps > Topps Welcome to the Club: 3X MVP, 36
// cards, BSC only (approved by Jason 2026-10-11; SET-REGISTRY.md has the row
// and the measurement). Its clubs, per BSC's facets: Philadelphia Athletics on
// #34 and #35 (Foxx), Boston Red Sox on #36 (Foxx), Brooklyn Dodgers on
// #25-#27 (Campanella), current MLB clubs on the rest. MEASURED on PR #314's
// preview: "0 new players + 1 new teams need confirmation"; the combobox's
// empty list held the four Athletics eras plus one close match.
//
// Sole writer of Baseball > 2025 (R7a): it commits, because the link reaches a
// card only at commit. Fresh-only: a re-run finds the checklist committed and
// fails at "No cards in this checklist yet." Re-seed before re-running.
//
// No card surface prints a team's ERA (the sub-line, the drawer's chip and
// Player Management print the full name only), so the card reads prove the
// link reached the cards, and the era options prove which era was offered and
// chosen.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { editCardButton } from "../../support/cards";
import {
  fetchOneMarketplaceSetChecklistToWizard,
  openOneMarketplaceSetBase,
  reviewedLine,
  reviewWizard,
} from "../../support/wizard";

const TARGET = { sport: "Baseball", year: "2025", manufacturer: "Topps", set: "Topps Welcome to the Club: 3X MVP" };
const CLUB = "Philadelphia Athletics";

test(
  "Entity review — a checklist club held in several past eras is linked to the era on the card, and the commit puts it on that club's cards",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── PART 1: fetch the set one-sided ──
    await fetchOneMarketplaceSetChecklistToWizard(page, env, TARGET);
    const wizard = reviewWizard(page);

    // R2(a): the notice names what reached the review: no player, one team. The
    // set's other clubs, Brooklyn Dodgers included, were settled before it.
    await expect(
      page.getByText(/Kept all [0-9]+ cards from BSC.* 0 new players \+ 1 new teams? need confirmation/),
    ).toBeVisible();
    await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed/);

    // ── PART 2: the operator's past-era link ──
    // The batch's one lookup (the team's enrichment) settles before the step is
    // presented. R5 exception above 7 s: Jason approved 20 s on 2026-10-12 as a
    // STOPGAP until this Playwright rewrite (NEO-341). The lookup itself is a
    // recorded fixture hit (NEO-289 recording), so it costs no network;
    // MEASURED in CI run 38209599290 at 11.0 s, ALL of it queue time behind
    // another runner's ~45 Venezuelan player lookups in the deployment-wide
    // lookup pool every runner's wizard flows share FIFO. No readiness signal
    // exists that is not the same settle (the step is presented only once the
    // row settles, and the footer's "still being looked up" is the same wait
    // read the other way), so the step's heading is the positive gate and
    // carries the 20 s. Raising it further is a new decision for Jason, not a
    // tuning knob.
    const step = wizard.getByRole("heading", { level: 3, name: `New Team: ${CLUB}` });
    await expect(step).toBeVisible({ timeout: 20_000 });
    await expect(wizard.getByRole("button", { name: /^Skip .* — not a team$/ })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, past-era team step" });

    // UNTICK the remember-box FIRST, while the combobox is closed. Proven by
    // R2(d)'s decision line, which a ticked box would extend with "· remembered as ...".
    const remember = wizard.getByRole("checkbox", { name: `Remember “${CLUB}” as a name for this team` });
    await remember.uncheck();
    await expect(remember).not.toBeChecked();

    // Empty and focused, the combobox lists the step's near matches (NEO-326):
    // the catalogue's rows of this exact name first. Each option reads the full
    // name, then "same name · <league> · <years>". Four rows of one name, none
    // covering 2025 - R2(c). Picked by LABEL, never by position (NEO-331 ranks a
    // typed search by the set's context).
    await wizard.getByRole("combobox", { name: "Search all teams" }).click();
    const era = (years: RegExp) => page.getByRole("option", { name: new RegExp(`same name . [A-Z]+ . ${years.source}`) });
    await expect(era(/1871.1875/)).toBeVisible();
    await expect(era(/1876.1876/)).toBeVisible();
    await expect(era(/1882.1890/)).toBeVisible();
    await expect(era(/1901.1954/)).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, past-era options offered" });
    await era(/1901.1954/).click();

    // The decision landing moves the wizard off the step: with one row in the
    // batch it goes straight to the all-decided summary. "Linked to existing" is
    // the count line, and the Decided row's text is a FULL match - the link, and
    // no "· remembered as" tail.
    await expect(wizard.getByText(/^All reviewed . save [0-9]+ cards\?/)).toBeVisible();
    await expect(reviewedLine(page)).toHaveText(/^1 of [0-9]+ reviewed/);
    await expect(wizard.getByText("Linked to existing", { exact: true })).toBeVisible();
    await expect(wizard.getByText(`Linked to ${CLUB}`, { exact: true })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, summary" });

    // ── PART 3: commit ──
    await wizard.getByRole("button", { name: /Confirm & Save/ }).click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible();

    // ── PART 4: the cards carry their clubs ──
    // Read on a FRESH load of the set: the page the commit leaves mounted its
    // virtualized list on the first streamed batch, while a fresh mount opens at
    // the LAST row (#34-#36 are the bottom three rows). The re-entry cancels
    // the base picker again (it reopens on every visit while SportLots is unmapped).
    await openOneMarketplaceSetBase(page, env, TARGET);
    await expect(editCardButton(page, "36")).toBeVisible();
    await expect(editCardButton(page, "35")).toBeVisible();
    await expect(editCardButton(page, "34")).toBeVisible();
    // The sub-line is one text node: the resolved teams by full name first, an
    // unresolved one as "<name> (unconfirmed)", so the anchored pattern admits
    // later parts and never " (unconfirmed)". Rows carry no role or name of
    // their own, so a row cannot be addressed as "#34's sub-line": the Athletics
    // sub-line is asserted to appear on EXACTLY the two cards (#34 and #35) BSC
    // gives it, and the Red Sox on the third.
    await expect(page.getByText(new RegExp(`^${CLUB}( · .*)?$`))).toHaveCount(2);
    await expect(page.getByText(/^Boston Red Sox( · .*)?$/).first()).toBeVisible();

    // The automatic past-era link: Campanella's cards (#25-#27) sit above the
    // list's window. One wheel scroll inside the list, as a user would, brings
    // them in; an unresolved club would print "(unconfirmed)" and not match.
    await editCardButton(page, "36").hover();
    await page.mouse.wheel(0, -360);
    await expect(editCardButton(page, "27")).toBeVisible();
    await expect(page.getByText(/^Brooklyn Dodgers( · .*)?$/).first()).toBeVisible();
  },
);
