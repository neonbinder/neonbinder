// Origin: .maestro/flows/set-selector/topps-chrome-marketplace-read.yaml (Maestro suite retired in NEO-341; see git history)
// Read-only: never saves, never edits. Expands the attributes panel only if it
// is collapsed (opening it is a view toggle, not a write).
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { drillToSet, setBuilderReady } from "../../support/set-builder";

test(
  "Topps Chrome — read-only verify marketplace-derived set attributes are present (read-only)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToSet(page, env);

    // The panel remembers whether it was left open: expand only if collapsed.
    const edit = page.getByRole("button", { name: "Edit attributes" });
    const hide = page.getByRole("button", { name: "Hide attributes" });
    await expect(edit.or(hide)).toBeVisible();
    if (await edit.isVisible()) await edit.click();
    await expect(hide).toBeVisible();

    // Breadcrumb scope: the "›" separator shows the ancestry is rendered.
    await expect(page.getByText(/›.*Topps Chrome/).first()).toBeVisible();

    // The League feature is the primary marketplace-derived Baseball feature
    // and renders whether or not a marketplace filled it (SL-pause agnostic).
    await expect(page.getByLabel("Value for League").first()).toBeVisible();

    // Release metadata rows always render at set level.
    await expect(page.getByText(/Total Cards|Block/).first()).toBeVisible();
  },
);
