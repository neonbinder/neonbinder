// NEO-450 (Jason, 2026-11-10).
//
// R1 - ONE FEATURE: a Set Builder column whose sync failed says so, and only
// so. The column shows "Couldn't sync sets — please try again." (naming its
// column), its idle "No sets available. Sync from marketplaces to populate."
// line is hidden meanwhile (that line reads as an answer from the
// marketplaces when nobody got one), and its `Sync Sets` button is the retry,
// described by that sentence while it stands. The sentence is a polite
// `status` for a failure the server already held, and an `alert` once THIS
// session's own retry has failed. A retry that works removes it and the
// column's real state is back.
//
// THE FAILURE IS FAKED IN THE BROWSER (Jason, 2026-11-10: no product or test
// hook in Convex). support/column-sync-fault.ts sits on the Convex sync
// WebSocket and answers ONE subscription, the Sets column's
// `getSelectorSyncStatus({ level: "setName", parentId: <brand> })`, with the
// error row a failed sync stores; every other frame passes untouched. For the
// failed retry it also rewrites that one forced sync's answer to the result a
// failed sync returns (`failNextRetry`). It ends the fake only when the server
// has answered a later forced sync of the column, so the error going away
// proves the `Sync Sets` press reached the server as a retry of THIS column. The brand's id is read from the set builder's own
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
import { columnSyncFailedMessage } from "../../../components/SetSelector/column-sync-failed";
import {
  ANY_COLUMN_SYNC_FAILED,
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

    const sentence = columnSyncFailedMessage("Sets");
    const empty = page.getByText("No sets available. Sync from marketplaces to populate.", { exact: true });
    const failed = columnSyncError(page, "Sets");
    const stored = page.getByRole("status").filter({ hasText: sentence });
    const fresh = page.getByRole("alert").filter({ hasText: sentence });
    const retry = page.getByRole("button", { name: "Sync Sets", exact: true });

    // Before: an empty column with no failure. The Sync button renders only
    // once the column's status read has landed (NEO-427), so the fake below
    // has a real value to replace.
    await expect(empty).toBeVisible();
    await expect(retry).toBeVisible();
    await expect(failed).toBeHidden();
    await expect(retry).toHaveAccessibleDescription("");

    // The column's sync fails.
    const brandId = new URL(page.url()).searchParams.get("brand") ?? "";
    expect(brandId, "the set builder's address names the picked brand (NEO-224)").not.toBe("");
    fault.failStatus({ level: "setName", parentId: brandId });

    // A failure the server holds: a polite status, not an alert, and the
    // retry button is described by it.
    await expect(stored).toBeVisible();
    await expect(fresh).toHaveCount(0);
    await expect(empty).toBeHidden();
    await expect(retry).toHaveAccessibleDescription(sentence);
    // setup.spec's page-wide "no column failed" check matches this sentence
    // as rendered, and any column's (its Variant Types sync), so it cannot
    // pass on copy it no longer recognises.
    await expect(page.getByText(ANY_COLUMN_SYNC_FAILED)).toHaveCount(1);
    expect(columnSyncFailedMessage("Variant Types")).toMatch(ANY_COLUMN_SYNC_FAILED);
    await expectAccessible(page, { label: "Sets column, stored sync failure" });

    // This session's own retry fails: the same sentence, now an alert.
    fault.failNextRetry();
    await retry.click();
    await expect(fresh).toBeVisible();
    await expect(stored).toHaveCount(0);
    await expect(empty).toBeHidden();
    await expect(retry).toHaveAccessibleDescription(sentence);
    await expectAccessible(page, { label: "Sets column, this session's sync failed" });

    // A retry that works: the error goes and the column's real (empty) state
    // is back, with nothing describing the button any more.
    await retry.click();
    await expect(failed).toHaveCount(0);
    await expect(empty).toBeVisible();
    await expect(retry).toHaveAccessibleDescription("");
    expect(fault.retriesAnswered(), "two forced syncs of the Sets column reached the server").toBe(2);
  },
);
