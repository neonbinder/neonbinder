import { useEffect, useRef, useState } from "react";
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
 * ── MARKUP CONSTRAINT (read before moving this) ─────────────────────────────
 * The selector row is a single full-width <button> (EntitySelector.tsx), so
 * this control CANNOT be nested inside it — a button inside a button is
 * invalid HTML and browsers reparent it, which detaches the click handler.
 * It renders as a SIBLING inside the row's flex wrapper.
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
  const [draft, setDraft] = useState(currentValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // A rename landing from elsewhere (or a re-sync) should not leave a stale
  // draft behind the next time this opens.
  useEffect(() => {
    if (!editing) setDraft(currentValue);
  }, [currentValue, editing]);

  const commit = async () => {
    const trimmed = draft.trim();
    if (saving) return;
    if (!trimmed || trimmed === currentValue) {
      setEditing(false);
      setDraft(currentValue);
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

  const cancel = () => {
    setEditing(false);
    setDraft(currentValue);
    setError(null);
  };

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        aria-label={`Rename ${currentValue}`}
        className="shrink-0 px-2 text-xs text-gray-500 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted disabled:opacity-50"
      >
        Rename
      </button>
    );
  }

  return (
    <div className="shrink-0 flex items-center gap-1">
      <input
        ref={inputRef}
        value={draft}
        disabled={saving}
        aria-label={`Edit name for ${currentValue}`}
        className={`${fieldClass("rename")} w-32 px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800`}
        onChange={(e) => setDraft(e.target.value)}
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
