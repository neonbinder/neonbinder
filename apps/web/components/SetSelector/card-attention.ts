export * from "../../convex/features/cardAttention";

import type { AttentionKind } from "../../convex/features/cardAttention";

/**
 * NEO-102 — the SPA's view of the derived "needs attention" rule.
 *
 * The rule itself lives in `convex/features/cardAttention.ts`, which is
 * deliberately pure (no ctx, no db, no async) precisely so the browser can
 * call it on a `getCardChecklist` row — the same trick `expectedFeatures`
 * already uses. Re-exported through this module rather than imported directly
 * at each call site so `components/SetSelector` has ONE seam onto it: the
 * badge, the header count, the grid filter and the walker all import from
 * here.
 *
 * Only the WORDING lives on this side. That is not incidental: how an item is
 * phrased to an operator is a UI decision, and a copy of the string in the
 * Convex module is how the two drift apart — see the note on `AttentionItem`
 * there, which carries no message text for exactly this reason.
 */

/**
 * Operator-facing reason text, per kind. Read through `attentionItemLabel`
 * rather than indexed directly.
 */
export const ATTENTION_LABELS: Record<AttentionKind, string> = {
  missingTeam: "no team on this card yet",
  // NEO-101. Worded as what is wrong rather than what to do — the fixer next
  // to it is the instruction. The numbers are spelled out because an operator
  // reading a badge has no other way to know which limit bit.
  titleOverLimit: "title is over the 80-character limit",
  titleTruncated: "auto-generated title was cut short",
  aspectValueOverLimit: "variation text is over the 65-character limit",
  // NEO-221 (D12). Says what is MISSING — the LINK — and deliberately says
  // nothing about review.
  //
  // The kind fires for two different origins: a name a marketplace commit left
  // undecided, and a name an operator typed into the quick-add form that no
  // `players`/`teams` row exists for yet. "Not reviewed" is true of the first
  // and a lie about the second, and an operator who has just typed a name does
  // not want to be told nobody reviewed it. "Not yet linked" is exactly what
  // is wrong in both cases, and it is the thing the fixer next to it fixes.
  unreviewedName: "name not yet linked to a player or team",
};

/**
 * The reason text for one item.
 *
 * Falls back for an unrecognised kind rather than rendering `undefined`. That
 * is a real state, not defensive padding: a Convex deploy is a hard cutover,
 * so a browser holding this bundle can read rows flagged by a newer one —
 * NEO-101's title kinds land in `AttentionItem` before every open tab has
 * reloaded.
 */
export function attentionItemLabel(item: { kind: string }): string {
  return ATTENTION_LABELS[item.kind as AttentionKind] ?? "needs a look";
}
