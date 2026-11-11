// Origin: .maestro/flows/set-selector/checklist-bsc-team-enrichment.yaml (Maestro suite retired in NEO-341; see git history)
// A synced BSC Base card (2024 Topps Chrome #300, Julio Rodriguez) carries its
// real, marketplace-resolved team into the card detail drawer. READ-ONLY on
// the shared, pre-synced checklist: nothing is typed, toggled or picked, so
// closing the drawer leaves it exactly as found.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { bscLookupOutcome } from "../../support/marketplace-wait";
import { drillToBaseVariant, setBuilderReady } from "../../support/set-builder";

test(
  "Checklist — a synced Base card carries its real BSC-resolved team into the card detail drawer (NEO-90, NEO-195)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToBaseVariant(page, env);

    // Card #300 sits at the bottom of the virtualised list; click() scrolls it in.
    await page.getByRole("button", { name: /^Edit card 300(,|$)/ }).click();

    // The drawer is open on the right card.
    const drawer = page.getByRole("dialog");
    const cardName = drawer.getByRole("textbox", { name: "Card name" });
    await expect(cardName).toBeVisible();
    await expect(drawer.getByText(/Card #300/)).toBeVisible();
    await expect(cardName).toHaveValue(/Julio Rodriguez/);

    // The resolved team (a TeamPicker chip). The exact name: if BSC ever
    // returns a different team for this printed card it is a data regression.
    // NEO-489 (Jason, 2026-11-11: a BSC 429 or an open cooldown on a live card is a pass):
    // #300 is the ONE Base card the seed's checklist leaves out, so BSC was asked about it live.
    // Answered: the chip names Seattle Mariners and NO other team. Skipped (a 429 or an open
    // cooldown at the seed): the card waits in the background queue, so the checklist says
    // "Still looking up teams for 1 card." and the card holds no team chip at all. A DIFFERENT
    // team is never accepted in either branch.
    await expect(drawer.getByText("Teams", { exact: true })).toBeVisible();
    const mariners = drawer.getByRole("button", { name: "Remove team Seattle Mariners" });
    const lookingUp = page.getByRole("status").filter({ hasText: "Still looking up teams for 1 card." });
    await expect(mariners.or(lookingUp).first()).toBeVisible();
    const answered = await mariners.isVisible();
    bscLookupOutcome(answered ? "answered" : "cooldown", "2024 Topps Chrome #300");
    await expect(drawer.getByRole("button", { name: /^Remove team / })).toHaveCount(answered ? 1 : 0);
    await expectAccessible(page, { within: drawer, label: "Card detail drawer with resolved team" });

    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
  },
);
