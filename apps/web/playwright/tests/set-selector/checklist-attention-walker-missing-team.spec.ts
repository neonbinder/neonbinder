// Origin: .maestro/flows/set-selector/checklist-attention-walker-missing-team.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-102: the "Fix them one at a time" walker answers a card's missing team,
// one card at a time. SKIP defers (nothing written); NO TEAM is a persisted
// answer; a PICKED TEAM saved with "Save & Next" clears the badge because the
// row changed. Per-worker, per-attempt custom set under the real
// Baseball > 2024 > Topps ancestors (a real sport row is what lets the team
// picker create a team at all).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom } from "../../support/set-builder";
import { addCardViaForm } from "../../support/cards";

test(
  "Attention walker — answering a card's missing team, one card at a time",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const T = env.ATTEMPT_TOKEN;
    const target = {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: `cnw-${env.WORKER_INDEX}-${A}`,
      variantType: "Insert",
      variant: "Base",
    };
    const fixThem = page.getByRole("button", { name: /^Fix cards needing attention one at a time/ });
    const needsTeam = (n: string) =>
      page.getByRole("img", { name: new RegExp(`^Card ${n}-${A}(,.*)? needs attention: no team on this card yet$`) });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, target);

    // Two hand-made cards, each with no team.
    await addCardViaForm(page, { cardNumber: `801-${A}`, playerName: `Walker Alpha ${A}` });
    await addCardViaForm(page, { cardNumber: `802-${A}`, playerName: `Walker Bravo ${A}` });
    await expect(page.getByText("2 need attention")).toBeVisible();
    await expectAccessible(page, { label: "Checklist with two cards needing attention" });

    // Open the walker: it pins the first flagged row, #801.
    await fixThem.click();
    const walker = page.getByRole("dialog", { name: "Cards Needing Attention" });
    await expect(walker).toBeVisible();
    await expect(walker.getByRole("button", { name: `Skip card 801-${A} for now` })).toBeVisible();
    await expect(walker.getByText(/2 cards need attention . 0 fixed/)).toBeVisible();
    await expect(walker.getByText("No players on this card.")).toBeVisible();
    await expect(walker.getByText("Pick at least one team, or record that this card has none.")).toBeVisible();
    await expectAccessible(page, { within: walker, label: "Attention walker, first card" });

    // SKIP defers: the walker moves on to #802 and nothing is recorded.
    await walker.getByRole("button", { name: `Skip card 801-${A} for now` }).click();
    await expect(walker.getByRole("button", { name: `Skip card 802-${A} for now` })).toBeVisible();
    await expect(walker.getByText(/1 card needs attention . 0 fixed/)).toBeVisible();
    await expectAccessible(page, { within: walker, label: "Attention walker, second card" });

    // NO TEAM is an answer, not an abandonment.
    await walker.getByRole("button", { name: "No team on this card" }).click();
    await expect(walker.getByText("All clear — nothing on this checklist needs attention.")).toBeVisible();
    await expect(walker.getByText(/0 cards need attention . 1 fixed/)).toBeVisible();
    await expectAccessible(page, { within: walker, label: "Attention walker, all clear" });
    await walker.getByRole("button", { name: "Done (Esc)" }).click();
    await expect(walker).toBeHidden();

    // #802 lost its badge (answered); #801 (skipped) keeps it.
    await expect(needsTeam("802")).toBeHidden();
    await expect(needsTeam("801")).toBeVisible();
    await expect(page.getByText("1 need attention")).toBeVisible();

    // Reopen: the skipped card comes back first.
    await fixThem.click();
    await expect(walker.getByRole("button", { name: `Skip card 801-${A} for now` })).toBeVisible();
    await expect(walker.getByText(/1 card needs attention . 0 fixed/)).toBeVisible();

    // A TEAM: create one through the picker (a single search token, minted).
    const TEAM = `CNWT${T}`;
    await walker.getByRole("button", { name: "Add team" }).click();
    const search = page.getByRole("textbox", { name: "Search teams" });
    await expect(search).toBeVisible();
    await search.fill(TEAM);
    await expect(page.getByText("No matches.")).toBeVisible();
    await search.press("Enter");
    await expect(page.getByText(`New team: ${TEAM}`)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "New team name" })).toHaveValue(TEAM);
    await expectAccessible(page, {
      within: page.getByRole("dialog", { name: `New team: ${TEAM}` }),
      label: "New team dialog opened from the attention walker",
    });
    await page.getByRole("button", { name: `Create team ${TEAM}` }).click();
    await expect(walker.getByRole("button", { name: `Remove team ${TEAM}` })).toBeVisible();
    await expectAccessible(page, { within: walker, label: "Attention walker, team picked" });

    // Click the walker's title to dismiss the open picker, then Save & Next.
    await walker.getByRole("heading").first().click();
    await expect(search).toBeHidden();
    await walker.getByRole("button", { name: /Save & Next/ }).click();
    await expect(walker.getByText("All clear — nothing on this checklist needs attention.")).toBeVisible();
    await expect(walker.getByText(/0 cards need attention . 1 fixed/)).toBeVisible();
    await walker.getByRole("button", { name: "Done (Esc)" }).click();
    await expect(walker).toBeHidden();

    // Both badges are gone, the CTA is gone, and the team shows on #801's row.
    await expect(needsTeam("801")).toBeHidden();
    await expect(fixThem).toBeHidden();
    await expect(page.getByText(new RegExp(TEAM)).first()).toBeVisible();
    await expectAccessible(page, { label: "Checklist after every card was answered" });

    // A fresh drill: the answers were persisted, not a local toggle.
    await drillToCustom(page, target);
    await expect(page.getByText(`Walker Bravo ${A}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Walker Alpha ${A}`, { exact: true })).toBeVisible();
    await expect(needsTeam("802")).toBeHidden();
    await expect(needsTeam("801")).toBeHidden();
    await expect(fixThem).toBeHidden();
  },
);
