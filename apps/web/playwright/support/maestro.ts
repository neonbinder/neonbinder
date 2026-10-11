/**
 * A thin Maestro-shaped driver over Playwright, so a ported spec reads
 * line-for-line like the flow it came from. See ../PORTING.md for the full
 * command mapping.
 *
 * SELECTOR RULE (Jason, non-negotiable): match only on what a user can
 * perceive. Everything here resolves through getByText / getByPlaceholder /
 * getByRole / getByLabel / getByTitle. Never add a CSS, XPath, id, class or
 * data-testid selector — not here, not in a spec.
 *
 * MATCHING SEMANTICS, decompiled from the pinned Maestro CLI (2.8.0):
 * - Every pattern is a regex, FULL-matched, case-insensitive, dot-all
 *   (Orchestra.REGEX_OPTIONS = IGNORE_CASE | DOT_MATCHES_ALL | MULTILINE).
 *   `mrx()` reproduces that: `^(?:pattern)$` with flags `is`.
 * - `text:` (and a bare string) matches an element's own text, or an input's
 *   value / placeholder / aria-label  -> `m.text()`.
 * - `id:` matches resource-id = node.id || aria-label || name || title. We only
 *   ever honour the user-perceivable half (aria-label / <label> / title)
 *   -> `m.id()`. A flow targeting a real DOM id cannot be ported: test.fixme.
 *
 * TIMEOUT RULE: every helper defaults to 7000 ms (R5's in-app budget). Where
 * the Maestro step states a timeout, pass that exact number.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { FlowEnv } from "./env";

/**
 * The budget for a step whose Maestro original states no timeout. 7000 per the
 * bake-off brief and R5. Maestro's real unstated defaults are looser (17000
 * for assertVisible / extendedWaitUntil / tapOn lookups, 20000 for
 * scrollUntilVisible); set PW_UNSTATED_TIMEOUT=17000 to mirror them instead.
 */
export const DEFAULT_TIMEOUT = Number(process.env.PW_UNSTATED_TIMEOUT ?? 7_000);
const POLL_MS = 100;

/**
 * A selector Playwright has no single locator for, resolved by polling a probe:
 * relational (below / above / leftOf / rightOf, by geometry) and `value()`.
 */
export interface Relational {
  readonly kind: "relational";
  readonly description: string;
  /** One non-waiting probe: the best visible match right now, or null. */
  probe(): Promise<Locator | null>;
}

/** Anything a driver method accepts: a Maestro text pattern, a Locator, or a relational. */
export type Sel = string | Locator | Relational;

/** Maestro pattern -> anchored, case-insensitive, dot-all RegExp. */
export function mrx(pattern: string): RegExp {
  // Maestro also accepts an element whose text equals the pattern literally
  // (e.g. "Cancel (Esc)"), so match the regex OR the escaped literal.
  const literal = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`^(?:${pattern}|${literal})$`, "is");
  } catch {
    // Maestro's toRegexSafe falls back to a literal match on an invalid regex.
    return new RegExp(`^${literal}$`, "is");
  }
}

