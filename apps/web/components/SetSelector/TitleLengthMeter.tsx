import type { ReactNode } from "react";
import {
  ASPECT_VALUE_MAX,
  LISTING_TITLE_MAX,
  LISTING_TITLE_MOBILE_CLIP,
  LISTING_TITLE_SEARCH_CLIP,
} from "../../convex/features/listingLimits";

/**
 * NEO-101 — the length readout for a marketplace-capped field, shared by the
 * card detail drawer and the attention walker's title fixer.
 *
 * ## Why one component for two surfaces
 *
 * The same question ("does this title fit?") is asked in two places that look
 * nothing alike: a right-anchored drawer the operator edits a whole card in,
 * and a one-card-at-a-time dialog that exists only because the title does NOT
 * fit. If the two disagreed about where amber starts, or worded the over-cap
 * message differently, the walker would be teaching an operator a rule the
 * drawer then contradicts. So the bands, the wording and the colour roles live
 * here once and both surfaces render the same two pieces:
 *
 *   - {@link TitleLengthMeter} — `62/80 · may clip in search`, in the field's
 *     label row, ABOVE the input;
 *   - {@link TitleLengthAlert} — the over-cap `role="alert"`, BELOW the input.
 *
 * They are two components rather than one because they render either side of
 * the input, and the input's position in the drawer is load-bearing (Maestro
 * flows key off `id: "Card title"` and the documented drawer field order).
 *
 * ## Colour is never the only signal
 *
 * Every band that is not "fine" carries words: `may clip on mobile`,
 * `may clip in search`, and a full sentence in the alert. The colours below are
 * the app's existing roles — grey is neutral, pink (#FF2E9A) is the error
 * colour used for every inline field error in this directory — plus two warm
 * steps between them.
 *
 * ## Two surfaces (NEO-101 audit), one set of roles (NEO-356)
 *
 * This renders on TitleFixer's walker dialog (`surface="dark"`) and on
 * CardDetailPanel's drawer (`"themed"`, the default). Both now paint with
 * colour roles, which follow the light/dark mode, so each tone reads 4.5:1 on
 * either surface in either mode. The two maps differ only in the over-cap
 * tone: on the drawer's graphite the brand pink measures 4.4:1, so it takes
 * the danger notice ink there. `surface` stays so callers need no change.
 *
 * ## The bands are display truncation, not rules
 *
 * Only `LISTING_TITLE_MAX` is a rule — eBay rejects an over-length title at
 * listing time (error 70), it does not trim it. 55 and 70 are where eBay's own
 * search results clip a title for a reader; a title past them still lists fine.
 * That is why they warn and only the cap blocks. See
 * convex/features/listingLimits.ts for the sourcing.
 */

/** Which band a length falls in. Ordered least to most serious. */
export type TitleLengthTone = "ok" | "mobile" | "search" | "over";

export type TitleLengthState = {
  tone: TitleLengthTone;
  /** True once the value exceeds the cap — the state that blocks a save. */
  over: boolean;
  /** How many characters past the cap. 0 when within it. */
  overBy: number;
  /** Short phrase for the counter row. `null` in the "ok" band. */
  hint: string | null;
  /**
   * The over-cap FACT, without advice: "84 characters — 4 over the
   * 80-character limit." `null` unless over the cap. The advice that follows it
   * differs per field (the title blocks a save, an aspect value only warns), so
   * it is the alert component's to add, not this function's.
   */
  alert: string | null;
};

/** Which ambient surface a caller renders this on. See the header note. */
export type TitleLengthSurface = "themed" | "dark";

/** TitleFixer's walker dialog. */
const TONE_CLASS_DARK: Record<TitleLengthTone, string> = {
  ok: "text-ink-3",
  mobile: "text-notice-warn-ink",
  search: "text-neon-orange-text",
  over: "text-neon-pink-text",
};

/** CardDetailPanel's drawer (`bg-raised`). */
const TONE_CLASS_THEMED: Record<TitleLengthTone, string> = {
  ok: "text-ink-3",
  mobile: "text-notice-warn-ink",
  search: "text-neon-orange-text",
  // The brand pink is 4.4:1 on the dark drawer; the danger ink clears 4.5:1.
  over: "text-notice-danger-ink",
};

function toneClass(tone: TitleLengthTone, surface: TitleLengthSurface): string {
  return surface === "dark" ? TONE_CLASS_DARK[tone] : TONE_CLASS_THEMED[tone];
}

/**
 * Classify a length against a cap.
 *
 * `soft` opts into the display-truncation bands, which belong to the listing
 * TITLE only: an eBay aspect value is not shown in search results, so there is
 * nothing for a "may clip" warning to mean on the variation field — it has a
 * hard cap and nothing else.
 */
