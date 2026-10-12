// Origin: .maestro/flows/set-selector/checklist-wizard-same-name-pick-step.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-332: when two players on file share a checklist name, the entity-review
// wizard opens on a PICK step ("Which <name> is this?") instead of offering
// "Add as New Player". "Create new" opens the New Player step, "Back to the
// list" returns with nothing decided, and taking a candidate records a link to
// THAT player.
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
// idempotent (an existing b. 1851 row is adopted). The decided count is read
// relative to K, the walk's skips, and only the decided number is asserted (the
// total grows while lookups land).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectPlayersLoaded, emptyListAndPickSport, PLAYERS_MATCHES, playersCounter } from "../../support/players";
import { fetchChecklistToWizard, reviewWizard, reviewedLine, walkToPlayerRow } from "../../support/wizard";

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

    // ── SETUP: this set's live fetch, the wizard open at "0 reviewed" ──
    await fetchChecklistToWizard(page, env, { set: SET });
    const wizard = reviewWizard(page);
    if (!/^0 of /.test((await reviewedLine(page).textContent()) ?? "")) {
      // A red attempt left its review batch on this set and the fetch resumed
      // it: throw it away and fetch again so this run starts clean.
      await page.getByRole("button", { name: "Cancel (Esc)" }).click();
      await expect(page.getByText(/Discard [0-9]+ decisions?/)).toBeVisible();
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible({ timeout: 30_000 });
      await fetchChecklistToWizard(page, env, { set: SET });
    }
    await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed/);

    // ── STEP 1: the wizard opens on the pick step with nothing decided, while the
    // other names are still being looked up. The same-name row arrives ready (no
    // lookup of its own); this set stages ~20 other names, each behind a live
    // lookup in the deployment's FIFO pool, so the header carries "· N still
    // being looked up" for tens of seconds (Jason, 2026-10-11: keep it). A
    // product that looked the name up first would show "Looking up N more
    // names…" instead. The total is never pinned: it GROWS while lookups land.
    const question = wizard.getByText(`Which ${NAME} is this?`);
    const link1851 = wizard.getByRole("button", { name: `Link to ${NAME}, b. 1851` });
    // The catalogue's man: his label carries what is on file about him but no
    // birth year, so "any Shuya Yamada link that is not a dated one" cannot be
    // the b. 1851 row and pins no catalogue data this spec does not own.
    const linkCatalogue = wizard.getByRole("button", { name: new RegExp(`^Link to ${NAME}, (?!b\\. ).+`) });
    await expect(question).toBeVisible();
    await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed . [0-9]+ still being looked up/);
    await expect(wizard.getByText("We've got 2 on file under that name. Pick the one on this card.")).toBeVisible();
    await expect(link1851).toBeVisible();
    await expect(linkCatalogue).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Create new" })).toBeVisible();
    await expect(wizard.getByRole("button", { name: `Skip ${NAME} — not a person` })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, same-name pick step" });

    // THE WALK, so the pick step holds still for STEPS 2-4: an UNTOUCHED pick
    // step yields to the first settled team or league (NEO-236), and the career
    // teams settle ~14-25 s into the batch. The walk waits the batch out, SKIPS
    // every team/league step, and stops on the first player row: this pick step
    // (rows are inserted in card order and he is card #1). Its skips are K
    // decisions, so every count below is read against K.
    await walkToPlayerRow(page);
    await expect(question).toBeVisible();
    const k = Number(((await reviewedLine(page).textContent()) ?? "").match(/^([0-9]+) of /)?.[1]);
    expect(Number.isInteger(k), "the header shows a decided count").toBe(true);

    // ── STEP 2: Create new opens the New Player step, without the list ──
    await wizard.getByRole("button", { name: "Create new" }).click();
    await expect(wizard.getByRole("button", { name: "Add as New Player" })).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Back to the list" })).toBeVisible();
    await expect(wizard.getByRole("heading", { name: `New Player: ${NAME}` })).toBeVisible();
    await expect(question).toBeHidden();
    await expect(wizard.getByRole("button", { name: new RegExp(`^Link to ${NAME}, `) })).toBeHidden();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, New Player step opened from the pick step" });

    // ── STEP 3: Back to the list decides nothing ──
    await wizard.getByRole("button", { name: "Back to the list" }).click();
    await expect(question).toBeVisible();
    await expect(link1851).toBeVisible();
    await expect(linkCatalogue).toBeVisible();
    await expect(wizard.getByText("Back at the list. 2 on file.")).toBeVisible();
    // Nothing was recorded: still K decided (Create new started this row's own
    // lookup, so the header may carry a tail).
    await expect(reviewedLine(page)).toHaveText(new RegExp(`^${k} of [0-9]+ reviewed`));

    // ── STEP 4: take one, and the read-back says which ──
    await link1851.click();
    // Exactly one decision: the link.
    await expect(reviewedLine(page)).toHaveText(new RegExp(`^${k + 1} of [0-9]+ reviewed`));
    await expect(question).toBeHidden();
    // The read-back names WHICH man. Not the Decided list (it folds past five and
    // the walk's skips usually put it there): the link moved the walk on, and the
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
