// Origin: .maestro/flows/set-selector/all-brands-view-lists-every-set.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { columnHeading, columnOption, columnSelection, setBuilderReady, drillToCustom } from "../../support/set-builder";

test(
  "All Brands is a pinned view — every set in the year with its brand, no + Custom, the brand back-filled on pick, and the name refused as a brand",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const w = env.WORKER_INDEX;
    const sport = `xb-sport-${w}`;
    const setA = `xb-a-${w}`;
    const setB = `xb-b-${w}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── The pinned view heads the Manufacturers column and says what it shows ──
    await drillToCustom(page, { sport, year: "2026" });
    const allBrands = columnOption(page, "Manufacturers", "All Brands");
    await expect(allBrands).toBeVisible();
    await expect(allBrands.getByText("Every set in 2026")).toBeVisible();
    await expectAccessible(page, { label: "Manufacturers column with the pinned All Brands view" });

    // ── "All Brands" is refused as a brand name ──
    await page.getByRole("button", { name: "Add custom Manufacturers" }).click();
    await expect(page.getByText("Add Custom Entry")).toBeVisible();
    const value = page.getByPlaceholder("Enter custom value...");
    await value.fill("All Brands");
    await value.press("Enter");
    await expect(page.getByText("All Brands is the view at the top of this column, not a brand.")).toBeVisible();
    await expect(page.getByText("Add Custom Entry")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Create manufacturer/ })).toBeHidden();
    await expectAccessible(page, { label: "Custom manufacturer form refusing All Brands" });
    await page.getByRole("button", { name: "Cancel new manufacturer" }).click();
    await expect(page.getByText("Add Custom Entry")).toBeHidden();
    await expect(page.getByRole("button", { name: "Add custom Manufacturers" })).toBeVisible();

    // ── Two sets under two brands ──
    await drillToCustom(page, { sport, year: "2026", manufacturer: "Topps", set: setA });
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    await drillToCustom(page, { sport, year: "2026", manufacturer: "Panini", set: setB });
    await expect(columnHeading(page, "Variant Types")).toBeVisible();

    // ── The view lists both, each with its brand, and offers no + Custom ──
    await drillToCustom(page, { sport, year: "2026" });
    await columnOption(page, "Manufacturers", "All Brands").click();
    await expect(columnHeading(page, "Sets")).toBeVisible();
    await expect(page.getByText("Pick a brand to add a set")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add custom Sets" })).toBeHidden();

    const rowA = columnOption(page, "Sets", setA);
    const rowB = columnOption(page, "Sets", setB);
    await expect(rowA.getByText("Topps", { exact: true })).toBeVisible();
    await expect(rowB.getByText("Panini", { exact: true })).toBeVisible();
    await expectAccessible(page, { label: "All Brands view listing every set with its brand" });

    // ── Picking a row back-fills its brand ──
    await rowB.click();
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    await expect(columnSelection(page, "Manufacturers", "Panini")).toBeVisible();
    await expect(columnSelection(page, "Sets", setB)).toBeVisible();

    // ── The brand Panini carries a Brand attribute ──
    await drillToCustom(page, { sport, year: "2026", manufacturer: "Panini" });
    await expect(columnHeading(page, "Sets")).toBeVisible();
    const edit = page.getByRole("button", { name: "Edit attributes" });
    const hide = page.getByRole("button", { name: "Hide attributes" });
    await expect(edit.or(hide)).toBeVisible();
    if (await edit.isVisible()) await edit.click();
    await expect(hide).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Value for Brand" })).toHaveValue("Panini");
    await expectAccessible(page, { label: "Brand attributes panel for Panini" });
  },
);
