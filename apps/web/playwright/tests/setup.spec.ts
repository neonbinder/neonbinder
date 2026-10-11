// Port of .maestro/flows/setup.yaml — THE GLOBAL SETUP TRACK.
//
// Runs ONCE, as worker 0, in the seed job, after `e2e-baseline.sh reset` and
// before any shard starts (project `setup`, never sharded). See the flow for
// the full rationale behind every step; comments here only mark the sections.
// Timeouts are the flow's own measured cold-path values: R5 exempts the setup
// track as a class (live marketplace round-trips on unwarmed data).
import { test } from "../support/fixtures";
import { utilPausedPlatforms } from "../support/subflows/util/util-paused-platforms";
import { utilLoginToBsc } from "../support/subflows/util/util-login-to-bsc";
import { utilLoginToSportlots } from "../support/subflows/util/util-login-to-sportlots";
import { utilDrillTo2024ToppsChrome } from "../support/subflows/set-selector/util-drill-to-2024-topps-chrome";
import { utilDrillToBaseVariant } from "../support/subflows/set-selector/util-drill-to-base-variant";
import { utilDrillToColdRealSet } from "../support/subflows/set-selector/util-drill-to-cold-real-set";
import type { Maestro } from "../support/maestro";

const NO_REACH = ".*could not be reached, so nothing from .* was changed.*";
const NO_SYNC = ".*Couldn.t sync options.*";

/** The Match Cards dialog, when two marketplaces both answered (live branch). */
async function resolveMatchCards(m: Maestro, closeTimeout: number): Promise<void> {
  if (await m.isVisible("Match Cards.*")) {
    await m.waitVisible("^Confirm$", 120_000);
    if (await m.isVisible(".*BSC only \\([1-9][0-9]*\\).*")) {
      await m.tapOn(m.id("Keep all BSC-only cards"));
    }
    if (await m.isVisible(".*SportLots only \\([1-9][0-9]*\\).*")) {
      await m.tapOn(m.id("Keep all SportLots-only cards"));
    }
    await m.tapOn(m.id("Confirm card matches"));
    await m.waitNotVisible("Match Cards.*", closeTimeout);
  }
}

/** Reconcile dialog for an Insert/Parallel column, then pick the target row. */
async function reconcileAndPick(
  m: Maestro,
  o: { title: string; searchId: string; query: string; row: string },
): Promise<void> {
  await m.scrollUntilVisible(`.*${o.searchId}.*`, { centerElement: true, timeout: 10_000 });
  if (await m.isNotVisible(o.title)) {
    await m.tapOn(`.*${o.searchId}.*`);
    await m.inputText(o.query);
  }
  await m.waitVisible(`.*${o.title}.*|^${o.row}$`, 240_000);
  if (await m.isVisible(o.title)) {
    await m.assertVisible(".*[0-9]+ ready.*");
    await m.assertVisible(".*Ready \\([0-9]+\\).*");
    await m.scrollUntilVisible(".*Save [0-9]+ sets.*", { timeout: 30_000 });
    await m.tapOn(".*Save [0-9]+ sets.*");
    await m.waitNotVisible(o.title, 30_000);
    await m.scrollUntilVisible(m.id(o.searchId), { direction: "UP", centerElement: true, timeout: 7_000 });
    if (await m.isNotVisible(m.below(`^${o.row}$`, m.id(o.searchId)))) {
      await m.tapOn(m.id(o.searchId));
      await m.eraseText(30);
      await m.inputText(o.query);
    }
  }
  await m.waitVisible(m.below(`^${o.row}$`, m.id(o.searchId)), 15_000);
  await m.assertNotVisible(NO_REACH);
  await m.assertNotVisible(NO_SYNC);
  await m.tapOn(m.below(`^${o.row}$`, m.id(o.searchId)));
}

