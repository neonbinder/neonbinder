/**
 * DIAGNOSTIC-ONLY tap-forensics instrumentation.
 *
 * Purpose: prove/disprove a Maestro tap-drop mechanism by recording, for every
 * pointerdown/click, whether the event's target actually matches the element at
 * the tap coordinates (a "MISMATCH" means the tap landed on a stale/wrong/absent
 * element — the signature of a dropped or misrouted tap).
 *
 * !!! GATE: GLOBAL on this diagnostic branch (isEnabled() returns true). This
 * branch is NOT intended to merge. To re-scope, revert isEnabled() to the
 * `?tapForensics=1` URL gate (see the one-liner in isEnabled below).
 *
 * Capture model (empirically derived):
 *  - maestro-web writes NO hierarchy dump on failure, and its copyTextFrom reads
 *    a node but does NOT log the copied value — so the ONLY reliable capture is a
 *    VISIBLE panel caught in the failure SCREENSHOT.
 *  - copyTextFrom of a large hidden full-JSON <pre> triggered a CDP
 *    MismatchedInputException (empty response) and adds global CDP-read weight —
 *    so there is NO hidden full-JSON node. The single visible panel IS both the
 *    screenshot capture AND the copyTextFrom target (carries id="tap-forensics").
 *
 * HARD CONSTRAINTS (do not relax):
 *  - IN-MEMORY ONLY. No network, no Convex, no React state, no mutations per
 *    event. Everything accumulates in a plain JS array (window.__tapForensics)
 *    plus one textContent write to the visible panel. Adding any reactivity
 *    (setState / Convex write) per event would poison the measurement.
 *  - The visible panel is pointer-events:none — proven to keep maestro's
 *    visibility/occlusion check seeing through it AND to keep it transparent to
 *    elementFromPoint, so it can NEVER corrupt the measurement.
 */

type TapEventEntry = {
  t: number;
  type: string;
  x: number;
  y: number;
  tappedTarget: string;
  elementAtPoint: string;
  match: string;
};

type RenderEntry = {
  t: number;
  kind: "render";
  title: string;
  itemsLen: number;
};

type ItemsChangedEntry = {
  t: number;
  kind: "items-changed";
  title: string;
};

type TapEntry = TapEventEntry | RenderEntry | ItemsChangedEntry;

declare global {
  interface Window {
    __tapForensics?: TapEntry[];
  }
}

const MAX_ENTRIES = 200;
/** "TAPS" section: the last N pointerdown/click entries. */
const TAP_LINES = 5;
/** "RECENT" section: the last N entries of ANY kind (survives a render flood). */
const RECENT_LINES = 28;

/** The single VISIBLE panel — screenshot capture + copyTextFrom target. */
let panelNode: HTMLPreElement | null = null;
/** Previous `items` reference per EntitySelector title (reference identity). */
const prevItemsByTitle = new Map<string, unknown>();

function isEnabled(): boolean {
  // GLOBAL for this diagnostic branch; revert to the `?tapForensics=1` URL gate
  // to re-scope. To revert, replace `return true` with:
  //   return new URLSearchParams(window.location.search).get("tapForensics") === "1";
  return true;
}

function truncate(s: string): string {
  return s.length > 60 ? s.slice(0, 60) : s;
}

/**
 * Short human-readable label for an element.
 * Note: uses truthy (`||`) fallbacks so an empty `id`/`aria-label` correctly
 * falls through to the tag+class label rather than yielding an empty string.
 * Non-Element targets (document/window) → "null".
 */
function label(el: EventTarget | null): string {
  if (!(el instanceof Element)) return "null";
  const aria = el.getAttribute("aria-label");
  if (aria) return truncate(aria);
  if (el.id) return truncate(el.id);
  const cls = typeof el.className === "string" ? el.className : "";
  const classPart = cls.split(/\s+/).filter(Boolean).slice(0, 2).join(".");
  return truncate(`${el.tagName.toLowerCase()}.${classPart}`);
}

/**
 * THE key signal: did the tap coordinate resolve to the same element the event
 * targeted, a related ancestor/descendant, an unrelated element, or nothing?
 */
function matchKind(target: EventTarget | null, atPoint: Element | null): string {
  if (atPoint === null) return "atPoint-null";
  if (atPoint === target) return "same";
  if (target instanceof Node && atPoint.contains(target)) return "contains";
  if (target instanceof Element && atPoint instanceof Node && target.contains(atPoint)) {
    return "contained-by";
  }
  return "MISMATCH";
}

