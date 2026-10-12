// Origin: .maestro/flows/set-selector/checklist-attention-badge-and-filter.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom } from "../../support/set-builder";
import { addCardViaForm } from "../../support/cards";
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
  // NEO-331: Enter on the create row is dropped while the rows are HELD from an
  // earlier query; "No matches." is the verdict for THIS query, so wait for it.
  await expect(page.getByText("No matches.")).toBeVisible();
  await search.press("Enter");
  const dialog = page.getByRole("dialog", { name: `New team: ${name}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "New team name" })).toHaveValue(name);
  await expectAccessible(page, { within: dialog, label: `New team dialog for ${name}` });
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
      set: `cna-${env.WORKER_INDEX}-${id}`,
      variantType: "Insert",
      variant: "Base",
    });

    // Two cards with no team, one with a team.
    await addCardViaForm(page, { cardNumber: `701-${id}`, playerName: `AttnAlpha${token}` });
    await addCardViaForm(page, { cardNumber: `702-${id}`, playerName: `AttnBravo${token}` });
    await addCardViaForm(page, {
      cardNumber: `703-${id}`,
      playerName: `AttnCharlie${token}`,
      beforeSubmit: async () => {
        await expectAccessible(page, { label: "Add card form" });
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
    await expectAccessible(page, { label: "Checklist with attention badges and count" });

    // Give card 702 a team through its drawer: its badge goes, the count drops.
    await page.getByRole("button", { name: new RegExp(`^Edit card 702-${id}(, .*)?$`) }).click();
    const cardName = page.getByRole("textbox", { name: "Card name", exact: true });
    await expect(cardName).toBeVisible({ timeout: 15_000 });
    await expectAccessible(page, { within: page.getByRole("dialog", { name: /^Card #/ }), label: "Card detail drawer" });
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
    await expect(page.getByText(`AttnBravo${token}`)).toBeHidden();
    await expect(page.getByText(`AttnAlpha${token}`)).toBeVisible();
    await expect(page.getByText(`AttnCharlie${token}`)).toBeHidden();
    await expectAccessible(page, { label: "Checklist filtered to cards needing attention" });
    await page.getByRole("button", { name: "Show only cards needing attention (on)" }).click();
    await expect(page.getByText(`AttnBravo${token}`)).toBeVisible();
  },
);
