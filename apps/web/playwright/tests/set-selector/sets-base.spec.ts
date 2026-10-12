// Origin: .maestro/flows/set-selector/sets-base.yaml (Maestro suite retired in NEO-341; see git history)
// Sole writer of 2024 Topps Heritage's base mapping.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { drillToSet, pick, setBuilderReady, syncChecklistButton } from "../../support/set-builder";

test(
  "BaseSetPicker — confirm SportLots base-set mapping for 2024 Topps Heritage",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToSet(page, env, { set: "Topps Heritage" });
    await pick(page, "Variant Types", "Base", { search: false });

    const picker = page.getByRole("dialog", { name: "Select Base Set" });
    const remap = page.getByRole("button", { name: /Re-map Base/ });
    const confirm = picker.getByRole("button", { name: "Confirm Base Set" });
    const bsc = picker.getByRole("option", { name: /^BSC base candidate: / });
    const sl = picker.getByRole("option", { name: /^SportLots base candidate: / });

    // Either the picker opens (no prior mapping) or the row offers a re-map.
    await expect(picker.or(remap)).toBeVisible();

    if (!env.SL_PAUSED) {
      if (await picker.isVisible()) {
        await expect(picker.getByText(/Choose the SportLots and BSC sets/)).toBeVisible();
        await expect(picker.getByText(/SportLots base/).first()).toBeVisible();
        await expect(picker.getByText(/BSC base/).first()).toBeVisible();
        // The scored options arrive after the live SportLots fetch.
        await expect(picker.getByText("likely match").first()).toBeVisible();
        // Nothing is linked on the operator's behalf: pick a set on each side.
        await bsc.first().click();
        await sl.first().click();
        await confirm.click();
        await expect(picker).toBeHidden();
      } else {
        await expect(remap).toBeVisible();
      }
      await expect(syncChecklistButton(page)).toBeVisible();
      await expect(remap).toBeVisible();
    } else {
      // A BSC-only mapping reads as unmapped under the pause: the picker is open.
      await expect(picker).toBeVisible();
      await expect(picker.getByText(/Choose the SportLots and BSC sets/)).toBeVisible();
      await expect(picker.getByText(/SportLots base/).first()).toBeVisible();
      await expect(picker.getByText(/BSC base/).first()).toBeVisible();
      // "Loading…" becomes "Confirm Base Set" once the BSC round trip lands.
      await expect(confirm).toBeVisible({ timeout: 45_000 });
      await expect(picker.getByText(/^SportLots returned no base set for /)).toBeVisible();
      await expect(bsc.first()).toBeVisible();
      await expect(sl).toHaveCount(0);
      await bsc.first().click();
      await confirm.click();
      await expect(picker).toBeHidden();
      await expect(syncChecklistButton(page)).toBeVisible();
    }
  },
);
