// Origin: .maestro/flows/set-selector/base-mapping-cancel-recovers.yaml (Maestro suite retired in NEO-341; see git history)
// Cancelling the Base-set picker leaves a message and a working Retry (no
// dead end); Retry reopens the picker with its candidates. Read-only.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { drillToSet, pick, setBuilderReady } from "../../support/set-builder";

test(
  "Base-set picker Cancel recovers — message + working Retry, no dead-end (NEO-71-74)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToSet(page, env, { set: "Topps 206" });
    await pick(page, "Variant Types", "Base", { search: false });

    const picker = page.getByRole("dialog", { name: "Select Base Set" });
    const bsc = picker.getByRole("option", { name: /^BSC base candidate: / });
    const sl = picker.getByRole("option", { name: /^SportLots base candidate: / });

    // Both the first open and the Retry show the candidates (live fetch, 60 s).
    async function expectCandidates() {
      await expect(picker.getByRole("button", { name: "Confirm Base Set" })).toBeVisible({
        timeout: 60_000,
      });
      if (!env.SL_PAUSED) {
        await expect(picker.getByText(/SportLots base/).first()).toBeVisible();
      } else {
        await expect(picker.getByText(/^SportLots returned no base set for /)).toBeVisible();
        await expect(bsc.first()).toBeVisible();
        await expect(sl).toHaveCount(0);
      }
    }

    await expect(picker).toBeVisible();
    await expectCandidates();

    await picker.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText(/Base mapping cancelled/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm Base Set" })).toBeHidden();
    const retry = page.getByRole("button", { name: "Retry" });
    await expect(retry).toBeVisible();

    await retry.click();
    await expect(picker).toBeVisible();
    await expectCandidates();
  },
);
