import { useEffect, useRef, useState } from "react";
import { PencilSquareIcon } from "@heroicons/react/24/outline";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useFieldTestClass } from "../../src/hooks/useFieldTestClass";
import { Input } from "../primitives/Input";

/**
 * NEO-96: inline rename for a single `selectorOptions` row's display value.
 *
 * Until now `value` was write-once — set at insert and never patched anywhere
 * in the codebase — so a typo in a sport, year, manufacturer, set or variant
 * name was permanent. (`renamePlatformLabel` renames a MARKETPLACE label, which
 * is a different thing.) Renaming only became safe once entities referenced the
 * sport ROW instead of copying its label: before that, a rename would silently
 * orphan every team/player holding the old string, and break SKU generation and
 * enrichment, which both keyed off the display name.
 *
 * ── WHERE THIS LIVES (read before moving it) ────────────────────────────────
 * A pencil icon immediately after SetAttributesPanel's header title, which is
 * the name it renames. That adjacency IS the affordance: an earlier revision
 * put a "Rename" text link over by the SET ATTRIBUTES heading, far from the
 * name, where nobody would connect the two.
 *
 * The panel targets exactly one row — the deepest current selection, at ANY
 * level — so rename reaches sports, years, manufacturers, sets and variants.
 *
 * Do not put it back on the selector rows: it was there first, one per row in
 * every column, which was a lot of permanent weight for a rare action. An
 * EntitySelector row is also a single full-width <button>, and a <button>
 * inside a <button> is invalid HTML that browsers reparent, detaching the
 * click handler — so it could only ever be a sibling, never inline with the
 * name the way it is here.
 *
 * ── UNCONTROLLED INPUT (NEO-36 pattern — do not "fix" this back) ─────────────
 * The name field is UNCONTROLLED (a ref, read at commit) rather than controlled
 * React state, for the same reason as CardChecklist's add-card form: this row
 * lives in a Convex-reactive list that re-renders on every selectorOptions
 * update, and those externally-triggered re-renders contend with a controlled
 * input's value. React never reconciles an uncontrolled input's value, so the
 * DOM holds exactly what was typed and commit() reads it directly: what you
 * see is what you save.
 *
 * ── EMPTY, NOT PRE-SEEDED (deliberate) ──────────────────────────────────────
 * The field opens EMPTY with the current name as its placeholder, rather than
 * pre-filled with the current name. Typing a name replaces it; submitting an
 * empty field is a no-op (treated as cancel), so the old name is never lost by
 * accident.
 *
 * Pre-seeding cost two E2E runs to diagnose: clicking into a pre-filled field
 * puts the caret WHERE YOU CLICKED, and a backspace-based clear only removes
 * what is left of the caret — renaming to `rnmx-0-w0-a2-6355` committed
 * `rnmx-0-w0-a2-6355a2-6355`, the un-erased tail still trailing. A human hits
 * the same edge (click the middle, select-all-and-retype is a habit, not a
 * guarantee); maestro-web additionally cannot send Cmd/Ctrl+A at all, since it
 * rejects modifier combos. Empty-on-open removes the caret from the problem.
 *
 * ── MAESTRO ─────────────────────────────────────────────────────────────────
 * Selectors are visible text or aria-label only. The input additionally carries
 * a per-instance class from useFieldTestClass: maestro-web's `inputText` builds
 * an XPath from `id` → `class` → positional index, and every row here would
 * otherwise share one Tailwind className, so typing would land in the first
 * row's input rather than the one the test tapped (mobile-dev-inc/maestro#1083).
 *
 * Interaction mirrors MultiSourcePanel's Chip, the existing inline-rename
 * precedent: Enter commits, Escape reverts, blur commits, errors surface in a
 * role="alert" rather than being swallowed.
 *
 * ── EVERY ROW IS RENAMEABLE (NEO-239) ───────────────────────────────────────
 * `variantType` rows used to be refused a rename, because two things read their
 * DISPLAY VALUE as code: Base detection matched the literal "base", and the BSC
 * checklist fetch re-derived its `variant` facet from the value. Both now read
 * ids and NB role flags instead — Base is `metadata.isBase`, and the `variant`
 * facet comes off the row's tagged BSC slot — so the value is a label again, at
 * every level. Nothing user-facing may key on a marketplace value or feed an NB
 * display value back into a marketplace query; a rename gate built on that
 * coupling had to go with it.
 */

