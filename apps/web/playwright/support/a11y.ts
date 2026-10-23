/**
 * Accessibility checks (axe-core) for the E2E suite. Specs call
 * `expectAccessible` from ./fixtures, which wraps `checkAccessibility` below
 * in a boxed test step; nothing else should import this file directly.
 *
 *   await expect(page.getByRole("heading", { name: "Players" })).toBeVisible();
 *   await expectAccessible(page);                        // the whole page
 *   await expectAccessible(page, { within: dialog, label: "New Team dialog" });
 *
 * Rules: WCAG 2.0, 2.1 and 2.2, levels A and AA (the axe tags below). A
 * violation fails the test with one readable line per rule: impact, rule id,
 * what to fix, how many elements, the first element's selector. The full
 * result, minus every node's HTML, is attached to the test as JSON.
 *
 * Every call checks the screen TWICE, once painted light and once painted dark
 * (Jason, 2026-10-22: "axe should check both light and dark mode"), and always
 * ends with the OS dark, the suite pin. See `checkAccessibility`.
 *
 * Violations are product bugs: fix the product. Never add an exclusion here
 * to make a spec pass, and never exclude NeonBinder's own UI.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { pageHasBanner, paintsLook, type Look } from "./theme";

// axe-core's own types, reached through the package we depend on (axe-core
// itself is only its transitive dependency).
type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type Result = AxeResults["violations"][number];
type NodeResult = Result["nodes"][number];

/**
 * WCAG 2.0 / 2.1 / 2.2, A + AA. axe-core 4.13 tags WCAG 2.2's new success
 * criteria as `wcag22aa` only (target size); it has no `wcag22a` rule, so
 * there is no tag to add for it.
 */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

/**
 * Everything the check never looks inside, each with its reason. Only UI
 * that is not NeonBinder's and that NeonBinder cannot change belongs here.
 * Adding an entry needs the reason and owner sign-off; it is never a way to
 * get a red spec green.
 */
export const EXCLUDED_REGIONS: ReadonlyArray<{ selector: string; reason: string }> = [
  {
    selector: "vercel-live-feedback",
    reason:
      "Vercel's preview toolbar. Vercel injects it into preview deployments only (the CI target); production users never see it and NB cannot change it.",
  },
  {
    selector: ".cl-formFieldInputCopyToClipboardButton",
    reason:
      "Clerk's own icon-only copy button inside <APIKeys/> (rendered from Clerk's UI bundle) has no accessible name (button-name). NB renders none of it; pending owner sign-off to report upstream to Clerk (NEO-341).",
  },
];

export interface AccessibleOptions {
  /**
   * Check only this region (a dialog, a panel), located the way any spec
   * locates: by role, label or text. It must resolve to exactly one element.
   * Default: the whole page, which is what to use unless a screen genuinely
   * is the region (e.g. a dialog over a page another check already covered).
   */
  within?: Locator;
  /**
   * What the user is looking at, for the step title, the failure message and
   * the attachment name, e.g. "New Team dialog". Default: the page path.
   */
  label?: string;
}

/** The marker attribute that turns a perceivable Locator into an axe context. */
const SCOPE_ATTR = "data-e2e-axe-scope";

function describeNode(node: NodeResult): string {
  const target = node.target?.[0];
  return Array.isArray(target) ? target.join(" >>> ") : String(target ?? "");
}

/** One readable line per violated rule. Never includes node HTML. */
export function summarize(violations: Result[]): string[] {
  return violations.map((v) => {
    const n = v.nodes.length;
    const first = v.nodes[0] ? `; first: ${describeNode(v.nodes[0])}` : "";
    return `[${v.impact ?? "unknown"}] ${v.id}: ${v.help} (${n} element${n === 1 ? "" : "s"}${first}) ${v.helpUrl}`;
  });
}

/**
 * The attachment. Node HTML is dropped: blob and merged reports are public
 * CI artifacts, and a page's markup can carry the signed-in account's own
 * details. Selectors and axe's fix-it text are enough to find the element.
 */
function sanitize(results: AxeResults) {
  const rule = (r: Result) => ({
    id: r.id,
    impact: r.impact,
    help: r.help,
    helpUrl: r.helpUrl,
    tags: r.tags,
    nodes: r.nodes.map((n) => ({ target: n.target, impact: n.impact, failureSummary: n.failureSummary })),
  });
  return {
    testEngine: results.testEngine?.version,
    violations: results.violations.map(rule),
    // Needs-review results (e.g. contrast over an image): informational, never fail.
    incomplete: results.incomplete.map((r) => ({ id: r.id, impact: r.impact, help: r.help, count: r.nodes.length })),
    passes: results.passes.length,
  };
}

/** axe checks whatever is painted right now: let every finite animation and transition finish first. */
async function settle(page: Page): Promise<void> {
  // A dialog still fading in (Clerk's modals, Radix overlays), or a colour
  // transition still running after a mode flip, measures its text against a
  // half-blended layer and reports contrast the settled screen does not
  // have. Infinite animations (spinners, the neon glow) never settle and are
  // ignored.
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity),
    undefined,
    { timeout: 7_000 },
  );
}

