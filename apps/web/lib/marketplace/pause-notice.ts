/**
 * NEO-287 — every user-facing string for the "this marketplace is on pause"
 * state, in one place. Sibling of `reauth-notice.ts`, same shape.
 *
 * WHY THIS EXISTS: an operator sets `NEONBINDER_PAUSED_PLATFORMS` and
 * NeonBinder stops contacting that marketplace — no sign-ins, no session
 * checks, no fetches on that side. The user has to see that everywhere they
 * would otherwise have connected, tested or synced it, and the copy has to say
 * the one thing that matters to them: nothing of theirs was touched. Sessions
 * stay stored, links stay attached (product invariant #5). Three surfaces read
 * from here — the Profile credentials card, the Set Builder strip and the two
 * marketplace pickers — so a wording change is one edit.
 *
 * Copy approved verbatim by Jason (todos/neo-287-plan.md §4, 2026-09-17). Do
 * not paraphrase; a change goes back through sign-off.
 *
 * Marketplace NAMES are fine here: this is signed-in UI telling the user which
 * account is benched, not public copy, and the names are display-only —
 * nothing keys behaviour on them (invariant #4). Two vocabularies reach this
 * module and both resolve to a display name before any sentence is built:
 *
 *   - credential SITE keys (`sportlots`, `buysportscards`) — the Profile card
 *     and the Set Builder strip, via `siteLabel` / `joinSiteLabels`;
 *   - slot SIDES (`sportlots`, `bsc`) — the picker panes, which read
 *     `pausedSides` off a sync result, via `platformNames`.
 */

import { platformNames } from "@/convex/selectorSyncStore";
import { joinSiteLabels } from "./reauth-notice";

export { joinSiteLabels, siteLabel } from "./reauth-notice";

/** Display name of ONE slot side ("bsc" → "BuySportsCards"). */
export function sideLabel(side: string): string {
  return platformNames([side]);
}

/**
 * Copy for sign-off lives here and nowhere else. Every function takes a
 * DISPLAY NAME (or a joined list of them), never a key, so the BuySportsCards
 * variants fall out of the same sentences.
 */
export const PAUSE_NOTICE_COPY = {
  /** /profile/credentials — the amber card above the connection states. */
  profile: {
    heading: (name: string) => `${name} is on pause`,
    /** The account is connected; its stored session is untouched. */
    bodyConnected: (name: string) =>
      `Sign-ins to ${name} are benched for now. Your saved session stays right where it is — nothing to redo. We'll flip the switch back the moment the coast is clear.`,
    /** Nothing is connected, and connecting is exactly what is paused. */
    bodyNotConnected: (name: string) =>
      `Sign-ins to ${name} are benched for now, so we can't hook up a new account just yet. Check back soon — we'll flip the switch the moment the coast is clear.`,
    /**
     * Labels of the two disabled controls. Distinct from each other AND from
     * the live labels ("Sign in again" / "Test Credentials") so no two
     * buttons on the panel ever share an accessible name, and so a flow that
     * waits on "Test Credentials" can never tap a paused control (Maestro
     * cannot read `enabled` on web; the label is the only evidence).
     */
    signInPaused: "Sign-in paused",
    testPaused: "Test paused",
  },

  /** /admin/set-builder — the amber strip above the heading. */
  strip: {
    /** Bold lead. `names` is the joined paused list, `count` how many. */
    lead: (names: string, count: number) =>
      `${names} ${count > 1 ? "are" : "is"} on pause.`,
    /**
     * Plain follow-on. `activeNames` is the joined list of marketplaces still
     * being synced; when none are left the sentence changes shape entirely,
     * because "roll on with  only" is not a sentence.
     */
    body: (pausedNames: string, activeNames: string) =>
      activeNames
        ? `Syncs roll on with ${activeNames} only. Your ${pausedNames} links stay put — nothing gets unlinked.`
        : "Syncs are benched until a marketplace is back.",
    /** Visible label of the dismiss control. */
    dismiss: "Dismiss",
    /**
     * Accessible name of the dismiss control. Distinct from ReauthNotice's
     * "Dismiss sign-in notice" and SyncDoneNotice's "Dismiss <column> notice":
     * all three can share the page.
     */
    dismissLabel: "Dismiss pause notice",
  },

  /**
   * Base picker / attach dialog — replaces a pane's empty state when that side
   * was never asked because it is paused. One sentence, no list: there is
   * nothing to pick from and nothing to fix.
   */
  pane: (name: string) =>
    `${name} is on pause — no ${name} sets to pick from right now. Your existing ${name} links stay put.`,
} as const;

/**
 * The Set Builder strip's two sentences for a set of paused SITE keys, given
 * the full site vocabulary so the "still rolling" list can be derived. Kept
 * here rather than in the component so the join rule is testable without a
 * DOM, the same way `REAUTH_NOTICE_COPY.lead` is.
 */
export function pausedStripText(
  pausedSites: readonly string[],
  knownSites: readonly string[],
): { lead: string; body: string } {
  const paused = new Set(pausedSites);
  const active = knownSites.filter((s) => !paused.has(s));
  return {
    lead: PAUSE_NOTICE_COPY.strip.lead(
      joinSiteLabels(pausedSites),
      pausedSites.length,
    ),
    body: PAUSE_NOTICE_COPY.strip.body(
      joinSiteLabels(pausedSites),
      joinSiteLabels(active),
    ),
  };
}
