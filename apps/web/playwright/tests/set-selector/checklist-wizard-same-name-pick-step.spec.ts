// Origin: .maestro/flows/set-selector/checklist-wizard-same-name-pick-step.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-332: when two players on file share a checklist name, the entity-review
// wizard opens on a PICK step ("Which <name> is this?") instead of offering
// "Add as New Player". "Create new" opens the New Player step, "Back to the
// list" returns with nothing decided, and taking a candidate records a link to
// THAT player. Untouched, the step HOLDS its place while the rest of the
// batch settles (NEO-339): no team or league settling elsewhere takes it away.
//
// The ambiguity is made through the product. The NEO-330 reference catalogue (a
// prod snapshot) already holds a "Shuya Yamada" (Hanshin Tigers from 2026, no
// birth year); the spec adds a second Baseball "Shuya Yamada" born 1851 (the
// form's floor is 1850). Two on file, so the name is ambiguous. ONE row of our
// own, not two: on a catalogue preview the server refuses a second fork
// (`adoptOrForkOnCreate` forks past ONE undated rival but not past several;
// CI run 38197074499). The b. 1851 row has no stint, so card-year narrowing
// never filters him out; the catalogue row survives the +-2-year tolerance and
// his stint starts after 2024, so the card's team cannot pick him outright. If
// a catalogue refresh moves that stint or drops the row, STEP 1 fails by name
// (no pick step): re-measure, do not hedge.
//
// The name is a REAL two-token checklist name, not a minted one (the exception
// to single-token names; SET-REGISTRY.md "Topps Chrome NPB"). Sole owner of that
// set; READ-ONLY on it: the spec leaves through Cancel and Discard. Re-runs are
// idempotent (an existing b. 1851 row is adopted). Nothing is walked, so the
// counts are absolute: "Step 1" (nothing decided) before the link and "Step 2"
// after it. Only the counter's x is asserted (on a name step x is the decided
// count plus one; y grows while lookups land).
// NEO-335: the header's one counter is "Step x of y" (it was "N of M reviewed").
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectPlayersLoaded, emptyListAndPickSport, PLAYERS_MATCHES, playersCounter } from "../../support/players";
import { fetchChecklistToWizard, reviewWizard, stepCounter } from "../../support/wizard";

const SET = "Topps Chrome NPB";
const NAME = "Shuya Yamada";

