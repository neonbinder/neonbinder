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
