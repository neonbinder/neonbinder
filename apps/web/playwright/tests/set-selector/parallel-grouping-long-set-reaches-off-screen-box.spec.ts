// NEO-472 (Jason, 2026-11-08).
//
// R1 - ONE FEATURE: on a set too long for one screen, an insert's "Parallels
// of" box is reachable from its row however far down it sits. Two ways in,
// both starting from a box that is off screen:
//
//   1. DRAG. A row dragged from the left pane toward the bottom of the
//      right-hand "Parallels by insert" pane scrolls that pane (dnd-kit's
//      autoscroll) until the last box comes into view, and dropping on it
//      makes the row a parallel. On a phone the panes stack and the dialog
//      body is the one scroller, so the same drag scrolls the body instead.
//   2. JUMP. Once that insert holds a parallel, its row's "has parallels" tag
//      is a button ("<name> has parallels. Jump to them") that brings the box
//      into view and moves focus to it, without selecting the row.
//
// FIXTURE: twenty single-token inserts, `pgl<token>a` ... `pgl<token>t`. The
// boxes are listed in the rows' order, so `...t`'s box is the last one, below
// nineteen others: off screen in the right pane on desktop and below the
// whole stacked list on a phone. None is a word-prefix of another, so Group
// Parallels suggests nothing and the drop is the only change.
//
// R7/R7a - ISOLATION: one per-attempt hand-made set, `pgl<token>`, under
// `E2E Test Sport <worker>` > 2026 > Topps (drillToCustomSet; SET-REGISTRY.md,
// Custom sets). Hand-made, so nothing waits on a marketplace: every wait is
// the 7 s budget. Per-attempt because the save is the proof, and a rerun must
// start with twenty top-level inserts. Nothing is deleted; the set stands.
//
// R9: the drill goes through drillToCustomSet; the inserts are made inline
// with "+ Custom", as the other Group Parallels specs make theirs.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import type { Locator } from "@playwright/test";
import {
  addCustomEntry,
  columnOption,
  columnSearch,
  drillToCustomSet,
  setBuilderReady,
} from "../../support/set-builder";

/** A locator's box; it must be laid out (a hidden one fails the spec here). */
async function rectOf(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect, "the element to be laid out").not.toBeNull();
  return rect!;
}