/** Compact one-line summary of an entry for the visible panel. */
function formatEntry(e: TapEntry): string {
  if ("kind" in e) {
    return e.kind === "render"
      ? `${e.t} render ${e.title} n=${e.itemsLen}`
      : `${e.t} items-changed ${e.title}`;
  }
  return `${e.t} ${e.type} (${e.x},${e.y}) tap=${e.tappedTarget} at=${e.elementAtPoint} ${e.match}`;
}

/**
 * Two-section panel text. "TAPS" pins the last few taps so a render-flood in the
 * wait window can't push the dropped tap out of view; "RECENT" shows the full
 * recent timeline of any kind.
 */
function renderPanel(arr: TapEntry[]): string {
  const taps = arr.filter((e) => !("kind" in e)).slice(-TAP_LINES);
  const recent = arr.slice(-RECENT_LINES);
  return [
    "TAPS:",
    taps.map(formatEntry).join("\n"),
    "---",
    "RECENT:",
    recent.map(formatEntry).join("\n"),
  ].join("\n");
}

/** Push an entry (in-memory), cap the buffer, and mirror to the visible panel. */
function push(entry: TapEntry): void {
  if (!isEnabled()) return;
  if (!window.__tapForensics) window.__tapForensics = [];
  const arr = window.__tapForensics;
  arr.push(entry);
  if (arr.length > MAX_ENTRIES) {
    arr.splice(0, arr.length - MAX_ENTRIES);
  }
  if (panelNode) {
    panelNode.textContent = renderPanel(arr);
  }
}

function handleTapEvent(e: Event): void {
  // pointerdown/click both carry clientX/clientY via MouseEvent.
  const me = e as MouseEvent;
  const atPoint = document.elementFromPoint(me.clientX, me.clientY);
  push({
    t: Math.round(performance.now()),
    type: e.type,
    x: Math.round(me.clientX),
    y: Math.round(me.clientY),
    tappedTarget: label(e.target),
    elementAtPoint: label(atPoint),
    match: matchKind(e.target, atPoint),
  });
}

/**
 * Initialize the instrumentation. Self-gates via isEnabled() (GLOBAL on this
 * branch). Idempotent — safe to call more than once.
 */
export function initTapForensics(): void {
  if (!isEnabled()) return;
  if (window.__tapForensics) return; // already initialized
  window.__tapForensics = [];

  // The ONE visible panel: legible in maestro's failure SCREENSHOT AND the
  // copyTextFrom target, so it carries BOTH id="tap-forensics" and the matching
  // aria-label. pointer-events:none is essential — keeps maestro's occlusion
  // check seeing through it and keeps it transparent to elementFromPoint (so it
  // can never corrupt the measurement).
  const panel = document.createElement("pre");
  panel.id = "tap-forensics";
  panel.setAttribute("aria-label", "tap-forensics");
  panel.style.cssText =
    "position:fixed;top:0;left:0;max-width:680px;font-size:12px;line-height:1.15;font-family:monospace;background:rgba(0,0,0,.78);color:#0f0;z-index:2147483647;pointer-events:none;white-space:pre;margin:0;padding:3px;";
  panelNode = panel;

  const attach = (): void => {
    if (document.body && !document.body.contains(panel)) {
      document.body.appendChild(panel);
    }
  };
  if (document.body) {
    attach();
  } else {
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  }

  document.addEventListener("pointerdown", handleTapEvent, {
    capture: true,
    passive: true,
  });
  document.addEventListener("click", handleTapEvent, {
    capture: true,
    passive: true,
  });
}

/**
 * Record an EntitySelector render. Gated via isEnabled() (GLOBAL on this branch).
 * Pushes a "render" entry every call, plus an "items-changed" entry whenever the
 * `items` reference differs from the previous render for the same `title` — which
 * reveals whether a data-driven re-render/reorder fired inside a tap window.
 * Must NOT trigger a re-render (no state writes).
 */
export function recordEntitySelectorRender(title: string, items: unknown): void {
  if (!isEnabled()) return;
  const t = Math.round(performance.now());
  const itemsLen = Array.isArray(items) ? items.length : items == null ? -1 : 0;
  push({ t, kind: "render", title, itemsLen });
  if (prevItemsByTitle.has(title) && prevItemsByTitle.get(title) !== items) {
    push({ t, kind: "items-changed", title });
  }
  prevItemsByTitle.set(title, items);
}
