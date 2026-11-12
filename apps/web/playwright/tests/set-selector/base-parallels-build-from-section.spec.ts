// Origin: .maestro/flows/set-selector/base-parallels-build-from-section.yaml (Maestro suite retired in NEO-341; see git history)
// Sole writer of the 2024 Topps Chrome base set's parallels build.
//
// NEO-496 — A BLOCKED PARALLEL, said up front in the list AND in the run. A
// rebuild deletes a parallel's cards, and a card a collector owns is never
// deleted (NEO-358), so the server marks that parallel blocked before a run
// starts. The fixture is the parallel this spec has just built: the worker's
// own account marks one of its cards Have through the real /collection, the
// section names it blocked (and leaves it out of what a run would replace),
// and a second run shows it Blocked in the ledger without sending it. The copy
// is removed through the card drawer before the spec ends (R7, self-cleaning;
// a `finally` so a red body still lets go of it, or the parallel would stay
// blocked for the next run on the same deployment).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { columnOption, columnSearch, drillToSet, pick, setBuilderReady } from "../../support/set-builder";
import {
  TOPPS_CHROME_2024,
  countOf,
  drillToCollectorChecklist,
  ordinaryBaseRows,
  shortNameOf,
  type CollectorSet,
} from "../../support/collection";

// lib/collection/collectors.ts `blockedCollectedReason`, for one collector: the
// list and the build read one card's collectors, so the count is "a collector".
const COLLECTED_REASON =
  "a collector owns copies of its cards, and a rebuild would pull those cards out from under them";

