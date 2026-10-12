// Origin: .maestro/flows/set-selector/new-chain-autopopulates-features.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom, customSport } from "../../support/set-builder";

test(
  "Write-once feature snapshots — a freshly-built set chain auto-populates its SetAttributesPanel feature values with NO card-checklist step",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const w = env.WORKER_INDEX;
    const variantType = `WOVT3-${w}`;
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustom(page, {
      sport: customSport(env),
      year: "1975",
      manufacturer: `WOMfr-${w}`,
      set: `WOSet3-${w}`,
      variantType,
    });

    await expect(page.getByText(`Attributes for ${variantType}`)).toBeVisible();
    // The panel's breadcrumb names the chain it was built from.
    await expect(
      page.getByText(`${customSport(env)} › 1975 › WOMfr-${w} › WOSet3-${w} › ${variantType}`, { exact: true }),
    ).toBeVisible();

    // The panel remembers whether it was left open, so open it only if needed.
    const edit = page.getByRole("button", { name: "Edit attributes" });
    const hide = page.getByRole("button", { name: "Hide attributes" });
    await expect(edit.or(hide)).toBeVisible();
    if (await edit.isVisible()) await edit.click();
    await expect(hide).toBeVisible();

    // Written once, at creation, from the chain: no checklist sync happened.
    const era = page.getByRole("combobox", { name: "Value for Era" });
    await expect(era.getByRole("option", { selected: true })).toHaveText(/1970-79/);
    await expect(page.getByRole("textbox", { name: "Value for Card Thickness" })).toHaveValue("20pt");
    await expect(page.getByRole("textbox", { name: "Value for Country of Origin" })).toHaveValue("USA");
    await expectAccessible(page, { label: "Set attributes panel, auto-populated" });
  },
);
