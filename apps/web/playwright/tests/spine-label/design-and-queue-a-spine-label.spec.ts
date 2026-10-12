// Origin: .maestro/flows/spine-label/design-and-queue-a-spine-label.yaml (Maestro suite retired in NEO-341; see git history)
// Page-state only: nothing is saved to Convex. We never press "Print": it
// calls window.print() and blocks the browser; the queued sheet is the
// assertable half of the feature.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Spine Labels — design a label and queue it on the sheet",
  { tag: ["@smoke", "@spine-label"] },
  async ({ page, signIn }) => {
    await signIn("/print/spine-label");
    await expect(page.getByRole("heading", { name: "Spine Labels" }).first()).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    await expectAccessible(page, { label: "Spine Labels designer" });

    // The free-text name is the always-available path (no player needed).
    await page.getByLabel("Name on the label").fill("Ken Griffey Jr.");

    // The contrast readout only resolves once both colours are valid hex.
    await expect(page.getByText(/Contrast .*:1/)).toBeVisible();

    // Typeface: the character note follows the selected font.
    await page.getByRole("radio", { name: "Graduate" }).click();
    await expect(page.getByText("Collegiate slab. Varsity.")).toBeVisible();

    // Ring size: the per-sheet line is composed from it.
    await page.getByRole("group", { name: "Spine width presets" }).getByRole("button", { name: /^3"/ }).click();
    await expect(page.getByText(/2 labels per sheet at 3.{1,2} wide/)).toBeVisible();

    await page.getByRole("button", { name: "Add to sheet" }).click();

    // The queued label's remove button is named from all three choices.
    const remove = page.getByRole("button", {
      name: "Remove Ken Griffey Jr., 3 inch spine in Graduate, from the sheet",
    });
    await expect(remove).toBeVisible();
    await expect(page.getByText(/Sheet \(1 label, 1 page\)/)).toBeVisible();
    await expectAccessible(page, { label: "Spine Labels, label queued" });

    await remove.click();
    await expect(page.getByText(/Sheet \(0 labels, 0 pages\)/)).toBeVisible();

    // The designer cleared itself: with an empty sheet and a blank name the
    // preview falls back to its prompt.
    await expect(page.getByText("Pick a player, or type a name, to see the label.")).toBeVisible();
  },
);
