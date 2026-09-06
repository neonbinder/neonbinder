/**
 * NEO-251 (security review) — marketplace text on its way into a log line.
 *
 * A SportLots card description is attacker-influenced in the ordinary sense
 * that anybody who can get a card listed chooses what it says. Two of those
 * strings are logged verbatim and unbounded today — the
 * `indistinguishableSlRefs` and orphaned-ref reports in `fetchCardChecklist`,
 * both a `.join(" | ")` over a list whose length is the marketplace's choice —
 * and a log line is not an inert sink: it is read in a terminal, in Convex's
 * dashboard, and in whatever ships it onward, all of which interpret control
 * characters.
 *
 * Two problems, one helper:
 *
 *  - CONTROL AND DIRECTION CHARACTERS. A newline turns one log entry into two,
 *    and the second one is written by the marketplace — that is log forgery,
 *    and it is how a fabricated line gets into an incident timeline. ANSI
 *    escapes repaint a terminal; the bidirectional overrides reorder what a
 *    human reads without changing the bytes, which is the Trojan-Source trick
 *    aimed at an operator's screen rather than at a compiler.
 *  - LENGTH. A ref list is bounded only by how many cards a set has, so one
 *    condition on a 900-card set can emit a single line of tens of kilobytes.
 *
 * It REPLACES rather than drops, so what was removed still occupies a
 * character and a stripped string cannot silently become a different
 * legitimate one. Prefer logging a COUNT to logging the text at all; use this
 * when the text itself is what an operator needs in order to act.
 */

/** How much of one marketplace string a log line is allowed to carry. */
const MAX_LOGGED_TEXT = 80;

/** C0 controls (newline, tab, ESC), DEL, and the C1 range. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Bidi marks, embeddings, overrides and isolates — invisible on their own, and
 * they reorder the rest of the line as it is rendered.
 */
const BIDI_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function safeMarketplaceText(raw: string): string {
  const stripped = raw
    .replace(CONTROL_CHARS, "\uFFFD")
    .replace(BIDI_CHARS, "\uFFFD");
  return stripped.length > MAX_LOGGED_TEXT
    ? `${stripped.slice(0, MAX_LOGGED_TEXT)}…`
    : stripped;
}
