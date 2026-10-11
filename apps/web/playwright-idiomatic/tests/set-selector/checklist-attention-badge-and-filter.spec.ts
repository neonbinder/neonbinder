// Spec: .maestro/flows/set-selector/checklist-attention-badge-and-filter.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCardViaForm, drillToCustom } from "../../support/batch4/custom-drill";
import type { Page } from "@playwright/test";

/** Raise a brand-new team through the card form's team picker. */
async function addNewTeam(page: Page, name: string) {
  await page.getByRole("button", { name: "Add team" }).click();
  const search = page.getByRole("textbox", { name: "Search teams" });
  await expect(search).toBeVisible();
  await search.fill(name);
  // The picker is keyboard-first: Enter on a name no team has opens "New team".
  // (Its dropdown can sit below the fold of the card form, so no click here.)
  await expect(page.getByRole("button", { name: `New team ${name}` })).toBeVisible();
  await search.press("Enter");
  const dialog = page.getByRole("dialog", { name: `New team: ${name}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "New team name" })).toHaveValue(name);
  await dialog.getByRole("button", { name: `Create team ${name}` }).click();
  await expect(page.getByRole("button", { name: `Remove team ${name}` })).toBeVisible();
}

test(
  "Checklist attention — a card with no team is badged, counted, and filterable",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const id = env.ATTEMPT_ID;
    const token = env.ATTEMPT_TOKEN;
    const badge = (n: string) =>
      page.getByRole("img", { name: new RegExp(`^Card ${n}-${id}(, .*)? needs attention: no team on this card yet$`) });
    const teamB = `CNAB${token}`;
    const teamA = `CNAA${token}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      setName: `cna-${env.WORKER_INDEX}-${id}`,
      variantType: "Insert",
      variant: "Base",
    });

    // Two cards with no team, one with a team.
    await addCardViaForm(page, { cardNumber: `701-${id}`, playerName: `Attn Alpha ${id}` });
    await addCardViaForm(page, { cardNumber: `702-${id}`, playerName: `Attn Bravo ${id}` });
    await addCardViaForm(page, {
      cardNumber: `703-${id}`,
      playerName: `Attn Charlie ${id}`,
      beforeSubmit: async () => {
        await addNewTeam(page, teamB);
        // Leaving the picker closes its search.
        await page.getByRole("textbox", { name: "Card name", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Search teams" })).toBeHidden();
      },
    });
    await expect(page.getByText(teamB).first()).toBeVisible();

    // Only the team-less cards are badged, and the header counts them.
    await expect(badge("703")).toBeHidden();
    await expect(badge("701")).toBeVisible();
    await expect(badge("702")).toBeVisible();
    await expect(page.getByText("2 need attention")).toBeVisible();
    await expect(page.getByText("Fix them one at a time")).toBeVisible();

    // Give card 702 a team through its drawer: its badge goes, the count drops.
    await page.getByRole("button", { name: new RegExp(`^Edit card 702-${id}(, .*)?$`) }).click();
    const cardName = page.getByRole("textbox", { name: "Card name", exact: true });
    await expect(cardName).toBeVisible({ timeout: 15_000 });
    await addNewTeam(page, teamA);
    await expect(page.getByText(/Saved Teams/)).toBeVisible();
    await cardName.click();
    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(badge("702")).toBeHidden();
    await expect(badge("701")).toBeVisible();
    await expect(page.getByText("1 need attention")).toBeVisible();
    await expect(page.getByText(teamA).first()).toBeVisible();

    // The filter keeps only cards that still need attention, and restores the rest.
    await page.getByRole("button", { name: "Show only cards needing attention", exact: true }).click();
    await expect(page.getByText(`Attn Bravo ${id}`)).toBeHidden();
    await expect(page.getByText(`Attn Alpha ${id}`)).toBeVisible();
    await expect(page.getByText(`Attn Charlie ${id}`)).toBeHidden();
    await page.getByRole("button", { name: "Show only cards needing attention (on)" }).click();
    await expect(page.getByText(`Attn Bravo ${id}`)).toBeVisible();
  },
);