function isRelational(sel: Sel): sel is Relational {
  return typeof sel === "object" && sel !== null && (sel as Relational).kind === "relational";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Direction = "DOWN" | "UP" | "LEFT" | "RIGHT";

export interface ScrollOptions {
  /** Maestro `timeout:`. Every scroll in the suite states it; default 7000. */
  timeout?: number;
  /** Maestro `direction:` (default DOWN). UP scrolls toward the top. */
  direction?: Direction;
  /** Maestro `centerElement: true`. */
  centerElement?: boolean;
}

export interface TapOptions {
  timeout?: number;
  /** Maestro `optional: true`: a miss is logged, not thrown. */
  optional?: boolean;
}

export class Maestro {
  constructor(
    readonly page: Page,
    readonly env: FlowEnv,
  ) {}

  // ── selectors ──────────────────────────────────────────────────────────

  /** Maestro `text: "<pattern>"` (and a bare-string selector). Visible matches only. */
  text(pattern: string): Locator {
    const re = mrx(pattern);
    const p = this.page;
    return p
      .getByText(re)
      .or(p.getByPlaceholder(re))
      .or(p.getByRole("textbox", { name: re }))
      .filter({ visible: true });
  }

  /** Maestro `id: "<pattern>"` — the accessible name (aria-label, <label>, title). */
  id(pattern: string): Locator {
    const re = mrx(pattern);
    const p = this.page;
    return p.getByLabel(re).or(p.getByTitle(re)).filter({ visible: true });
  }

  /** Maestro `below:` — nearest visible `target` whose top is at/under `anchor`'s bottom. */
  below(target: Sel, anchor: Sel): Relational {
    return this.relational("below", target, anchor, (t, a) =>
      t.y >= a.y + a.height - 1 ? t.y - (a.y + a.height) : null,
    );
  }

  /** Maestro `above:`. */
  above(target: Sel, anchor: Sel): Relational {
    return this.relational("above", target, anchor, (t, a) =>
      t.y + t.height <= a.y + 1 ? a.y - (t.y + t.height) : null,
    );
  }

  /** Maestro `leftOf:`. */
  leftOf(target: Sel, anchor: Sel): Relational {
    return this.relational("leftOf", target, anchor, (t, a) =>
      t.x + t.width <= a.x + 1 ? a.x - (t.x + t.width) : null,
    );
  }

  /** Maestro `rightOf:`. */
  rightOf(target: Sel, anchor: Sel): Relational {
    return this.relational("rightOf", target, anchor, (t, a) =>
      t.x >= a.x + a.width - 1 ? t.x - (a.x + a.width) : null,
    );
  }

  /**
   * An input whose current VALUE full-matches `pattern`. Maestro's `text:`
   * matches an input's value (value || placeholder || aria-label); Playwright's
   * getByText never does, so assert typed text with `m.value("...")`.
   */
  value(pattern: string): Relational {
    const re = mrx(pattern);
    const p = this.page;
    return {
      kind: "relational",
      description: `input with value ${JSON.stringify(pattern)}`,
      probe: async () => {
        const fields = p
          .getByRole("textbox")
          .or(p.getByRole("searchbox"))
          .or(p.getByRole("combobox"))
          .or(p.getByRole("spinbutton"))
          .filter({ visible: true });
        const n = await fields.count();
        for (let i = 0; i < n; i++) {
          const v = await fields.nth(i).inputValue().catch(() => null);
          if (v !== null && re.test(v)) return fields.nth(i);
        }
        return null;
      },
    };
  }

  /**
   * Maestro `childOf:` / `containsChild:` have direct Playwright equivalents:
   *   childOf       -> parentLocator.getByText(...)  (scope the search)
   *   containsChild -> locator.filter({ has: childLocator })
   * This helper is the first: `m.within(m.id("Years"), "2024")`.
   */
  within(parent: Locator, pattern: string): Locator {
    const re = mrx(pattern);
    return parent
      .getByText(re)
      .or(parent.getByPlaceholder(re))
      .or(parent.getByRole("textbox", { name: re }))
      .filter({ visible: true });
  }

  // ── navigation ─────────────────────────────────────────────────────────

  /**
   * The flow's top-level `url:` for an authenticated flow (R4):
   * `/testing/sign-in?redirect=<redirect>&worker=${WORKER_INDEX}`. Pass the
   * redirect exactly as the flow spells it (nested `?` and `%26` included).
   */
  signInUrl(redirect: string, opts: { account?: string } = {}): string {
    const account = opts.account ? `&account=${opts.account}` : "";
    return `/testing/sign-in?redirect=${redirect}${account}&worker=${this.env.WORKER_INDEX}`;
  }

  /** `launchApp` with the flow's `url:`. Each test has a fresh context, so clearState is implicit. */
  async launch(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  /** `openLink: ${APP_URL}/path` — pass "/path". */
  async openLink(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  // ── waits and asserts ──────────────────────────────────────────────────

  /** Resolve a selector to one visible Locator, waiting up to `timeout`. */
  async resolve(sel: Sel, timeout = DEFAULT_TIMEOUT): Promise<Locator> {
    if (isRelational(sel)) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = await sel.probe();
        if (hit) return hit;
        if (Date.now() >= deadline) {
          throw new Error(`No visible element ${sel.description} within ${timeout}ms`);
        }
        await sleep(POLL_MS);
      }
    }
    const loc = this.loc(sel).first();
    await expect(loc, `visible: ${describe(sel)}`).toBeVisible({ timeout });
    return loc;
  }

  /** `extendedWaitUntil: { visible: X, timeout }` / `assertVisible: X`. */
  async waitVisible(sel: Sel, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await this.resolve(sel, timeout);
  }

  /** `assertVisible` (7000 unless the flow states otherwise). */
  async assertVisible(sel: Sel, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await this.resolve(sel, timeout);
  }

  /** `extendedWaitUntil: { notVisible: X, timeout }` / `assertNotVisible: X`. */
  async waitNotVisible(sel: Sel, timeout = DEFAULT_TIMEOUT): Promise<void> {
    if (isRelational(sel)) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (!(await sel.probe())) return;
        if (Date.now() >= deadline) {
          throw new Error(`Element ${sel.description} still visible after ${timeout}ms`);
        }
        await sleep(POLL_MS);
      }
    }
    await expect(this.loc(sel).first(), `not visible: ${describe(sel)}`).toBeHidden({ timeout });
  }

  /** `assertNotVisible` (7000 unless the flow states otherwise). */
  async assertNotVisible(sel: Sel, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await this.waitNotVisible(sel, timeout);
  }

  /**
   * `runFlow: when: { visible: X }` — true as soon as X is visible, false
   * after `timeout` (Maestro's condition lookup, 7000). Mirrors the cost:
   * a false branch pays the full wait, exactly as in Maestro (R10).
   */
  async isVisible(sel: Sel, timeout = DEFAULT_TIMEOUT): Promise<boolean> {
    try {
      await this.resolve(sel, timeout);
      return true;
    } catch {
      return false;
    }
  }

  /** `runFlow: when: { notVisible: X }` — true as soon as X is gone, false after `timeout`. */
  async isNotVisible(sel: Sel, timeout = DEFAULT_TIMEOUT): Promise<boolean> {
    try {
      await this.waitNotVisible(sel, timeout);
      return true;
    } catch {
      return false;
    }
  }

  // ── actions ────────────────────────────────────────────────────────────

  /** `tapOn`. `retryTapIfNoChange` / `waitToSettleTimeoutMs` have no equivalent and are dropped. */
  async tapOn(sel: Sel, opts: TapOptions = {}): Promise<void> {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    try {
      const loc = await this.resolve(sel, timeout);
      await loc.click({ timeout });
    } catch (e) {
      if (!opts.optional) throw e;
      console.warn(`[optional tapOn skipped] ${describe(sel)}: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  /** `tapOn: { point: "5%, 50%" }` (percent of viewport) or `"120,340"` (pixels). */
  async tapPoint(point: string): Promise<void> {
    const vp = this.page.viewportSize() ?? { width: 1024, height: 629 };
    const [xs, ys] = point.split(",").map((s) => s.trim());
    const px = (v: string, total: number) =>
      v.endsWith("%") ? (parseFloat(v) / 100) * total : parseFloat(v);
    await this.page.mouse.click(px(xs, vp.width), px(ys, vp.height));
  }

  /** `inputText` — types into whatever is focused, exactly like Maestro. */
  async inputText(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  /** `eraseText: N` — N backspaces at the focus (Maestro's default is 50). */
  async eraseText(chars = 50): Promise<void> {
    for (let i = 0; i < chars; i++) await this.page.keyboard.press("Backspace");
  }

  /** `pressKey` — Maestro key names (Enter, Backspace, Tab, Escape, ...). */
  async pressKey(key: string): Promise<void> {
    const map: Record<string, string> = {
      enter: "Enter",
      backspace: "Backspace",
      tab: "Tab",
      escape: "Escape",
      back: "Escape",
      home: "Home",
      end: "End",
      "remote dpad up": "ArrowUp",
      "remote dpad down": "ArrowDown",
    };
    await this.page.keyboard.press(map[key.toLowerCase()] ?? key);
  }

  /**
   * `scrollUntilVisible`. Scrolls the WINDOW (Maestro's only primitive) until
   * the target is visible, then brings it into view (centred when asked).
   * Unlike maestro-web, a target already in the DOM is scrolled to directly,
   * whatever `direction` says; direction only steers the search for content
   * that is not rendered yet (virtualised lists).
   */
  async scrollUntilVisible(sel: Sel, opts: ScrollOptions = {}): Promise<Locator> {
    const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    const deadline = Date.now() + timeout;
    const step = opts.direction === "UP" ? -0.6 : 0.6;
    for (;;) {
      const hit = await this.probe(sel);
      if (hit) {
        if (opts.centerElement) {
          await hit.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
        } else {
          await hit.scrollIntoViewIfNeeded({ timeout });
        }
        return hit;
      }
      if (Date.now() >= deadline) {
        throw new Error(`scrollUntilVisible: ${describe(sel)} not found within ${timeout}ms`);
      }
      await this.page.evaluate((f) => window.scrollBy(0, Math.round(window.innerHeight * f)), step);
      await sleep(POLL_MS);
    }
  }

  /**
   * `swipe: { start: "50%, 70%", end: "50%, 30%" }` — maestro-web turns a
   * swipe into a window scroll by the vertical distance; so do we.
   * `direction: UP` (content moves up = page scrolls down) is also accepted.
   */
  async swipe(opts: { start?: string; end?: string; direction?: Direction }): Promise<void> {
    let fraction = 0;
    if (opts.start && opts.end) {
      const y = (s: string) => parseFloat(s.split(",")[1]);
      fraction = (y(opts.start) - y(opts.end)) / 100;
    } else if (opts.direction === "UP") {
      fraction = 0.5;
    } else if (opts.direction === "DOWN") {
      fraction = -0.5;
    }
    await this.page.evaluate((f) => window.scrollBy(0, Math.round(window.innerHeight * f)), fraction);
  }

  /** `copyTextFrom` — returns the text instead of stashing it in `maestro.copiedText`. */
  async copyTextFrom(sel: Sel, timeout = DEFAULT_TIMEOUT): Promise<string> {
    const loc = await this.resolve(sel, timeout);
    return loc.evaluate((el) =>
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.value || el.placeholder || el.getAttribute("aria-label") || ""
        : ((el as HTMLElement).innerText ?? el.textContent ?? "").trim(),
    );
  }

  /** `retry: { maxRetries: N, commands: [...] }`. */
  async retry(maxRetries: number, fn: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await fn();
        return;
      } catch (e) {
        if (attempt >= maxRetries) throw e;
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private loc(sel: string | Locator): Locator {
    return typeof sel === "string" ? this.text(sel) : sel;
  }

  /** One non-waiting visibility probe. */
  private async probe(sel: Sel): Promise<Locator | null> {
    if (isRelational(sel)) return sel.probe();
    const loc = this.loc(sel).first();
    return (await loc.isVisible().catch(() => false)) ? loc : null;
  }

  private relational(
    kind: string,
    target: Sel,
    anchor: Sel,
    distance: (
      t: { x: number; y: number; width: number; height: number },
      a: { x: number; y: number; width: number; height: number },
    ) => number | null,
  ): Relational {
    return {
      kind: "relational",
      description: `${describe(target)} ${kind} ${describe(anchor)}`,
      probe: async () => {
        const a = await this.probe(anchor);
        if (!a) return null;
        const aBox = await a.boundingBox().catch(() => null);
        if (!aBox) return null;
        if (isRelational(target)) return target.probe();
        const candidates = this.loc(target);
        const n = await candidates.count();
        let best: { i: number; d: number } | null = null;
        for (let i = 0; i < n; i++) {
          const box = await candidates.nth(i).boundingBox().catch(() => null);
          if (!box) continue;
          const d = distance(box, aBox);
          if (d !== null && (best === null || d < best.d)) best = { i, d };
        }
        return best ? candidates.nth(best.i) : null;
      },
    };
  }
}

function describe(sel: Sel): string {
  if (typeof sel === "string") return JSON.stringify(sel);
  if (isRelational(sel)) return sel.description;
  return sel.toString();
}
