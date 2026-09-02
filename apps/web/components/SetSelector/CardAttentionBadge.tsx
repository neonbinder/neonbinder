import { attentionItemLabel, type AttentionItem } from "./card-attention";

/**
 * NEO-102 — the checklist grid's first row-level diagnostic mark.
 *
 * ## Design
 *
 * Deliberately one glyph, not a word. The grid is up to 908 rows of
 * `#123 · Card Name · team · badges · Edit Del`, and every horizontal pixel
 * already belongs to something; a "Needs attention" pill would push the
 * platform badges into a second line on narrow columns. So the mark is an
 * amber `!` in a fixed 20px disc, and the *words* live in its accessible name
 * and tooltip, where they can be as long as they need to be.
 *
 * Amber because the other two roles are taken and both would lie: neon green
 * (#00D558) is "good, confirmed" throughout this app, and pink (#FF2EB3) is
 * destructive. This is neither — it is an unanswered question. Amber also
 * matches nothing else in the row's own badge cluster (`RC` amber sits in the
 * attribute group with a filled background; this is an outlined disc in its
 * own reserved slot), so the two do not read as the same kind of thing.
 *
 * ## Why it renders inside a caller-reserved slot
 *
 * It must NOT be the thing that changes a row's size. `CardChecklist`'s rows
 * are virtualized, and a row-height or row-width change re-measures the
 * Virtuoso list and reflows everything below it — the long-standing
 * dropped-tap flake that CardChecklistItem's always-reserved subtitle line
 * and always-reserved disclosure slot both exist to prevent. Attention state
 * is exactly the kind that flips under the operator (the background BSC team
 * pass lands, or they fix a card in the walker), so the caller reserves a
 * constant-size slot on every row and this renders into it or not.
 *
 * ## Not interactive, on purpose
 *
 * Fixing happens in `CardAttentionWalker`, reached from the set header — the
 * grid's job here is to say WHICH rows, at a glance. Keeping it a `<span>`
 * also keeps the virtualized list from gaining another tab stop per row.
 * `role="img"` is what makes a non-interactive glyph's `aria-label` count as
 * its accessible name.
 */
export default function CardAttentionBadge({
  items,
  cardNumber,
}: {
  /** Non-empty. The caller decides whether to render this at all. */
  items: AttentionItem[];
  /** Named in the accessible label so the mark is meaningful out of row context. */
  cardNumber: string;
}) {
  // Every kind, joined — one mark can stand for several reasons once NEO-101
  // adds its title kinds, and the operator should hear all of them.
  const reasons = items.map(attentionItemLabel).join("; ");
  return (
    <span
      role="img"
      aria-label={`Card ${cardNumber} needs attention: ${reasons}`}
      title={`Needs attention — ${reasons}`}
      // a11y (1.4.3 / 1.4.11): the original light-mode pairing — border-
      // amber-400/70 + text-amber-600 over this badge's own translucent
      // bg-amber-400/15 (itself blended over the row's white background) —
      // measured 1.48:1 (border, non-text, needs 3:1) and 2.92:1 (text, needs
      // 4.5:1); both fail. Dark mode's amber-300/amber-400 pairing already
      // passed (7.36:1 text, 4.90:1 border) and is unchanged. amber-700/
      // amber-800 solid measure 5.03:1 and 6.48:1 against this same
      // composited background, so both clear their thresholds with margin.
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-amber-700 dark:border-amber-400/70 bg-amber-400/15 text-[11px] font-bold text-amber-800 dark:text-amber-300"
    >
      <span aria-hidden="true">!</span>
    </span>
  );
}
