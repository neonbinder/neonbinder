import posthog from "posthog-js";
import type { CaptureResult, PostHogConfig } from "posthog-js";

/**
 * NEO-392 — PostHog as an E2E flight recorder.
 *
 * E2E reds such as "the click landed and the form never opened" leave a
 * screenshot and nothing else: the page's own state at that moment is gone.
 * Under E2E (VITE_CLERK_TESTING_ENABLED) PostHog used to be switched off
 * entirely (NEO-13: Maestro's CDP driver latched onto PostHog's recorder
 * workers and iframes). Maestro is gone (NEO-341), so PostHog now runs under
 * E2E in a narrow diagnostic mode instead:
 *
 * - nothing automatic: no autocapture, pageviews, recordings, surveys,
 *   heatmaps or flags, so the page under test loads no recorder worker or
 *   survey iframe (exception capture loads its one script);
 * - only the events named in {@link E2E_DIAGNOSTIC_EVENTS} leave the page;
 * - every event carries the run, attempt, worker, project and test the
 *   Playwright fixture stamped onto the page ({@link readE2ETags}), so one
 *   red in CI maps to one filterable timeline in PostHog;
 * - each event is sent at once (no batching): a test's context closes the
 *   moment it ends, and a batched tail would be lost with it.
 */

export const isE2E = (): boolean =>
  import.meta.env.VITE_CLERK_TESTING_ENABLED === "true";

/** The only events E2E sends. Anything else is dropped before it is sent. */
export const E2E_DIAGNOSTIC_EVENTS: ReadonlySet<string> = new Set([
  "e2e_page_start",
  "e2e_column",
  "e2e_press",
  "convex_client_reconnect",
  "selector_options_stall_backstop",
  "selector_sync_fe_timeout",
  // NEO-466: a copy photo save that was slow, retried or failed (copy-photo-timing.ts).
  "copy_photo_save_timing",
  "$exception",
]);

/** Keys the Playwright fixture may set on `window.__NB_E2E`. */
const TAG_KEYS = [
  "run_id",
  "run_attempt",
  "worker",
  "project",
  "test",
  "file",
  "retry",
] as const;

const MAX_TAG_LENGTH = 200;

/**
 * Reads the tags the Playwright fixture put on the window, keeping only the
 * known keys with string or number values. The window object is page-owned,
 * so nothing else on it is trusted or forwarded.
 */
export function readE2ETags(
  source: unknown,
): Record<string, string | number> {
  const tags: Record<string, string | number> = { e2e: "true" };
  if (!source || typeof source !== "object") return tags;
  const record = source as Record<string, unknown>;
  for (const key of TAG_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      tags[`e2e_${key}`] = value;
    } else if (typeof value === "string") {
      tags[`e2e_${key}`] = value.slice(0, MAX_TAG_LENGTH);
    }
  }
  return tags;
}

/** Drops every event that is not a named diagnostic event. */
export function keepDiagnosticEvent(
  event: CaptureResult | null,
): CaptureResult | null {
  return event && E2E_DIAGNOSTIC_EVENTS.has(event.event) ? event : null;
}

/** The PostHog options for E2E: everything automatic off, sends unbatched. */
export function e2eDiagnosticConfig(): Partial<PostHogConfig> {
  return {
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    rageclick: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    persistence: "memory",
    request_batching: false,
    capture_exceptions: true,
    // Playwright's Chromium reports itself as automated, and PostHog drops
    // automated browsers' events by default. Keep them: they are the point.
    opt_out_useragent_filter: true,
    before_send: keepDiagnosticEvent,
  };
}

/**
 * Records one diagnostic event, under E2E only. Real users never send
 * these: they would be noise there, and the E2E tags would be absent.
 */
export function e2eDiagnostic(
  event: string,
  properties: Record<string, string | number | boolean | null>,
): void {
  if (!isE2E()) return;
  if (!E2E_DIAGNOSTIC_EVENTS.has(event)) return;
  try {
    posthog.capture(event, {
      ...properties,
      at_ms: Math.round(performance.now()),
    });
  } catch {
    // Diagnostics must never break the screen they observe.
  }
}

