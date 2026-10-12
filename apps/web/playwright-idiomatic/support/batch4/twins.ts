/**
 * util-attach-pane-sportlots-twin-ids.yaml (NEO-325): open a saved insert
 * row's "Attach more source sets" pane and read which SportLots twin it
 * holds. The twin it holds is excluded from the candidates (so searching its
 * own id finds nothing) while the other twin is offered.
 */
import { expect, type Page } from "@playwright/test";
import type { FlowEnv } from "../env";
import { columnOption, columnSearch, drillToSet } from "../set-builder";

export async function readAttachedTwinId(
  page: Page,
  env: FlowEnv,
  opts: {
    set: string;
    insertQuery: string;
    insertRow: string;
    twin: string;
    attachedId: string;
    otherId: string;
  },
): Promise<void> {
  const { set, insertQuery, insertRow, twin, attachedId, otherId } = opts;
  await drillToSet(page, env, { set });
  await columnOption(page, "Variant Types", "Insert").click();
  await columnSearch(page, "Inserts").fill(insertQuery);
  await columnOption(page, "Inserts", insertRow).click();

  await expect(page.getByText("Multi-source sets")).toBeVisible();
  await page.getByRole("button", { name: "Attach more source sets" }).click();
  const search = page.getByRole("textbox", { name: "Search SportLots sets" });
  await expect(search).toBeVisible();
  const candidates = page.getByRole("region", { name: "SportLots candidates" });
  // The candidate list loads live (the flow's 30 s).
  await expect(candidates.getByText(/^id: [0-9]+$/).first()).toBeVisible({ timeout: 30_000 });

  // The other twin is still on offer; the one this row holds is not.
  await search.fill(otherId);
  await expect(candidates.getByText(`id: ${otherId}`)).toBeVisible();
  await expect(candidates.getByRole("checkbox", { name: `Toggle ${twin}` })).toBeVisible();
  await search.fill(attachedId);
  await expect(candidates.getByText(new RegExp(`No matches for .${attachedId}.\\.`))).toBeVisible();
  await expect(candidates.getByText(`id: ${attachedId}`)).toBeHidden();

  await page.getByRole("button", { name: "Cancel attach sets" }).click();
  await expect(search).toBeHidden();
}
