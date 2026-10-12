// Origin: .maestro/flows/set-selector/base-parallels-build-from-section.yaml (Maestro suite retired in NEO-341; see git history)
// Sole writer of the 2024 Topps Chrome base set's parallels build.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { columnOption, columnSearch, drillToSet, pick, setBuilderReady } from "../../support/set-builder";

test(
  "2024 Topps Chrome Parallel — Build the base set's parallels from Base, stop after one, and the copy's title names its parallel (NEO-321)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    // Live, SportLots contributes 41 parallels; paused, only BSC's count is known to be non-zero.
    const total = env.SL_PAUSED ? "[0-9]+" : "41";

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToSet(page, env);
    await pick(page, "Variant Types", "Parallel", { search: false });

    const build = page.getByRole("button", { name: new RegExp(`^Build ${total} parallels from Base$`) });
    await expect(page.getByText("Parallels of Base")).toBeVisible();
    await build.click();

    // Parallels that already hold cards ask before they are replaced.
    await expect(
      page.getByText(new RegExp(`Replace the cards on [1-9][0-9]* of ${total} parallels with fresh copies of Base.s\\?`)),
    ).toBeVisible();
    await page.getByRole("button", { name: "Replace and build" }).click();

    await page.getByRole("button", { name: "Stop after this one" }).click();
    await expect(
      page.getByRole("heading", { name: new RegExp(`Base parallels — stopped after 1 of ${total}`) }),
    ).toBeVisible();

    // The ledger names the one parallel that was built.
    const built = page.getByText(/^.+ — (Built|Rebuilt) [1-9][0-9]* cards?(, .+)?$/).first();
    await expect(built).toBeVisible();
    const parallel = ((await built.textContent()) ?? "").split(" — ")[0].trim();
    expect(parallel.length).toBeGreaterThan(0);

    // Reopen that parallel; its copy's title names it.
    await drillToSet(page, env);
    await pick(page, "Variant Types", "Parallel", { search: false });
    await columnSearch(page, "Parallels").fill(parallel);
    await columnOption(page, "Parallels", parallel).click();
    await expect(page.getByRole("heading", { name: `Attributes for ${parallel}` })).toBeVisible();

    await page.getByRole("button", { name: /^Edit card .+/ }).last().click();
    await expect(page.getByRole("textbox", { name: "Card title" })).toHaveValue(new RegExp(escapeRegExp(parallel)));
  },
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
