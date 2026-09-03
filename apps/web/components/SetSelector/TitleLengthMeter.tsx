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
 * the app's existing roles — grey is neutral, pink (#FF2EB3) is the error
 * colour used for every inline field error in this directory — plus two warm
 * steps between them.
 *
 * ## Two surfaces, two colour strategies (a11y fix, NEO-101 audit)
 *
 * This component renders on two DIFFERENT kinds of surface, and one fixed set
 * of hexes cannot be correct on both:
 *
 *   - `TitleFixer`'s dialog (`CardAttentionWalker`) hardcodes `bg-gray-900`
 *     with no `dark:` qualifier anywhere in that file — it is unconditionally
 *     dark, the same reasoning `BASE_INPUT` in components/primitives/Input.tsx
 *     documents: a `dark:` pair would render its LIGHT half on that surface
 *     for anyone whose OS is in light mode, since Tailwind's `dark:` variant
 *     follows `prefers-color-scheme`, not this app's forced Radix
 *     `appearance="dark"`. Fixed hexes are correct and required there.
 *   - `CardDetailPanel`'s own drawer chrome is `bg-white dark:bg-gray-800` —
 *     genuinely bi-themed, unlike the walker. The SAME fixed hexes measured
 *     (WCAG relative-luminance) at 1.83–3.34:1 against white — all fail
 *     4.5:1 — and the error tone even measures 4.40:1 against this drawer's
 *     own `gray-800` (still fails, if narrowly). Verified: no forced `.dark`
 *     class exists anywhere in `src/main.tsx`/`index.html`, so an operator
 *     whose OS is in light mode really does render this drawer on white.
 *
 * `surface` picks which of the two applies. Default `"themed"` — safe with NO
 * caller change for `CardDetailPanel`, which already uses `dark:` pairs
 * elsewhere in the same file for exactly this reason (e.g. its own
 * `text-[#C2178A] dark:text-[#FF6FCB]` error line, `text-gray-500
 * dark:text-gray-400` secondary text — the light-mode halves here are chosen
 * to match that existing precedent). `TitleFixer` passes `surface="dark"`
 * explicitly, since its dialog is the one surface where a `dark:` pair would
 * be the wrong, trap-prone choice.
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

/** Safe ONLY on an unconditionally-dark surface (TitleFixer's walker dialog). */
const TONE_CLASS_DARK: Record<TitleLengthTone, string> = {
  ok: "text-gray-400",
  mobile: "text-[#FFB020]",
  search: "text-[#FF7A45]",
  over: "text-[#FF2EB3]",
};

/**
 * Safe on a genuinely bi-themed surface (CardDetailPanel's `bg-white
 * dark:bg-gray-800`). Light halves are new, chosen to clear 4.5:1 against
 * white; dark halves reuse the values above unchanged (already verified safe
 * against `gray-800`).
 */
const TONE_CLASS_THEMED: Record<TitleLengthTone, string> = {
  ok: "text-gray-500 dark:text-gray-400",
  mobile: "text-[#973C00] dark:text-[#FFB020]",
  search: "text-[#A8431A] dark:text-[#FF7A45]",
  // Reuses this app's own error-pink dark-split precedent verbatim (see
  // CardDetailPanel.tsx's variation-parent error line) rather than inventing
  // a third pink.
  over: "text-[#C2178A] dark:text-[#FF6FCB]",
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