export function titleLengthState(
  length: number,
  max: number = LISTING_TITLE_MAX,
  soft = false,
): TitleLengthState {
  if (length > max) {
    const overBy = length - max;
    return {
      tone: "over",
      over: true,
      overBy,
      hint: `${overBy} over`,
      alert: `${length} characters — ${overBy} over the ${max}-character limit.`,
    };
  }
  if (soft && length >= LISTING_TITLE_SEARCH_CLIP) {
    return {
      tone: "search",
      over: false,
      overBy: 0,
      hint: "may clip in search",
      alert: null,
    };
  }
  if (soft && length >= LISTING_TITLE_MOBILE_CLIP) {
    return {
      tone: "mobile",
      over: false,
      overBy: 0,
      hint: "may clip on mobile",
      alert: null,
    };
  }
  return { tone: "ok", over: false, overBy: 0, hint: null, alert: null };
}

/** The aspect-value cap, re-exported so a caller needs one import, not two. */
export { ASPECT_VALUE_MAX, LISTING_TITLE_MAX };

/**
 * `62/80 · may clip in search` — the counter for a field's label row.
 *
 * Rendered as plain text, not a live region: it updates on every keystroke, and
 * an assertive readout of a character count while someone is typing is noise.
 * The state that actually needs announcing (over the cap) is
 * {@link TitleLengthAlert}, which is a live region and fires once per crossing.
 */
export function TitleLengthMeter({
  length,
  max = LISTING_TITLE_MAX,
  soft = false,
  surface = "themed",
}: {
  length: number;
  max?: number;
  soft?: boolean;
  /** Which ambient surface this renders on. Default is safe for CardDetailPanel; TitleFixer passes `"dark"`. */
  surface?: TitleLengthSurface;
}) {
  const state = titleLengthState(length, max, soft);
  return (
    <span className={`flex items-center gap-1 tabular-nums ${toneClass(state.tone, surface)}`}>
      <span>
        {length}/{max}
      </span>
      {state.hint && (
        <>
          {/* aria-hidden: the separator is typographic, and "middle dot" read
              aloud between the count and the phrase is noise. */}
          <span aria-hidden="true">·</span>
          {/* Not uppercase like the label beside it: this is a sentence the
              operator reads, not a field name they scan for. */}
          <span className="normal-case">{state.hint}</span>
        </>
      )}
    </span>
  );
}

/**
 * The over-cap message, below the input.
 *
 * Renders nothing at all within the cap — an always-present region that
 * switched text would announce on every band change, including the two that are
 * advisory.
 *
 * `blocking` picks both the advice and the politeness. The listing title blocks
 * the save, so it is `role="alert"` and says so. An aspect value does NOT block
 * (NEO-101 decision: we do not yet know which NB field maps verbatim to which
 * marketplace aspect, and hard-blocking on a guess is the NEO-189 mistake), so
 * it is `role="status"` and says what the risk is instead of what to do.
 */
export function TitleLengthAlert({
  id,
  length,
  max = LISTING_TITLE_MAX,
  what = "Title",
  blocking = true,
  surface = "themed",
}: {
  id?: string;
  length: number;
  max?: number;
  /** Field name to lead with, so the walker's two fields read distinctly. */
  what?: string;
  /** False for a warn-only field. */
  blocking?: boolean;
  /** Which ambient surface this renders on. Default is safe for CardDetailPanel; TitleFixer passes `"dark"`. */
  surface?: TitleLengthSurface;
}) {
  const state = titleLengthState(length, max);
  if (!state.alert) return null;
  return (
    <p
      id={id}
      role={blocking ? "alert" : "status"}
      aria-atomic="true"
      className={`mt-1 text-[10px] ${toneClass("over", surface)}`}
    >
      {what} is {state.alert}{" "}
      {blocking
        ? "Shorten it before saving."
        : "You can still save it, but a marketplace that caps this field will reject the value."}
    </p>
  );
}

/**
 * The advisory note used for `listingTitleTruncated` and for the walker's
 * per-item reasons. Same type scale and colour as the counter's soft bands, so
 * "this needs a look" reads as one voice wherever it appears.
 */
export function TitleFieldNote({
  children,
  surface = "themed",
}: {
  children: ReactNode;
  /** Which ambient surface this renders on. Default is safe for CardDetailPanel; TitleFixer passes `"dark"`. */
  surface?: TitleLengthSurface;
}) {
  return <p className={`mt-1 text-[10px] ${toneClass("mobile", surface)}`}>{children}</p>;
}
