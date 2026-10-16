// Origin: .maestro/flows/set-selector/gold-wave-build-from-base-row.yaml (NEO-339; Maestro suite retired in NEO-341)
//
// R1 — ONE FEATURE: A BASE PARALLEL'S OWN ROW BUILDS ITS CHECKLIST FROM BASE
// (NEO-321 D3), LINKED TO THE PARALLEL'S OWN MARKETPLACE CARDS ON EVERY PAGE.
// Baseball -> 2024 -> Topps -> Topps Chrome › Parallel › Gold Wave Refractors:
//   (e) the empty row's Sync slot is `Build from Base` (never `Fetch from
//       Marketplaces`), and pressing it builds at once: no Match Cards dialog,
//       no entity review, and the notice `Gold Wave Refractors — Built 300
//       cards…` (Base's 335 minus the 35 Gold Wave lists on neither side);
//   (f) the copies carry SportLots links (the `SL` badge). The build reads Gold
//       Wave's SportLots checklist page by page, and the list opens at its END
//       (the far SportLots pages), so a regression to a single page (NEO-137)
//       strips exactly the links read here. Paused, every copy is "BSC only".
// Both claims were the retired seed's Gold Wave block. The scripted seed now
// builds a DIFFERENT parallel (never Gold Wave, never the first buildable row).
//
// R3 — NOT RE-PROVED HERE: the section-level build, its confirm and Stop
// (base-parallels-build-from-section); Rebuild's confirm and the notice wording
// (ParallelBuildPanel unit tests).
//
// R7a — SOLE WRITER of Gold Wave's cards (SET-REGISTRY.md -> "The NEO-339
// flows on 2024 Topps Chrome"). The build reads Base and never writes it;
// copies take Base's players and teams, so nothing is minted. One concurrent
// Base writer exists: signed-by-autofills-from-players edits card #300, and a
// copy taken while that lands is skipped, so the notice admits exactly that
// one other outcome. Fresh-only: a re-run finds `Rebuild from Base` and fails
// by name. Each CI pass runs on its own reset and seed.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnOption,
  columnSearch,
  drillToSet,
  pick,
  setBuilderReady,
  syncChecklistButton,
} from "../../support/set-builder";
import { reviewWizard } from "../../support/wizard";

const PARALLEL = "Gold Wave Refractors";

test(
  "2024 Topps Chrome Parallel — a base parallel's row builds from Base with no dialog, and its last cards carry SportLots links (NEO-339)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // ── STEP 1: drill to Topps Chrome › Parallel › Gold Wave Refractors ──
    await drillToSet(page, env);
    await pick(page, "Variant Types", "Parallel", { search: false });
    // A PREFIX is typed so the box's own value can never be the row.
    await columnSearch(page, "Parallels").fill("Gold Wave Refractor");
    await columnOption(page, "Parallels", PARALLEL).click();
    await expect(page.getByRole("heading", { name: `Attributes for ${PARALLEL}` })).toBeVisible();

    // ── STEP 2 (e): the row's slot is the build, and it builds with no dialog ──
    // `Build from Base` renders once the server has named the source, so this
    // is also the wait for that read (7 s). Exact: the section above offers
    // "Build N parallels from Base", which would build EVERY parallel.
    const build = page.getByRole("button", { name: "Build from Base", exact: true });
    await expect(build).toBeVisible();
    // R2: no fetch on a base-parallel row (paired with the positive above).
    await expect(syncChecklistButton(page)).toHaveCount(0);
    await expectAccessible(page, { label: "Gold Wave Refractors, empty, Build from Base offered" });
    // An EMPTY parallel builds at once (only a parallel with cards asks to
    // replace them); a confirm here means a stale deployment and the notice
    // wait below fails by name.
    await build.click();

    // THE RESULT, pinned (`buildNotice`): "<parallel> — Built N cards[, clauses]."
    // Measured live (CI 37179999943): "Gold Wave Refractors — Built 300 cards,
    // 1 without a SportLots card, 35 left off — not on either marketplace's
    // list, 1 on SportLots that Base doesn't have." The count is anchored by a
    // following clause or the full stop; the one other outcome admitted is the
    // concurrent #300 edit (header): 299 built, "1 skipped — Base changed them
    // mid-build". R5 marketplace exception: a live BSC + paged SportLots
    // checklist fetch of ids nothing pre-synced, then the link pass and the
    // copy; measured 4.5 s, 30 s is the round-trip ceiling, never a budget.
    await expect(
      page.getByText(
        new RegExp(
          `^${PARALLEL} — Built (300 cards|299 cards(, [^.]+)?, 1 skipped — Base changed them mid-build)(, [^.]+)?\\.`,
        ),
      ),
    ).toBeVisible({ timeout: 30_000 });
    // D3: the pairing dialog and the entity review are retired here.
    await expect(page.getByRole("dialog", { name: /^Match Cards/ })).toHaveCount(0);
    await expect(reviewWizard(page)).toHaveCount(0);

    // ── STEP 3 (f): the copies carry their marketplace links ──
    // The checklist opens at its END (the far SportLots pages, ~#290-#300).
    await expect(page.getByText(/^#[0-9]/).first()).toBeVisible();
    if (!env.SL_PAUSED) {
      await expect(page.getByText("SL", { exact: true }).first()).toBeVisible();
    } else {
      // Base was fetched BSC-only, so every copy carries Base's "BSC only" tag.
      await expect(page.getByText("BSC only", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("SL", { exact: true })).toHaveCount(0);
    }
    await expectAccessible(page, { label: "Gold Wave Refractors built from Base" });
  },
);