/**
 * The server's refusal payload for a rename it would not accept. Matched
 * structurally rather than with `instanceof ConvexError` so a mocked/rethrown
 * error in a test, or a version skew in the convex client, still surfaces the
 * server's own words. Kept as a defensive read after NEO-239 removed the only
 * refusal that used it: an old bundle talking to a new server, or a future
 * refusal, should still say why rather than failing silently.
 */
function refusalMessage(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const data = (e as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, message } = data as { code?: unknown; message?: unknown };
  if (code !== "VARIANT_TYPE_RENAME_REFUSED") return null;
  return typeof message === "string" && message.length > 0
    ? message
    : "This name can't be changed.";
}
export default function RenameEntityControl({
  id,
  currentValue,
  disabled,
}: {
  id: Id<"selectorOptions">;
  currentValue: string;
  disabled?: boolean;
}) {
  const rename = useMutation(api.selectorOptions.renameSelectorOption);
  const fieldClass = useFieldTestClass();

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Guards the focus-restore effect below so it only fires on a genuine
  // editing->not-editing transition, never on this component's own initial
  // mount (where `editing` is already false and there is nothing to restore
  // focus FROM).
  const wasEditingRef = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // The input unmounts the instant `editing` goes false (commit succeeding,
  // or Escape reverting) and the pencil button takes its place — with nothing
  // to move focus onto it, the browser drops focus to <body>. Same shape as
  // every other busy/unmount focus-park case in this codebase; here the
  // return target is simply the control that opened the editor.
  useEffect(() => {
    if (wasEditingRef.current && !editing) buttonRef.current?.focus();
    wasEditingRef.current = editing;
  }, [editing]);

  const commit = async () => {
    // Read the live DOM value (uncontrolled input) — see the NEO-36 note above.
    const trimmed = (inputRef.current?.value ?? "").trim();
    if (saving) return;
    if (!trimmed || trimmed === currentValue) {
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await rename({ id, value: trimmed });
      setEditing(false);
    } catch (e) {
      // Surface it: a sibling-name collision is the expected failure here and
      // the user needs to see why their rename didn't take. A variantType
      // refusal (NEO-211) arrives as a structured ConvexError whose own message
      // explains WHY the value is load-bearing — render that, not a generic.
      setError(refusalMessage(e) ?? (e instanceof Error ? e.message : "Rename failed"));
    } finally {
      setSaving(false);
    }
  };

  // Closing unmounts the input; it remounts empty, so there is nothing to reset.
  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  if (!editing) {
    return (
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        aria-label={`Rename ${currentValue}`}
        title={`Rename ${currentValue}`}
        // p-1: a bare 16x16 icon with no padding is a ~16x16 hit target,
        // under WCAG 2.5.8's 24x24 CSS pixel minimum. p-1 (4px/side) brings
        // it to 24x24.
        className="shrink-0 p-1 text-gray-500 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none disabled:opacity-50"
      >
        <PencilSquareIcon className="w-4 h-4" />
      </button>
    );
  }

  return (
    <div className="shrink-0 flex items-center gap-1">
      <Input
        bare
        ref={inputRef}
        placeholder={currentValue}
        // readOnly + aria-disabled, not disabled: this field's own onKeyDown
        // triggers commit() directly (Enter), which sets `saving` true
        // synchronously — a native `disabled` on the still-focused input
        // would force-blur it to <body> for the duration of the rename
        // round-trip. readOnly blocks edits without removing focusability;
        // aria-disabled still announces the busy state.
        readOnly={saving}
        aria-disabled={saving || undefined}
        aria-label={`Edit name for ${currentValue}`}
        className={`${fieldClass("rename")} w-32 px-2 py-1 text-sm aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
        onKeyDown={(e) => {
          // Stop the row's own handlers from seeing these — the row is a
          // sibling button and Enter would otherwise also select it.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => void commit()}
      />
      {error && (
        <span role="alert" className="text-xs text-[#FF2EB3] max-w-40">
          {error}
        </span>
      )}
    </div>
  );
}