async function runAxe(page: Page, opts: AccessibleOptions): Promise<AxeResults> {
  await settle(page);
  let builder = new AxeBuilder({ page }).withTags([...WCAG_TAGS]);
  for (const { selector } of EXCLUDED_REGIONS) builder = builder.exclude(selector);

  let token: string | undefined;
  if (opts.within) {
    // axe takes a CSS context, specs never write CSS: mark the one element
    // the Locator resolves to, scope to the mark, remove it afterwards.
    token = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await opts.within.evaluate((el, [attr, value]) => el.setAttribute(attr, value), [SCOPE_ATTR, token] as const);
    builder = builder.include(`[${SCOPE_ATTR}="${token}"]`);
  }
  try {
    return await builder.analyze();
  } finally {
    if (opts.within && token) {
      await opts.within.evaluate((el, attr) => el.removeAttribute(attr), SCOPE_ATTR).catch(() => undefined);
    }
  }
}

interface ModePass {
  mode: Look;
  results: AxeResults;
}

/**
 * Checks the screen in BOTH modes and leaves the OS dark (the suite pin).
 *
 * Light first: `emulateMedia({ colorScheme: "light" })`, wait until the page
 * is actually painted light, run axe; then dark the same way. That works
 * because test accounts are on System, so the app follows the OS.
 *
 * "Painted" is read with support/theme.ts `paintsLook` (the page colour behind
 * the header banner), not the `<html data-theme>` attribute: it needs no
 * exception to the perceivable-only rule, and it is what the user sees. The
 * attribute would be wrong on the pages that scope their own mode inside the
 * root (the public profile and sale pages are a dark design of their own).
 *
 * Some pages cannot flip, and the check then runs in the mode the page IS in
 * and SAYS SO (a `note` in the attachment, an `axe-single-mode` annotation in
 * the report, never silent):
 *   - the page follows an explicit saved theme, a ForceDark route, or the
 *     demo toggle's override (it did not repaint within the 7 s budget);
 *   - the page has no banner to read the mode from.
 * A spec that saved an explicit theme restores System before calling.
 */
export async function checkAccessibility(page: Page, testInfo: TestInfo, opts: AccessibleOptions = {}): Promise<void> {
  const path = new URL(page.url()).pathname;
  const label = opts.label ?? path;
  const project = testInfo.project.name;

  const passes: ModePass[] = [];
  let note: string | undefined;
  try {
    if (!(await pageHasBanner(page))) {
      // Nothing to read the mode from, so no flip can be proven: check the
      // OS-dark page as it stands.
      await page.emulateMedia({ colorScheme: "dark" });
      note = "no page banner to read the mode from; checked as it stood, with the OS dark";
      passes.push({ mode: "dark", results: await runAxe(page, opts) });
    } else {
      await page.emulateMedia({ colorScheme: "light" });
      const followsLight = await paintsLook(page, "light");
      if (followsLight) passes.push({ mode: "light", results: await runAxe(page, opts) });

      await page.emulateMedia({ colorScheme: "dark" });
      const followsDark = await paintsLook(page, "dark");
      if (followsDark) passes.push({ mode: "dark", results: await runAxe(page, opts) });

      if (!followsLight && !followsDark) {
        throw new Error(
          `"${label}" (${project}) painted neither light nor dark after the OS scheme changed; it has no banner colour of either mode.`,
        );
      }
      if (!followsLight) note = "the page stayed dark when the OS went light (pinned dark); only dark was checked";
      if (!followsDark) note = "the page stayed light when the OS went dark (pinned light); only light was checked";
    }
  } finally {
    // The suite pin, whatever happened above.
    await page.emulateMedia({ colorScheme: "dark" });
  }
  if (note) testInfo.annotations.push({ type: "axe-single-mode", description: `${label}: ${note}` });

  await testInfo.attach(`axe ${label} (${project})`, {
    contentType: "application/json",
    body: JSON.stringify(
      {
        label,
        path,
        project,
        scope: opts.within ? "region" : "page",
        tags: WCAG_TAGS,
        modesChecked: passes.map((p) => p.mode),
        ...(note ? { note } : {}),
        modes: Object.fromEntries(passes.map((p) => [p.mode, sanitize(p.results)])),
      },
      null,
      2,
    ),
  });

  // Every line says which mode it came from.
  const lines = passes.flatMap((p) => summarize(p.results.violations).map((line) => `(${p.mode}) ${line}`));
  const modes = passes.map((p) => p.mode).join(" + ");
  expect(
    lines,
    `axe found ${lines.length} WCAG 2.2 A/AA rule${lines.length === 1 ? "" : "s"} violated on "${label}" (${project}; checked ${modes}${note ? `; ${note}` : ""}). ` +
      `The mode each came from is in front of its line. ` +
      `These are product bugs: fix them in the product, never by excluding them (playwright/GUIDE.md, "Accessibility checks").`,
  ).toEqual([]);
}
