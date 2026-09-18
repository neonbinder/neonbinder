import { useState } from "react";
import { KNOWN_SITES } from "@/convex/lib/marketplacePause";
import {
  PAUSE_NOTICE_COPY,
  pausedStripText,
} from "@/lib/marketplace/pause-notice";
import { REAUTH_NOTICE_FOCUS_PARK_ID } from "./ReauthNotice";

/**
 * NEO-287 — "this marketplace is on pause" notice for the sync surface.
 *
 * Renders when the operator has set `NEONBINDER_PAUSED_PLATFORMS`, and names
 * every paused marketplace. See lib/marketplace/pause-notice.ts for the copy
 * and the reason the switch exists.
 *
 * ## The same shape as ReauthNotice, deliberately
 *
 * Both answer the same question on the same surface — "why is a marketplace
 * not taking part in my syncs?" — so they share one visual grammar: a slim
 * amber strip above the page heading, a 4px left rule as the non-colour cue,
 * a bold lead that names the platforms, `role="status"` (polite; worth
 * announcing, not worth interrupting a keyboard user mid-cascade), and a
 * per-session Dismiss that parks focus on the heading. The strip's budget
 * matters here: the headless E2E viewport is 1024x629 and the Sports column
 * has to stay above the fold, so this costs the cascade one wrapped line.
 *
 * What is different is what the strip ASKS. A lapsed session has a fix the
 * operator can perform, so ReauthNotice carries a link. A pause is the
 * operator's own decision and lifts server-side, so there is nothing for the
 * reader to do — this strip states the facts (syncs roll on with the other
 * marketplace; nothing gets unlinked) and offers only Dismiss.
 *
 * ## Dismissible per session, keyed on the paused list
 *
 * Dismiss hides it for the rest of this browser tab session, keyed on WHICH
 * platforms are paused — if a second platform is paused after the dismiss,
 * the key changes and the notice comes back. Nothing is written server-side.
 * `sessionStorage` can throw (private windows, blocked site data), so every
 * touch is guarded and the notice simply stays visible if it does.
 */

const DISMISS_KEY = "nb.pausedNoticeDismissed";

export interface PausedNoticeProps {
  /**
   * The paused credential SITE keys, from `usePausedPlatforms`. Any iterable
   * order is fine — the notice sorts, so the key and the join are stable.
   */
  sites: Iterable<string>;
}

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(key: string) {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, key);
  } catch {
    // Storage unavailable — the notice just stays visible.
  }
}

/** The set-builder heading `PausedNotice` parks focus on after Dismiss. */
export const PAUSED_NOTICE_FOCUS_PARK_ID = REAUTH_NOTICE_FOCUS_PARK_ID;

export default function PausedNotice({ sites }: PausedNoticeProps) {
  // Lazy initialiser: one synchronous read on mount, then React state owns it.
  const [dismissedKey, setDismissedKey] = useState<string | null>(readDismissed);

  const sorted = [...new Set(sites)].sort();
  if (sorted.length === 0) return null;

  const key = sorted.join(",");
  if (dismissedKey === key) return null;

  const { lead, body } = pausedStripText(sorted, KNOWN_SITES);

  const onDismiss = () => {
    writeDismissed(key);
    setDismissedKey(key);
    // Dismiss unmounts the very button that was clicked, which drops focus to
    // <body> (WCAG 2.4.3). Park it on the page heading a frame later, once the
    // unmount has happened, and only if nothing else claimed focus meanwhile.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {
        document.getElementById(PAUSED_NOTICE_FOCUS_PARK_ID)?.focus();
      }
    });
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border border-l-4 border-amber-700 dark:border-amber-400/70 bg-amber-400/10 rounded-md text-amber-800 dark:text-amber-300 text-sm"
    >
      <p className="min-w-0 flex-1 basis-64">
        <strong className="font-semibold">{lead}</strong> {body}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={PAUSE_NOTICE_COPY.strip.dismissLabel}
        // px-2 py-1.5 keeps the target at or above WCAG 2.5.8's 24px minimum,
        // as ReauthNotice's Dismiss does.
        className="shrink-0 text-xs underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-[#00B7FF] rounded px-2 py-1.5"
      >
        {PAUSE_NOTICE_COPY.strip.dismiss}
      </button>
    </div>
  );
}
