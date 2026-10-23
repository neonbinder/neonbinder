/**
 * NEO-356 no-flash exception, approved by Jason 2026-10-22.
 *
 * This file is the ONE place in the suite that reads under-the-covers state
 * (the `<html data-theme>` attribute, `page.addInitScript`, `page.evaluate`,
 * `page.locator("html")`). It covers the no-flash check ONLY: that the saved
 * mode is on the page from the first frame, before the app runs. A flash
 * is not perceivable after the fact, so the check has no role/label/text
 * handle. Nothing else may import this file, and every other theme assertion
 * stays perceivable (support/theme.ts: painted colour, the chosen radio).
 *
 * The record is deterministic, not timed. An init script runs before any page
 * script, so before index.html's inline pre-paint script, and logs:
 *   - "mutation": every change to `data-theme` (the pre-paint script's write,
 *     then any later flip once React mounts);
 *   - "body": the value at the moment the parser first inserts `<body>`, which
 *     is after the pre-paint script and before any deferred module script
 *     (the app) can run, so it is exactly what the first paint would show;
 *   - "frame": the value at the first animation frame.
 * Without the pre-paint script the "body" and "frame" values are the HTML's
 * dark default (or a late flip appears as a dark/light mutation pair).
 */
import { expect, type Page } from "@playwright/test";

export type ThemeLogEntry = { at: "mutation" | "body" | "frame"; value: string | null };

/** Start recording `data-theme` from document start on every later navigation. */
export async function recordThemeFromDocumentStart(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: ThemeLogEntry[] = [];
    (window as unknown as { __themeLog: ThemeLogEntry[] }).__themeLog = log;
    const value = () => document.documentElement?.getAttribute("data-theme") ?? null;
    new MutationObserver(() => log.push({ at: "mutation", value: value() })).observe(document, {
      attributes: true,
      attributeFilter: ["data-theme"],
      subtree: true,
    });
    const bodyWatch = new MutationObserver(() => {
      if (!document.body) return;
      log.push({ at: "body", value: value() });
      bodyWatch.disconnect();
    });
    bodyWatch.observe(document, { childList: true, subtree: true });
    requestAnimationFrame(() => log.push({ at: "frame", value: value() }));
  });
}

/**
 * Call once the page is up (a control of the app is on screen). Fails unless
 * the body-insert and first-frame samples exist and EVERY recorded value is
 * `mode`: the first frame was already `mode` and it never flipped.
 */
export async function expectNoFlash(page: Page, mode: "light" | "dark"): Promise<void> {
  const log = await page.evaluate(
    () => (window as unknown as { __themeLog: ThemeLogEntry[] }).__themeLog,
  );
  expect(log.map((entry) => entry.at)).toEqual(expect.arrayContaining(["body", "frame"]));
  expect(log.filter((entry) => entry.value !== mode)).toEqual([]);
}

/** The root attribute, for the bundle-blocked check (no app, so nothing perceivable renders). */
export function themeAttribute(page: Page) {
  // NEO-356 no-flash exception, approved by Jason 2026-10-22: the root element has no role or name.
  // eslint-disable-next-line no-restricted-properties
  return page.locator("html");
}
