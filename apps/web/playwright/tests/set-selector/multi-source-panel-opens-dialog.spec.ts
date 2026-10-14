// Origin: .maestro/flows/set-selector/multi-source-panel-opens-dialog.yaml (Maestro suite retired in NEO-341; see git history)
// The Multi-source sets panel on a mapped Base variant: "Attach more" opens
// the picker dialog, a BSC search lists matches, SportLots lists candidates
// (or is empty while paused), and Cancel closes it again. Read-only.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToBaseVariant, setBuilderReady } from "../../support/set-builder";

test(
  "Multi-source sets panel — Attach more dialog opens and cancels",
  { tag: ["@set-selector", "@neo-6"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToBaseVariant(page, env);

    const panelHeading = page.getByRole("heading", { name: "Multi-source sets" });
    await expect(panelHeading).toBeVisible();
    await page.getByRole("button", { name: "Attach more source sets" }).click();

    const dialog = page.getByRole("dialog", { name: "Attach more source sets" });
    const search = dialog.getByRole("textbox", { name: "Search BSC sets" });
    await expect(search).toBeVisible();
    await search.fill("Chrome");
    await expect(dialog.getByRole("region", { name: "BSC candidates" }).getByText(/Chrome/).first()).toBeVisible();

    const sportLots = dialog.getByRole("region", { name: "SportLots candidates" });
    if (!env.SL_PAUSED) {
      // Live SportLots catalogue (the flow's 30 s).
      await expect(sportLots.getByText(/id: [0-9]+/).first()).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(sportLots).toBeVisible();
    }
    await expectAccessible(page, { within: dialog, label: "Attach more source sets dialog" });

    await dialog.getByRole("button", { name: "Cancel attach sets" }).click();
    await expect(dialog).toBeHidden();
    await expect(panelHeading).toBeVisible();
  },
);