test(
  "Group Parallels on a long set — a drag scrolls the right pane to an off-screen box and drops there, and that insert's 'has parallels' jumps to and focuses its box (NEO-472)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ page, signIn, env, isMobile }) => {
    const T = env.ATTEMPT_TOKEN;
    const SET = `pgl${T}`;
    const names = "abcdefghijklmnopqrst".split("").map((c) => `pgl${T}${c}`);
    const first = names[0];
    const second = names[1];
    const last = names[names.length - 1];

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustomSet(page, env, { set: SET, variantType: "Insert" });
    for (const name of names) {
      await addCustomEntry(page, "Inserts", name, { confirm: "required" });
    }

    const dialog = page.getByRole("dialog", { name: "Group Parallels" });
    const inserts = dialog.getByRole("region", { name: "Inserts" });
    const boxes = dialog.getByRole("region", { name: "Parallels by insert" });
    const row = (name: string) => inserts.getByRole("group", { name, exact: true });
    const boxOf = (name: string) => boxes.getByRole("group", { name: `Parallels of "${name}"`, exact: true });

    await page.getByRole("button", { name: "Group Parallels" }).click();
    await expect(dialog.getByText(/Drag inserts under a parent/)).toBeVisible();
    await expect(dialog.getByText("No changes yet")).toBeVisible();
    // The two panes: the rows on the left, one box per row on the right.
    await expect(inserts.getByText("Top-level inserts")).toBeVisible();
    await expect(row(first)).toBeVisible();
    await expect(boxOf(first)).toBeVisible();
    // An empty box is one line: its name and where to drop.
    await expect(boxOf(first).getByText("drop here", { exact: true })).toBeVisible();
    // Nothing holds parallels yet, so no row offers a jump.
    await expect(inserts.getByRole("button", { name: /has parallels\. Jump to them$/ })).toHaveCount(0);
    await expectAccessible(page, { within: dialog, label: "Group Parallels dialog on a long set" });

    // ── CLAIM 1: A DRAG SCROLLS TO THE OFF-SCREEN BOX AND DROPS THERE ──
    // Precondition: the last box is below the fold (R2: the drag must be what
    // brings it into view).
    await expect(boxOf(last)).toBeAttached();
    await expect(boxOf(last)).not.toBeInViewport();

    // dnd-kit's MouseSensor starts a drag after 5 px of movement from a press
    // on the row; the drag then scrolls whichever scroller holds the pointer
    // near its edge, for as long as the pointer stays there.
    await row(first).scrollIntoViewIfNeeded();
    const from = await rectOf(row(first));
    const fromX = from.x + from.width / 2;
    const fromY = from.y + from.height / 2;
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(fromX + 12, fromY + 12, { steps: 4 });

    // Where the pointer parks: desktop, just inside the bottom of the
    // right-hand pane (the pane scrolls on its own); phone, the panes stack
    // and the dialog body is the one scroller, so just above the footer.
    const pane = await rectOf(boxes);
    const edgeX = pane.x + pane.width / 2;
    const edgeY = isMobile
      ? (await rectOf(dialog.getByText("No changes yet"))).y - 40
      : pane.y + pane.height - 12;
    await page.mouse.move(edgeX, edgeY, { steps: 10 });
    // Held still at the edge, the drag scrolls the box all the way in.
    await expect(boxOf(last)).toBeInViewport({ ratio: 1 });

    // Onto the box, then let go.
    const target = await rectOf(boxOf(last));
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
    await page.mouse.move(target.x + target.width / 2 + 1, target.y + target.height / 2, { steps: 1 });
    await page.mouse.up();

    // The drop landed: one promotion, the row now sits in the last box (with
    // its ✕), and it has left the top-level list.
    await expect(dialog.getByText("1 promotion, 0 demotions")).toBeVisible();
    await expect(boxOf(last).getByRole("group", { name: first, exact: true })).toBeVisible();
    await expect(boxOf(last).getByRole("button", { name: `Remove ${first} from parallels` })).toBeVisible();
    await expect(row(second)).toBeAttached();
    await expect(row(first)).toHaveCount(0);

    // ── CLAIM 2: "HAS PARALLELS" JUMPS TO THE BOX AND FOCUSES IT ──
    // The last insert holds a parallel now, so its row offers the jump.
    const jump = inserts.getByRole("button", { name: `${last} has parallels. Jump to them`, exact: true });
    await expect(jump).toBeVisible();
    // Put the box out of view again: the top of the right-hand list (the top
    // of the body on a phone), then the row's tag into view on the left. On a
    // phone the tag sits at the end of the top-level list, nineteen boxes
    // above the last one.
    await boxOf(second).scrollIntoViewIfNeeded();
    await jump.scrollIntoViewIfNeeded();
    await expect(jump).toBeInViewport();
    await expect(boxOf(last)).not.toBeInViewport();

    await jump.click();
    await expect(boxOf(last)).toBeFocused();
    await expect(boxOf(last)).toBeInViewport({ ratio: 1 });
    // The jump never selects the row: its name button stays unpressed and the
    // footer counts no selection.
    await expect(row(last).getByRole("button", { name: last, exact: true, pressed: false })).toBeVisible();
    await expect(dialog.getByText(/^\d+ selected/)).toHaveCount(0);
    await expect(dialog.getByText("1 promotion, 0 demotions")).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Group Parallels dialog after a has-parallels jump" });

    // ── SAVE: the drop was a real move ──
    await dialog.getByRole("button", { name: "Save 1 change" }).click();
    await expect(dialog).toBeHidden();
    await columnSearch(page, "Inserts").fill(last);
    await columnOption(page, "Inserts", last).click();
    await expect(columnOption(page, "Parallels", first)).toBeVisible();
  },
);
