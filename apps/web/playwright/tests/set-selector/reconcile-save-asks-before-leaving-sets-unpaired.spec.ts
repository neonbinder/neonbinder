// NEO-339, R1: pressing Save in the Reconcile dialog never leaves the set's own
// sets behind silently. While BSC sets (and SportLots sets inside the default
// prefix filter) wait in Pending, Save opens "Leave N sets unpaired?" first:
//   (a) the step names its count and lists each set with its marketplace, the
//       Ready sets are not among them, and nothing is saved yet (the dialog
//       behind is still up and its Save still reads "Save N sets");
//   (b) focus opens on Cancel; Cancel and Escape each go back to the same
//       dialog, the same counts, focus returned to Save;
//   (c) the step offers "Leave them, save N sets" with the Ready count.
// The saving half ("Leave them" writes only the Ready sets; a dialog with
// nothing in Pending saves at once) is proved where a WRITE is allowed: the
// registered sole-writer reconcile specs press Save through `saveReconcile`
// (support/set-builder.ts), which asserts the step or the direct save from the
// dialog's own Pending columns, and
// reconcile-sportlots-twins-save-each-to-its-own-set reads back that a listed
// set got no row.
//
// READ-ONLY (R7a, SET-REGISTRY.md -> "SportLots twin names"): the seeded 2024
// Topps Chrome `Parallel` reconcile, the same dialog the twins read-only spec
// opens. It never presses "Leave them" and never saves: `openLeaveStep` refuses
// to press Save at all unless the Pending columns list something, and the spec
// leaves through the dialog's own Cancel (no edits, so no discard question).
// What the seed leaves in Pending there is its own `pending: leave` decisions:
// BSC's `Black Refractors` (its SportLots twin is never auto-linked) and
// SportLots' `Chrome Update Sapphire` twins (inside the default "Chrome" prefix).
//
// Paused SportLots: the Parallel column takes the single-platform store path,
// no dialog opens; the spec asserts the Sync button and stops (as the twins
// read-only spec does).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { columnHeading, drillToSet, openLeaveStep, pick, setBuilderReady } from "../../support/set-builder";

/** A pair the seed saved: Ready, so the step must not list it. */
const READY_ROW = "Sepia Refractors";
/** BSC's parallel the seed leaves unpaired (SET-REGISTRY.md: "BSC `Black Refractors` stays in Pending"). */
const BSC_LEFT = "Black Refractors";
/** SportLots' twin inside the default prefix filter (SET-REGISTRY.md: "SportLots twin names"). */
const SL_LEFT = "Chrome Update Sapphire";

test(
  "Reconcile — Save lists the set's own sets still in Pending before leaving them, and Cancel or Escape goes back with nothing saved (NEO-339, read-only)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToSet(page, env);
    await pick(page, "Variant Types", "Parallel", { search: false });
    await expect(columnHeading(page, "Parallels")).toBeVisible();
    const sync = page.getByRole("button", { name: "Sync Parallels" });
    await expect(sync).toBeVisible();

    // Paused: one marketplace, nothing to reconcile; the Sync button is all there is.
    if (env.SL_PAUSED) return;

    await sync.click();
    const dialog = page.getByRole("dialog", { name: "Reconcile Parallels" });
    // Sync Parallels drives a live BSC + SportLots round trip (R5, the marketplace
    // exception; the twins read-only spec waits the same 60 s for this dialog).
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    const summary = dialog.getByText(/^[0-9]+ ready, [0-9]+ pending$/);
    await expect(summary).toBeVisible();
    const before = (await summary.textContent()) ?? "";
    const pending = Number(before.match(/, ([0-9]+) pending/)?.[1]);

    // ── (a) Save with sets in Pending opens the step, listing them; nothing is saved ──
    const { step, save, saved, left } = await openLeaveStep(page, dialog, {
      placed: [READY_ROW],
      axe: "Leave N sets unpaired step (2024 Topps Chrome Parallel reconcile)",
    });
    // The seed's own leftovers are named, each with its marketplace.
    expect(left, "BSC's Black Refractors waits in Pending").toContainEqual({ name: BSC_LEFT, side: "BSC" });
    expect(
      left.some((set) => set.side === "SportLots" && set.name.startsWith(SL_LEFT)),
      "SportLots' Chrome Update Sapphire twins wait in Pending",
    ).toBe(true);
    // The step asks about Pending sets only: no more than the dialog says are pending.
    expect(left.length).toBeLessThanOrEqual(pending);
    // And it offers to save exactly the Ready sets.
    await expect(
      step.getByRole("button", { name: `Leave them, save ${saved} ${saved === 1 ? "set" : "sets"}`, exact: true }),
    ).toBeVisible();
    await expect(summary).toHaveText(before);

    // ── (b) Cancel goes back: same dialog, same counts, focus on Save ──
    await step.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(step).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(summary).toHaveText(before);
    await expect(save).toHaveText(`Save ${saved} sets`);
    await expect(save).toBeFocused();

    // ── (b) Escape does the same, and only closes the step ──
    await save.click();
    await expect(step).toBeVisible();
    await expect(step.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(step).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(summary).toHaveText(before);
    await expect(save).toHaveText(`Save ${saved} sets`);
    await expect(save).toBeFocused();

    // ── Out through the dialog's own Cancel: no edits were made, so no discard question ──
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(sync).toBeVisible();
  },
);
