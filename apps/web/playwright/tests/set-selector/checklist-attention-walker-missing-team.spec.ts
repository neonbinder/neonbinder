// Origin: .maestro/flows/set-selector/checklist-attention-walker-missing-team.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-102: the attention walker answers a card's missing team, one card at a
// time. Since NEO-335 its one door is the checklist header's amber "N need you"
// pill ("1 needs you" for one card) and it wears the wizard's chrome (title
// "Tidy up this set", subtitle = the question, one "Step x of y" counter, no
// "fixed" count); the wizard shares that title, so the walker is told apart by
// its own "Skip for now, card <number>" control. SKIP defers (nothing written); NO TEAM is a persisted
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
    // The header pill: its visible text is its accessible name, so the exact
    // name IS the exact count.
    const pill = (name: string) => page.getByRole("button", { name, exact: true });
    const anyPill = page.getByRole("button", { name: /^[0-9]+ needs? you$/ });
    const skipFor = (n: string) => `Skip for now, card ${n}-${A}`;
    const needsTeam = (n: string) =>
      page.getByRole("img", { name: new RegExp(`^Card ${n}-${A}(,.*)? needs attention: no team on this card yet$`) });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, target);

    // Two hand-made cards, each with no team.
    await addCardViaForm(page, { cardNumber: `801-${A}`, playerName: `WalkerAlpha${T}` });
    await addCardViaForm(page, { cardNumber: `802-${A}`, playerName: `WalkerBravo${T}` });
    await expect(pill("2 need you")).toBeVisible();
    await expectAccessible(page, { label: "Checklist with two cards needing attention" });

    // Open the walker from the pill: it pins the first flagged row, #801, and
    // its counter agrees with the pill (two cards, the first on screen).
    await pill("2 need you").click();
    const walker = page.getByRole("dialog", { name: "Tidy up this set" });
    await expect(walker).toBeVisible();
    await expect(walker.getByRole("button", { name: skipFor("801") })).toBeVisible();
    await expect(walker.getByText("Step 1 of 2", { exact: true })).toBeVisible();
    await expect(walker.getByText("Cards with no team", { exact: true })).toBeVisible();
    await expect(walker.getByText("No players on this card.")).toBeVisible();
    await expect(walker.getByText("Pick at least one team, or record that this card has none.")).toBeVisible();
    await expectAccessible(page, { within: walker, label: "Attention walker, first card" });

    // SKIP defers: the walker moves on to #802. A skip is not a write; that half
    // is proved after the walker closes, where #801 keeps its badge.
    await walker.getByRole("button", { name: skipFor("801") }).click();
    await expect(walker.getByRole("button", { name: skipFor("802") })).toBeVisible();
    await expect(walker.getByText("Step 2 of 2", { exact: true })).toBeVisible();
    await expectAccessible(page, { within: walker, label: "Attention walker, second card" });

    // NO TEAM is an answer, not an abandonment.
    await walker.getByRole("button", { name: "No team on this card" }).click();
    await expect(walker.getByText("All clear — nothing on this checklist needs attention.")).toBeVisible();
    // Nothing is left: the rail is full and y still holds the two cards this
    // sitting saw (y never shrinks).
    await expect(walker.getByText("Step 2 of 2", { exact: true })).toBeVisible();
    await expectAccessible(page, { within: walker, label: "Attention walker, all clear" });
    await walker.getByRole("button", { name: "Done (Esc)" }).click();
    await expect(walker).toBeHidden();

    // #802 lost its badge (answered); #801 (skipped) keeps it.
    await expect(needsTeam("802")).toBeHidden();
    await expect(needsTeam("801")).toBeVisible();
    // Exact name: a stale "2 need you" fails here.
    await expect(pill("1 needs you")).toBeVisible();

    // Reopen: the skipped card comes back first (the skip was session-only), and
    // a fresh sitting counts only what is flagged now.
    await pill("1 needs you").click();
    await expect(walker.getByRole("button", { name: skipFor("801") })).toBeVisible();
    await expect(walker.getByText("Step 1 of 1", { exact: true })).toBeVisible();

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
    await walker.getByRole("heading", { name: "Tidy up this set" }).click();
    await expect(search).toBeHidden();
    await walker.getByRole("button", { name: /Save & Next/ }).click();
    await expect(walker.getByText("All clear — nothing on this checklist needs attention.")).toBeVisible();
    await expect(walker.getByText("Step 1 of 1", { exact: true })).toBeVisible();
    await walker.getByRole("button", { name: "Done (Esc)" }).click();
    await expect(walker).toBeHidden();

    // Both badges are gone, the pill is gone, and the team shows on #801's row.
    await expect(needsTeam("801")).toBeHidden();
    await expect(anyPill).toBeHidden();
    await expect(page.getByText(new RegExp(TEAM)).first()).toBeVisible();
    await expectAccessible(page, { label: "Checklist after every card was answered" });

    // A fresh drill: the answers were persisted, not a local toggle.
    await drillToCustom(page, target);
    await expect(page.getByText(`WalkerBravo${T}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`WalkerAlpha${T}`, { exact: true })).toBeVisible();
    await expect(needsTeam("802")).toBeHidden();
    await expect(needsTeam("801")).toBeHidden();
    await expect(anyPill).toBeHidden();
  },
);
