/**
 * DIAGNOSTIC-ONLY tap-forensics instrumentation.
 *
 * Purpose: prove/disprove a Maestro tap-drop mechanism by recording, for every
 * pointerdown/click, whether the event's target actually matches the element at
 * the tap coordinates (a "MISMATCH" means the tap landed on a stale/wrong/absent
 * element — the signature of a dropped or misrouted tap).
 *
 * HARD CONSTRAINTS (do not relax):
 *  - GATED behind `?tapForensics=1`. When absent this module does NOTHING: no
 *    listeners, no DOM node, no allocation, no overhead.
 *  - IN-MEMORY ONLY. No network, no Convex, no React state, no mutations per
 *    event. Everything accumulates in a plain JS array. Adding any reactivity
 *    (setState / Convex write) per event would poison the very measurement this
 *    exists to take.
 *
 * Read-out: when enabled, a hidden-but-accessibility-visible <pre id="tap-forensics">
 * mirrors the array as JSON so Maestro can read it from the a11y tree.
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
/** How many recent entries the visible tail panel shows. */
const TAIL_ENTRIES = 12;

/** Cached gate result — the URL flag can't change without a full reload. */
let cachedEnabled: boolean | null = null;
/**
 * The full-JSON read-out node (created lazily in initTapForensics). Positioned
 * ON-SCREEN at (0,0) as a 1px element — NOT off-screen — so maestro-web's
 * copyTextFrom/visibility model treats it as present with valid layout bounds.
 */
let readoutNode: HTMLPreElement | null = null;
/**
 * A second, VISIBLE compact panel showing a one-line-per-entry summary of the
 * last ~12 entries. Captured legibly in maestro's failure screenshot — the key
 * backup when a tap drops (maestro-web has no hierarchy dump on failure).
 */
let tailNode: HTMLPreElement | null = null;
/** Previous `items` reference per EntitySelector title (reference identity). */
const prevItemsByTitle = new Map<string, unknown>();

function isEnabled(): boolean {
  if (cachedEnabled === null) {
    try {
      cachedEnabled =
        new URLSearchParams(window.location.search).get("tapForensics") === "1";
    } catch {
      cachedEnabled = false;
    }
  }
  return cachedEnabled;
}

function truncate(s: string): string {
  return s.length > 60 ? s.slice(0, 60) : s;
}

/**
 * Short human-readable label for an element.
 * Note: spec used `?? el.id ?? ...`; we use truthy (`||`) fallbacks instead so an
 * empty `id`/`aria-label` correctly falls through to the tag+class label rather
 * than yielding an empty string. Non-Element targets (document/window) → "null".
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

/** Compact one-line summary of an entry for the visible tail panel. */
function formatEntry(e: TapEntry): string {
  if ("kind" in e) {
    return e.kind === "render"
      ? `${e.t} render ${e.title} n=${e.itemsLen}`
      : `${e.t} items-changed ${e.title}`;
  }
  return `${e.t} ${e.type} (${e.x},${e.y}) tap=${e.tappedTarget} at=${e.elementAtPoint} ${e.match}`;
}

/**
 * Push an entry (in-memory), cap the buffer, and mirror to BOTH read-out nodes:
 * the full-JSON node (a11y-readable) and the compact visible tail panel
 * (screenshot-legible). No network, no state.
 */
function push(entry: TapEntry): void {
  if (!isEnabled()) return;
  if (!window.__tapForensics) window.__tapForensics = [];
  const arr = window.__tapForensics;
  arr.push(entry);
  if (arr.length > MAX_ENTRIES) {
    arr.splice(0, arr.length - MAX_ENTRIES);
  }
  if (readoutNode) {
    readoutNode.textContent = JSON.stringify(arr);
  }
  if (tailNode) {
    tailNode.textContent = arr.slice(-TAIL_ENTRIES).map(formatEntry).join("\n");
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
 * Initialize the instrumentation. Self-gates on `?tapForensics=1`; a no-op
 * (returns immediately) otherwise. Idempotent — safe to call more than once.
 */
export function initTapForensics(): void {
  if (!isEnabled()) return;
  if (window.__tapForensics) return; // already initialized
  window.__tapForensics = [];

  // Full-JSON read-out: a 1px element ON-SCREEN at (0,0) — NOT off-screen. A 1px
  // element at (0,0) has valid on-screen layout bounds, so maestro-web's
  // copyTextFrom/visibility model treats it as present and readable, while it
  // stays invisible to a human. Deliberately NOT display:none / visibility:hidden
  // / [hidden], which would drop it from the a11y tree.
  const pre = document.createElement("pre");
  pre.id = "tap-forensics";
  pre.setAttribute("aria-label", "tap-forensics");
  pre.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden;z-index:0;white-space:pre;";
  readoutNode = pre;

  // Visible compact tail panel: legible in maestro's failure SCREENSHOT (the key
  // backup when a tap drops — maestro-web has no hierarchy dump on failure).
  // pointer-events:none so it NEVER intercepts taps.
  const tail = document.createElement("pre");
  tail.id = "tap-forensics-tail";
  tail.setAttribute("aria-label", "tap-forensics-tail");
  tail.style.cssText =
    "position:fixed;top:0;left:0;max-width:520px;font-size:9px;line-height:1.1;background:rgba(0,0,0,.6);color:#0f0;z-index:2147483647;pointer-events:none;white-space:pre;margin:0;padding:2px;";
  tailNode = tail;

  const attach = (): void => {
    if (!document.body) return;
    if (!document.body.contains(pre)) document.body.appendChild(pre);
    if (!document.body.contains(tail)) document.body.appendChild(tail);
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
 * Record an EntitySelector render. Cheap no-op unless `?tapForensics=1`.
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
