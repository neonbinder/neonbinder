// R1: when the chunk is gone for good, a visitor gets ONE automatic reload and
// then the crash message, never a reload loop (NEO-434). Every request for the
// chunk is answered 404 (support/stale-chunks.ts), so the reloaded page fails
// the same way and the reload guard stops a second attempt.
import { test, expect, expectAccessible } from "../../support/fixtures";
import { watchStaleChunks } from "../../support/stale-chunks";

const CRASH_MESSAGE = "An error occurred. Please refresh the page.";

test(
  "A page chunk that stays gone reloads once and then shows the error message",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    // Signed out (R4): a fresh context, so the reload guard starts empty.
    const chunks = watchStaleChunks(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();

    const about = page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "About", exact: true });
    await chunks.arm("fail-always");
    const injected = chunks.firstBlocked();
    await about.click();
    const gone = (await injected).url();

    // The give-up state, reached only by the reloaded page failing again.
    await expect(page.getByText(CRASH_MESSAGE)).toBeVisible();
    await expect(page.getByRole("heading", { name: "About Neon Binder" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/about$/);
    await expectAccessible(page, { label: "Error message after a chunk that stays gone" });

    // The same file was asked for in two documents and refused both times,
    // and exactly one reload happened between them.
    expect(chunks.statusesOf(gone)).toEqual([404, 404]);
    expect(chunks.navigations()).toBe(1);
  },
);
