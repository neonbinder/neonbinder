// Port of .maestro/flows/set-selector/drill-restores-from-url.yaml
import { test, expect } from "../../support/fixtures";
import { mrx, type Maestro } from "../../support/maestro";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";

/**
 * Maestro `visible: { id: X, text: T }` — one element whose accessible name
 * matches X AND whose text (value, else placeholder, else aria-label) matches T.
 */
async function waitIdWithText(m: Maestro, id: string, textPattern: string, timeout: number): Promise<void> {
  const re = mrx(textPattern);
  await expect
    .poll(
      async () => {
        const loc = m.id(id).first();
        if (!(await loc.isVisible().catch(() => false))) return null;
        const value = await loc.inputValue().catch(() => "");
        if (value) return value;
        return (await loc.getAttribute("placeholder")) ?? (await loc.getAttribute("aria-label")) ?? "";
      },
      { timeout, message: `id ${id} with text ${textPattern}` },
    )
    .toMatch(re);
}

test(
  "Set Builder drill lives in the URL — Back undoes the last pick, and coming back to the page restores the drill from the address with focus in the deepest open column (NEO-224)",
  { tag: ["@set-selector"] },
  async ({ m, page }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // STEP 1
    await utilDrillTo2024ToppsChrome(m);
    await m.waitVisible(m.id("Sets: Topps Chrome — change"), 7_000);

    // STEP 2 — Maestro `back` (navigate().back()). The driver has no back(); this is page.goBack().
    await page.goBack({ waitUntil: "domcontentloaded" });
    await m.waitVisible(m.id("Search sets"), 7_000);
    await m.waitVisible(m.id("Manufacturers: Topps — change"), 7_000);
    await m.assertNotVisible("Variant Types");

    await m.inputText("Topps Chrome");
    await waitIdWithText(m, "Search sets", "Topps Chrome", 7_000);
    await m.waitVisible(m.below("Topps Chrome", m.id("Search sets")), 7_000);
    await m.pressKey("Enter");
    await m.waitVisible("Variant Types", 7_000);
    await m.waitVisible(m.id("Sets: Topps Chrome — change"), 7_000);

    await m.inputText("Ins");
    await waitIdWithText(m, "Search variant types", "Ins", 7_000);

    // STEP 3
    await m.scrollUntilVisible(m.within(m.id("Admin sections"), "Teams"), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.within(m.id("Admin sections"), "Teams"));
    await m.waitVisible("Team Management", 7_000);
    await m.tapOn("Filter teams");
    await m.inputText("zz");
    await m.waitVisible(m.value("zz"), 7_000);

    // STEP 4
    await page.goBack({ waitUntil: "domcontentloaded" });
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 7_000);
    await m.waitVisible(m.id("Sets: Topps Chrome — change"), 7_000);
    await m.waitVisible("Variant Types", 7_000);

    await waitIdWithText(m, "Search variant types", "Search variant types\\.\\.\\.", 7_000);

    await m.inputText("Base");
    await waitIdWithText(m, "Search variant types", "Base", 7_000);
    await m.waitVisible(m.below("Base", m.id("Search variant types")), 7_000);
    await m.pressKey("Enter");
    await m.scrollUntilVisible(m.id("Variant Types: Base — change"), { direction: "UP", timeout: 7_000 });
  },
);
