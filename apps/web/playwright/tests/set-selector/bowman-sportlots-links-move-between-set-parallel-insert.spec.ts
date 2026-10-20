// Origin: .maestro/flows/set-selector/bowman-sportlots-links-move-between-set-parallel-insert.yaml (Maestro suite retired in NEO-341; see git history)
// 2026 Bowman: Blue pairs both marketplace links; Promote to set and Make
// parallel of move its SportLots link out and back; Make insert of files
// "All-America Game Autos Red Ink" as the parallel "Red Ink"; a later sync
// never re-creates it, and its SportLots link is still on the moved row.
//
// NEO-334, claim 10 (R3: no other spec proves the seventh column's gating):
// only an INSERT has sub-variants. A parallel of Base (Blue, under the
// Parallel-titled type) opens no Sub-Variants column; an insert (All-America
// Game Autos, under the Insert-titled type) does. The spec already stands on
// both sides of the line, so the claim costs two reads, not a second drill.
// The negative half runs in both modes; the positive half rides the live-only
// step at the end.
//
// Sole writer of Bowman > Parallel's rows; fresh-only (the global seed's
// review fixture is consumed by the moves). Paused SportLots has its own
// branches, both ending in hard asserts.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnOption,
  columnSearch,
  drillToColdManufacturer,
  drillToSet,
  saveReconcile,
  setBuilderReady,
} from "../../support/set-builder";
import type { Page } from "@playwright/test";

const BRAND = "Bowman";
const COLOUR = "Blue";
const SL_SET = "Bowman Blue";
const INSERT_ROW = "All-America Game Autos";
const SOURCE_ROW = "All-America Game Autos Red Ink";
const NEW_PARALLEL = "Red Ink";
const TYPE_PARALLEL = "Parallel";
const TYPE_INSERT = "Insert";

/** The live marketplace round trip of a Parallels sync (the flow's 240 s). */
const PARALLELS_FETCH = 240_000;

const drillBowman = (page: Page, env: Parameters<typeof drillToSet>[1]) =>
  drillToSet(page, env, { sport: "Baseball", year: "2026", manufacturer: BRAND, set: BRAND });

/** Pick a row of the Parallels column through its search. */
async function pickParallel(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Search parallels" }).fill(name);
  await columnOption(page, "Parallels", name).click();
}

