// Origin: .maestro/flows/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.yaml (Maestro suite retired in NEO-341; see git history)
// Sole writer of the 1996 Score Dugout Collection Artists Proofs insert; fresh-only.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { columnOption, columnSearch, drillToSet, pick, setBuilderReady, syncChecklistButton } from "../../support/set-builder";
import { answerStepAsNew } from "../../support/wizard";
import type { Page } from "@playwright/test";

const SERIES_1 = "Dugout Collection Artist's Proofs Series 1";
const SERIES_2 = "Dugout Collection Artist's Proofs Series 2";
const MERGED = "Dugout Collection Artists Proofs";
const FETCH = 120_000;

async function openScoreInserts(page: Page, env: Parameters<typeof drillToSet>[1]) {
  await drillToSet(page, env, { year: "1996", manufacturer: "Score", set: "Score", createManufacturer: true });
  await pick(page, "Variant Types", "Insert", { search: false });
}

test(
  "Inserts — ONE NeonBinder set maps to TWO BSC sets and one SportLots set, and a re-sync keeps NeonBinder's own card name (1996 Score, NEO-137 + NEO-203)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const id = env.ATTEMPT_ID;
    const renamed = `${MERGED} NB211-${id}`;
    const reconcile = page.getByRole("dialog", { name: "Reconcile Inserts" });
    const pairing = page.getByRole("dialog", { name: /Match Cards/ });
    const confirmMatches = page.getByRole("button", { name: "Confirm card matches", disabled: false });
    const wizard = page.getByRole("dialog", { name: "Confirm New Players & Teams" });
    const saveSets = reconcile.getByRole("button", { name: /^Save [0-9]+ sets$/ });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await openScoreInserts(page, env);

    if (env.SL_PAUSED) {
      // Only BSC answers: the two BSC sets stay separate and nothing reconciles.
      await expect(page.getByRole("heading", { name: "Inserts", exact: true })).toBeVisible({ timeout: 240_000 });
      await expect(reconcile).toBeHidden();
      await columnSearch(page, "Inserts").fill("Artist");
      await expect(columnOption(page, "Inserts", SERIES_1)).toBeVisible();
      await expect(columnOption(page, "Inserts", SERIES_2)).toBeVisible();
      await expect(columnOption(page, "Inserts", SERIES_1).getByText("BSC", { exact: true })).toBeVisible();
      await expect(page.getByText("SL", { exact: true })).toBeHidden();
      await expectAccessible(page, { label: "Score inserts, BSC-only (SportLots paused)" });
      return;
    }

    // ── 1. The first sync opens the reconcile: merge the two BSC series into one NB set ──
    await expect(reconcile).toBeVisible({ timeout: 240_000 });
    await expect(reconcile.getByText(/Ready \([0-9]+/)).toBeVisible();
    await expectAccessible(page, { within: reconcile, label: "Reconcile Inserts dialog" });

    await reconcile.getByRole("textbox", { name: "Filter NeonBinder sets" }).fill("Artist");
    await expect(reconcile.getByText(/Ready \(1 of [0-9]+\)/)).toBeVisible();
    await expect(reconcile.getByText(/Pending \([0-9]+/)).toBeVisible();
    const setName = reconcile.getByRole("textbox", { name: `NeonBinder set name for ${SERIES_2}` });
    await expect(setName).toBeVisible();

    await reconcile.getByRole("textbox", { name: "Filter BSC items" }).fill("Artist");
    await expect(reconcile.getByText(/BSC \(1 of [0-9]+\)/)).toBeVisible();
    await reconcile.getByText(SERIES_1, { exact: true }).click();
    await reconcile.getByLabel(`Add ${SERIES_1} to this set, ${SERIES_2}`, { exact: true }).click();
    await expect(reconcile.getByText(/BSC \(0 of [0-9]+\)/)).toBeVisible();

    // Name the merged set (no apostrophe, so no marketplace name is quoted back).
    await setName.fill(MERGED);
    await setName.press("Enter");
    await expect(reconcile.getByRole("textbox", { name: `NeonBinder set name for ${MERGED}` })).toBeVisible();

    await saveSets.click();
    await expect(reconcile).toBeHidden();

    // ── 2. Re-open: one NB set holds both BSC sets ──
    await openScoreInserts(page, env);
    await columnSearch(page, "Inserts").fill("Artist");
    await expect(columnOption(page, "Inserts", MERGED)).toBeVisible();
    await expect(page.getByText(/Artist's Proofs Series [12]/)).toBeHidden();
    await columnOption(page, "Inserts", MERGED).click();

    const multiSource = page.getByRole("heading", { name: "Multi-source sets" });
    await expect(multiSource).toBeVisible();
    await expect(page.getByText(SERIES_1).first()).toBeVisible();
    await expect(page.getByText(SERIES_2).first()).toBeVisible();
    await expect(page.getByText(/PRIMARY/)).toBeHidden();
    await expectAccessible(page, { label: "Multi-source insert set" });

    // ── 3. Fetch the checklist: both BSC sets + SportLots pair into one ──
    await syncChecklistButton(page).click();
    await expect(pairing).toBeVisible({ timeout: FETCH });
    await expect(confirmMatches).toBeVisible({ timeout: FETCH });
    await expect(pairing.getByText(new RegExp(`Match Cards — ${MERGED}`))).toBeVisible();
    await expect(pairing.getByText(/Unlink/).first()).toBeVisible();
    await expect(pairing.getByText(/BSC only/)).toBeHidden();
    await expect(pairing.getByText(/SportLots only/)).toBeHidden();
    await expect(pairing.getByText(/Nothing kept/)).toBeHidden();
    await expect(pairing.getByText(/220 cards will be saved/)).toBeVisible();
    await expectAccessible(page, { within: pairing, label: "Match Cards dialog (two BSC sources + SportLots)" });
    await confirmMatches.click();
    await expect(pairing).toBeHidden({ timeout: 60_000 });

    // ── 4. Entity review: decide one row, back out of the discard, then add the rest ──
    await expect(wizard).toBeVisible({ timeout: FETCH });
    await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: 180_000 });
    await expectAccessible(page, { within: wizard, label: "Confirm New Players & Teams wizard" });
    // NEO-331: a New League step's primary is held until a Level is pressed
    // (none is pre-pressed), so read which kind settled first. "Other" claims
    // nothing (the batch is discarded or bulk-added anyway).
    const anyAddAsNew = wizard.getByRole("button", { name: /^Add as New (Player|Team|League)$/ });
    await expect(anyAddAsNew.first()).toBeVisible({ timeout: 30_000 });
    if (/League/.test((await anyAddAsNew.first().textContent()) ?? "")) {
      await wizard.getByRole("radio", { name: "Other", exact: true }).click();
    }
    await wizard
      .getByRole("button", { name: /^Add as New (Player|Team|League)$/, disabled: false })
      .first()
      .click({ timeout: 30_000 });
    await expect(wizard.getByText(/^1 of [0-9]+ reviewed/)).toBeVisible();
    await wizard.getByRole("button", { name: "Cancel (Esc)" }).click();
    await expect(page.getByText(/Discard 1 decision/)).toBeVisible();
    await expect(page.getByText(/The same names come back the next time you sync this set/)).toBeVisible();
    await expectAccessible(page, {
      within: page.getByRole("dialog", { name: /Discard 1 decision/ }),
      label: "Discard decisions confirm",
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(wizard).toBeVisible();
    await expect(wizard.getByText(/^1 of [0-9]+ reviewed/)).toBeVisible();

    await wizard.getByRole("button", { name: /Add remaining players as new/ }).click();
    // The bulk walk reads "Adding players…" while it runs; deciding a team step
    // in the middle of it would race the bulk's own writes (Convex OCC), and a
    // user watches the walk finish before touching the next step.
    await expect(wizard.getByRole("button", { name: "Adding players…" })).toBeHidden({ timeout: 240_000 });
    const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
    const stepHeading = wizard.getByRole("heading", { name: /^New (Team|League): / });
    for (let i = 0; i < 250; i++) {
      await expect(confirmSave.or(stepHeading)).toBeVisible({ timeout: 240_000 });
      if (await confirmSave.isVisible()) break;
      // R10 loop rule: act on the step, then wait for ITS heading to go before
      // looking for the next one (NEO-331: a league step gets its Level first).
      const step = (await stepHeading.textContent()) ?? "";
      await answerStepAsNew(page);
      await expect(wizard.getByRole("heading", { name: step, exact: true })).toBeHidden();
    }
    await expect(confirmSave).toBeVisible();
    await confirmSave.press("Enter");
    await expect(page.getByText(/Saved 220 cards/)).toBeVisible({ timeout: FETCH });
    await expectAccessible(page, { label: "Saved 1996 Score insert checklist" });

    // ── 5. NeonBinder's own card name survives a re-sync (NEO-203) ──
    await expect(page.getByText("BSC source", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Edit card / }).first().click();
    const cardName = page.getByRole("textbox", { name: "Card name" });
    await expect(cardName).toBeVisible();
    await expectAccessible(page, { label: "Card detail drawer" });
    await cardName.pressSequentially(`NB203-${id}`);
    await cardName.press("Enter");
    await expect(page.getByText(/Saved Card name/)).toBeVisible();
    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
    await expect(page.getByText(new RegExp(`NB203-${id}`)).first()).toBeVisible();

    await syncChecklistButton(page).click();
    await expect(pairing).toBeVisible({ timeout: FETCH });
    await expect(confirmMatches).toBeVisible({ timeout: FETCH });
    await expect(pairing.getByText(/220 cards will be saved/)).toBeVisible();
    await confirmMatches.click();

    const review = page.getByRole("dialog", { name: new RegExp(`Review Changes — ${MERGED}`) });
    await expect(review).toBeVisible();
    await expect(review.getByText(/Content changes \(1\)/)).toBeVisible();
    await expect(review.getByText("Card name", { exact: true }).first()).toBeVisible();
    await expect(review.getByText(new RegExp(`NB203-${id}`)).first()).toBeVisible();
    await expect(review.getByText(/ 0 new .*unchanged/)).toBeVisible();
    await expectAccessible(page, { within: review, label: "Review Changes dialog" });
    await expect(review.getByText(/no longer listed upstream/)).toBeHidden();
    await review.getByRole("button", { name: "Apply selected changes" }).click();
    await expect(page.getByText(/Saved 220 cards/)).toBeVisible({ timeout: FETCH });
    await expect(page.getByText(new RegExp(`NB203-${id}`)).first()).toBeVisible();

    // ── 6. Rename the NB set, re-sync the column: the name check offers suggestions ──
    await page.getByRole("button", { name: `Rename ${MERGED}` }).click();
    const edit = page.getByRole("textbox", { name: `Edit name for ${MERGED}` });
    await edit.fill(renamed);
    await edit.press("Enter");
    await expect(page.getByRole("heading", { name: `Attributes for ${renamed}` })).toBeVisible();

    await page.getByRole("button", { name: "Sync Inserts" }).click();
    await expect(reconcile).toBeVisible({ timeout: 240_000 });
    await reconcile.getByRole("textbox", { name: "Filter NeonBinder sets" }).fill(`NB211-${id}`);
    await expect(reconcile.getByText(/Ready \(1 of [0-9]+\)/)).toBeVisible();
    await expect(reconcile.getByRole("textbox", { name: `NeonBinder set name for ${renamed}` })).toBeVisible();
    await saveSets.click();
    await expect(reconcile).toBeHidden();

    // ── 7. The renamed set keeps its name; upstream spellings are only suggestions ──
    await openScoreInserts(page, env);
    await columnSearch(page, "Inserts").fill("Artist");
    await expect(columnOption(page, "Inserts", renamed)).toBeVisible();
    await expect(page.getByText(/Artist.s Proofs Series [12]/)).toBeHidden();

    await page.getByRole("button", { name: /names? to check — review suggestions/ }).click();
    const nameCheck = page.getByRole("dialog", { name: "Name Check — Inserts" });
    await expect(nameCheck).toBeVisible();
    await expect(nameCheck.getByText(/SportLots calls it "Dugout Collection Artists Proofs"/)).toBeVisible();
    await expect(nameCheck.getByText(/BSC calls it "Dugout Collection Artist.s Proofs Series [12]"/)).toBeVisible();
    await expectAccessible(page, { within: nameCheck, label: "Name Check dialog" });
    const keep = (side: string) =>
      nameCheck.getByRole("button", {
        name: new RegExp(`^Keep mine — keep "${renamed}"; stop suggesting ${side}'s ".*"$`),
      });
    await keep("BSC").click();
    await keep("SportLots").click();
    await expect(nameCheck.getByText("0 to take · 2 to keep")).toBeVisible();
    await nameCheck.getByRole("button", { name: "Apply decisions" }).click();
    await expect(page.getByText("2 declined")).toBeVisible();

    await expect(columnOption(page, "Inserts", renamed)).toBeVisible();
    await columnOption(page, "Inserts", renamed).click();

    // ── 8. Both BSC sources are still attached; detaching one asks first ──
    await expect(multiSource).toBeVisible();
    await expect(page.getByText(/Dugout Collection Artist.s Proofs Series 1/).first()).toBeVisible();
    await expect(page.getByText(/Dugout Collection Artist.s Proofs Series 2/).first()).toBeVisible();
    await page.getByRole("button", { name: /^Remove Dugout Collection Artist.s Proofs Series 1$/ }).click();
    await expect(
      page.getByText(/110 cards were fetched from it; their BSC link will be dropped/),
    ).toBeVisible();
    await expectAccessible(page, { label: "Detach BSC source confirm" });
    await page.getByRole("button", { name: /^Cancel detach Dugout Collection Artist.s Proofs Series 1$/ }).click();
    await expect(page.getByText(/were fetched from it/)).toBeHidden();
    await expect(page.getByText(/Dugout Collection Artist.s Proofs Series 1/).first()).toBeVisible();
    await expect(page.getByText(/Dugout Collection Artist.s Proofs Series 2/).first()).toBeVisible();
  },
);
