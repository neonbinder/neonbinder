// NEO-350 (R1): /print/spine-label opens with the designer prefilled from
// ?name=&bg=&fg=&font= and nothing queued on the sheet; an invalid value
// falls back to that field's default. Page-state only: nothing is saved.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Spine Labels: prefilled from the link, invalid values fall back to the defaults",
  { tag: ["@smoke", "@spine-label"] },
  async ({ page, signIn }) => {
    const field = (label: string) => page.getByLabel(label, { exact: true });
    const sheetEmpty = page.getByText(/Sheet \(0 labels, 0 pages\)/);

    // A nested "&" is written %26 in the sign-in redirect.
    await signIn("/print/spine-label?name=All%20Reggie%20White%26bg=203731%26fg=FFB612%26font=teko");
    await expect(page.getByRole("heading", { name: "Spine Labels" }).first()).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    await expect(field("Name on the label")).toHaveValue("All Reggie White");
    await expect(field("Background")).toHaveValue("#203731");
    await expect(field("Lettering")).toHaveValue("#ffb612");
    await expect(page.getByRole("radio", { name: "Teko" })).toBeChecked();
    await expect(page.getByText(/Contrast 7\.2:1/)).toBeVisible();
    await expect(sheetEmpty).toBeVisible();
    await expectAccessible(page, { label: "Spine Labels, prefilled from a link" });

    // An invalid colour is dropped without a word; the valid name still lands.
    await page.goto("/print/spine-label?name=Red%20Wings&bg=red&fg=FFFFFF");
    await expect(field("Name on the label")).toHaveValue("Red Wings");
    await expect(field("Background")).toHaveValue("#101820");
    await expect(field("Lettering")).toHaveValue("#ffffff");
    await expect(page.getByRole("radio", { name: "Anton" })).toBeChecked();
    await expect(sheetEmpty).toBeVisible();

    // A prefilled pair under 3:1 raises the reworded low-contrast hint.
    await page.goto("/print/spine-label?name=Yellow%20PC&bg=FFFF00&fg=FFFFFF");
    await expect(field("Background")).toHaveValue("#ffff00");
    await expect(page.getByText(/Try a lighter or darker lettering color/)).toBeVisible();
    // No axe scan here: the preview shows the colours the user picked, exactly
    // as they will print, so color-contrast would flag the user's own choice.
    // The page warns them (above); the page itself was scanned at the top.
  },
);
