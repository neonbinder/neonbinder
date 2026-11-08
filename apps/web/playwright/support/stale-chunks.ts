/**
 * Stale-chunk injection for the NEO-434 specs (`home/stale-chunk-*`).
 *
 * A tab left open across a deploy asks for a code file the server no longer
 * has. This reproduces that at the network: once armed, every same-origin
 * script the page has NOT already loaded is answered 404. The landing page is
 * in the entry bundle, so everything that loads after the landing has settled
 * is a lazy route's chunk (a hashed `/assets/page-<hash>.js` in a built
 * bundle, `/app/<route>/page.tsx` under Vite dev). No file name is hard-coded:
 * "not seen before arming" is the rule in both modes.
 *
 * Why a snapshot: Playwright's `request` event fires before a route predicate
 * runs, so a live "seen" set already holds the very request being judged and
 * would never block anything. The set is copied when `arm` is called.
 *
 * Why the reload still works: the entry bundle was seen before arming, so it
 * is let through when the reloaded document asks for it again; only the lazy
 * chunk stays stale.
 *
 * Every number a spec asserts about the injection (what was answered 404, what
 * each URL answered over time, how many documents were requested) comes from
 * here, so a spec cannot go green without the failure having really happened.
 */
import type { Page, Response } from "@playwright/test";

export type StaleMode =
  /** The first stale request is answered 404; everything after goes through (a chunk that is back after the reload). */
  | "fail-once"
  /** Every stale request is answered 404 (a chunk that is gone for good). */
  | "fail-always";

/** The suite's 7 s UX budget (GUIDE hard rule 3), for the one wait here that is not an expect. */
const BUDGET = 7_000;

const CODE_FILE = /\.(js|mjs|ts|tsx|jsx)(\?|$)/;

export interface StaleChunks {
  /**
   * Runs `action` (the one click or focus that should ask for the chunk) with
   * 404s on: same-origin code the page has not requested by the moment the
   * action starts is answered 404. The route is registered first and judges
   * nothing until the action begins, and the "already seen" snapshot is taken
   * at that same moment, so a late request from anything else (an idle
   * prefetch, a dev-server module) can neither take a `fail-once` 404 nor be
   * mistaken for the chunk: only what the action itself asks for is judged.
   */
  injectDuring(mode: StaleMode, action: () => Promise<unknown>): Promise<void>;
  /** Stops answering 404 (requests go through again). */
  disarm(): void;
  /**
   * Resolves when the first 404 the page received for a stale file lands.
   * Create it BEFORE the action, await it AFTER: it is the positive anchor
   * every "nothing happened" assertion needs.
   */
  firstBlocked(): Promise<Response>;
  /** Every URL answered 404 by the injection, in order. */
  blockedUrls(): string[];
  /** The status each response for `url` carried since arming, in order. */
  statusesOf(url: string): number[];
  /** Main-frame document requests since arming: a reload is exactly one. */
  navigations(): number;
}

export function watchStaleChunks(page: Page): StaleChunks {
  // Everything requested so far. Listeners go on before the first goto.
  const seen = new Set<string>();
  page.on("request", (request) => {
    seen.add(request.url());
  });

  let armed = false;
  let blocking = false;
  let started = false;
  let mode: StaleMode = "fail-once";
  let known = new Set<string>();
  const blocked: string[] = [];
  const responses: Array<{ url: string; status: number }> = [];
  let documents = 0;

  page.on("request", (request) => {
    if (armed && request.isNavigationRequest() && request.frame() === page.mainFrame()) documents += 1;
  });
  page.on("response", (response) => {
    if (armed) responses.push({ url: response.url(), status: response.status() });
  });

  return {
    async injectDuring(next, action) {
      mode = next;
      const origin = new URL(page.url()).origin;
      const isStale = (url: URL) =>
        url.origin === origin && CODE_FILE.test(url.pathname + url.search) && !known.has(url.href);
      await page.route(isStale, async (route) => {
        // `route.fulfill` and `route.continue` may each run once, and the route
        // cannot be removed first ("Route is already handled!"), so the switch
        // is a flag the handler reads. Before the action starts it only passes
        // requests through.
        if (!started || !blocking || (mode === "fail-once" && blocked.length > 0)) {
          await route.continue();
          return;
        }
        blocked.push(route.request().url());
        await route.fulfill({ status: 404, contentType: "text/plain", body: "gone" });
      });
      // From here the snapshot, the counters and the 404s all start together.
      known = new Set(seen);
      blocking = true;
      armed = true;
      started = true;
      await action();
    },
    disarm() {
      blocking = false;
    },
    firstBlocked() {
      const landed = page.waitForResponse((response) => response.status() === 404 && blocked.includes(response.url()), {
        timeout: BUDGET,
      });
      // Created before the action and awaited after it: if the action throws first, this must not surface as an unhandled rejection.
      landed.catch(() => {});
      return landed;
    },
    blockedUrls() {
      return [...blocked];
    },
    statusesOf(url) {
      return responses.filter((r) => r.url === url).map((r) => r.status);
    },
    navigations() {
      return documents;
    },
  };
}
