import type { Ref } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import SetRowActionButton from "./SetRowActionButton";
import { slReviewPillText } from "./selector-sync-feedback";

/**
 * NEO-306 — the Sets column's "N SportLots sets to sort" pill: the door to
 * the SportLots-only review (`SlSetReviewModal`).
 *
 * Its own component, owning its own query, so `EntityColumn` never learns the
 * review's module: the column only renders this for a Sets column scoped to
 * ONE brand (the review doc is keyed per brand), and every other column —
 * and every existing column test — never evaluates `api.slSetReview`.
 *
 * Rendered only once the summary has RESOLVED to something to sort: no ghost
 * "0 SportLots sets" while loading, and never a pill that opens an empty
 * dialog (the suggestions pill's rule, `EntityColumn`).
 *
 * The house attention style (`SetRowActionButton` tone "attention", the same
 * amber as the suggestions pill and `CardAttentionBadge`): amber is "a person
 * should look at this" throughout the builder. The visible text is the
 * accessible name, so a flow's `text:` and a screen reader hear one string.
 */
export default function SlSetReviewPill({
  manufacturerId,
  buttonRef,
  onOpen,
}: {
  manufacturerId: Id<"selectorOptions">;
  /** Where focus goes back to when the review closes. */
  buttonRef?: Ref<HTMLButtonElement>;
  onOpen: () => void;
}) {
  const summary: unknown = useQuery(api.slSetReview.getSlSetReviewSummary, {
    manufacturerId,
  });
  // Shape-guarded, not trusted: the column subscribes to several queries and
  // anything but a positive count is "nothing to sort".
  if (typeof summary !== "object" || summary === null) return null;
  const { pending, partial } = summary as { pending?: unknown; partial?: unknown };
  if (typeof pending !== "number" || pending <= 0) return null;
  return (
    <SetRowActionButton
      tone="attention"
      ref={buttonRef}
      onActivate={onOpen}
      aria-haspopup="dialog"
    >
      {slReviewPillText({ pending, partial: partial === true })}
    </SetRowActionButton>
  );
}
