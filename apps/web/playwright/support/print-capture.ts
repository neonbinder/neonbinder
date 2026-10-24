/**
 * Capture what the app hands to the printer, without opening the printer.
 *
 * WHY THIS IS ALLOWED (GUIDE hard rule 2). The print document lives in a
 * hidden, aria-hidden iframe the user never sees, and the only thing that ever
 * shows it is the browser's print dialog, which Playwright cannot assert and
 * which would hang the run. So the proof is taken where the browser takes it:
 * an init script replaces `window.print` in every frame, and the replacement
 * reports what the browser WOULD have printed (the document's `@page` rule,
 * its backgrounds, where the label sits on the page, its text) as one console
 * line. No spec locates anything: the page is still driven by role and name,
 * and nothing here is a selector, an id or a test id. The stub is an
 * environment substitute for a native dialog (like a stubbed download), and
 * the assertion is on the print output itself.
 *
 * The print document's own shape (lib/print/print-html.ts `buildDocument`) is
 * the contract this reads: a page box that is the first child of `<body>`, the
 * label turned onto it as the box's first child, and the label's own content
 * as that box's first child. It is walked by position, never matched by name.
 */
import { expect, type Page } from "@playwright/test";

const PRINT_REPORT = "[e2e-print] ";

type Box = { x: number; y: number; width: number; height: number };

export type PrintReport = {
  /** True when print() was called on the print iframe, never the app page. */
  inFrame: boolean;
  /** Every `@page` rule in the printed document, whitespace-collapsed. */
  pageRules: string[];
  pageBackground: string;
  bodyBackground: string;
  /** The page box: what the printer is fed. Null if the body is empty. */
  paper: Box | null;
  /** The label's box: layout size (before turning) and where it lands (after). */
  turned: { layoutWidth: number; layoutHeight: number; landed: Box } | null;
  /** The label's own content. */
  content: { layoutWidth: number; layoutHeight: number; background: string } | null;
  /** All text the label carries, whitespace-collapsed. */
  text: string;
};

/** Replace the native print dialog in every frame, before any page script. */
export async function stubPrintDialog(page: Page): Promise<void> {
  await page.addInitScript((prefix) => {
    window.print = () => {
      const rectOf = (el: Element | null | undefined) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const pageRules: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSPageRule) pageRules.push(rule.cssText.replace(/\s+/g, " "));
        }
      }
      const paper = document.body.firstElementChild;
      const turned = paper?.firstElementChild as HTMLElement | null | undefined;
      const content = turned?.firstElementChild as HTMLElement | null | undefined;
      console.log(
        prefix +
          JSON.stringify({
            inFrame: window !== window.top,
            pageRules,
            pageBackground: getComputedStyle(document.documentElement).backgroundColor,
            bodyBackground: getComputedStyle(document.body).backgroundColor,
            paper: rectOf(paper),
            turned: turned
              ? {
                  layoutWidth: turned.offsetWidth,
                  layoutHeight: turned.offsetHeight,
                  landed: rectOf(turned),
                }
              : null,
            content: content
              ? {
                  layoutWidth: content.offsetWidth,
                  layoutHeight: content.offsetHeight,
                  background: getComputedStyle(content).backgroundColor,
                }
              : null,
            text: (document.body.textContent ?? "").replace(/\s+/g, " ").trim(),
          }),
      );
    };
  }, PRINT_REPORT);
}

/**
 * Run `trigger` (the click that prints) and return what was handed to the
 * printer. Call {@link stubPrintDialog} before the page loads. The listener is
 * armed before the click; the 7 s budget is the suite's default.
 */
export async function capturePrint(
  page: Page,
  trigger: () => Promise<void>,
): Promise<PrintReport> {
  const printed = page.waitForEvent("console", {
    predicate: (message) => message.text().startsWith(PRINT_REPORT),
    timeout: 7_000,
  });
  await trigger();
  return JSON.parse((await printed).text().slice(PRINT_REPORT.length)) as PrintReport;
}

/**
 * A 6in x 4in label fed to a 4x6 label printer: the printed page is the
 * portrait 4in x 6in paper (the page the roll really is), and the landscape
 * label is turned 90deg clockwise onto it so it fills the paper exactly.
 *
 * "Turned clockwise and filling the paper" is read from geometry, not from a
 * transform string: the label lays out 576 x 384 px (6in x 4in at 96 dpi) yet
 * lands in a 384 x 576 px box at the paper's top-left corner. Turned the other
 * way, or not turned, it would land elsewhere or keep the landscape shape.
 */
export function expectRotatedFourBySixPage(report: PrintReport): void {
  // It is the print document that was printed, never the app page itself.
  expect(report.inFrame).toBe(true);

  // The page the printer is asked for: portrait 4in x 6in, no margin.
  expect(report.pageRules).toHaveLength(1);
  expect(report.pageRules[0]).toMatch(/size: 4in 6in/);
  expect(report.pageRules[0]).not.toMatch(/size: 6in 4in/);
  expect(report.pageRules[0]).toMatch(/margin: 0(px)?;/);

  // The paper box is the portrait 384 x 576 px page at the origin.
  expect(report.paper).not.toBeNull();
  expect(report.paper!.x).toBeCloseTo(0, 1);
  expect(report.paper!.y).toBeCloseTo(0, 1);
  expect(report.paper!.width).toBeCloseTo(384, 1);
  expect(report.paper!.height).toBeCloseTo(576, 1);

  // The label keeps its landscape layout, turned onto the paper.
  expect(report.turned).not.toBeNull();
  expect(report.turned!.layoutWidth).toBe(576);
  expect(report.turned!.layoutHeight).toBe(384);
  expect(report.turned!.landed.x).toBeCloseTo(0, 1);
  expect(report.turned!.landed.y).toBeCloseTo(0, 1);
  expect(report.turned!.landed.width).toBeCloseTo(384, 1);
  expect(report.turned!.landed.height).toBeCloseTo(576, 1);
}
