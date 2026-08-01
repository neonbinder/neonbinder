import { useEffect, useRef, useState } from "react";
import { PencilSquareIcon } from "@heroicons/react/24/outline";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useFieldTestClass } from "../../src/hooks/useFieldTestClass";

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
 */
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

  useEffect(() => {
    if (editing) inputRef.current?.focus();
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
      // the user needs to see why their rename didn't take.
      setError(e instanceof Error ? e.message : "Rename failed");
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
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        aria-label={`Rename ${currentValue}`}
        title={`Rename ${currentValue}`}
        className="shrink-0 text-gray-500 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none disabled:opacity-50"
      >
        <PencilSquareIcon className="w-4 h-4" />
      </button>
    );
  }

  return (
    <div className="shrink-0 flex items-center gap-1">
      <input
        ref={inputRef}
        placeholder={currentValue}
        disabled={saving}
        aria-label={`Edit name for ${currentValue}`}
        className={`${fieldClass("rename")} w-32 px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800`}
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
