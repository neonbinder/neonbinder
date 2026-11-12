// Origin: .maestro/flows/set-selector/bowman-insert-grouping-builds-parallels.yaml (Maestro suite retired in NEO-341; see git history)
// Fresh-only: it saves 2026 Bowman's inserts as sets, groups them, and builds
// Anime Kanji's cards from Anime.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnOption,
  columnSearch,
  drillToSet,
  openAttributesPanel,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";
import { CHECKLISTS, confirmChecklistMatchCards, matchCardsDialog, usePublishersChecklist } from "../../support/published-checklist";
import { advanceToSave, confirmSaveButton, reviewWizard } from "../../support/wizard";
import { expectAfterMarketplace } from "../../support/marketplace-wait";
import type { Page } from "@playwright/test";

const BOWMAN = { sport: "Baseball", year: "2026", manufacturer: "Bowman", set: "Bowman" };
/** 201 and up: the grouping suggestions the flow expects for the whole Bowman year. */
const OVER_200 = "(20[1-9]|2[1-9][0-9]|[3-9][0-9][0-9]|[1-9][0-9]{3,})";

test(
  "2026 Bowman inserts — BSC's inserts become NB sets, Group Parallels nests Anime Kanji under Anime, and saving Anime builds Kanji's cards (NEO-293…312)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    const reconcile = page.getByRole("dialog", { name: "Reconcile Inserts" });
    const grouping = page.getByRole("dialog").filter({ hasText: /Drag inserts under a parent/ });
    const insert = columnOption(page, "Variant Types", "Insert");

    /** Re-drill to Bowman's Insert column from a fresh page load. */
    const openInserts = async () => {
      await drillToSet(page, env, BOWMAN);
      await insert.click();
    };
    const searchAnime = async () => {
      await columnSearch(page, "Inserts").fill("Anime");
      await expect(columnOption(page, "Inserts", "Anime")).toBeVisible();
    };

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await openInserts();

    if (!env.SL_PAUSED) {
      // ── PART 1: Sync Inserts opens Reconcile (both marketplaces, live: the flow's 240 s) ──
      await page.getByRole("button", { name: "Sync Inserts" }).click();
      await expect(reconcile).toBeVisible({ timeout: 240_000 });

      const filterSets = reconcile.getByRole("textbox", { name: "Filter NeonBinder sets" });
      const filterBsc = reconcile.getByRole("textbox", { name: "Filter BSC items" });
      await filterSets.fill("Anime");
      await filterBsc.fill("Anime");

      // "Anime" is either already a set (a rerun) or still BSC-only: make it its own set.
      const animeSet = reconcile.getByRole("textbox", { name: "NeonBinder set name for Anime", exact: true });
      const animeOwn = reconcile.getByRole("button", { name: "Make its own set: Anime", exact: true });
      await expect(animeSet.or(animeOwn)).toBeVisible();
      if (await animeOwn.isVisible()) await animeOwn.click();
      await expect(animeSet).toBeVisible();
      await expect(
        reconcile
          .getByRole("textbox", { name: "NeonBinder set name for Anime Kanji", exact: true })
          .or(reconcile.getByRole("button", { name: "Make its own set: Anime Kanji", exact: true })),
      ).toBeVisible();
      await expect(reconcile.getByRole("button", { name: /^Keep all [1-9][0-9]*, BSC sets?$/ })).toBeVisible();
      await expectAccessible(page, { within: reconcile, label: "Reconcile Inserts dialog" });

      // Keep all of the rest of BSC's inserts: Ready grows by exactly what was pending in BSC.
      await filterBsc.clear();
      const bscCount = reconcile.getByText(/BSC \([1-9][0-9]*\)/);
      await expect(bscCount).toBeVisible();
      const summary = reconcile.getByText(/[0-9]+ ready, [0-9]+ pending/);
      const readyBefore = Number(((await summary.textContent()) ?? "").split(" ")[0]);
      const keepAllN = Number((((await bscCount.textContent()) ?? "").match(/\((\d+)\)/) ?? [])[1]);
      expect(readyBefore).toBeGreaterThan(0);
      expect(keepAllN).toBeGreaterThan(0);
      await reconcile.getByRole("button", { name: /^Keep all(?: [1-9][0-9]*)?, BSC sets?$/ }).click();
      await expect(reconcile.getByText(new RegExp(`^${readyBefore + keepAllN} ready, [0-9]+ pending`))).toBeVisible();

      await expect(
        reconcile.getByRole("textbox", { name: "NeonBinder set name for Anime Kanji", exact: true }),
      ).toBeVisible();
      await expect(animeSet).toBeVisible();
      await reconcile.getByRole("button", { name: /^Save [0-9]+ sets/ }).click();
      await expect(reconcile).toBeHidden();
      await openInserts();
    } else {
      // Paused: SportLots offers no twin, so the sets come in without a reconcile.
      await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: 240_000 });
      await expect(reconcile).toBeHidden();
      // GUIDE R5 exception, a live BSC round trip: the heading shows while the
      // column's BSC sync is still running ("Syncing Inserts"), before Anime
      // is written. Run 41212224696 searched at that moment and read "No
      // matches found"; the sync finished 5 s later.
      await columnSearch(page, "Inserts").fill("Anime");
      await expect(columnOption(page, "Inserts", "Anime")).toBeVisible({ timeout: 60_000 });
    }

    // ── PART 2: both are inserts; Group Parallels nests Kanji under Anime ──
    await searchAnime();
    await expect(columnOption(page, "Inserts", "Anime Kanji")).toBeVisible();
    await page.getByRole("button", { name: "Group Parallels" }).click();
    await expect(grouping).toBeVisible();
    await expectAccessible(page, { within: grouping, label: "Group Parallels dialog with suggestions" });
    await grouping.getByRole("button", { name: new RegExp(`^Accept all suggestions \\(${OVER_200}\\)`) }).click();
    await expect(grouping.getByText(new RegExp(`${OVER_200} promotions, 0 demotions`))).toBeVisible();
    await grouping.getByRole("button", { name: new RegExp(`^Save ${OVER_200} changes`) }).click();
    await expect(grouping).toBeHidden();

    // Saved: Anime Kanji left the top level, and the grouping has nothing left to suggest.
    await openInserts();
    await searchAnime();
    await expect(columnOption(page, "Inserts", "Anime Kanji")).toBeHidden();
    await page.getByRole("button", { name: "Group Parallels" }).click();
    await expect(grouping).toBeVisible();
    await expect(grouping.getByRole("checkbox", { name: /^Select .+/ }).first()).toBeVisible();
    await expect(grouping.getByText("No changes yet")).toBeVisible();
    await expectAccessible(page, { within: grouping, label: "Group Parallels dialog with nothing left to suggest" });
    await expect(grouping.getByRole("button", { name: /^Accept all suggestions \([0-9]+\)/ })).toBeHidden();
    await grouping.getByRole("button", { name: "Cancel" }).click();
    await expect(grouping).toBeHidden();

    // ── PART 3: a re-sync leaves grouped parallels be ──
    await page.getByRole("button", { name: "Sync Inserts" }).click();
    if (!env.SL_PAUSED) {
      await expect(reconcile).toBeVisible({ timeout: 240_000 });
    } else {
      await expect(
        page.getByText(
          /Stored [0-9]+ variants \(single platform\)|Some variants were not stored|Sync failed: could not load variants/,
        ),
      ).toBeVisible({ timeout: 240_000 });
    }
    await expect(
      page.getByText(/[0-9]+ already grouped as (a parallel|parallels)\. Leaving (it|those) be\./),
    ).toBeVisible();
    await expect(page.getByText("Show grouped")).toBeVisible();
    if (!env.SL_PAUSED) {
      await expectAccessible(page, { within: reconcile, label: "Reconcile Inserts dialog leaving grouped parallels be" });
      await reconcile.getByRole("button", { name: /^Save [0-9]+ sets/ }).click();
      await expect(reconcile).toBeHidden();
    }

    // ── PART 4: opening Anime lists Kanji as its parallel; syncing Anime builds Kanji's cards ──
    await openInserts();
    await searchAnime();
    await expect(columnOption(page, "Inserts", "Anime Kanji")).toBeHidden();
    await columnOption(page, "Inserts", "Anime").click();
    await expect(columnHeading(page, "Parallels")).toBeVisible();
    await expect(columnOption(page, "Parallels", "Anime Kanji")).toBeVisible();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    // The publisher's checklist (NEO-478): Anime's teams are BSC's own answers, uploaded, so the fetch
    // asks BSC for the cards' list and for no card's team (NEO-489: the number column is trusted as
    // printed, so the `TBD` card pairs by its number like the rest, 36 of 36). Six of the cards are
    // football players; the file carries their teams as BSC named them.
    const facts = await usePublishersChecklist(page, CHECKLISTS.bowmanAnime2026);
    await syncChecklistButton(page).click();

    // NEO-496 (D10, NQ1): BSC plus the uploaded checklist are two sources, so Match Cards opens
    // with SportLots paused or live. The cards come from BSC (and SportLots, paired, when it is
    // live): GUIDE R5's marketplace wait, measured time plus 7 s, never a flat ceiling.
    const matchCards = matchCardsDialog(page);
    await expectAfterMarketplace(page, matchCards.getByRole("button", { name: "Confirm card matches", disabled: false }), {
      platform: "BuySportsCards",
      what: "the Anime fetch's Match Cards",
    });
    await expect(matchCards.getByRole("heading", { name: "Match Cards — Anime" })).toBeVisible();
    await expectAccessible(page, { within: matchCards, label: "Match Cards dialog" });
    // Proves the teams line while the dialog is open, keeps any card the file leaves out, confirms.
    await confirmChecklistMatchCards(page, { facts, what: "the Anime fetch" });

    // Either new names need review, or the cards save straight away. Since
    // NEO-335 the wizard ("Tidy up <year> <set> <variant>" since NEO-497) has THREE shapes: names to decide
    // (footer "Skip remaining names (N)"), or every name known and the open
    // question is a teamless card or a trimmed title (it opens on that step with
    // "Next (Enter)"). Same branch below: past the names, advanceToSave leaves
    // the teams / titles steps on their defaults and stops on the Save step.
    const wizard = reviewWizard(page);
    const saved = page.getByText(/Saved [0-9]+ cards/);
    await expect(wizard.or(saved)).toBeVisible({ timeout: 60_000 });
    if (await wizard.isVisible()) {
      await expectAccessible(page, { within: wizard, label: "Tidy-up wizard" });
      // The footer's first action says which shape opened (it paints with the batch).
      const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
      await expect(
        skipRemaining.or(wizard.getByRole("button", { name: "Next (Enter)", exact: true })).or(confirmSaveButton(page)),
      ).toBeVisible();
      if (await skipRemaining.isVisible()) {
        await skipRemaining.click();
        // The lookups behind the batch settle here (the flow's 60 s, unchanged).
        await expect(
          wizard.getByRole("button", { name: "Next (Enter)", exact: true }).or(confirmSaveButton(page)),
        ).toBeVisible({ timeout: 60_000 });
      }
      await advanceToSave(page);
      await confirmSaveButton(page).click();
    }
    await expect(page.getByText(/Saved [1-9][0-9]* cards?/)).toBeVisible();

    // The build of Kanji's cards from Anime reports itself, then lands.
    await expect(
      page.getByText(/Building parallels of Anime — [0-9]+ of [0-9]+|Anime parallels — [^.]+/).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Anime parallels — [1-9][0-9]* built(, [0-9]+ (blocked|skipped|failed))*/ }),
    ).toBeVisible({ timeout: 60_000 });
    // (a status line may repeat this for screen readers: any one of them will do)
    await expect(page.getByText(/Anime Kanji — Built [1-9][0-9]* cards?(, .+)?/).first()).toBeVisible();
    await expectAccessible(page, { label: "Anime parallels build ledger" });

    // Kanji stays attached to BSC as a variant; detaching asks first and can be cancelled.
    // Live, the Reconcile Save above stored each source's name, so the chip
    // reads "Anime Kanji". Paused, the sets arrive through the drill's own sync
    // with no reconcile (above), nothing stores a name, and the chip falls back
    // to BSC's slug: that is what the operator sees, so that is the handle.
    const chip = env.SL_PAUSED ? "anime-kanji" : "Anime Kanji";
    await columnOption(page, "Parallels", "Anime Kanji").click();
    // NEO-496 (Jason): the Cards section speaks only about the row on screen. Kanji's own
    // slot is up (its cards were built, so it offers a rebuild), and Anime's "Saved N cards."
    // and its parallels ledger went with the pick.
    await expect(page.getByRole("button", { name: "Rebuild from Anime" })).toBeVisible();
    await expect(page.getByText(/Saved [0-9]+ cards?/)).toBeHidden();
    await expect(page.getByRole("heading", { name: /^Anime parallels — / })).toBeHidden();
    // NEO-496: the sources live inside the attributes panel, closed below the set.
    await openAttributesPanel(page);
    await expect(page.getByText("Multi-source sets")).toBeVisible();
    const remove = page.getByRole("button", { name: `Remove ${chip}`, exact: true });
    await expect(remove).toBeVisible();
    await expect(page.getByLabel(`${chip} is attached as a BSC variant`)).toBeVisible();
    await expect(page.getByText("Needs re-mapping")).toBeHidden();
    await remove.click();
    const warning = page.getByText(/(1 card was|[1-9][0-9]* cards were) fetched from it; (its|their) BSC link will be dropped/);
    await expect(warning).toBeVisible();
    await expectAccessible(page, { label: "Detach Anime Kanji confirmation" });
    await page.getByRole("button", { name: `Cancel detach ${chip}` }).click();
    await expect(warning).toBeHidden();
    await expect(remove).toBeVisible();
    await expect(page.getByRole("button", { name: "Rebuild from Anime" })).toBeVisible();
  },
);
