/**
 * Batch 3 helpers: the entity-review wizard utils the checklist-wizard specs
 * share. Specs: .maestro/flows/set-selector/util-fetch-real-set-checklist-to-wizard.yaml,
 * util-discard-resumed-review-batch.yaml, util-wizard-walk-to-player-row.yaml
 * and util-wizard-walk-to-player-row-creating-teams.yaml.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { FlowEnv } from "../../../playwright/support/env";
import { drillToBaseVariant, syncChecklistButton, type DrillTarget } from "../set-builder";

/** A live marketplace fetch, or a whole batch's lookups (the flows' 120 s / 180 s). */
const FETCH = 120_000;
const LOOKUPS = 180_000;

export function reviewWizard(page: Page): Locator {
  return page.getByRole("dialog", { name: "Confirm New Players & Teams" });
}

/** "<n> of <m> reviewed" progress line of the open wizard. */
export function reviewedLine(page: Page): Locator {
  return reviewWizard(page).getByText(/^[0-9]+ of [0-9]+ reviewed/);
}

/**
 * util-fetch-real-set-checklist-to-wizard.yaml: drill to a real set's Base
 * checklist (Topps Big League by default), fetch it from the marketplaces,
 * confirm the card pairing when both marketplaces answered, and land in the
 * entity-review wizard.
 */
export async function fetchChecklistToWizard(
  page: Page,
  env: FlowEnv,
  target: DrillTarget = {},
): Promise<void> {
  await drillToBaseVariant(page, env, { set: "Topps Big League", ...target });
  await syncChecklistButton(page).click();

  // Reads "Loading…" and refuses (aria-disabled) until every card has arrived.
  const confirmMatches = page.getByRole("button", { name: "Confirm card matches", disabled: false });
  if (!env.SL_PAUSED) {
    await expect(page.getByText(/Match Cards/).first()).toBeVisible({ timeout: FETCH });
    await expect(confirmMatches).toBeVisible({ timeout: FETCH });
    await confirmMatches.click();
  } else {
    // One marketplace answered: the solo path keeps its cards without pairing.
    await expect(page.getByText(/Kept all [0-9]+ cards? from BSC/)).toBeVisible({ timeout: FETCH });
    await expect(page.getByText(/Match Cards/)).toBeHidden();
    await expect(confirmMatches).toBeHidden();
  }
  await expect(reviewWizard(page)).toBeVisible({ timeout: FETCH });
}

/** Cancel out of the wizard and discard its decisions (the flows' ending). */
export async function cancelAndDiscard(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Cancel (Esc)" }).click();
  await expect(page.getByText(/Discard [0-9]+ decisions?/)).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible();
}

/**
 * util-discard-resumed-review-batch.yaml: a batch an earlier flow left behind
 * opens with decisions already on it; throw it away and fetch again so this
 * flow starts at "0 reviewed".
 */
export async function discardResumedReviewBatch(page: Page, env: FlowEnv): Promise<void> {
  await expect(reviewedLine(page)).toBeVisible();
  if (!/^0 of [0-9]+ reviewed/.test((await reviewedLine(page).textContent()) ?? "")) {
    await page.getByRole("button", { name: "Cancel (Esc)" }).click();
    await expect(page.getByText(/Discard [0-9]+ decisions?/)).toBeVisible();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible({ timeout: 30_000 });
    await fetchChecklistToWizard(page, env);
  }
  await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed/);
}

/** The "not a person" skip: its presence means the wizard is on a player row. */
export function personSkip(page: Page): Locator {
  return reviewWizard(page).getByRole("button", { name: /^Skip .* — not a person$/ });
}

/**
 * util-wizard-walk-to-player-row(-creating-teams).yaml: move the wizard past
 * every team/league step to the first player row. `creatingTeams: false`
 * skips each team/league step (a skip creates nothing); `true` adds each as
 * new instead.
 */
export async function walkToPlayerRow(
  page: Page,
  { creatingTeams = false }: { creatingTeams?: boolean } = {},
): Promise<void> {
  const wizard = reviewWizard(page);
  const person = personSkip(page);
  const stepSkip = wizard.getByRole("button", { name: /^Skip .* — (not a team|this team has no league)$/ });
  const addAsNew = wizard.getByRole("button", { name: /^Add as New (Team|League)$/, disabled: false });

  // A pass over the team/league steps; run twice because the lookups of the
  // rows behind them settle only once the earlier steps are decided.
  for (let pass = 0; pass < 2; pass++) {
    await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS });
    for (let i = 0; i < 200; i++) {
      await expect(person.or(stepSkip)).toBeVisible();
      if (await person.isVisible()) break;
      // The step's own skip names it, so its going away means the step moved on.
      const name = (await stepSkip.first().getAttribute("aria-label")) ?? "";
      if (creatingTeams) {
        await addAsNew.click();
      } else {
        await stepSkip.first().click();
      }
      await expect(wizard.getByRole("button", { name, exact: true })).toBeHidden();
    }
    await expect(person).toBeVisible({ timeout: 30_000 });
  }
}
