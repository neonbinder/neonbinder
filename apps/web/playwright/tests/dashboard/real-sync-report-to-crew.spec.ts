// R1: a collector whose set a sync held cards back from, for a reason only our
// crew can fix (the marketplace numbers the card differently), reports it from
// the dashboard's Sync status (NEO-536). The report stands under "With our
// crew" and can be withdrawn and sent again; the crew sees it under "From
// collectors", follows it to Card Requests (`?kind=sync&open=<id>`), where
// Not a bug is refused without a note and Mark fixed closes it with one; the
// collector's dashboard no longer lists it, and My requests (`?ask=mine`)
// shows it as Fixed with the crew's note.
//
// A held-back set is a state only a real sync produces, so the spec seeds NB's
// own record of one with /testing/seed-dashboard?syncHeld=numberMismatch
// (`seedMyTestSync`, `clearMyTestDashboardSeeds`: the caller's own marked rows,
// refused off testing deployments; nothing seeded makes NB call a marketplace).
//
// Every E2E account is an admin, so the spec plays both sides on one account:
// the collector-only view (no "From collectors", no review) is covered by the
// unit tests (`CrewDesk.test.tsx`, `syncReports.test.ts`), not here.
//
// R7/R7a: writes only the signed-in user's own rows: a box and one copy in it on
// one card of the seed's 2024 Topps Chrome Base (registered in SET-REGISTRY.md),
// the marked sync seeds, and its own sync report (a `syncReports` row, closed
// by the spec). Self-cleaning: the report is closed, the seeds cleared, the copy
// removed and the box deleted through the UI; an afterEach withdraws an open
// report, clears the seeds, removes the copy and deletes the box on a failure
// (the report and seeds first: left behind, they would show on this account's
// dashboard and in every admin's queue). The box's name and the notes are single
// tokens minted from `env.ATTEMPT_TOKEN`.
import { createBox, deleteBoxNamed, deleteOpenBox, drillToCollectorBase, inventoryTabs, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import type { Page } from "@playwright/test";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the body has written so far, so the failure hook can take it back. */
const written: { box?: string; card?: { short: string; number: string; player: string }; reported?: boolean } = {};

/** The card's panel, by its title ("2024 Topps Chrome #<number> <player>..."). */
const drawerOf = (page: Page, card: { number: string; player: string }) =>
  page.getByRole("dialog", { name: new RegExp(`^2024 Topps Chrome #${escapeRegExp(card.number)} ${escapeRegExp(card.player)}`) });

/** The BuySportsCards set on the dashboard's Sync status, by its heading ("<set> on BuySportsCards"). */
const bscSet = (page: Page) =>
  page
    .getByRole("region", { name: "Sync status" })
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { level: 3, name: / on BuySportsCards$/ }) });

const REPORTED = "Reported. Our crew's on it.";
const WITHDRAW_REPORT = /^Withdraw report for /;

