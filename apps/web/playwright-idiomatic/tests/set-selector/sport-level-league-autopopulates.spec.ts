// Spec: .maestro/flows/set-selector/sport-level-league-autopopulates.yaml
// Only READS Baseball's already-derived snapshot: drilling to the sport opens
// Years with the attributes panel mounted at the sport level, and League
// shows MLB with no set, variant or card checklist ever opened.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { columnHeading, pick, setBuilderReady } from "../../support/set-builder";

test(
  "Write-once feature snapshots — the SPORT-level attributes panel auto-populates League from the sport, with NO card-checklist step",
  { tag: ["@set-selector"] },
  async ({ page, signIn }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await pick(page, "Sports", "Baseball");
    // NEO-38: the panel at the sport level must not break the cascade.
    await expect(columnHeading(page, "Years")).toBeVisible();

    const panel = page.getByRole("region", { name: "Set attributes panel" });
    await expect(panel.getByRole("heading", { name: /Attributes for Baseball.*Sport/ })).toBeVisible();

    // Collapsed by default at the sport level; open it if needed.
    const edit = panel.getByRole("button", { name: "Edit attributes" });
    const hide = panel.getByRole("button", { name: "Hide attributes" });
    await expect(edit.or(hide)).toBeVisible();
    if (await edit.isVisible()) await edit.click();
    await expect(hide).toBeVisible();

    // League is derived from the sport name onto the sport's write-once snapshot.
    await expect(panel.getByLabel("Value for League")).toHaveValue("MLB");
  },
);