test(
  "2026 Bowman SportLots links — Blue pairs both links, Promote to set and Make parallel of move its SportLots link out and back, Make insert of files Red Ink (NEO-305/306)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    const reconcile = page.getByRole("dialog", { name: `Reconcile ${TYPE_PARALLEL}s` });
    const syncParallels = page.getByRole("button", { name: `Sync ${TYPE_PARALLEL}s` });

    // ── STEP 1: Bowman > Parallel; sync it and file the SportLots review ──
    await drillBowman(page, env);
    await columnOption(page, "Variant Types", TYPE_PARALLEL).click();

    if (!env.SL_PAUSED) {
      await syncParallels.click();
      await expect(reconcile).toBeVisible({ timeout: PARALLELS_FETCH });
      await reconcile.getByRole("textbox", { name: "Filter NeonBinder sets" }).fill(COLOUR);
      await expect(
        reconcile.getByRole("textbox", { name: `NeonBinder set name for ${COLOUR}`, exact: true }),
      ).toBeVisible();
      // Blue pairs both links: two chips on the one NB row.
      await expect(reconcile.getByRole("button", { name: `Remove ${COLOUR} from ${COLOUR}` }).nth(1)).toBeVisible();
      await expectAccessible(page, { within: reconcile, label: "Reconcile Parallels dialog" });
      // NEO-339: a SportLots or BSC set left in Pending makes Save ask "Leave N
      // sets unpaired?"; `saveReconcile` asserts whichever outcome the Pending
      // columns call for (Blue and the review's Red Ink source row are Ready, so
      // neither is among the sets listed).
      await saveReconcile(page, reconcile, { placed: [COLOUR, SOURCE_ROW] });
      await expect(reconcile).toBeHidden();
    } else {
      await expect(page.getByRole("listbox", { name: `${TYPE_PARALLEL}s` })).toBeVisible({
        timeout: PARALLELS_FETCH,
      });
      await expect(reconcile).toBeHidden();
    }

    await pickParallel(page, COLOUR);
    // CLAIM 10, NEGATIVE HALF (NEO-334, both modes): Blue is a parallel of the
    // Base set, so nothing nests under it. POSITIVE FIRST (R2): the pick landed
    // and the Parallels column collapsed to its card. That collapse also removes
    // the column's OWN search box, so after this gate the only box that could
    // carry that name is a seventh column's, which would mount in the same
    // render. `.*` after the name admits a twin suffix ` (#<id>)`.
    await expect(page.getByRole("button", { name: new RegExp(`^Parallels: ${COLOUR}.* — change$`) })).toBeVisible();
    await expect(columnSearch(page, "Parallels")).toBeHidden();
    await expect(page.getByRole("button", { name: "Sync Sub-Variants" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Add custom Sub-Variants" })).toBeHidden();
    await expect(page.getByText(new RegExp(`Attributes for ${COLOUR}`))).toBeVisible();
    await expectAccessible(page, { label: "Blue parallel with its attributes" });

    // ── Promote to set (live only: paused, Blue carries no SportLots link) ──
    if (env.SL_PAUSED) {
      await expect(page.getByRole("button", { name: "Promote to set" })).toBeHidden();
    } else {
      await page.getByRole("button", { name: "Promote to set" }).click();
      const promote = page.getByRole("dialog", { name: `Promote “${COLOUR}” to a set` });
      await expect(promote).toBeVisible();
      await expect(promote.getByText(new RegExp(`“${COLOUR}” stays, keeping everything else on it\\.`))).toBeVisible();
      await expectAccessible(page, { within: promote, label: "Promote to set dialog" });
      await promote.getByRole("button", { name: "Promote it" }).click();
      await expect(page.getByText(`“${SL_SET}” is its own set now.`)).toBeVisible();

      // ── Make parallel of…: the promoted set goes back under Bowman's Blue ──
      await drillToSet(page, env, { sport: "Baseball", year: "2026", manufacturer: BRAND, set: SL_SET });
      await expect(page.getByText(new RegExp(`Attributes for ${SL_SET}`))).toBeVisible();
      await page.getByRole("button", { name: "Make parallel of…" }).click();
      const makeParallel = page.getByRole("dialog", { name: `Make “${SL_SET}” a parallel` });
      await expect(makeParallel).toBeVisible();
      await expect(makeParallel.getByText(`Parallel of: ${BRAND}`)).toBeVisible();
      await expect(makeParallel.getByText("joins").first()).toBeVisible();
      await expectAccessible(page, { within: makeParallel, label: "Make parallel of dialog" });
      await makeParallel.getByRole("button", { name: "Make it a parallel" }).click();
      await expect(
        page.getByText(new RegExp(`“${SL_SET}” joined ${BRAND}.s “${COLOUR}” parallel\\.`)),
      ).toBeVisible();

      // The promoted set is gone from the Sets column; its neighbours stay.
      await drillToColdManufacturer(page, env, { sport: "Baseball", year: "2026", manufacturer: BRAND });
      await expect(page.getByRole("button", { name: "Sync Sets" })).toBeVisible();
      await expect(columnOption(page, "Sets", "Bowman Chrome")).toBeVisible();
      await expect(columnOption(page, "Sets", "Bowman Sapphire Edition")).toBeVisible();
      await expect(columnOption(page, "Sets", SL_SET)).toBeHidden();

      // ── Make insert of…: Red Ink becomes a parallel of All-America Game Autos ──
      await drillBowman(page, env);
      await columnOption(page, "Variant Types", TYPE_PARALLEL).click();
      await pickParallel(page, SOURCE_ROW);
      await expect(page.getByText(new RegExp(`Attributes for ${SOURCE_ROW}`))).toBeVisible();
      await page.getByRole("button", { name: "Make insert of…" }).click();
      const makeInsert = page.getByRole("dialog", { name: new RegExp(`^Make “${SOURCE_ROW}” (an insert|a parallel)$`) });
      await expect(makeInsert).toBeVisible();
      await expect(makeInsert.getByText(`Insert of: ${BRAND}`)).toBeVisible();
      await expect(makeInsert.getByText("Where it goes", { exact: true }).first()).toBeVisible();

      // A long list offers a filter; a short one does not.
      const find = makeInsert.getByRole("textbox", { name: "Find an insert" });
      if (await find.isVisible()) await find.fill(INSERT_ROW);
      await makeInsert.getByRole("radio", { name: new RegExp(`^Add to ${INSERT_ROW}$`) }).click();
      await expect(makeInsert.getByText(`Where it goes: ${INSERT_ROW}`)).toBeVisible();
      await expect(makeInsert.getByText(`Under ${INSERT_ROW} as`)).toBeVisible();
      await expect(makeInsert.getByText(NEW_PARALLEL, { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("dialog", { name: `Make “${SOURCE_ROW}” a parallel` })).toBeVisible();
      await expectAccessible(page, { within: makeInsert, label: "Make insert of dialog with a destination chosen" });
      await makeInsert.getByRole("button", { name: "Make it a parallel" }).click();
      await expect(
        page.getByText(
          `“${SOURCE_ROW}” now lives at ${BRAND} › ${TYPE_INSERT} › ${INSERT_ROW} › ${NEW_PARALLEL}.`,
        ),
      ).toBeVisible();
      await expect(page.getByText(new RegExp(`Attributes for ${NEW_PARALLEL}`))).toBeVisible();
      await expectAccessible(page, { label: "Red Ink parallel after Make insert of" });
    }

    // ── STEPS 15–16: a later Parallels sync never re-creates the moved row ──
    await drillBowman(page, env);
    await columnOption(page, "Variant Types", TYPE_PARALLEL).click();
    await syncParallels.click();

    if (!env.SL_PAUSED) {
      await expect(reconcile).toBeVisible({ timeout: PARALLELS_FETCH });
      // The same step as the first Save (NEO-339). The moved row's ids are held
      // under its new insert, which the dialog neither seeds into Ready nor offers
      // in Pending, so the step must not list it either.
      await saveReconcile(page, reconcile, { placed: [COLOUR, SOURCE_ROW] });
      await expect(reconcile).toBeHidden();
    } else {
      const outcome = page.getByText(
        /Stored [0-9]+ variants \(single platform\)|Some variants were not stored|Sync failed: could not load variants/,
      );
      await expect(outcome.first()).toBeVisible({ timeout: PARALLELS_FETCH });
      await expect(page.getByText(/Stored [0-9]+ variants \(single platform\)/)).toBeVisible();
      await expect(reconcile).toBeHidden();
    }

    await page.getByRole("combobox", { name: "Search parallels" }).fill(SOURCE_ROW);
    await expect(page.getByText("No matches found")).toBeVisible();
    await expect(columnOption(page, "Parallels", SOURCE_ROW)).toBeHidden();

    if (!env.SL_PAUSED) {
      // The moved row still holds the SportLots link under its new insert.
      await drillBowman(page, env);
      await columnOption(page, "Variant Types", TYPE_INSERT).click();
      const search = page.getByRole("combobox", { name: "Search inserts" });
      // The Inserts column offers a search only when it is long.
      if (await search.isVisible()) await search.fill(INSERT_ROW);
      await columnOption(page, "Inserts", INSERT_ROW).click();
      await expect(page.getByRole("heading", { name: "Parallels", exact: true })).toBeVisible();
      await columnOption(page, "Parallels", NEW_PARALLEL).click();

      // CLAIM 10, POSITIVE HALF (NEO-334, live only: paused, no moved row exists
      // to stand on): an insert has a sub-variants column. The pick collapsed
      // the Parallels column to its card (the gate: the click took, R2), and the
      // seventh column's own "Sync Sub-Variants" is on screen.
      await expect(
        page.getByRole("button", { name: new RegExp(`^Parallels: ${NEW_PARALLEL}.* — change$`) }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Sync Sub-Variants" })).toBeVisible();

      await expect(page.getByText("Multi-source sets")).toBeVisible();
      const chip = page.getByRole("button", { name: new RegExp(`^Remove .*${NEW_PARALLEL}$`) });
      await chip.click();
      await expect(page.getByText(new RegExp(`Detach SportLots ".*${NEW_PARALLEL}"\\? `))).toBeVisible();
      await expectAccessible(page, { label: "Detach SportLots link confirmation" });
      await page.getByRole("button", { name: new RegExp(`^Cancel detach .*${NEW_PARALLEL}`) }).click();
      await expect(page.getByText(/Detach SportLots /)).toBeHidden();
      await expect(chip).toBeVisible();
    }
  },
);