// A failed run must not leave an open report, its seeds, its copy or its box behind (the report would sit in every
// admin's queue, the seeds on this account's dashboard for the next spec on this worker). Each step runs even when
// an earlier one fails, and the first failure is rethrown at the end.
test.afterEach(async ({ context }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const clean = await context.newPage();
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    if (written.reported) {
      await attempt(async () => {
        await clean.goto("/dashboard");
        await expect(clean.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
        const set = bscSet(clean);
        const reportedLine = set.getByText(REPORTED);
        const reportButton = set.getByRole("button", { name: /^Report to our crew about /, exact: false });
        // The set settles on one of two: still reported (withdraw it), or the body already closed it.
        await expect(reportedLine.or(reportButton)).toBeVisible();
        if (await reportedLine.isVisible()) {
          await clean.getByRole("button", { name: WITHDRAW_REPORT }).click();
          await expect(reportButton).toBeVisible();
        }
      });
    }
    await attempt(async () => {
      await clean.goto("/testing/seed-dashboard?clear=1");
      await expect(clean).toHaveURL(/\/dashboard$/);
      await expect(clean.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible();
    });
    const { card, box } = written;
    if (card) {
      await attempt(async () => {
        await clean.goto("/inventory?tab=checklists");
        const stock = await drillToCollectorBase(clean);
        const drawer = drawerOf(clean, card);
        await stock.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
        const yourCopies = drawer.getByRole("region", { name: `Your copies of ${card.short}`, exact: true });
        const none = yourCopies.getByText("None yet. Fill in what you know below and add it.");
        const remove = yourCopies.getByRole("button", { name: `Remove ${card.short}, Raw, Excellent`, exact: true });
        // The body added one copy, or died before it did: the panel settles on one of the two.
        await expect(none.or(remove)).toBeVisible();
        if (await remove.isVisible()) {
          await remove.click();
          await expect(none).toBeVisible();
        }
        await drawer.getByRole("button", { name: "Close card detail" }).click();
        await expect(drawer).toBeHidden();
      });
    }
    if (box) await attempt(() => deleteBoxNamed(clean, box));
  } finally {
    await clean.close();
    written.box = undefined;
    written.card = undefined;
    written.reported = undefined;
  }
  if (failures.length > 0) throw failures[0];
});

test(
  "Dashboard: a set held back for a reason only our crew can fix is reported from Sync status, reviewed and closed by the crew, and shows as fixed in My requests",
  { tag: ["@dashboard"] },
  async ({ page, signIn, env }) => {
    const box = `Report${env.ATTEMPT_TOKEN}`;
    const note = `Numbering${env.ATTEMPT_TOKEN}`;
    const crewNote = `Relinked${env.ATTEMPT_TOKEN}`;
    const greeting = page.getByRole("heading", { level: 1, name: "Welcome back, slugger." });

    // --- A box with one card in it: what the held-back seed hangs on ----------
    // Any seeds a broken earlier run left are cleared first (the page then forwards to the dashboard).
    await signIn("/testing/seed-dashboard?clear=1");
    await expect(greeting).toBeVisible({ timeout: LAUNCH_GATE });
    await page.goto("/inventory?tab=boxes");
    await expect(page.getByRole("list", { name: "Your boxes" })).toBeVisible();
    await createBox(page, box);
    written.box = box;
    await page.goto("/inventory?tab=checklists");
    await expect(inventoryTabs(page).getByRole("link", { name: "Checklists", exact: true })).toHaveAttribute("aria-current", "page");
    const stock = await drillToCollectorBase(page);
    // The sixth ordinary row: the other dashboard specs on this account use the first five.
    const row = ordinaryBaseRows(stock).nth(5);
    await expect(row).toBeVisible();
    const card = await shortNameOf(row);
    written.card = card;
    const drawer = drawerOf(page, card);
    await stock.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${card.short}`, exact: true });
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add a copy", exact: true });
    await addForm.getByRole("combobox", { name: "Where it lives" }).selectOption({ label: `${box} (box, for sale)` });
    await addForm.getByRole("spinbutton", { name: "Price", exact: true }).fill("2");
    await addForm.getByRole("button", { name: "Add to inventory" }).click();
    await expect(drawer.getByRole("status").filter({ hasText: `Added ${card.short}, Raw, Excellent` })).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- Seed a set held back for a numbering the crew must fix, then the dashboard ---
    await page.goto("/testing/seed-dashboard?syncHeld=numberMismatch");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(greeting).toBeVisible();

    // BuySportsCards' block: the tile says it numbers the card differently, the lead says it is on our crew.
    const set = bscSet(page);
    await expect(set).toBeVisible();
    await expect(set.getByRole("link", { name: /numbers this card differently/ })).toBeVisible();
    await expect(set.getByText("That one's on our crew, not you. Report it and we'll fix it:")).toBeVisible();
    const reportButton = set.getByRole("button", { name: /^Report to our crew about .+ on BuySportsCards$/ });
    await expect(reportButton).toBeVisible();
    // "<set label>", read off the button's own name so the later rows are found by what they say.
    const setLabel = /^Report to our crew about (.+) on BuySportsCards$/.exec((await reportButton.textContent())?.trim() ?? "")?.[1];
    expect(setLabel, "the set's label, from the Report button's name").toBeTruthy();

    // --- Report it with a note ------------------------------------------------
    const reportWithNote = async () => {
      await reportButton.click();
      const noteField = set.getByRole("textbox", { name: /^Note for our crew \(optional\)/ });
      await expect(noteField).toBeFocused();
      await noteField.fill(note);
      written.reported = true;
      await set.getByRole("button", { name: /^Send report on / }).click();
      await expect(set.getByText(REPORTED)).toBeVisible();
    };
    await reportWithNote();
    await expect(reportButton).toHaveCount(0);

    // "With our crew" lists it, one line, with a way to take it back.
    const withCrew = page.getByRole("region", { name: "With our crew" });
    const mine = withCrew.getByRole("listitem").filter({ hasText: "Sync report" }).filter({ hasText: setLabel! });
    await expect(mine).toBeVisible();
    await expect(mine).toContainText("BuySportsCards");
    await expectAccessible(page, { label: "Dashboard, a set reported to the crew" });

    // --- Withdraw: gone from the list, Report is back; report again ---------------
    await mine.getByRole("button", { name: WITHDRAW_REPORT }).click();
    await expect(mine).toHaveCount(0);
    written.reported = false;
    await expect(reportButton).toBeVisible();
    await expect(set.getByText(REPORTED)).toHaveCount(0);
    await reportWithNote();
    await expect(mine).toBeVisible();

    // --- The crew's side: "From collectors" links to the review --------------------
    const fromCollectors = page.getByRole("region", { name: "From collectors" });
    const theirs = fromCollectors.getByRole("link").filter({ hasText: "Sync report" }).filter({ hasText: setLabel! });
    await expect(theirs).toBeVisible();
    await theirs.click();
    await expect(page).toHaveURL(/\/admin\/card-requests\?/);
    await expect(page).toHaveURL(/[?&]kind=sync(&|$)/);
    await expect(page).toHaveURL(/[?&]open=[^&]+/);
    const review = page.getByRole("region", { name: "Review" });
    await expect(review.getByRole("heading", { level: 3, name: `Sync report: ${setLabel}`, exact: true })).toBeVisible();
    await expect(review.getByText(note)).toBeVisible();
    await expect(review.getByText(/numbers this card differently/)).toBeVisible();
    await expectAccessible(page, { label: "Card Requests, a sync report open for review" });

    // --- Not a bug needs a note: refused without one -------------------------------
    await review.getByRole("button", { name: "Not a bug", exact: true }).click();
    await expect(review.getByRole("alert").filter({ hasText: "Add a note saying why it isn't a bug." })).toBeVisible();
    await expect(page).toHaveURL(/[?&]open=[^&]+/);
    await expect(review.getByRole("button", { name: "Mark fixed", exact: true })).toBeVisible();

    // --- Mark fixed, with our note; Back returns to the list, without the report ------
    await review.getByRole("textbox", { name: "Note to the collector" }).fill(crewNote);
    await review.getByRole("button", { name: "Mark fixed", exact: true }).click();
    await expect(review.getByRole("status").filter({ hasText: "Marked fixed." })).toBeVisible();
    written.reported = false;
    await review.getByRole("button", { name: "Back to the list", exact: true }).click();
    await expect(page).toHaveURL(/[?&]kind=sync(&|$)/);
    await expect(page).not.toHaveURL(/[?&]open=/);
    await expect(review.getByText("Pick a report to review it.")).toBeVisible();
    const reports = page.getByRole("region", { name: "Reports" });
    await expect(reports.getByRole("button").filter({ hasText: setLabel! })).toHaveCount(0);
    await expect(reports.getByText(note)).toHaveCount(0);

    // Back steps off Card Requests to the dashboard it was followed from.
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(greeting).toBeVisible();

    // --- The dashboard: the report is gone from "With our crew", Report is offered again ---
    await expect(bscSet(page).getByRole("button", { name: /^Report to our crew about .+ on BuySportsCards$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: WITHDRAW_REPORT })).toHaveCount(0);
    await expect(page.getByRole("listitem").filter({ hasText: "Sync report" }).filter({ hasText: setLabel! })).toHaveCount(0);

    // --- My requests: the report, Fixed, with the crew's note -----------------------
    await page.goto("/collection?tab=checklists&ask=mine");
    const dialog = page.getByRole("dialog", { name: "Can't find it?" });
    await expect(dialog.getByRole("tab", { name: "My requests", selected: true })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Sets you reported" })).toBeVisible();
    const reported = dialog
      .getByRole("list", { name: "My sync reports" })
      .getByRole("listitem")
      .filter({ hasText: setLabel! })
      .filter({ hasText: crewNote });
    await expect(reported).toBeVisible();
    await expect(reported).toContainText("BuySportsCards");
    await expect(reported).toContainText("Fixed");
    await expect(reported).toContainText(`Your note: ${note}`);
    await expect(reported).toContainText(`From our crew: ${crewNote}`);
    await expect(reported.getByRole("button", { name: /^Withdraw/ })).toHaveCount(0);
    await expectAccessible(page, { label: "My requests, a report the crew fixed" });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // --- Clear the seeds, then cleanup through the UI: remove the copy, delete the box ---
    await page.goto("/testing/seed-dashboard?clear=1");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(greeting).toBeVisible();
    await expect(page.getByRole("region", { name: "Sync status" }).getByRole("article")).toHaveCount(0);
    await page.goto("/inventory?tab=checklists");
    const again = await drillToCollectorBase(page);
    await again.getByRole("button", { name: `Details for ${card.short}`, exact: true }).click();
    await yourCopies.getByRole("button", { name: `Remove ${card.short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await page.goto("/inventory?tab=boxes");
    await page.getByRole("list", { name: "Your boxes" }).getByLabel(new RegExp(`^${escapeRegExp(box)}, box, `)).click();
    await deleteOpenBox(page, box);
    await expect(page.getByRole("list", { name: "Your boxes" }).getByLabel(new RegExp(`^${escapeRegExp(box)}, box, `))).toHaveCount(0);
  },
);
