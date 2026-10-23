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
 * (#00D558) is "good, confirmed" throughout this app, and pink (#FF2E9A) is
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
  cardIdentity,
}: {
  /** Non-empty. The caller decides whether to render this at all. */
  items: AttentionItem[];
  /**
   * How the row names itself — its card number, and its card name when it has
   * one ("NNO, Jon Larson"). Composed by the caller; see the `cardIdentity`
   * note in CardChecklistItem.
   *
   * NEO-272: this was the card NUMBER alone, and product invariant 7 says a
   * card number is never unique at any scope — on an unnumbered set every mark
   * in the list announced itself as "Card NNO needs attention: …", which
   * defeats the whole point of naming the card in a label that exists to be
   * meaningful out of row context.
   */
  cardIdentity: string;
}) {
  // Every kind, joined — one mark can stand for several reasons once NEO-101
  // adds its title kinds, and the operator should hear all of them.
  const reasons = items.map(attentionItemLabel).join("; ");
  return (
    <span
      role="img"
      aria-label={`Card ${cardIdentity} needs attention: ${reasons}`}
      title={`Needs attention — ${reasons}`}
      // a11y (1.4.3 / 1.4.11): the warn notice roles (NEO-356). Over this
      // badge's own translucent amber wash, the ink clears 4.5:1 and the
      // rule 3:1 in both modes; a raw amber step cannot do both, since the
      // shade that passes on graphite fails on white and the reverse.
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-notice-warn-rule bg-amber-400/15 text-[11px] font-bold text-notice-warn-ink"
    >
      <span aria-hidden="true">!</span>
    </span>
  );
}
