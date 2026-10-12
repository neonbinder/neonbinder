/**
 * Entity-review wizard helpers the checklist-wizard specs share. Origins:
 * .maestro/flows/set-selector/util-fetch-real-set-checklist-to-wizard.yaml,
 * util-discard-resumed-review-batch.yaml, util-wizard-walk-to-player-row.yaml
 * and util-wizard-walk-to-player-row-creating-teams.yaml (Maestro suite
 * retired in NEO-341; see git history).
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./fixtures";
import type { FlowEnv } from "./env";
import { drillToBaseVariant, syncChecklistButton, type DrillTarget } from "./set-builder";

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

  const confirmMatches = page.getByRole("button", { name: "Confirm card matches" });
  if (!env.SL_PAUSED) {
    await expect(page.getByText(/Match Cards/).first()).toBeVisible({ timeout: FETCH });
    // The button reads "Loading…" (aria-disabled) while cards still stream in;
    // wait for the usable one (the flow's "^Confirm$" text).
    const ready = page.getByRole("button", { name: "Confirm card matches", disabled: false });
    await expect(ready).toBeVisible({ timeout: FETCH });
    await ready.click();
  } else {
    // One marketplace answered: the solo path keeps its cards without pairing.
    await expect(page.getByText(/Kept all [0-9]+ cards? from BSC/)).toBeVisible({ timeout: FETCH });
    await expect(page.getByText(/Match Cards/)).toBeHidden();
    await expect(confirmMatches).toBeHidden();
  }
  await expect(reviewWizard(page)).toBeVisible({ timeout: FETCH });
  // The helper's product is this screen, so it checks it (GUIDE "Accessibility checks").
  await expectAccessible(page, { within: reviewWizard(page), label: "entity-review wizard" });
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
  // A fresh batch opens at "0 of N", but its own lookups start settling rows
  // at once, so by the time this is read the count may already have moved:
  // what must hold is that a batch is on screen with nothing expired.
  await expect(reviewedLine(page)).toHaveText(/^[0-9]+ of [1-9][0-9]* reviewed/);
}

/**
 * The decided-names history of the open wizard, opened. The product collapses
 * it once more than five names are decided (a batch's lookups settle dozens of
 * rows on their own), so a row decided a moment ago is in the DOM but hidden.
 * Opening it is the user's own step; the hard assert after it is the proof.
 */
export async function openDecidedList(page: Page): Promise<Locator> {
  const wizard = reviewWizard(page);
  const names = wizard.getByRole("list", { name: "Decided names" });
  const summary = wizard.getByText(/^Decided \([0-9]+\)$/);
  await expect(summary).toBeVisible();
  if (!(await names.isVisible())) await summary.click();
  await expect(names).toBeVisible();
  return names;
}

/** The "not a person" skip: its presence means the wizard is on a player row. */
export function personSkip(page: Page): Locator {
  return reviewWizard(page).getByRole("button", { name: /^Skip .* — not a person$/ });
}

/** The presented New Team / New League step's primary action, in any state (held, enabled). */
export function addAsNewStep(page: Page): Locator {
  return reviewWizard(page).getByRole("button", { name: /^Add as New (Team|League)$/ });
}

/**
 * The presented New Team / New League step's heading ("New League: Pacific
 * League"). Its accessible name is the step's identity: it goes away exactly
 * when the step does.
 */
export function newStepHeading(page: Page): Locator {
  return reviewWizard(page).getByRole("heading", { level: 3, name: /^New (Team|League): / });
}

/**
 * util-wizard-answer-step-as-new.yaml (NEO-331): answer the wizard's
 * presented New Team / New League step as a create, and return once the
 * wizard has moved off it.
 *
 * A league cannot be added without a level and none is pre-pressed (its
 * primary stays aria-disabled until one is), so a league step first gets
 * `level` (default "Other", what the step pre-pressed before NEO-331; a
 * drain claims nothing), checked before the primary is pressed. A team step
 * is one tap. The league's Wikidata lookup is not waited for: the step says
 * "Add it now", and the lookup fills the fields nobody touched when it lands.
 *
 * It ends by waiting for the step's heading to go. Until the decision write
 * returns, the step just answered stays on screen with its primary
 * aria-disabled, so a caller looping on "a primary is visible" would read the
 * OLD step, press a level on it, and leave the next league with none pressed
 * (CI run 38195356897: a 180 s wait on a held "Add as New League").
 */
export async function answerStepAsNew(
  page: Page,
  { level = "Other" }: { level?: "Major" | "Minor" | "College" | "International" | "Independent" | "Other" } = {},
): Promise<void> {
  const wizard = reviewWizard(page);
  const heading = newStepHeading(page);
  await expect(heading).toBeVisible();
  const step = ((await heading.textContent()) ?? "").trim();
  const isLeague = step.startsWith("New League: ");
  const primary = wizard.getByRole("button", {
    name: isLeague ? "Add as New League" : "Add as New Team",
    exact: true,
  });
  if (isLeague) {
    const radio = wizard.getByRole("radio", { name: level, exact: true });
    await radio.click();
    await expect(radio, `Level "${level}" is not pressed on "${step}"`).toBeChecked();
  }
  // No lookup holds the primary: only a missing level (pressed above), a
  // draft error, or a decision write in flight, so it is a UX budget, not a
  // lookup wait.
  await expect(primary, `"${step}": its Add as New is still held`).toBeEnabled();
  await primary.click();
  await expect(
    wizard.getByRole("heading", { level: 3, name: step, exact: true }),
    `"${step}" is still on screen after Add as New`,
  ).toBeHidden();
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
  // A step's skip stays aria-disabled while that row's live lookup is in
  // flight, so only the usable one counts (the lookups' 180 s budget).
  const stepSkip = wizard.getByRole("button", {
    name: /^Skip .* — (not a team|this team has no league)$/,
    disabled: false,
  });

  // A pass over the team/league steps; run twice because the lookups of the
  // rows behind them settle only once the earlier steps are decided.
  for (let pass = 0; pass < 2; pass++) {
    await expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS });
    for (let i = 0; i < 200; i++) {
      await expect(person.or(stepSkip)).toBeVisible({ timeout: LOOKUPS });
      if (await person.isVisible()) break;
      // The step's own skip names it, so its going away means the step moved on.
      const name = (await stepSkip.first().getAttribute("aria-label")) ?? "";
      if (creatingTeams) {
        await answerStepAsNew(page);
      } else {
        await stepSkip.first().click();
      }
      await expect(wizard.getByRole("button", { name, exact: true })).toBeHidden();
    }
    await expect(person).toBeVisible({ timeout: 30_000 });
  }
}
