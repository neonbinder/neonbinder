// Origin: .maestro/flows/set-selector/card-autograph-always-visible-saves.yaml (Maestro suite retired in NEO-341; see git history)
// The Autographed pill group is promoted out of the collapsed features editor:
// it is reachable in the drawer body while "Show features editor" is still the
// collapsed trigger. Per-worker custom set; the card is deleted at the end.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard, confirmDeleteCardButton, deleteCardButton, editCardButton } from "../../support/cards";

test(
  "Card detail — the unified Autographed control is always-visible (promoted out of Show features), not gated behind the features editor",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const card = `778-${env.ATTEMPT_ID}`;
    const player = `AutographPlayer${env.ATTEMPT_TOKEN}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await addCustomCard(page, env, {
      set: `cag-${env.WORKER_INDEX}`,
      variantType: "Insert",
      insertName: "Base",
      cardNumber: card,
      playerName: player,
    });

    await editCardButton(page, card).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeVisible();

    // The features editor stays collapsed (we never open it) ...
    await expect(drawer.getByRole("button", { name: "Show features editor" })).toBeVisible();
    // ... yet the Autographed pill is reachable in the main body.
    await expect(drawer.getByRole("button", { name: /Value for Autographed: Auto \(On Card\)/ })).toBeVisible();
    await expectAccessible(page, { within: drawer, label: "Card detail drawer (features editor collapsed)" });

    // Close and clean up this attempt's card.
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeHidden();
    await deleteCardButton(page, card).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDeleteCardButton(page, card).click();
    await expect(page.getByText(player)).toBeHidden();
  },
);
