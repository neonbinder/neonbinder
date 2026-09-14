/**
 * NEO-278 — every user-facing string for the "your marketplace session
 * lapsed" notice, in one place.
 *
 * WHY THIS EXISTS: when a marketplace session dies and cannot be renewed, the
 * server sets `needsReauth: true` on that site's credential row. Until
 * NEO-278 the ONLY place that surfaced was the amber card on
 * /profile/credentials — a page nobody opens while building sets. Syncs keep
 * running on the stale token in the meantime, so the operator sees nothing
 * until the day the marketplace finally rejects it and a sync fails cold.
 * On 2026-09-14 both platforms sat in `needsReauth` all day with zero signal.
 *
 * The notice that fixes that lives on the sync surface (the Set Builder) and
 * reads the same server-owned flag the profile page reads. This module holds
 * its copy so a wording change is one edit, and so the join rule ("A and B",
 * "A, B, and C") is testable without a DOM.
 *
 * Marketplace NAMES are fine here: this is the signed-in operator UI telling
 * them which account to reconnect, not public copy. The map is display-only —
 * nothing keys behaviour on it (product invariant #4). An unknown site key
 * falls through to itself rather than throwing, because a row for a platform
 * this map has not learned yet must still be nameable.
 */

const SITE_LABEL: Record<string, string> = {
  buysportscards: "BuySportsCards",
  sportlots: "SportLots",
};

export function siteLabel(site: string): string {
  return SITE_LABEL[site] ?? site;
}

/** "A" / "A and B" / "A, B, and C" — the same join MissingCredentialsBanner uses for two. */
export function joinSiteLabels(sites: readonly string[]): string {
  const labels = sites.map(siteLabel);
  if (labels.length <= 1) return labels.join("");
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

/**
 * Copy for sign-off lives here and nowhere else. Register: short, punchy,
 * a little 80s — and it says what the operator should DO, not how the
 * fallback works under the hood.
 */
export const REAUTH_NOTICE_COPY = {
  /**
   * Bold lead. `sites` is the joined platform list, `count` how many, for the
   * plural. Jason, 2026-09-14: "ran out", not "signed you out" — the
   * marketplace did nothing; our session lapsed.
   */
  lead: (sites: string, count: number) =>
    `Your ${sites} ${count > 1 ? "sessions" : "session"} ran out.`,
  /** Plain follow-on. */
  body: "Syncs are running on borrowed time. Sign in again to keep them rolling.",
  /** Link text — the accessible name of the link, so it must stay unique on the page. */
  link: "Sign in again on your Profile →",
  /** Visible label of the dismiss control. */
  dismiss: "Dismiss",
  /**
   * Accessible name of the dismiss control. Distinct from SyncDoneNotice's
   * "Dismiss <column> notice" so two dismiss buttons on the same page never
   * share a name.
   */
  dismissLabel: "Dismiss sign-in notice",
} as const;
