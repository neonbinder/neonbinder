// Origin: .maestro/flows/set-selector/move-set-to-another-brand.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-294: re-file a set under another brand of its own year from the
// attributes panel. The current brand is not offered, Cancel moves nothing,
// confirming files the set under the chosen brand (the open column follows
// it), and it works in both directions. Marketplace-free: everything lives
// under a sport this flow owns; a re-run finds the fixture as it left it.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { columnHeading, columnOption, columnSelection, setBuilderReady, drillToCustom } from "../../support/set-builder";

test(
  "A set moves to another brand of its own year from the attributes panel — the current brand is not offered, Cancel moves nothing, and the set arrives under the brand the confirm named",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const sport = `msb-sport-${env.WORKER_INDEX}`;
    const set = `msb-a-${env.WORKER_INDEX}`;
    const breadcrumb = (brand: string) => page.getByText(new RegExp(`2026 › ${brand} › ${set}`)).first();

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── PART 1: the fixture. Panini first and left empty (the destination);
    // then Topps with the set under it. Both drills select what exists and
    // create only what is missing.
    await drillToCustom(page, { sport, year: "2026", manufacturer: "Panini" });
    await expect(columnHeading(page, "Sets")).toBeVisible();
    await drillToCustom(page, { sport, year: "2026", manufacturer: "Topps", set });
    await expect(columnHeading(page, "Variant Types")).toBeVisible();

    // ── PART 2: the list, the confirm, and a Cancel that moves nothing.
    const panel = page.getByRole("region", { name: "Set attributes panel" });
    await expect(page.getByRole("button", { name: `Delete ${set}` })).toBeVisible();
    await expect(panel.getByRole("heading", { name: new RegExp(`Attributes for ${set}`) })).toBeVisible();

    const trigger = page.getByRole("button", { name: "Move to another brand" });
    await trigger.click();
    await expect(page.getByText("Move to which brand?")).toBeVisible();
    const brands = page.getByRole("group", { name: "Brands in 2026" });
    await expect(brands.getByRole("button", { name: "Move to Panini" })).toBeVisible();
    // The set's CURRENT brand is never offered.
    await expect(brands.getByRole("button", { name: "Move to Topps" })).toBeHidden();

    await brands.getByRole("button", { name: "Move to Panini" }).click();
    const confirm = page.getByRole("dialog", { name: `Move "${set}" to Panini?` });
    await expect(confirm).toBeVisible();
    await expect(
      confirm.getByText(
        "The set keeps its cards, its variants and its marketplace links — only the brand above it changes. Sync Sets will leave it where you put it.",
      ),
    ).toBeVisible();

    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    // The list is still open where it was, and the breadcrumb still reads Topps.
    await expect(page.getByText("Move to which brand?")).toBeVisible();
    await expect(breadcrumb("Topps")).toBeVisible();

    // ── PART 3: confirming files it under Panini.
    await brands.getByRole("button", { name: "Move to Panini" }).click();
    await page.getByRole("dialog", { name: `Move "${set}" to Panini?` }).getByRole("button", { name: "Yes, move it" }).click();
    await expect(page.getByText("Moved to Panini")).toBeVisible();
    await expect(breadcrumb("Panini")).toBeVisible();
    // The open column follows the set: Panini is the selected brand, the set still selected.
    await expect(columnSelection(page, "Manufacturers", "Panini")).toBeVisible();
    await expect(columnSelection(page, "Sets", set)).toBeVisible();

    // ── PART 4: really re-parented: listed under Panini, gone from Topps.
    await drillToCustom(page, { sport, year: "2026", manufacturer: "Panini" });
    await expect(columnOption(page, "Sets", set)).toBeVisible();

    await drillToCustom(page, { sport, year: "2026", manufacturer: "Topps" });
    await expect(page.getByRole("button", { name: "Add custom Sets" })).toBeVisible();
    await expect(columnOption(page, "Sets", set)).toBeHidden();

    // ── PART 5: and back again (also leaves the fixture where PART 1 put it).
    await drillToCustom(page, { sport, year: "2026", manufacturer: "Panini", set });
    await expect(columnHeading(page, "Variant Types")).toBeVisible();

    await trigger.click();
    await expect(page.getByText("Move to which brand?")).toBeVisible();
    // Now Panini is left out and Topps is offered.
    await expect(brands.getByRole("button", { name: "Move to Topps" })).toBeVisible();
    await expect(brands.getByRole("button", { name: "Move to Panini" })).toBeHidden();

    await brands.getByRole("button", { name: "Move to Topps" }).click();
    const back = page.getByRole("dialog", { name: `Move "${set}" to Topps?` });
    await expect(back).toBeVisible();
    await back.getByRole("button", { name: "Yes, move it" }).click();
    await expect(page.getByText("Moved to Topps")).toBeVisible();
    await expect(breadcrumb("Topps")).toBeVisible();
  },
);