test(
  "Entity review — a checklist name two players on file share asks which one it is, and Create new is a step you can back out of",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/admin/players");
    // The list counter, not the heading: the heading paints before the list query answers.
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // ── FIXTURE: a second Baseball Shuya Yamada, b. 1851, beside the catalogue's ──
    await emptyListAndPickSport(page, "Baseball");
    const newName = page.getByRole("textbox", { name: "New player name" });
    const birthYear = page.getByRole("spinbutton", { name: /^Birth year \(optional\)/ });
    // With the catalogue's row on file creation is the demoted "anyway" control;
    // without it (no catalogue) the plain one. A re-run adopts the b. 1851 row
    // ("already exists"). A REFUSAL renders neither result line, so this fails by
    // name if the server will not file him.
    const create = page.getByRole("button", { name: new RegExp(`^Create player ${NAME}( anyway)?$`) });
    const result = page.getByText(new RegExp(`(Added ${NAME}\\.|That player already exists — opened it\\.)`));
    await page.getByRole("button", { name: "Add player" }).click();
    await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
    await newName.fill(NAME);
    await birthYear.fill("1851");
    await create.click();
    await expect(result).toBeVisible();

    // The b. 1851 row is on file (a server search, so read back from the
    // database). No count is asserted: the search matches ANY token, so other
    // Baseball "Yamada"s may fill the page ("10+ matches"); rows matching both
    // tokens rank first. That the name is AMBIGUOUS is proved by the wizard's own
    // intro in STEP 1.
    await page.getByRole("textbox", { name: "Filter players" }).fill(NAME);
    await expect(playersCounter(page, PLAYERS_MATCHES)).toBeVisible();
    await expect(page.getByText(/b\. 1851/).first()).toBeVisible();

    // ── SETUP: this set's live fetch, the wizard open at "Step 1" (nothing decided) ──
    await fetchChecklistToWizard(page, env, { set: SET });
    const wizard = reviewWizard(page);
    await expect(stepCounter(page)).toBeVisible();
    if (!/^Step 1 of /.test((await stepCounter(page).textContent()) ?? "")) {
      // A red attempt left its review batch on this set and the fetch resumed
      // it: throw it away and fetch again so this run starts clean.
      await page.getByRole("button", { name: "Cancel (Esc)" }).click();
      await expect(page.getByText(/Discard [0-9]+ decisions?/)).toBeVisible();
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible({ timeout: 30_000 });
      await fetchChecklistToWizard(page, env, { set: SET });
    }
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);

    // ── STEP 1: the wizard opens on the pick step with nothing decided, while the
    // other names are still being looked up. The same-name row arrives ready (no
    // lookup of its own); this set stages ~20 other names, each behind a live
    // lookup in the deployment's FIFO pool, which keeps the batch pending for
    // tens of seconds. NEO-335 dropped the header's "· N still being looked up"
    // tail, so "still looked up" rests on the timing: this is the FIRST read after
    // the wizard opens, and a product that looked the name up first would show
    // "Looking up N more names…" instead of the pick step. y is never pinned: it
    // GROWS while lookups land.
    const question = wizard.getByText(`Which ${NAME} is this?`);
    const link1851 = wizard.getByRole("button", { name: `Link to ${NAME}, b. 1851` });
    // The catalogue's man: his label carries what is on file about him but no
    // birth year, so "any Shuya Yamada link that is not a dated one" cannot be
    // the b. 1851 row and pins no catalogue data this spec does not own.
    const linkCatalogue = wizard.getByRole("button", { name: new RegExp(`^Link to ${NAME}, (?!b\\. ).+`) });
    await expect(question).toBeVisible();
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);
    // NEO-335: the pick step is its own screen type in the header.
    await expect(wizard.getByText("Which player is this?", { exact: true })).toBeVisible();
    await expect(wizard.getByText("We've got 2 on file under that name. Pick the one on this card.")).toBeVisible();
    await expect(link1851).toBeVisible();
    await expect(linkCatalogue).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Create new" })).toBeVisible();
    await expect(wizard.getByRole("button", { name: `Skip ${NAME} — not a person` })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, same-name pick step" });

    // ── R2(b2), NEO-339: THE BATCH SETTLES AND THE PICK STEP IS STILL HERE ──
    // No walk: since NEO-339 a pick step holds its place, touched or not, so
    // STEPS 2-3 need nothing drained (walkToPlayerRow now SKIPS a held pick
    // step, so it is not for this spec). The batch's lookups are still waited
    // out, for two reasons: the step must still be on screen once everything
    // has settled (the claim bites because this batch stages career teams and
    // a league, measured 2026-10-11), and STEP 4's read-back needs a settled
    // row for the link to hand control to, whose footer carries "Back to
    // previous decision". Marketplace-class wait (R5): one live Wikidata
    // round trip per unknown name (20 NPB players, then the career teams they
    // stage), the 180 s ceiling the wizard helpers give it.
    await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: 180_000 });
    // Still the untouched pick step, and still nothing decided (the negative
    // above is paired with these positives).
    await expect(question).toBeVisible();
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, pick step held after the batch settled" });
    const step = 1;

    // ── STEP 2: Create new opens the New Player step, without the list ──
    await wizard.getByRole("button", { name: "Create new" }).click();
    await expect(wizard.getByRole("button", { name: "Add as New Player" })).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Back to the list" })).toBeVisible();
    await expect(wizard.getByRole("heading", { name: `New Player: ${NAME}` })).toBeVisible();
    // ...and the header says which screen type this is now: a New Player step.
    await expect(wizard.getByText("New player", { exact: true })).toBeVisible();
    await expect(question).toBeHidden();
    await expect(wizard.getByRole("button", { name: new RegExp(`^Link to ${NAME}, `) })).toBeHidden();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, New Player step opened from the pick step" });

    // ── STEP 3: Back to the list decides nothing ──
    await wizard.getByRole("button", { name: "Back to the list" }).click();
    await expect(question).toBeVisible();
    await expect(link1851).toBeVisible();
    await expect(linkCatalogue).toBeVisible();
    await expect(wizard.getByText("Back at the list. 2 on file.")).toBeVisible();
    // Nothing was recorded: still "Step 1" (Create new started this row's own lookup).
    await expect(stepCounter(page)).toHaveText(new RegExp(`^Step ${step} of [0-9]+$`));

    // ── STEP 4: take one, and the read-back says which ──
    await link1851.click();
    // Exactly one decision: the link.
    await expect(stepCounter(page)).toHaveText(new RegExp(`^Step ${step + 1} of [0-9]+$`));
    await expect(question).toBeHidden();
    // The read-back names WHICH man. Not the Decided list (it folds past five
    // once the batch settles rows): the link handed control back to the walk,
    // which presents the next settled row (leagues -> teams -> players), and the
    // footer's "Back to previous decision" reopens this row read-only, in a panel
    // named for the row. Neither a create, a skip nor a link to the catalogue's
    // undated Shuya Yamada can produce this text.
    await wizard.getByRole("button", { name: "Back to previous decision" }).click();
    await expect(
      wizard.getByRole("group", { name: `Decision for ${NAME}` }).getByText(`Linked to ${NAME}, b. 1851`),
    ).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, pick recorded" });

    // ── STEP 5: leave without writing anything ──
    await wizard.getByRole("button", { name: "Cancel (Esc)" }).click();
    await expect(page.getByText(/Discard [0-9]+ decisions?/)).toBeVisible();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible();
  },
);
