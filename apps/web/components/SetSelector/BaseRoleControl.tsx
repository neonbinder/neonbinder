import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { isBaseRole } from "./baseRole";

/**
 * NEO-239 — say which variant type is the set's BASE.
 *
 * ## Why this control has to exist
 *
 * Base used to be detected by matching a row's display value against the
 * literal `"base"`, so a hand-built set got its base by the operator happening
 * to type the right word. The role is a flag on the row now (`metadata.isBase`,
 * see ./baseRole), which is what finally made variant types renameable — and it
 * left hand entry with no way to set the flag at all. This is that way.
 *
 * ## Why it is an action and not a toggle
 *
 * A set has exactly ONE base, and the mutation clears the siblings. So "off" is
 * not a state this row owns: turning it on turns another row off. A switch or a
 * checked box would promise a per-row setting and quietly do something else, so
 * the non-base row gets a verb — "Mark as base set", which is precisely what
 * happens — and the base row gets a static tag plus a SEPARATE verb for the one
 * thing it can still do. The side effect rides in the `title` at the point of
 * decision rather than in a confirm dialog: both actions are one tap to
 * reverse, and a modal for a reversible role change would be a stop sign in
 * front of a signpost.
 *
 * Clearing is its own control rather than a second meaning for the tag, because
 * the two states are not symmetric. Marking is a transfer — it always lands the
 * role somewhere. Clearing leaves the set with NO base, which is legitimate
 * (`clear: true` exists precisely so an operator who set the wrong row has a way
 * back that does not require guessing a right one) but is a different act, and
 * an operator who can only reach it by promoting some other row would be forced
 * into exactly that guess.
 *
 * Both states occupy the same slot in the panel header, so the row of controls
 * does not reflow when the role moves.
 *
 * The panel scopes itself to ONE row, so the operator never sees the group from
 * here. That is the whole reason the base row shows an indicator rather than
 * nothing: without it, "which one is the base?" would need a column-by-column
 * hunt — and it is why the two halves of the side effect are split across two
 * moments. The `title` states the rule while the operator is deciding; the
 * confirmation reports what the server actually did, counted from its own
 * `clearedIds`, once it is done. Neither is a guess, and neither is a hedge.
 *
 * ## Copy
 *
 * The button, its aria-label and the confirmation all use the same verb, so the
 * control that says "Mark as base set" produces "Marked Base as the base set"
 * — the vocabulary stays put across the flow. The failure says what did not
 * happen and that nothing changed, and carries no thrown text: a Convex/adapter
 * error can embed a marketplace URL or a credential hint, and none of that is
 * user-facing copy (NEO-47 / NEO-211 B).
 */
export default function BaseRoleControl({
  id,
  value,
  metadata,
  onResult,
}: {
  id: Id<"selectorOptions">;
  /** The row's display name — the confirmation and the aria-label name it. */
  value: string;
  /** The row's `metadata`, read for `isBase` only. */
  metadata: unknown;
  /** Hands the panel a sentence to put in its own toast. */
  onResult: (message: string) => void;
}) {
  const setBaseVariantType = useMutation(
    api.selectorOptions.setBaseVariantType,
  );
  const [busy, setBusy] = useState(false);

  const markAsBase = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await setBaseVariantType({ variantTypeId: id });
      // Optional-chained: a mocked or older deployment can answer with nothing,
      // and a missing count is a reason to say less, never to throw away a
      // confirmation for a write that succeeded.
      const cleared = result?.clearedIds?.length ?? 0;
      onResult(
        cleared > 0
          ? `Marked ${value} as the base set — cleared ${cleared} other${
              cleared === 1 ? "" : "s"
            }`
          : `Marked ${value} as the base set`,
      );
    } catch {
      onResult("Couldn't set the base set. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };

  const clearBase = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setBaseVariantType({ variantTypeId: id, clear: true });
      // No count here, unlike marking: clearing touches exactly the row the
      // operator is looking at, so there is no off-screen side effect to report.
      onResult("Cleared the base set");
    } catch {
      onResult("Couldn't clear the base set. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };

  if (isBaseRole(metadata)) {
    return (
      <span className="shrink-0 flex items-center gap-1.5">
        {/* Not a control, and deliberately not styled like one: the same 10px
            uppercase tag idiom MultiSourcePanel uses for a slot's facet, which
            this UI already reads as "a fact about the row". Green rather than
            that idiom's grey because it is the single most consequential fact
            a variant type carries — it decides whether the row is terminal and
            holds the checklist — and it is the one place this control spends
            colour. */}
        <span
          className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[#00D558]/50 text-[#00D558]"
          title="This variant type holds the set's base checklist."
        >
          Base set
        </span>
        <button
          type="button"
          onClick={clearBase}
          disabled={busy}
          aria-label={`Clear base set from ${value}`}
          title="Leaves this set with no base until you mark one."
          className="text-xs text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none disabled:opacity-50"
        >
          Clear base set
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={markAsBase}
      disabled={busy}
      aria-label={`Mark ${value} as the base set`}
      title="A set has one base — this clears any other."
      className="shrink-0 text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none disabled:opacity-50"
    >
      Mark as base set
    </button>
  );
}
