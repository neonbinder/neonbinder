// R1: a card a board on On the Bubble names as still needed opens its card panel over the
// dashboard, and its ↓ steps through the board's other needs (NEO-464). On a phone the first
// needs are rows of their own, each a full 44px target (a thumb never lands on its neighbour in
// the one-line list); on a wider screen they are links in the board's Need line. The public
// demo's 1996 Playoff Contenders board has a Want List card first (Deion Sanders #13, starred)
// and more needs behind it. Signed out, fake data, read-only (R7).
import { test, expect } from "../../support/fixtures";

test(
  "Dashboard demo: a board's needed cards open their card panel, as 44px rows on a phone",
  { tag: ["@smoke", "@dashboard"] },
  async ({ page, isMobile }) => {
    // Signed out: every test starts in a fresh browser context (R4).
    await page.goto("/demo");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();

    const board = page
      .getByRole("region", { name: "On the Bubble" })
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { level: 3, name: "1996 Playoff Contenders" }) });
    await expect(board).toBeVisible();
    // The Want List card leads the needs, spoken as such for a reader.
    const wantedNeed = board.getByRole("link", { name: /^On your Want List: 1996 Playoff Contenders Deion Sanders #13 / });
    await expect(wantedNeed).toBeVisible();

    if (isMobile) {
      // The phone's needs: the first two as rows, each at least 44px tall and as wide as a thumb needs,
      // and the rest said as "+N more".
      const chips = board.getByRole("list").getByRole("link");
      await expect(chips).toHaveCount(2);
      // (The wider line's own "+N more" is in the page too, hidden: only the one showing counts.)
      await expect(board.getByText(/^\+\d+ more$/).filter({ visible: true })).toBeVisible();
      for (const chip of await chips.all()) {
        const box = await chip.boundingBox();
        expect(box, "a need row on screen").not.toBeNull();
        expect(box!.height, "a need row is a 44px target").toBeGreaterThanOrEqual(44);
        expect(box!.width, "a need row is a 44px target").toBeGreaterThanOrEqual(44);
      }
    } else {
      // A wider screen names the needs in the one-line list, each its own link.
      await expect(board.getByRole("list")).toHaveCount(0);
      expect(await board.getByRole("link", { name: /#\d+ / }).count()).toBeGreaterThanOrEqual(2);
    }

    // A need opens its card panel (a Back step), the panel says it is the first of the board's needs, and
    // ↓ steps to the next. Back closes it with the keyboard on the need that opened it.
    await wantedNeed.click();
    await expect(page).toHaveURL(/\/demo\?(.*&)?detail=[^&]+$/);
    const panel = page.getByRole("dialog");
    await expect(panel.getByRole("button", { name: "Close card detail" })).toBeVisible();
    await expect(panel.getByText(/^Card 1 of \d+/)).toBeVisible();
    await panel.getByRole("button", { name: "Next card" }).click();
    await expect(panel.getByText(/^Card 2 of \d+/)).toBeVisible();
    await page.goBack();
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/detail=/);
    await expect(wantedNeed).toBeFocused();
  },
);
