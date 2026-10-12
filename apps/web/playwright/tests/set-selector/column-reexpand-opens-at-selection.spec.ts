// Origin: .maestro/flows/set-selector/column-reexpand-opens-at-selection.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-276: re-expanding a collapsed column opens its list scrolled to the
// selected row, not to the top. Racing sits far down the Sports list, so
// "Racing in view, Baseball (first) not in view" is the proof. Read-only.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
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

    // Collapse the column, then re-expand it.
    await columnSelection(page, "Sports", "Racing").click();
    await expect(columnSearch(page, "Sports")).toBeVisible();

    const racing = columnOption(page, "Sports", "Racing");
    const baseball = columnOption(page, "Sports", "Baseball");
    if (!env.SL_PAUSED) {
      await expect(page.getByRole("button", { name: "Add custom Sports" })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: "Dismiss Sports notice" })).toBeVisible();
      await expect(columnHeading(page, "Sports")).toBeVisible();
    }
    await expect(racing).toBeInViewport();
    await expect(baseball).not.toBeInViewport();
  },
);
