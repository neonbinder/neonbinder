// NEO-450 (Jason, 2026-11-10).
//
// R1 - ONE FEATURE: a Set Builder column whose sync failed says so, and only
// so. The column shows "Couldn't sync sets — please try again." (naming its
// column; role `status` here, since the error is one the server holds rather
// than this session's own failed attempt, which would be an `alert`;
// `columnSyncError` matches either), its idle "No sets available. Sync from
// marketplaces to populate." line is hidden meanwhile (that line reads as an
// answer from the marketplaces when nobody got one), and its `Sync Sets`
// button is the retry: once a retry has run, the alert goes and the column's
// real state is back.
//
// THE FAILURE IS FAKED IN THE BROWSER (Jason, 2026-11-10: no product or test
// hook in Convex). support/column-sync-fault.ts sits on the Convex sync
// WebSocket and answers ONE subscription, the Sets column's
// `getSelectorSyncStatus({ level: "setName", parentId: <brand> })`, with the
// error row a failed sync stores; every other frame passes untouched. It ends
// the fake only when the server has answered the column's own forced sync, so
// the alert going away proves the `Sync Sets` press reached the server as a
// retry of THIS column. The brand's id is read from the set builder's own
// address (`?brand=<id>`, NEO-224), the one place the page shows it.
//
// Why the Sets column: it is on the ensure-sync path (`useEnsureSync`, the
// reactive status query), and under a hand-made brand its real sync takes
// the no-marketplace-ids path, which clears the status at once with no
// marketplace round trip, so every wait is the 7 s budget.
//
// R7/R7a - ISOLATION: a private SPORT per attempt, `nsf<token>`, with year
// 2026 and ONE brand `nsfb<token>` under it, all hand-made (no marketplace
// id). A private sport, not `E2E Test Sport <w>`: a brand row there would
// push `Add custom Manufacturers` under the fold for the drillToCustomSet
// flows (SET-REGISTRY.md, "Adding ROWS to a shared column"). Nothing is
// written below the brand; nothing is deleted.
//
// MINTED NAMES are single tokens from env.ATTEMPT_TOKEN (GUIDE, "Minted names").
// R9: the drill goes through drillToCustom.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { faultColumnSyncStatus } from "../../support/column-sync-fault";
import {
  columnHeading,
  columnSelection,
  columnSyncError,
  drillToCustom,
  setBuilderReady,
} from "../../support/set-builder";

test(
  "A Set Builder column whose sync failed shows only its named error, and its Sync button retries it (NEO-450)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    // Before signIn: the route only catches sockets opened after it exists.
    const fault = await faultColumnSyncStatus(page);

    const sport = `nsf${env.ATTEMPT_TOKEN}`;
    const brand = `nsfb${env.ATTEMPT_TOKEN}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustom(page, { sport, year: "2026", manufacturer: brand });
    await expect(columnSelection(page, "Manufacturers", brand)).toBeVisible();
    await expect(columnHeading(page, "Sets")).toBeVisible();

    const empty = page.getByText("No sets available. Sync from marketplaces to populate.", { exact: true });
    const failed = columnSyncError(page, "Sets");
    const retry = page.getByRole("button", { name: "Sync Sets", exact: true });

    // Before: an empty column with no failure. The Sync button renders only
    // once the column's status read has landed (NEO-427), so the fake below
    // has a real value to replace.
    await expect(empty).toBeVisible();
    await expect(retry).toBeVisible();
    await expect(failed).toBeHidden();

    // The column's sync fails.
    const brandId = new URL(page.url()).searchParams.get("brand") ?? "";
    expect(brandId, "the set builder's address names the picked brand (NEO-224)").not.toBe("");
    fault.failStatus({ level: "setName", parentId: brandId });

    await expect(failed).toBeVisible();
    await expect(empty).toBeHidden();
    await expect(retry).toBeVisible();
    await expectAccessible(page, { label: "Sets column, sync failed" });

    // The retry: the alert goes and the column's real (empty) state is back.
    await retry.click();
    await expect(failed).toBeHidden();
    await expect(empty).toBeVisible();
    expect(fault.retriesAnswered(), "one forced sync of the Sets column reached the server").toBe(1);
  },
);