test(
  "2024 Topps Chrome Parallel — Build the base set's parallels from Base, stop after one, the copy's title names its parallel, and a collector's copy blocks that parallel in the list and the run (NEO-321, NEO-496)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    // Live, SportLots contributes 41 parallels; paused, only BSC's count is known to be non-zero.
    const total = env.SL_PAUSED ? "[0-9]+" : "41";

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToSet(page, env);
    await pick(page, "Variant Types", "Parallel", { search: false });

    const section = page.getByRole("region", { name: "Parallels of Base" });
    const build = section.getByRole("button", { name: new RegExp(`^Build ${total} parallels from Base$`) });
    await expect(section).toBeVisible();
    await expect(build).toBeVisible();
    // Nothing is blocked yet: the seed's parallels are all buildable.
    await expect(section.getByText(/ — blocked: /)).toHaveCount(0);
    await expectAccessible(page, { label: "Parallel column with the Build from Base section" });
    const parallels = await countOf(build, /^Build ([0-9]+) parallels from Base$/);
    await build.click();

    // Parallels that already hold cards ask before they are replaced.
    await expect(
      page.getByText(new RegExp(`Replace the cards on [1-9][0-9]* of ${parallels} parallels with fresh copies of Base.s\\?`)),
    ).toBeVisible();
    await expectAccessible(page, { label: "Replace cards confirmation" });
    await page.getByRole("button", { name: "Replace and build" }).click();

    await page.getByRole("button", { name: "Stop after this one" }).click();
    // GUIDE R5 exception, a live BSC round trip: building a parallel fetches its
    // checklist from BSC before writing it. Run 41212224696 spent 4.8 s in that
    // fetch (a BSC re-login inside it) plus 1.7 s writing the page, past 7 s.
    await expect(
      page.getByRole("heading", { name: `Base parallels — stopped after 1 of ${parallels}` }),
    ).toBeVisible({ timeout: 60_000 });

    await expectAccessible(page, { label: "Base parallels build stopped after one" });

    // The ledger names the one parallel that was built.
    const built = page.getByText(/^.+ — (Built|Rebuilt) [1-9][0-9]* cards?(, .+)?$/).first();
    await expect(built).toBeVisible();
    const parallel = ((await built.textContent()) ?? "").split(" — ")[0].trim();
    expect(parallel.length).toBeGreaterThan(0);

    // Reopen that parallel; its copy's title names it.
    await drillToSet(page, env);
    await pick(page, "Variant Types", "Parallel", { search: false });
    await columnSearch(page, "Parallels").fill(parallel);
    await columnOption(page, "Parallels", parallel).click();
    await expect(page.getByRole("heading", { name: `Attributes for ${parallel}` })).toBeVisible();
    await expectAccessible(page, { label: "Built parallel with its attributes and cards" });

    await page.getByRole("button", { name: /^Edit card .+/ }).last().click();
    await expect(page.getByRole("textbox", { name: "Card title" })).toHaveValue(new RegExp(escapeRegExp(parallel)));

    // --- NEO-496: a collector's copy blocks the parallel -----------------------
    const target: CollectorSet = { ...TOPPS_CHROME_2024, checklist: { type: "Parallel", name: parallel } };
    /** The copy this spec put in the collection, until it is removed again. */
    let held: string | undefined;
    let bodyFailed = true;
    try {
      // The worker's own account marks the parallel's first ordinary card Have.
      // The list reads a parallel's earliest cards (up to 200), and the build
      // copies Base in its own order, so the first row is one the list reads.
      await page.goto("/collection?tab=checklists");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
      const checklist = await drillToCollectorChecklist(page, target);
      const { short } = await shortNameOf(ordinaryBaseRows(checklist).first());
      // All is a view (NEO-374): Have files into a picked binder.
      await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
      await checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false }).click();
      // The toggle flips optimistically; the notice is the server's answer, and
      // only a stored copy blocks the rebuild.
      await expect(page.getByRole("status").filter({ hasText: `Added ${short} to Main` })).toBeVisible();
      held = short;

      // The list says so before any run: the summary counts it, and the
      // attention list names it with the reason.
      await drillToSet(page, env);
      await pick(page, "Variant Types", "Parallel", { search: false });
      await expect(section).toBeVisible();
      const blockedItem = section
        .getByRole("listitem")
        .filter({ hasText: `${parallel} — blocked: ${COLLECTED_REASON}` });
      await blockedItem.scrollIntoViewIfNeeded();
      await expect(blockedItem).toBeInViewport();
      await expect(section.getByText(/ — blocked: /)).toHaveCount(1);
      const summary = section.getByText(
        new RegExp(`^${parallels} parallels: [0-9]+ empty, ([0-9]+) with cards\\.(?: .+ without one\\.)? 1 is blocked\\. `),
      );
      await expect(summary).toBeVisible();
      const withCards = Number(/ ([0-9]+) with cards\./.exec((await summary.textContent()) ?? "")?.[1]);
      expect(withCards, "the blocked parallel holds cards, so it is one of those with cards").toBeGreaterThan(0);
      // The button still names every parallel; the run lists the blocked one too.
      await expect(section.getByRole("button", { name: `Build ${parallels} parallels from Base` })).toBeVisible();
      await expectAccessible(page, { label: "Parallels of Base with one parallel blocked by a collector's copy" });

      // A run would replace every parallel with cards but the blocked one.
      await section.getByRole("button", { name: `Build ${parallels} parallels from Base` }).click();
      await expect(
        page.getByText(
          new RegExp(`^Replace the cards on ${withCards - 1} of ${parallels} parallels with fresh copies of Base.s\\?$`),
        ),
      ).toBeVisible();
      await page.getByRole("button", { name: "Replace and build" }).click();

      // The run's ledger shows it Blocked from the start, and never sends it.
      const blockedLine = section
        .getByRole("listitem")
        .filter({ hasText: `${parallel} — Blocked — ${COLLECTED_REASON}` });
      await blockedLine.scrollIntoViewIfNeeded();
      await expect(blockedLine).toBeInViewport();
      await page.getByRole("button", { name: "Stop after this one" }).click();
      // GUIDE R5 exception, the same live BSC round trip as the first run: the
      // next parallel in order is fetched and written before the run stops.
      await expect(
        page.getByRole("heading", { name: `Base parallels — stopped after 1 of ${parallels}` }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(blockedLine).toBeVisible();
      await expect(
        section.getByRole("listitem").filter({ hasText: `${parallel} — Built` }),
      ).toHaveCount(0);
      await expectAccessible(page, { label: "Base parallels run with a blocked parallel, stopped after one" });
      bodyFailed = false;
    } finally {
      // Let go of the copy so the parallel builds again on the next run.
      if (held) {
        try {
          await page.goto("/collection?tab=checklists");
          const checklist = await drillToCollectorChecklist(page, target);
          await checklist.getByRole("button", { name: `Details for ${held}`, exact: true }).click();
          const drawer = page.getByRole("dialog", { name: new RegExp(escapeRegExp(held)) });
          const yourCopies = drawer.getByRole("region", { name: `Your copies of ${held}` });
          await yourCopies.getByRole("button", { name: `Remove ${held}, Raw, Excellent`, exact: true }).click();
          // The list empties optimistically; "Removed ..." is the server's answer.
          await expect(drawer.getByRole("status").filter({ hasText: `Removed ${held}, Raw, Excellent` })).toBeVisible();
          await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
        } catch (error) {
          // A red body keeps its own error as the one the report shows.
          if (!bodyFailed) throw error;
          test.info().annotations.push({ type: "cleanup", description: `copy of ${held} not removed: ${String(error)}` });
        }
      }
    }
  },
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
