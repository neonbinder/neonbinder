// Origin: .maestro/flows/set-selector/checklist-renders-rich-fields.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToBaseVariant, setBuilderReady } from "../../support/set-builder";

test(
  "Checklist — card rows render card number, sub-line, attribute badges, and platform badges",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // The seed pre-synced the 2024 Topps Chrome Base checklist.
    await drillToBaseVariant(page, env);

    // A card row's number cell: "#123" on its own (a column's twin notice
    // reads "Anime (SportLots #378117, #378118)", which is not a card row).
    await expect(page.getByText(/^#\d\S*$/).first()).toBeVisible();

    // The BSC platform badge is on marketplace-sourced rows. (The SL badge is
    // deliberately not asserted: the list opens on the SL-less tail.)
    await expect(page.getByText("BSC", { exact: true }).first()).toBeVisible();

    // A rookie badge exists somewhere in the base checklist.
    await expect(page.getByText("RC", { exact: true }).first()).toBeVisible();

    // The populated checklist is a new state: check it, rows and badges included.
    await expectAccessible(page, { label: "Base checklist with rich card rows" });
  },
);
