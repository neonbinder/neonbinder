import { useState } from "react";
import { Link } from "react-router";
import {
  REAUTH_NOTICE_COPY,
  joinSiteLabels,
} from "@/lib/marketplace/reauth-notice";

/**
 * NEO-278 — "your marketplace session lapsed" notice for the sync surfaces.
 *
 * Reads the SAME server-owned `needsReauth` flag the profile page's amber
 * "sign in again" card reads (`userProfile.getUserProfile` →
 * `siteCredentials[].needsReauth`), and names every platform carrying it.
 * See lib/marketplace/reauth-notice.ts for why this is needed and for the
 * copy.
 *
 * ## A warning, not a gate
 *
 * The Set Builder keeps working underneath — syncs still go out on the stored
 * session until the marketplace finally rejects it. So this is deliberately
 * NOT the shape of `MissingCredentialsBanner` (a full-width box that replaces
 * the tool): it is a slim strip that wraps on narrow screens, sits above the
 * page heading, and costs the cascade under it as little height as possible.
 * The admin layout's note explains why every header line matters here — the
 * headless E2E viewport is 1024x629 and the Sports column has to stay above
 * the fold.
 *
 * ## Register
 *
 * Amber, the house "an unanswered question, nothing broke" colour
 * (`SyncDoneNotice`, the suggestions pill, `CardAttentionBadge`) — and the
 * same colour the profile card uses for this exact state, so the two surfaces
 * read as one signal. Border weights are the pairing `SyncDoneNotice` already
 * measured against WCAG 1.4.11 (border-amber-700 / dark:border-amber-400/70
 * over bg-amber-400/10). The 4px left rule is the non-colour cue; the bold
 * lead names the platforms so colour is never the only signal.
 *
 * `role="status"` (polite) rather than `role="alert"`: worth announcing when
 * it appears, not worth interrupting a keyboard user mid-cascade.
 *
 * ## Dismissible per session
 *
 * Dismiss hides it for the rest of this browser tab session, keyed on WHICH
 * platforms are flagged — if a second platform lapses after the dismiss, the
 * key changes and the notice comes back. Nothing is written server-side: the
 * flag is the server's, and it clears itself when the operator signs in
 * again. `sessionStorage` can throw (private windows, blocked site data), so
 * every touch is guarded and the notice simply stays visible if it does.
 */

const DISMISS_KEY = "nb.reauthNoticeDismissed";

export interface ReauthNoticeProps {
  /** The profile's `siteCredentials` array, or nothing while loading / no profile. */
  siteCredentials:
    | ReadonlyArray<{ site: string; needsReauth?: boolean }>
    | null
    | undefined;
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

/** The set-builder heading `ReauthNotice` parks focus on after Dismiss. */
export const REAUTH_NOTICE_FOCUS_PARK_ID = "set-builder-heading";

export default function ReauthNotice({ siteCredentials }: ReauthNoticeProps) {
  // Lazy initialiser, the same shape as useSaleTotal's localStorage read: one
  // synchronous read on mount, then React state owns it.
  const [dismissedKey, setDismissedKey] = useState<string | null>(readDismissed);

  const sites = (siteCredentials ?? [])
    .filter((c) => c.needsReauth === true)
    .map((c) => c.site)
    .sort();

  if (sites.length === 0) return null;

  const key = sites.join(",");
  if (dismissedKey === key) return null;

  const onDismiss = () => {
    writeDismissed(key);
    setDismissedKey(key);
    // Dismiss unmounts the very button that was clicked, which drops focus to
    // <body> (WCAG 2.4.3). Park it on the page heading a frame later, once the
    // unmount has happened, and only if nothing else claimed focus meanwhile.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {
        document.getElementById(REAUTH_NOTICE_FOCUS_PARK_ID)?.focus();
      }
    });
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border border-l-4 border-amber-700 dark:border-amber-400/70 bg-amber-400/10 rounded-md text-amber-800 dark:text-amber-300 text-sm"
    >
      <p className="min-w-0 flex-1 basis-64">
        <strong className="font-semibold">
          {REAUTH_NOTICE_COPY.lead(joinSiteLabels(sites), sites.length)}
        </strong>{" "}
        {REAUTH_NOTICE_COPY.body}
      </p>
      <Link
        to="/profile/credentials"
        className="shrink-0 inline-block px-3 py-1.5 rounded-md bg-neon-green text-black text-xs font-semibold hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-green focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {REAUTH_NOTICE_COPY.link}
      </Link>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={REAUTH_NOTICE_COPY.dismissLabel}
        // px-2 py-1.5 keeps the target at or above WCAG 2.5.8's 24px minimum,
        // as SyncDoneNotice's Dismiss does.
        className="shrink-0 text-xs underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-[#00B7FF] rounded px-2 py-1.5"
      >
        {REAUTH_NOTICE_COPY.dismiss}
      </button>
    </div>
  );
}
