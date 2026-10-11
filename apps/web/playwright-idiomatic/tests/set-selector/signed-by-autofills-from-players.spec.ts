// Spec: .maestro/flows/set-selector/signed-by-autofills-from-players.yaml
// Signed By auto-fills from the card's players when Autographed flips
// None -> On Card (real Topps Chrome Base card #300; sole writer).
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { drillToBaseVariant, setBuilderReady } from "../../support/set-builder";
import { editCardButton } from "../../support/batch5/custom";

test(
  "Signed By auto-fills from the card's players when Autographed flips None → On Card (real Topps Chrome Base, sole-writer)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const SENTINEL = `SBSENT-${env.ATTEMPT_ID}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToBaseVariant(page, env);
    await expect(page.getByRole("button", { name: "Sync card checklist" })).toHaveText("Refresh");

    await editCardButton(page, "300").click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeVisible();
    await expect(drawer.getByText(/Card #300/)).toBeVisible();

    // Plant a sentinel in Signed By through the features editor.
    const showFeatures = drawer.getByRole("button", { name: "Show features editor" });
    const hideFeatures = drawer.getByRole("button", { name: "Hide features editor" });
    await showFeatures.click();
    await expect(drawer.getByLabel("Card features editor", { exact: true })).toBeVisible();
    const signedBy = drawer.getByRole("textbox", { name: "Value for Signed By" });
    await signedBy.fill(SENTINEL);
    await signedBy.press("Enter");
    await expect(signedBy).toHaveValue(SENTINEL);
    await hideFeatures.click();
    await expect(showFeatures).toBeVisible();

    // Autographed: Sticker on, Sticker off (None), then On Card.
    const sticker = drawer.getByRole("button", { name: /Value for Autographed: Auto \(Sticker\)/ });
    const onCard = drawer.getByRole("button", { name: /Value for Autographed: Auto \(On Card\)/ });
    await sticker.click();
    await sticker.click();
    await onCard.click();

    // Signed By now reads the card's player(s), and the sentinel is gone.
    await showFeatures.click();
    await expect(drawer.getByLabel("Card features editor", { exact: true })).toBeVisible();
    await expect(signedBy).toHaveValue(/Julio/);
    await expect(signedBy).not.toHaveValue(new RegExp(SENTINEL));

    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeHidden();
  },
);
