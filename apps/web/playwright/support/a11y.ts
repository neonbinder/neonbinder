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
 * Violations are product bugs: fix the product. Never add an exclusion here
 * to make a spec pass, and never exclude NeonBinder's own UI.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

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
function sanitize(results: AxeResults, meta: Record<string, unknown>) {
  const rule = (r: Result) => ({
    id: r.id,
    impact: r.impact,
    help: r.help,
    helpUrl: r.helpUrl,
    tags: r.tags,
    nodes: r.nodes.map((n) => ({ target: n.target, impact: n.impact, failureSummary: n.failureSummary })),
  });
  return {
    ...meta,
    testEngine: results.testEngine?.version,
    violations: results.violations.map(rule),
    // Needs-review results (e.g. contrast over an image): informational, never fail.
    incomplete: results.incomplete.map((r) => ({ id: r.id, impact: r.impact, help: r.help, count: r.nodes.length })),
    passes: results.passes.length,
  };
}

export async function checkAccessibility(page: Page, testInfo: TestInfo, opts: AccessibleOptions = {}): Promise<void> {
  const path = new URL(page.url()).pathname;
  const label = opts.label ?? path;
  // axe reads colours as painted right now: a dialog still fading in (Clerk's
  // modals, Radix overlays) measures its text against a half-transparent
  // layer and reports contrast the settled screen does not have. Wait for
  // every finite animation and transition to finish; infinite ones
  // (spinners, the neon glow) never settle and are ignored.
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity),
    undefined,
    { timeout: 7_000 },
  );
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

  let results: AxeResults;
  try {
    results = await builder.analyze();
  } finally {
    if (opts.within && token) {
      await opts.within.evaluate((el, attr) => el.removeAttribute(attr), SCOPE_ATTR).catch(() => undefined);
    }
  }

  const project = testInfo.project.name;
  await testInfo.attach(`axe ${label} (${project})`, {
    contentType: "application/json",
    body: JSON.stringify(
      sanitize(results, { label, path, project, scope: opts.within ? "region" : "page", tags: WCAG_TAGS }),
      null,
      2,
    ),
  });

  const lines = summarize(results.violations);
  expect(
    lines,
    `axe found ${lines.length} WCAG 2.2 A/AA rule${lines.length === 1 ? "" : "s"} violated on "${label}" (${project}). ` +
      `These are product bugs: fix them in the product, never by excluding them (playwright/GUIDE.md, "Accessibility checks").`,
  ).toEqual([]);
}
