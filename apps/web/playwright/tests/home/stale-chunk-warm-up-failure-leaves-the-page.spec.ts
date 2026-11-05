// R1: a background warm-up that fails (here the collection demo's chunk, warmed
// when a visitor focuses "Check it Out") must leave the page exactly where it
// is: no reload, no error message (NEO-434). Only the route's own failed
// import may reload the page; a warm-up pulling the page out from under
// someone mid-form is the regression this guards.
import { test, expect } from "../../support/fixtures";
import { watchStaleChunks } from "../../support/stale-chunks";

const CRASH_MESSAGE = "An error occurred. Please refresh the page.";

test(
  "A failed background warm-up does not reload the page or show an error",
  { tag: ["@smoke", "@home"] },
  async ({ page }) => {
    // Signed out (R4): a fresh browser context.
    const chunks = watchStaleChunks(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();

    // Focusing the link warms the demo's chunk; answer that request 404.
    const checkItOut = page.getByRole("region", { name: "Check it Out" }).getByRole("link", { name: "Check it Out", exact: true });
    const injected = chunks.firstBlocked();
    await chunks.injectDuring("fail-always", () => checkItOut.focus());
    await injected;

    // The warm-up failed and the page is untouched: still the landing page,
    // still interactive, no message.
    await expect(page.getByRole("button", { name: "Get Started" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText(CRASH_MESSAGE)).toHaveCount(0);

    // Positive anchor for "no reload": the same document still navigates the
    // app by itself. Stop the injection so this unrelated route loads, then
    // count the document requests since arming: none.
    chunks.disarm();
    await page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "About", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "About Neon Binder" })).toBeVisible();
    await expect(page.getByText(CRASH_MESSAGE)).toHaveCount(0);
    expect(chunks.navigations()).toBe(0);
  },
);