/**
 * NEO-417 — what a press actually hit. A red where "the click landed and the
 * form never opened" has to tell these apart: no pointerdown arrived, it landed
 * on another element, press and release landed on different elements so no click
 * fired, or the main thread was busy (`input_delay_ms`). Read beside `e2e_column`
 * `branch`, which says whether the column swapped under the press.
 *
 * Capture phase on `document`, so nothing on the page can stop it first. Each
 * press is three unbatched sends, so {@link holdE2EPressListeners} keeps the
 * listeners to the screens with an EntityColumn on them.
 */
const PRESS_EVENTS = ["pointerdown", "pointerup", "click"] as const;
const PRESS_LISTENER_OPTIONS = { capture: true, passive: true } as const;
const MAX_PRESS_NAME_LENGTH = 60;

/** Elements that hold typed text. Only a label ever comes out of one. */
const TEXT_ENTRY = "input, textarea, select, [contenteditable]";
/** Controls whose visible text IS their name. */
const NAMED_BY_CONTENT =
  'button, a, summary, [role="button"], [role="link"], [role="tab"], [role="option"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"]';

function shortName(text: string | null | undefined): string | null {
  const name = text?.replace(/\s+/g, " ").trim();
  return name ? name.slice(0, MAX_PRESS_NAME_LENGTH) : null;
}

/**
 * The target's name: its aria-label, else a control's own short text. A form
 * field's value is never read, nor is a plain element's text, because a sentence
 * on the page can echo what was just typed ("Create set 'x'?"). A plain element
 * gets the nearest aria-label instead, which says where it sits.
 *
 * A control's own name is still read, and it can echo typed text: TeamPicker's
 * and PlayerPicker's create options carry the live query in their aria-label, so
 * a press on one records up to the first {@link MAX_PRESS_NAME_LENGTH} characters
 * of that name.
 */
function pressTargetName(target: Element): string | null {
  const entry = target.closest(TEXT_ENTRY);
  if (entry) {
    return shortName(
      entry.getAttribute("aria-label") ?? entry.getAttribute("placeholder"),
    );
  }
  const control = target.closest(NAMED_BY_CONTENT);
  const own =
    shortName(control?.getAttribute("aria-label")) ??
    (control && !control.querySelector(TEXT_ENTRY)
      ? shortName(control.textContent)
      : null);
  return (
    own ?? shortName(target.closest("[aria-label]")?.getAttribute("aria-label"))
  );
}

/** One press event as identifiers and geometry. Exported for its tests. */
export function describePress(
  event: Event,
): Record<string, string | number | boolean | null> {
  const target = event.target instanceof Element ? event.target : null;
  const pointer = event as Partial<MouseEvent>;
  return {
    type: event.type,
    tag: target?.tagName.toLowerCase() ?? null,
    role: (target?.closest(NAMED_BY_CONTENT) ?? target)?.getAttribute("role") ?? null,
    name: target ? pressTargetName(target) : null,
    level: target?.closest("[data-cascade-level]")?.getAttribute("data-cascade-level") ?? null,
    connected: target?.isConnected ?? null,
    x: typeof pointer.clientX === "number" ? Math.round(pointer.clientX) : null,
    y: typeof pointer.clientY === "number" ? Math.round(pointer.clientY) : null,
    input_delay_ms: Math.round(performance.now() - event.timeStamp),
  };
}

function recordPress(event: Event): void {
  try {
    e2eDiagnostic("e2e_press", describePress(event));
  } catch {
    // Diagnostics must never break the screen they observe.
  }
}

let pressListenerHolds = 0;

/**
 * Holds the press listeners on for the caller, and returns the release. However
 * many columns hold them there is one set, gone when the last lets go. Outside
 * E2E this does nothing at all: real users get no listeners.
 */
export function holdE2EPressListeners(): () => void {
  if (!isE2E()) return () => {};
  pressListenerHolds += 1;
  if (pressListenerHolds === 1) {
    for (const type of PRESS_EVENTS) {
      document.addEventListener(type, recordPress, PRESS_LISTENER_OPTIONS);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pressListenerHolds -= 1;
    if (pressListenerHolds === 0) {
      for (const type of PRESS_EVENTS) {
        document.removeEventListener(type, recordPress, PRESS_LISTENER_OPTIONS);
      }
    }
  };
}
