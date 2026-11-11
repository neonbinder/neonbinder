// NEO-464 — R1: a deep link into Collection's Checklists tab, built the way the
// dashboard builds one (`checklistParamsOf` in app/dashboard/real/useRealDashboard.ts:
// `tab=checklists&set=<id>&type=<id>&variant=<id>`), lands on the checklist it
// names, with its heading and its cards. A variant's ids are the catalog's own, so
// the spec reads them the way a collector would: it walks the Checklists cascade
// to the seeded 2024 Topps Chrome Insert > Future Stars and Parallel > Gold Wave
// Refractors, reads the page's own address, and rebuilds the link from its parts
// in `checklistParamsOf`'s order. It then opens that link on a fresh page load,
// where only the URL says where to be.
//
// The `sub` branch (a parallel under an insert: `...&variant=<insert>&sub=<parallel>`)
// is NOT proven here: the seed has no insert with sub-variants (Future Stars holds
// none; the Bowman Red Ink fixture is a sole-writer spec's own write, not baseline),
// and a fixture that needs one must not be invented. Its parsing is covered by the
// unit tests (checklistParams / useRealDashboard); a live proof waits for a seeded
// insert parallel.
//
// R7: read-only. R3: the cascade comes from support/collection.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  collectorCascade,
  drillToCollectorChecklist,
  checklistTitle,
  TOPPS_CHROME_2024,
  TOPPS_CHROME_2024_FUTURE_STARS,
  type CollectorSet,
} from "../../support/collection";
import type { Page } from "@playwright/test";

/** The link the dashboard would build for the checklist the page is showing: the ids off the page's own address, in `checklistParamsOf`'s order. */
function dashboardStyleLink(page: Page): string {
  const here = new URL(page.url()).searchParams;
  const out = new URLSearchParams();
  out.set("tab", "checklists");
  for (const key of ["set", "type", "variant"] as const) {
    const id = here.get(key);
    expect(id, `the Checklists address carries ${key}`).toBeTruthy();
    out.set(key, id!);
  }
  expect(here.get("sub"), "no parallel-under-insert in this checklist").toBeNull();
  return `/collection?${out.toString()}`;
}

test(
  "Collection's Checklists tab opens the insert and the parallel a dashboard-style deep link names",
  { tag: ["@smoke", "@dashboard"] },
  async ({ page, signIn }) => {
    await signIn("/collection?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });

    // --- An insert: 2024 Topps Chrome > Insert > Future Stars -------------------
    await drillToCollectorChecklist(page, TOPPS_CHROME_2024_FUTURE_STARS);
    const insertLink = dashboardStyleLink(page);

    // --- A parallel: 2024 Topps Chrome > Parallel > Gold Wave Refractors --------
    const parallel: CollectorSet = { ...TOPPS_CHROME_2024, checklist: { type: "Parallel", name: "Gold Wave Refractors" } };
    const { cascade, drill } = collectorCascade(page);
    await cascade.getByRole("button", { name: /^Variant Types: .*, change$/ }).click();
    await drill("Variant Types", parallel.checklist!.type, parallel.checklist!.type);
    await cascade
      .getByRole("listbox", { name: parallel.checklist!.type })
      .getByRole("option")
      .filter({ has: page.getByText(parallel.checklist!.name, { exact: true }) })
      .click();
    await expect(page.getByRole("heading", { level: 3, name: checklistTitle(parallel) })).toBeVisible();
    const parallelLink = dashboardStyleLink(page);
    expect(parallelLink).not.toBe(insertLink);

    // --- Each link, opened cold, lands on its own checklist ---------------------
    for (const [link, target] of [
      [insertLink, TOPPS_CHROME_2024_FUTURE_STARS],
      [parallelLink, parallel],
    ] as const) {
      await page.goto(link);
      const title = checklistTitle(target);
      const checklist = page.getByRole("region", { name: title, exact: true });
      await expect(checklist.getByRole("heading", { level: 3, name: title, exact: true })).toBeVisible();
      // The cascade reads the same place: set, then the variant type, then the row.
      const reopened = collectorCascade(page).cascade;
      await expect(reopened.getByRole("button", { name: `Sets: ${target.set}, change` })).toBeVisible();
      await expect(reopened.getByRole("button", { name: `Variant Types: ${target.checklist!.type}, change` })).toBeVisible();
      await expect(reopened.getByRole("button", { name: `${target.checklist!.type}: ${target.checklist!.name}, change` })).toBeVisible();
      // And its cards are dealt out: a row a collector can open.
      await expect(checklist.getByRole("button", { name: /^Details for #/ }).first()).toBeVisible();
    }

    // The parallel's checklist, opened cold from its link, is a screen of its own to check (the loop ended on it).
    await expectAccessible(page, { label: "Collection checklist opened by a dashboard-style deep link, a parallel" });

    // A real move: the link was a step in the history, and Back returns to the insert's own place.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${insertLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    await expect(page.getByRole("heading", { level: 3, name: checklistTitle(TOPPS_CHROME_2024_FUTURE_STARS), exact: true })).toBeVisible();
  },
);
