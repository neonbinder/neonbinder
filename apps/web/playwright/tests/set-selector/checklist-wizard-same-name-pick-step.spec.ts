// Origin: .maestro/flows/set-selector/checklist-wizard-same-name-pick-step.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-332: when two players on file share a checklist name, the entity-review
// wizard opens on a PICK step ("Which <name> is this?") instead of offering
// "Add as New Player". "Create new" opens the New Player step, "Back to the
// list" returns with nothing decided, and taking a candidate records a link to
// THAT player.
//
// The ambiguity is made through the product: two Baseball players named
// "Shuya Yamada" (born 1851 and 1852). The name is a REAL two-token checklist
// name, not a minted one (the exception to single-token names; SET-REGISTRY.md
// "Topps Chrome NPB"). Sole owner of that set; READ-ONLY on it: the spec leaves
// through Cancel and Discard. Only the decided number of the counter is ever
// asserted (the total grows while lookups land).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectPlayersLoaded, emptyListAndPickSport } from "../../support/players";
import { fetchChecklistToWizard, reviewWizard, reviewedLine } from "../../support/wizard";

const SET = "Topps Chrome NPB";
const NAME = "Shuya Yamada";

test(
  "Entity review — a checklist name two players on file share asks which one it is, and Create new is a step you can back out of",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/admin/players");
    // The list counter, not the heading: the heading paints before the list query answers.
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // ── FIXTURE: two Baseball players named Shuya Yamada, b. 1851 and b. 1852 ──
    await emptyListAndPickSport(page, "Baseball");
    const newName = page.getByRole("textbox", { name: "New player name" });
    const birthYear = page.getByRole("textbox", { name: /^Birth year \(optional\)/ });
    // A re-run (retry, local re-run) finds a fork already on file: creation is
    // then the demoted "anyway" control and the result reads "already exists".
    // Either outcome is a row on file; the hard proof is the list read below.
    const create = page.getByRole("button", { name: new RegExp(`^Create player ${NAME}( anyway)?$`) });
    const result = page.getByText(new RegExp(`(Added ${NAME}\\.|That player already exists — opened it\\.)`));
    for (const year of ["1851", "1852"]) {
      await page.getByRole("button", { name: "Add player" }).click();
      await expect(page.getByRole("heading", { name: "Add a player" })).toBeVisible();
      await newName.fill(NAME);
      await birthYear.fill(year);
      await create.click();
      await expect(result).toBeVisible();
    }

    // Both forks are on file (a server search, so read back from the database).
    // No count is asserted: other "Yamada" rows may share a token.
    await page.getByRole("textbox", { name: "Filter players" }).fill(NAME);
    const matches = page.getByText(/^[0-9]+ matches$/);
    await expect(matches).toBeVisible();
    await expect(page.getByText(/b\. 1851/).first()).toBeVisible();
    await expect(page.getByText(/b\. 1852/).first()).toBeVisible();

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

    // ── STEP 1: the pick step is presented as the wizard opens. The same-name
    // row arrives ready (no lookup of its own) while every other name is still
    // being looked up, so no walk helper is used: a product that looked the
    // name up first would show "Looking up N more names…" here instead.
    const question = wizard.getByText(`Which ${NAME} is this?`);
    const link1851 = wizard.getByRole("button", { name: `Link to ${NAME}, b. 1851` });
    const link1852 = wizard.getByRole("button", { name: `Link to ${NAME}, b. 1852` });
    await expect(question).toBeVisible();
    await expect(wizard.getByText("We've got 2 on file under that name. Pick the one on this card.")).toBeVisible();
    await expect(link1851).toBeVisible();
    await expect(link1852).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Create new" })).toBeVisible();
    await expect(wizard.getByRole("button", { name: `Skip ${NAME} — not a person` })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, same-name pick step" });

    // ── STEP 2: Create new opens the New Player step, without the list ──
    await wizard.getByRole("button", { name: "Create new" }).click();
    await expect(wizard.getByRole("button", { name: "Add as New Player" })).toBeVisible();
    await expect(wizard.getByRole("button", { name: "Back to the list" })).toBeVisible();
    await expect(wizard.getByRole("heading", { name: `New Player: ${NAME}` })).toBeVisible();
    await expect(question).toBeHidden();
    await expect(link1851).toBeHidden();
    await expect(link1852).toBeHidden();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, New Player step opened from the pick step" });

    // ── STEP 3: Back to the list decides nothing ──
    await wizard.getByRole("button", { name: "Back to the list" }).click();
    await expect(question).toBeVisible();
    await expect(link1851).toBeVisible();
    await expect(link1852).toBeVisible();
    await expect(wizard.getByText("Back at the list. 2 on file.")).toBeVisible();
    await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed/);

    // ── STEP 4: take one, and the read-back says which ──
    await link1852.click();
    await expect(reviewedLine(page)).toHaveText(/^1 of [0-9]+ reviewed/);
    await expect(question).toBeHidden();
    const decided = wizard.getByRole("list", { name: "Decided names" });
    await expect(decided.getByText(`Linked to ${NAME}, b. 1852`)).toBeVisible();
    await expect(wizard.getByRole("button", { name: `Change decision for ${NAME}` })).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, pick recorded" });

    // ── STEP 5: leave without writing anything ──
    await wizard.getByRole("button", { name: "Cancel (Esc)" }).click();
    await expect(page.getByText(/Discard [0-9]+ decisions?/)).toBeVisible();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible();
  },
);
