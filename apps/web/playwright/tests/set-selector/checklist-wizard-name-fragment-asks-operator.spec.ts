// NEO-463: in the entity-review wizard, a ONE-WORD player name that is the
// first or last word of a fuller-named player in the same sport is never
// offered as a plain "Add as New Player". The step asks: "Just Scorch? We've
// got <fuller name>." Each fuller player is a `Link to <name>` choice, and the
// footer's primary becomes "Add as a one-name player" (the genuine mononym).
//
// The one-word name is REAL. Fort Worth Fire CHL (Hockey, 1995, BSC only)
// carries a card named `Scorch` and the catalogue holds no player of that name,
// so the wizard stages it (16 unknown names, one of them a single word). The
// wizard only opens from a marketplace checklist fetch, so there is no
// hand-made way to reach this step (SET-REGISTRY.md).
//
// The clash is made through the product, in the worker's own custom sport so
// that no real player's name can collide and no enrichment lookup is sent
// (GUIDE "Enrichment fixtures": a custom sport has no Wikidata mapping): the
// fuller player `D<token> Scorch` is added from Player Management, then the
// wizard row is moved from Hockey to that sport with the row's sport control.
//
// READ-ONLY on the set (R7, R7a): it shares Fort Worth Fire CHL with
// checklist-wizard-skip-not-a-person, which is also a reader. Review batches
// are per account (set + user), so the two never see each other's decisions.
// The spec leaves through Cancel -> Discard, which saves no card and mints no
// player, so the set stays first-fetch.
//
// Both answers are driven on the ONE row: the link is recorded and read back,
// then "Change decision" reopens the step and the one-name answer is recorded
// and read back. The server refuses a plain create of a fragment, so "Added as
// new" after "Add as a one-name player" proves the one-name flag arrived.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { addPlayerByHand, expectPlayersLoaded, playersCounter, PLAYERS_MATCHES } from "../../support/players";
import { customSport, drillToCustom, setBuilderReady } from "../../support/set-builder";
import {
  cancelAndDiscard,
  expectStepLeft,
  fetchOneMarketplaceSetChecklistToWizard,
  personSkip,
  readBackDecision,
  readStep,
  reviewWizard,
  stepCounter,
  walkToPlayerRow,
} from "../../support/wizard";
import { escapeRe } from "../../support/cards";

const SET = "Fort Worth Fire CHL";
const ONE_WORD = "Scorch";

test(
  "Entity review — a one-word name that is part of a fuller player's name asks the operator: link the fuller player, or add a one-name player",
  { tag: ["@smoke", "@set-selector"] },
  async ({ page, signIn, env }) => {
    const sport = customSport(env);
    const fuller = `D${env.ATTEMPT_TOKEN} ${ONE_WORD}`;

    // ── FIXTURE: the fuller player, in the worker's own custom sport ──
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    // Makes the sport row if it is missing (idempotent), so Player Management
    // and the wizard's sport list both offer it.
    await drillToCustom(page, { sport });
    await page.goto("/admin/players");
    await expectPlayersLoaded(page, 20_000);
    await addPlayerByHand(page, fuller, sport);

    // ── SETUP: the set's live fetch, the wizard open with nothing decided ──
    await fetchOneMarketplaceSetChecklistToWizard(page, env, { set: SET });
    const wizard = reviewWizard(page);
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);

    // ── STEP 1: walk to the one-word card. Every other name is a SKIP (decided
    // and thrown away with the batch). R2: if the name is not staged, this
    // fails by name instead of passing on some other row. ──
    const scorchSkip = wizard.getByRole("button", { name: `Skip ${ONE_WORD} — not a person`, exact: true });
    for (let i = 0; i < 20; i++) {
      await walkToPlayerRow(page);
      if (await scorchSkip.isVisible()) break;
      const { x } = await readStep(page);
      await personSkip(page).click();
      await expectStepLeft(page, x);
    }
    await expect(scorchSkip, `${ONE_WORD} is not staged on ${SET}: re-measure the set`).toBeVisible();

    // ── STEP 2: move the row to the custom sport, where the fuller player is ──
    await wizard.getByRole("button", { name: "Sport for this name: Hockey" }).click();
    const chooser = wizard.getByRole("listbox", { name: "Choose a sport" });
    await expect(chooser).toBeVisible();
    await chooser.getByRole("option", { name: sport, exact: true }).click();
    await expect(chooser).toBeHidden();
    // The switch re-queues the row's lookup, so the walk may leave and return.
    await walkToPlayerRow(page);
    await expect(scorchSkip).toBeVisible();
    await expect(wizard.getByRole("button", { name: `Sport for this name: ${sport}` })).toBeVisible();

    // ── STEP 3: the question, with the fuller name as a link choice ──
    // Earlier attempts' "D... Scorch" players share the last word, so the
    // sentence may name others (or "and N more"): the choice is the proof.
    const question = wizard.getByRole("group", { name: new RegExp(`^Just ${ONE_WORD}\\?`) });
    const linkFuller = question.getByRole("button", { name: `Link to ${fuller}`, exact: true });
    const oneName = wizard.getByRole("button", { name: "Add as a one-name player", exact: true });
    await expect(question).toBeVisible();
    await expect(linkFuller).toBeVisible();
    await expect(oneName).toBeVisible();
    // The plain create is gone: the fragment is never offered as a new player.
    await expect(wizard.getByRole("button", { name: /^Add as New Player/ })).toHaveCount(0);
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, one-word name that is part of a fuller name" });

    // ── STEP 4: link the fuller player; one decision, and the read-back says who ──
    const { x: step } = await readStep(page);
    await linkFuller.click();
    await expect(stepCounter(page)).toHaveText(new RegExp(`^Step ${step + 1} of [0-9]+$`));
    const decided = await readBackDecision(page, `Linked to ${fuller}`);

    // ── STEP 5: change it; the question is back and the one-name answer is
    // recorded ──
    await decided.getByRole("button", { name: "Change decision" }).click();
    await expect(question).toBeVisible();
    await expect(stepCounter(page)).toHaveText(new RegExp(`^Step ${step} of [0-9]+$`));
    await oneName.click();
    await expect(stepCounter(page)).toHaveText(new RegExp(`^Step ${step + 1} of [0-9]+$`));
    await readBackDecision(page, "Added as new");

    // ── STEP 6: leave without writing anything ──
    await cancelAndDiscard(page);

    // The fuller player is on file, and no bare one-word player was minted in
    // the custom sport by either decision.
    await page.goto("/admin/players");
    await expectPlayersLoaded(page, 20_000);
    await page.getByRole("combobox", { name: "Sport", exact: true }).selectOption({ label: sport });
    await page.getByRole("textbox", { name: "Filter players" }).fill(ONE_WORD);
    await expect(playersCounter(page, PLAYERS_MATCHES)).toBeVisible();
    const row = (name: string) =>
      page.getByRole("main").getByRole("button", { name: new RegExp(`^${escapeRe(name)}\\s*${escapeRe(sport)}`) });
    await expect(row(fuller)).toHaveCount(1);
    await expect(row(ONE_WORD)).toHaveCount(0);
  },
);
