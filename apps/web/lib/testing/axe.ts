/**
 * NEO-370 — axe-core for component tests (happy-dom), for screen states the
 * E2E suite cannot stage (a failed sync, an expired sign-in, a seller
 * account listing elsewhere, a populated Sales list…).
 *
 *   await expectAccessibleInBothModes(view.container, { label: "listing panel, sync error" });
 *
 * Same rules as the E2E check (`playwright/support/a11y.ts`, `expectAccessible`):
 * WCAG 2.0 / 2.1 / 2.2, A + AA, checked once painted light and once painted
 * dark, ending dark. The mode is flipped the way the app flips it: the
 * ThemeProvider writes `<html data-theme>`, and every component outside a
 * provider (`useTheme()`'s fallback) reads that attribute at render, so the
 * helper sets it and re-renders before each pass.
 *
 * One difference, deliberately: `color-contrast` is off. happy-dom loads no
 * stylesheet and computes no cascaded colours, so axe would judge contrast
 * against nothing and pass or fail at random. Contrast stays covered by the
 * E2E axe check, which runs in a real browser in both modes.
 *
 * Violations are product bugs: fix the product, never add an exclusion here.
 */
import axe from "axe-core";

/**
 * Keep in step with `WCAG_TAGS` in playwright/support/a11y.ts (that file
 * imports Playwright, so the unit run cannot import it). `axe.test.ts` pins
 * the two lists equal.
 */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

/** Rules the unit check cannot judge in happy-dom, each with why. */
export const UNIT_DISABLED_RULES: Readonly<Record<string, string>> = {
  "color-contrast": "happy-dom computes no cascaded colours; the E2E axe check covers contrast in both modes.",
};

export type Mode = "light" | "dark";

function summarize(violations: axe.Result[]): string[] {
  return violations.map((v) => {
    const first = v.nodes[0]?.target?.[0];
    const where = first ? `; first: ${Array.isArray(first) ? first.join(" >>> ") : String(first)}` : "";
    return `[${v.impact ?? "unknown"}] ${v.id}: ${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"}${where})`;
  });
}

/** Run axe over `context` in the mode `<html data-theme>` paints now. Returns one line per violated rule. */
export async function axeViolations(context: Element): Promise<string[]> {
  const results = await axe.run(context, {
    runOnly: { type: "tag", values: [...WCAG_TAGS] },
    rules: Object.fromEntries(Object.keys(UNIT_DISABLED_RULES).map((id) => [id, { enabled: false }])),
    resultTypes: ["violations"],
  });
  return summarize(results.violations);
}

/**
 * Fails with every violation, labelled by mode, after checking `context`
 * light and then dark. `rerender` re-renders the component under test with a
 * FRESH element (re-rendering the same element bails out), so a component
 * that reads the mode at render paints the new one. Leaves the page dark.
 */
export async function expectAccessibleInBothModes(
  context: Element,
  opts: { label: string; rerender?: () => void },
): Promise<void> {
  const failures: string[] = [];
  const html = document.documentElement;
  for (const mode of ["light", "dark"] as const) {
    html.dataset.theme = mode;
    opts.rerender?.();
    for (const line of await axeViolations(context)) failures.push(`${mode}: ${line}`);
  }
  html.dataset.theme = "dark";
  if (failures.length > 0) {
    throw new Error(`axe found violations in ${opts.label}:\n${failures.join("\n")}`);
  }
}
