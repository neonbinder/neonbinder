import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
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
 * ## NEO-306 — the role and the row are one thing
 *
 * Jason, 2026-09-27: `isBase` and the Base row must never move independently.
 * Clearing the flag and keeping the row is what broke a preview — the row
 * stopped being terminal, the cascade opened an Inserts column under it, and a
 * SportLots auto-sync filled that column with the brand's whole set list.
 *
 * So the control only ever GRANTS the role, and only to a set that has none:
 * "Mark as base set" renders on a non-base variant type only while
 * `getBaseVariantBySet` answers null for its set (and not while that answer is
 * still loading — offering it for a beat on a set that has a base would be a
 * button the server refuses). There is no transfer and no clear. The way to
 * take the role away is to delete the row, and that is the panel's ordinary
 * delete control beside this tag — one delete per row, with the same
 * emptiness check and the same explained refusal as every other row, and a
 * confirm that says what deleting a base means. The server refuses a second
 * base as well (`setBaseVariantType`), for a stale tab.
 *
 * ## The base row
 *
 * The panel scopes itself to ONE row, so the operator never sees the group from
 * here. That is why the base row shows an indicator rather than nothing:
 * without it, "which one is the base?" would need a column-by-column hunt.
 *
 * ## Copy
 *
 * The button, its aria-label and the confirmation all use the same verb, so the
 * control that says "Mark as base set" produces "Marked Base as the base set".
 * A failure says what did not happen and that nothing changed; the only thrown
 * text it ever shows is a ConvexError sentence the server wrote for a person
 * (`userFacingMessage`) — a Convex/adapter error can embed a marketplace URL or
 * a credential hint, and none of that is user-facing copy (NEO-47 / NEO-211 B).
 */
/**
 * NEO-306 — "Mark as base set" as a quiet outlined tag. `slate-500` is the
 * boundary tone that clears SC 1.4.11's 3:1 on the panel's dark surface
 * (slate-600 measured 2.4:1); the ring matches every other control in the
 * panel header and the action row.
 */
const BASE_ROLE_TAG =
  "shrink-0 inline-flex items-center min-h-6 px-2 rounded border border-slate-500 text-[11px] text-gray-200 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 " +
  "disabled:opacity-50";

export default function BaseRoleControl({
  id,
  value,
  metadata,
  setId,
  onResult,
}: {
  id: Id<"selectorOptions">;
  /** The row's display name — the confirmation and the aria-label name it. */
  value: string;
  /** The row's `metadata`, read for `isBase` only. */
  metadata: unknown;
  /** The set this variant type belongs to (its `parentId`). */
  setId: Id<"selectorOptions"> | undefined;
  /** Hands the panel a sentence to put in its own toast. */
  onResult: (message: string) => void;
}) {
  const setBaseVariantType = useMutation(
    api.selectorOptions.setBaseVariantType,
  );
  const isBase = isBaseRole(metadata);
  // Asked only for a row that could be offered the role. `null` is the one
  // answer that offers it; `undefined` (loading, or no set to ask about) and a
  // base found elsewhere both render nothing.
  const setBase = useQuery(
    api.selectorOptions.getBaseVariantBySet,
    !isBase && setId ? { setId } : "skip",
  );
  const [busy, setBusy] = useState(false);
  const tagRef = useRef<HTMLSpanElement>(null);
  const prevIsBaseRef = useRef(isBase);
  /**
   * This component's own write is what is about to swap the control.
   *
   * The role arrives from the server, so it can also flip while the operator is
   * doing nothing here — another tab, or a parallel worker, marking this row.
   * Moving focus on THAT would be focus theft, so the restore below fires only
   * when this instance's own button was the thing that caused the change. Same
   * shape as RenameEntityControl's `wasEditingRef`, except that one guards a
   * purely local transition and this one has to tell the two apart.
   */
  const actedRef = useRef(false);

  // The Mark button unmounts the instant the role lands, and with nothing to
  // move focus onto the browser drops it to <body> — a keyboard operator would
  // be returned to the top of the document mid-task. The tag that took its
  // place is the one thing in that slot now, and it says what just happened.
  useEffect(() => {
    if (prevIsBaseRef.current === isBase) return;
    const acted = actedRef.current;
    prevIsBaseRef.current = isBase;
    actedRef.current = false;
    if (acted && isBase) tagRef.current?.focus();
  }, [isBase]);

  const markAsBase = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setBaseVariantType({ variantTypeId: id });
      actedRef.current = true;
      onResult(`Marked ${value} as the base set`);
    } catch (e) {
      actedRef.current = false;
      // The server's own sentence when it refused (the set got a base in
      // another tab); otherwise the generic line, never the thrown text.
      onResult(
        userFacingMessage(e, "Couldn't set the base set. Nothing changed."),
      );
    } finally {
      setBusy(false);
    }
  };

  if (isBase) {
    return (
      // Not a control, and deliberately not styled like one: the same 10px
      // uppercase tag idiom MultiSourcePanel uses for a slot's facet, which
      // this UI already reads as "a fact about the row". Green rather than
      // that idiom's grey because it is the single most consequential fact a
      // variant type carries — it decides whether the row is terminal and
      // holds the checklist — and it is the one place this control spends
      // colour. `tabIndex={-1}`: focusable by script only, so marking has
      // somewhere to put focus without adding a tab stop.
      <span
        ref={tagRef}
        tabIndex={-1}
        className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[#00D558]/50 text-[#00D558] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
        title="This variant type holds the set's base checklist."
      >
        Base set
      </span>
    );
  }

  if (setBase !== null) return null;

  return (
    <button
      type="button"
      onClick={markAsBase}
      disabled={busy}
      aria-label={`Mark ${value} as the base set`}
      title="A set has one base set. Once marked, it stays until you delete it."
      // NEO-306: the quiet outlined TAG beside the title — smaller than the
      // action row's 32px chips because this is identity, not an action on the
      // row, but still visibly a control. min-h-6 keeps WCAG 2.5.8's 24px
      // minimum target; the ring is the panel's one focus ring (2px #00B7FF,
      // offset), focus-VISIBLE so a mouse click does not draw it.
      className={`${BASE_ROLE_TAG} hover:border-[#00D558] hover:text-[#00D558]`}
    >
      Mark as base set
    </button>
  );
}
