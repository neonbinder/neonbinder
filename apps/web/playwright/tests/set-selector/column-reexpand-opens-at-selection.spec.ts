// Origin: .maestro/flows/set-selector/column-reexpand-opens-at-selection.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-276: re-expanding a collapsed column opens its list scrolled to the
// selected row, not to the top. Racing sits far down the Sports list, so
// "Racing in view, Baseball (first) not in view" is the proof. Read-only.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnOption,
  columnSearch,
  columnSelection,
  setBuilderReady,
} from "../../support/set-builder";

test(
  "Set Builder cascade — re-expanding a collapsed column opens its list scrolled to the selected row, not to the top (NEO-276)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await columnSearch(page, "Sports").fill("Racing");
    await columnOption(page, "Sports", "Racing").click();
    await expect(columnHeading(page, "Years")).toBeVisible();
    // Wait for Years to hold its rows before collapsing Sports. On a phone the
    // cascade row scrolls sideways, and the freshly revealed Years column
    // re-centres itself once its first rows land (EntityColumn's reveal
    // settle). Re-expanding Sports before that lands means the late scroll
    // carries the row back to Years, and Racing sits off screen to the left
    // however well its list was scrolled. The Years heading is up in the first
    // frame, so only a Years row proves the column has settled.
    await expect(
      page.getByRole("listbox", { name: "Years" }).getByRole("option").first(),
    ).toBeVisible();

    // Collapse the column, then re-expand it.
    await columnSelection(page, "Sports", "Racing").click();
    await expect(columnSearch(page, "Sports")).toBeVisible();

    const racing = columnOption(page, "Sports", "Racing");
    const baseball = columnOption(page, "Sports", "Baseball");
    await expect(columnHeading(page, "Sports")).toBeVisible();
    if (!env.SL_PAUSED) {
      await expect(page.getByRole("button", { name: "Add custom Sports" })).toBeVisible();
    } else {
      // The pause strip adds a wrapped line above the cascade, which pushes the
      // centred row (the list's fold sits past the 629 px viewport) out of
      // view, so a reader dismisses it first. Session-only: nothing is written
      // server-side. The Sports column's own notice is NOT asserted either way:
      // it exists only after some spec forced a Sports sync, which is order.
      await page.getByRole("button", { name: "Dismiss pause notice" }).click();
      await expect(page.getByText("SportLots is on pause.")).toBeHidden();
    }
    await expect(racing).toBeInViewport();
    await expect(baseball).not.toBeInViewport();
    await expectAccessible(page, { label: "Sports column re-expanded at its selection" });
  },
);