test(
  "Setup — global reset + warm + sync 2024 Topps Chrome Baseball (Base + Insert + Parallel) + 2026 Bowman's SportLots review",
  { tag: ["@setup"] },
  async ({ m }) => {
    // ── sign in, per-user reset, seed creds, land on /admin ─────────────────
    await m.launch(
      m.signInUrl("/testing/reset?redirect=/testing/seed-credentials?redirect=/admin"),
    );
    await m.waitVisible(".*Build set parameters from marketplace data.*", 120_000);
    const SL_PAUSED = utilPausedPlatforms(m);
    await utilLoginToBsc(m);
    await utilLoginToSportlots(m);

    // ── Sports → Baseball ───────────────────────────────────────────────────
    await m.openLink("/set-selector");
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 20_000);
    await m.scrollUntilVisible("Sports", { centerElement: true, timeout: 10_000 });
    if (await m.isNotVisible("Baseball")) {
      await m.waitVisible("Baseball", 60_000);
    }
    await m.scrollUntilVisible("Baseball", { centerElement: true, timeout: 10_000 });
    await m.assertNotVisible(NO_REACH);
    await m.assertNotVisible(NO_SYNC);
    if (!SL_PAUSED) {
      await m.assertNotVisible("SportLots is on pause: nothing from SportLots was asked for or changed.");
    } else {
      await m.scrollUntilVisible(
        "SportLots is on pause: nothing from SportLots was asked for or changed.",
        { timeout: 10_000 },
      );
      await m.scrollUntilVisible("Baseball", { direction: "UP", centerElement: true, timeout: 10_000 });
    }
    await m.tapOn("Baseball");

    // ── Years → 2024 ────────────────────────────────────────────────────────
    await m.waitVisible("Years", 20_000);
    await m.waitVisible(m.id("Years"), 90_000);
    await m.assertNotVisible(NO_REACH);
    await m.assertNotVisible(NO_SYNC);
    await m.scrollUntilVisible(".*Search years.*", { centerElement: true, timeout: 10_000 });
    await m.tapOn(".*Search years.*");
    await m.inputText("2024");
    await m.tapOn(m.below("2024", m.id("Search years")));
    await m.waitVisible("Manufacturers", 20_000);

    // ── Manufacturers → Topps ───────────────────────────────────────────────
    if (!SL_PAUSED) {
      await m.scrollUntilVisible(".*Search manufacturers.*", { centerElement: true, timeout: 10_000 });
      await m.tapOn(".*Search manufacturers.*");
      await m.inputText("Topps");
      await m.waitVisible(m.below("Topps", m.id("Search manufacturers")), 45_000);
      await m.assertNotVisible(NO_REACH);
      await m.assertNotVisible(NO_SYNC);
      await m.tapOn(m.below("Topps", m.id("Search manufacturers")));
    } else {
      if (await m.isVisible("Syncing Manufacturer Options")) {
        await m.waitNotVisible("Syncing Manufacturer Options", 45_000);
      }
      await m.waitVisible("No manufacturers available. Sync from marketplaces to populate.", 45_000);
      await m.assertVisible("SportLots skipped: no SportLots ids on this path.");
      await m.assertNotVisible(NO_REACH);
      await m.assertNotVisible(NO_SYNC);
      await m.scrollUntilVisible(m.id("Add custom Manufacturers"), { centerElement: true, timeout: 10_000 });
      await m.tapOn(m.id("Add custom Manufacturers"));
      await m.waitVisible("Add Custom Entry", 7_000);
      await m.tapOn("Enter custom value...");
      await m.inputText("Topps");
      await m.pressKey("Enter");
      await m.waitVisible(m.id("Create manufacturer"), 7_000);
      await m.tapOn(m.id("Create manufacturer"));
      await m.waitNotVisible("Add Custom Entry", 10_000);
      await m.scrollUntilVisible(m.below("Topps", "Manufacturers"), { centerElement: true, timeout: 10_000 });
      await m.tapOn(m.below("Topps", "Manufacturers"));
    }

    // ── Sets → Topps Chrome ─────────────────────────────────────────────────
    await m.waitVisible("Sets", 20_000);
    await m.waitVisible(m.id("Sets"), 45_000);
    await m.assertNotVisible(NO_REACH);
    await m.assertNotVisible(NO_SYNC);
    await m.scrollUntilVisible(".*Search sets.*", { centerElement: true, timeout: 10_000 });
    await m.tapOn(".*Search sets.*");
    await m.inputText("Topps Chrome");
    await m.tapOn(m.below("Topps Chrome", m.id("Search sets")));

    // ── Variant Types ───────────────────────────────────────────────────────
    await m.waitVisible("Variant Types", 20_000);
    if (await m.isNotVisible("Base")) {
      await m.scrollUntilVisible("Sync Variant Types", { centerElement: true, timeout: 45_000 });
      await m.tapOn("Sync Variant Types");
      await m.waitNotVisible("Syncing Variant Types", 45_000);
      if (await m.isVisible("Close")) {
        await m.tapOn("Close");
        await m.waitVisible("Sync Variant Types", 10_000);
      }
    }
    await m.scrollUntilVisible("Base", { centerElement: true, timeout: 10_000 });
    await m.assertVisible("Insert");
    await m.assertVisible("Parallel");
    await m.assertNotVisible(NO_REACH);
    await m.assertNotVisible(NO_SYNC);

    // ── Base: map the base set, fetch + save the checklist ──────────────────
    await m.tapOn("Base");
    await m.assertNotVisible("An error occurred. Please refresh the page.");
    await m.scrollUntilVisible(".*Select Base Set.*|.*Re-map Base.*", { centerElement: true, timeout: 60_000 });
    if (await m.isVisible("Select Base Set")) {
      await m.waitVisible("Confirm Base Set", 45_000);
      if (!SL_PAUSED) {
        await m.tapOn(m.id("BSC base candidate: .*"));
        await m.tapOn(m.id("SportLots base candidate: .*"));
      } else {
        await m.assertVisible("SportLots returned no base set for .*");
        await m.assertNotVisible(m.id("SportLots base candidate: .*"));
        await m.tapOn(m.id("BSC base candidate: .*"));
      }
      await m.tapOn("Confirm Base Set");
      await m.waitNotVisible("Select Base Set", 30_000);
    }
    if (!SL_PAUSED) {
      await m.scrollUntilVisible("Re-map Base", { centerElement: true, timeout: 30_000 });
    } else {
      await m.assertNotVisible("Select Base Set");
      await m.assertNotVisible("An error occurred. Please refresh the page.");
    }
    await m.scrollUntilVisible("Add Card", { centerElement: true, timeout: 30_000 });
    await m.assertVisible(".*Fetch from Marketplaces.*|Refresh");
    await m.tapOn(".*Fetch from Marketplaces.*|Refresh");
    await m.waitVisible("Match Cards.*|.*Confirm New Players.*|.*Saved [0-9]+.*", 60_000);
    if (!SL_PAUSED) {
      await resolveMatchCards(m, 60_000);
    } else {
      await m.assertVisible(".*Kept all [0-9]+ cards? from BSC.*");
      await m.assertNotVisible("Match Cards.*");
    }
    await m.waitVisible(".*Confirm New Players.*|.*Saved [0-9]+.*", 60_000);
    if (await m.isVisible("Confirm New Players & Teams")) {
      await m.tapOn(".*Add remaining players as new.*");
      // repeat: times 250, while notVisible ".*Confirm & Save.*"
      for (let i = 0; i < 250; i++) {
        if (!(await m.isNotVisible(".*Confirm & Save.*"))) break;
        await m.waitVisible("Add as New (Team|League)|.*Confirm & Save.*", 240_000);
        if (await m.isVisible(m.id("Add as New (Team|League)"))) {
          await m.tapOn(m.id("Add as New (Team|League)"), { optional: true });
        }
      }
      await m.waitVisible(".*Confirm & Save.*", 240_000);
      await m.tapOn(".*Confirm & Save.*");
    }
    await m.waitVisible(".*Saved 335 cards.*", 120_000);
    await m.assertVisible("#[0-9][^ ]*");

    // ── Insert: reconcile, Future Stars checklist ───────────────────────────
    await utilDrillTo2024ToppsChrome(m);
    await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 10_000 });
    await m.tapOn("Insert");
    await m.waitVisible("Inserts", 20_000);
    await reconcileAndPick(m, {
      title: "Reconcile Inserts",
      searchId: "Search inserts",
      query: "Future Star",
      row: "Future Stars",
    });
    await m.scrollUntilVisible(".*Attributes for Future Stars.*", { centerElement: true, timeout: 30_000 });
    await m.scrollUntilVisible("Add Card", { centerElement: true, timeout: 30_000 });
    await m.assertVisible(".*Fetch from Marketplaces.*|Refresh");
    await m.tapOn(".*Fetch from Marketplaces.*|^Refresh$");
    await m.waitVisible("Match Cards.*|.*Confirm New Players.*|.*Saved [0-9]+.*", 90_000);
    if (!SL_PAUSED) {
      await resolveMatchCards(m, 90_000);
    } else {
      await m.assertNotVisible("Match Cards.*");
    }
    await m.waitVisible(".*Confirm New Players.*|.*Saved [0-9]+.*", 90_000);
    await m.assertNotVisible("Confirm New Players & Teams");
    await m.waitVisible(".*Saved 20 cards.*", 120_000);

    // ── Parallel: reconcile, Gold Wave Refractors built from Base ───────────
    await utilDrillTo2024ToppsChrome(m);
    await m.scrollUntilVisible("Parallel", { centerElement: true, timeout: 10_000 });
    await m.tapOn("Parallel");
    await m.waitVisible("Parallels", 20_000);
    await reconcileAndPick(m, {
      title: "Reconcile Parallels",
      searchId: "Search parallels",
      query: "Gold Wave Refractor",
      row: "Gold Wave Refractors",
    });
    await m.scrollUntilVisible(".*Attributes for Gold Wave Refractors.*", { centerElement: true, timeout: 30_000 });
    await m.scrollUntilVisible("Add Card", { centerElement: true, timeout: 30_000 });
    await m.scrollUntilVisible("^Build from Base$", { centerElement: true, timeout: 30_000 });
    await m.assertNotVisible(m.id("Sync card checklist"));
    await m.tapOn("^Build from Base$");
    await m.waitVisible("Gold Wave Refractors — Built 300 cards(, [^.]+)?\\..*", 120_000);
    await m.assertNotVisible("Match Cards.*");
    await m.assertNotVisible("Confirm New Players & Teams");
    if (!SL_PAUSED) {
      await m.scrollUntilVisible("#[0-9][^ ]*", { centerElement: true, timeout: 15_000 });
      await m.assertVisible("SL");
    } else {
      await m.scrollUntilVisible("#[0-9][^ ]*", { centerElement: true, timeout: 15_000 });
      await m.assertVisible("BSC");
      await m.assertVisible("BSC only");
      await m.assertNotVisible("SL");
    }

    // ── Topps Big League: base mapped, checklist left empty ─────────────────
    await utilDrillToBaseVariant(m, { SET: "Topps Big League" });
    if (!SL_PAUSED) {
      await m.scrollUntilVisible(".*Re-map Base.*", { direction: "UP", centerElement: true, timeout: 60_000 });
    } else {
      await m.scrollUntilVisible("Map Base Set", { direction: "UP", centerElement: true, timeout: 60_000 });
    }
    await m.scrollUntilVisible("No cards in this checklist yet.", { timeout: 15_000 });

    // ── 2026 Bowman: sort SportLots sets (NEO-312 fixture) ──────────────────
    const BRAND = "Bowman";
    const SL_SET = "Bowman Blue";
    const OWN_LABEL = "Bowman Sterling";
    const OWN_SET = "Bowman Sterling";
    const INSERT_ROW = "All-America Game Autos";
    const SOURCE_ROW = "All-America Game Autos Red Ink";
    const TYPE_PARALLEL = "Parallel";
    const TYPE_INSERT = "Insert";

    await utilDrillToColdRealSet(m, { SPORT: "Baseball", YEAR: "2026", MANUFACTURER: BRAND });
    await m.scrollUntilVisible("Sync Sets", { timeout: 150_000 });
    await m.assertVisible("Bowman Chrome");
    await m.assertVisible("Bowman Sapphire Edition");
    if (SL_PAUSED) {
      await m.assertVisible("SportLots skipped: no SportLots ids on this path.");
      await m.assertNotVisible("[0-9]+ SportLots sets? to sort");
    } else {
      await m.assertNotVisible("SportLots skipped: no SportLots ids on this path.");
      await m.assertNotVisible(SL_SET);
      await m.assertNotVisible("Bowman Gold");
      await m.assertNotVisible("Bowman Neon Green");
      await m.scrollUntilVisible("[0-9]+ SportLots sets? to sort", { centerElement: true, timeout: 7_000 });
      await m.tapOn("[0-9]+ SportLots sets? to sort");
      await m.waitVisible(`Sort SportLots sets for ${BRAND}`, 7_000);
      await m.tapOn(m.id("Select all shown"));
      await m.waitVisible("Apply to [1-9][0-9]* selected", 7_000);
      await m.tapOn(m.id(".*: set the selected rows belong to"));
      await m.waitVisible("Missing a set\\? Only sets that can sync their variant types show here\\.", 7_000);
      await m.tapOn(m.below(BRAND, m.id(".*: set the selected rows belong to")));
      await m.waitNotVisible(`Syncing ${BRAND}.s variant types…`, 60_000);
      await m.assertVisible(m.id(`${BRAND}: set the selected rows belong to`));
      await m.tapOn(m.id(".*: where the selected rows are filed"));
      await m.waitVisible(m.below(TYPE_PARALLEL, m.id(".*: where the selected rows are filed")), 7_000);
      await m.tapOn(m.below(TYPE_PARALLEL, m.id(".*: where the selected rows are filed")));
      await m.waitVisible(m.id(`${TYPE_PARALLEL}: where the selected rows are filed`), 7_000);
      await m.tapOn("Apply to [1-9][0-9]* selected");
      await m.waitVisible("Apply to 0 selected", 7_000);
      await m.tapOn(m.id(`Select ${INSERT_ROW}`));
      await m.waitVisible("Apply to 1 selected", 7_000);
      await m.tapOn(m.id(`${TYPE_PARALLEL}: where the selected rows are filed`));
      await m.waitVisible(m.below(TYPE_INSERT, m.id(`${TYPE_PARALLEL}: where the selected rows are filed`)), 7_000);
      await m.tapOn(m.below(TYPE_INSERT, m.id(`${TYPE_PARALLEL}: where the selected rows are filed`)));
      await m.waitVisible(m.id(`${TYPE_INSERT}: where the selected rows are filed`), 7_000);
      await m.tapOn("Apply to 1 selected");
      await m.waitVisible("Apply to 0 selected", 7_000);
      await m.assertVisible(m.id(`${TYPE_INSERT}: where ${INSERT_ROW} is filed`));
      await m.assertVisible(m.id(`${TYPE_PARALLEL}: where ${SOURCE_ROW} is filed`));
      await m.tapOn(m.id("Find a SportLots set"));
      await m.inputText(OWN_LABEL);
      await m.tapOn(m.id(`${BRAND}: set ${OWN_LABEL} belongs to`));
      await m.waitVisible("Missing a set\\? Only sets that can sync their variant types show here\\.", 7_000);
      await m.tapOn(m.below("Its own set", m.id(`${BRAND}: set ${OWN_LABEL} belongs to`)));
      await m.waitVisible(m.id(`Its own set: set ${OWN_LABEL} belongs to`), 7_000);
      await m.assertVisible("Save will file: 1 set · [0-9]+ parallels? · 1 insert");
      await m.tapOn("Save [0-9]+ SportLots sets?");
      await m.waitVisible("Saved 1 set, [0-9]+ parallels?, 1 insert\\.", 7_000);
      await m.assertVisible("Sync Sets");
      await m.assertNotVisible("[0-9]+ SportLots sets? (to sort|left — save again)");
      await m.scrollUntilVisible(OWN_SET, { direction: "UP", timeout: 7_000 });
      await m.assertVisible("Bowman Sapphire Edition");
      await m.assertNotVisible("Bowman Gold");
    }
    if (SL_PAUSED) {
      await utilDrillTo2024ToppsChrome(m, { SPORT: "Baseball", YEAR: "2026", MANUFACTURER: BRAND, SET: BRAND });
      await m.waitVisible(TYPE_INSERT, 7_000);
      await m.assertVisible(TYPE_PARALLEL);
    }
  },
);
