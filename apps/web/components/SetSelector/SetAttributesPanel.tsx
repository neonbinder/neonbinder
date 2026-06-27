import { useEffect, useMemo, useState } from "react";
import { useReactiveField } from "../forms/useReactiveField";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { EXPECTED_FEATURES } from "../../convex/features/expectedFeatures";

/**
 * NEO-38 (PR B-2) — level-agnostic set ATTRIBUTES editor.
 *
 * Renamed/generalized from `SetFeaturesPanel`. Mounts at the deepest
 * selected node at ANY level (sport → parallel), not just setName, so
 * the panel never vanishes when a variant (e.g. "Base") is selected.
 *
 * It unifies two previously-separate concepts into one "Set attributes"
 * list:
 *
 *  1. Editable marketplace FEATURES (`EXPECTED_FEATURES`) — persisted via
 *     `setSelectorOptionFeature`, which fans the change out to every
 *     descendant cardChecklist row that hasn't overridden the key.
 *
 *  2. Set METADATA (releaseDate, totalCardCount, block, tcdbSetId,
 *     sourceUrl) — formerly read-only header chips. Now rendered as rows in
 *     the same list. All of these are MANUALLY edited (no auto-sync):
 *       - At the setName level: editable string/number rows persisted via
 *         `setSetMetadata` (merge-patch; clearing a string field sends "").
 *       - At any other level: read-only, inherited from the nearest
 *         setName ancestor (surfaced by `getAncestorChain`'s setMetadata),
 *         labeled "From set: {value}".
 *     `sourceUrl` is rendered as plain text (never an auto-linked anchor) to
 *     avoid injecting a user-entered URL as a clickable link.
 *
 * Every row makes its source legible: own value vs. inherited-from-{level}.
 *
 * Collapsible so it never pushes the card list off-screen. Collapsed shows
 * a single summary bar (breadcrumb + an "N missing" amber badge + an
 * "Edit attributes" toggle). Default collapsed only when `defaultCollapsed`
 * (cards present); expanded otherwise so the setName-with-no-cards flow
 * needs no extra tap.
 *
 * Save flow (features):
 *   1. User types a new value into a row.
 *   2. Blur / Enter triggers the mutation.
 *   3. Mutation returns `{ propagatedToCardCount, skippedAsOverridden }`.
 *   4. Toast renders "Updated N cards; skipped M with overrides".
 *
 * "Will propagate to N cards" preview is shown above the edit area as a
 * static count from `getDescendantCardCount`.
 */

type Level =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

/** Human-readable label per selectorOptions level (fixes QA #2). */
const LEVEL_LABEL: Record<Level, string> = {
  sport: "Sport",
  year: "Year",
  manufacturer: "Manufacturer",
  setName: "Set",
  variantType: "Variant",
  insert: "Insert",
  parallel: "Parallel",
};

type SetMetadata = {
  releaseDate?: string;
  totalCardCount?: number;
  block?: string;
  tcdbSetId?: string;
  sourceUrl?: string;
  lastSyncedAt?: number;
};

export default function SetAttributesPanel({
  selectorOptionId,
  defaultCollapsed,
}: {
  selectorOptionId: Id<"selectorOptions">;
  /** Start collapsed (cards present) so the panel doesn't push them off-screen. */
  defaultCollapsed?: boolean;
}) {
  const row = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: selectorOptionId,
  });
  const chain = useQuery(api.selectorOptions.getAncestorChain, {
    id: selectorOptionId,
  });
  const descendantCardCount = useQuery(
    api.selectorOptions.getDescendantCardCount,
    { selectorOptionId },
  );
  const setSelectorOptionFeature = useMutation(
    api.selectorOptions.setSelectorOptionFeature,
  );
  const setSetMetadata = useMutation(api.selectorOptions.setSetMetadata);

  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [toast, setToast] = useState<string | null>(null);

  // Re-evaluate the default whenever the source intent flips (cards
  // appear/disappear or the selected node changes). Without this, drilling
  // from a card-less set into a node with cards would keep the panel
  // expanded (pushing the list down) because state initializes once.
  useEffect(() => {
    setExpanded(!defaultCollapsed);
  }, [defaultCollapsed, selectorOptionId]);

  // Derive the sport from the ancestor chain so we can drop features that
  // don't apply (e.g. "League" hidden for Pokemon).
  const ancestorSport = useMemo(() => {
    if (!chain) return undefined;
    return chain.find((c) => c.level === "sport")?.value;
  }, [chain]);

  // Inherited feature value per key (from strictly-shallower ancestors —
  // self excluded so the "Inherited:" hint shows the fallback when cleared).
  // Also remember WHICH level provided it, so each row can label its source.
  const inheritedFeatureByKey = useMemo(() => {
    const map: Record<string, { value: string; level: Level }> = {};
    if (!chain) return map;
    for (const ancestor of chain) {
      if (ancestor._id === selectorOptionId) continue;
      if (!ancestor.features) continue;
      for (const [k, v] of Object.entries(ancestor.features)) {
        map[k] = { value: v, level: ancestor.level as Level };
      }
    }
    return map;
  }, [chain, selectorOptionId]);

  // Nearest setName ancestor (root→leaf chain; last setName wins). Supplies
  // inherited metadata for non-setName levels.
  const setNameAncestor = useMemo(() => {
    if (!chain) return undefined;
    let found: { value: string; setMetadata?: SetMetadata } | undefined;
    for (const ancestor of chain) {
      if (ancestor.level === "setName") {
        found = { value: ancestor.value, setMetadata: ancestor.setMetadata };
      }
    }
    return found;
  }, [chain]);

  const applicable = useMemo(() => {
    return EXPECTED_FEATURES.filter((f) => {
      if (!f.applicableSports) return true;
      if (!ancestorSport) return true;
      return f.applicableSports.includes(ancestorSport);
    });
  }, [ancestorSport]);

  // Count applicable features with no effective value (own OR inherited).
  // Drives the collapsed-summary "N missing" amber badge.
  const missingCount = useMemo(() => {
    if (!row) return 0;
    const features = row.features ?? {};
    return applicable.reduce((acc, feat) => {
      const own = features[feat.key];
      const hasOwn = own !== undefined && own !== "";
      const inh = inheritedFeatureByKey[feat.key]?.value;
      const hasInherited = inh !== undefined && inh !== "";
      return acc + (hasOwn || hasInherited ? 0 : 1);
    }, 0);
  }, [row, applicable, inheritedFeatureByKey]);

  if (!row || !chain) return null;

  const leafLevel = row.level as Level;
  const isSetLevel = leafLevel === "setName";
  const features = row.features ?? {};

  // Breadcrumb: "Attributes for {leaf} ({levelLabel}) — a › b › c".
  const breadcrumb = chain.map((c) => c.value).join(" › ");
  const headerTitle = `Attributes for ${row.value} (${LEVEL_LABEL[leafLevel]})`;

  const handleSaveFeature = async (key: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (features[key] === trimmed) return; // no-op
    try {
      const result = await setSelectorOptionFeature({
        selectorOptionId,
        key,
        value: trimmed,
      });
      setToast(
        `Updated ${result.propagatedToCardCount} card${result.propagatedToCardCount === 1 ? "" : "s"}` +
          (result.skippedAsOverridden > 0
            ? `; skipped ${result.skippedAsOverridden} with overrides`
            : ""),
      );
      setTimeout(() => setToast(null), 6000);
    } catch (e) {
      setToast(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Persist a single setMetadata key (merge-patch via setSetMetadata).
  // Clearing a string field sends "" so the merge overwrites it.
  const handleSaveMetadata = async (
    patch: Partial<SetMetadata>,
  ): Promise<void> => {
    // Optimistic "Saved <field>" confirmation so the user knows the edit
    // landed — metadata writes don't fan out to cards, so the feature handler's
    // "Updated N cards" toast doesn't apply here. Shown before the await (it's
    // a one-row patch). The e2e (set-attributes-edit) asserts this toast.
    const METADATA_LABELS: Partial<Record<keyof SetMetadata, string>> = {
      releaseDate: "Release Date",
      totalCardCount: "Total Cards",
      block: "Block",
      tcdbSetId: "TCDB Set ID",
      sourceUrl: "Source URL",
    };
    const labels = Object.keys(patch)
      .map((k) => METADATA_LABELS[k as keyof SetMetadata] ?? k)
      .join(", ");
    setToast(`Saved ${labels}`);
    setTimeout(() => setToast(null), 6000);
    try {
      await setSetMetadata({ selectorOptionId, metadata: patch });
    } catch (e) {
      setToast(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div
      className="border border-gray-700 rounded-lg bg-gray-900/60 p-4 space-y-3"
      role="region"
      aria-label="Set attributes panel"
    >
      {/* Breadcrumb header (fixes QA #2 — which level/column applies). */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-100">
            {headerTitle}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5 truncate" title={breadcrumb}>
            {breadcrumb}
          </p>
        </div>
        {expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Hide attributes"
            className="shrink-0 text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
          >
            Hide attributes ▴
          </button>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            {missingCount > 0 && (
              <span
                className="inline-flex items-center px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/50 text-[10px] font-semibold text-amber-400"
                aria-label={`${missingCount} missing`}
              >
                {missingCount} missing
              </span>
            )}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Edit attributes"
              className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
            >
              Edit attributes ▾
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Set attributes
            </span>
            <span
              className="text-xs text-gray-500"
              aria-label={`Will propagate to ${descendantCardCount ?? "?"} descendant cards`}
            >
              {descendantCardCount !== undefined ? (
                <>
                  Will propagate to{" "}
                  <span className="text-[#00D558] font-semibold">
                    {descendantCardCount}
                  </span>{" "}
                  card{descendantCardCount === 1 ? "" : "s"}
                </>
              ) : (
                "Counting…"
              )}
            </span>
          </div>

          {toast && (
            // NEO-47: position the save confirmation FIXED in the viewport, not
            // in-flow above the grid. A save made while scrolled down to the
            // metadata/feature rows would otherwise render the toast off-screen
            // above the fold — invisible to the user (and the e2e assertion).
            // The optimistic toast fires correctly; it just wasn't visible.
            <div
              className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 border border-[#00D558]/60 rounded text-xs text-[#00D558] shadow-lg"
              role="status"
              aria-live="polite"
            >
              {toast}
            </div>
          )}

          {/* Unified list: editable features + metadata (fixes QA #4). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {applicable.map((feat) => (
              <SetFeatureRow
                key={feat.key}
                featKey={feat.key}
                label={feat.label}
                value={features[feat.key]}
                inherited={inheritedFeatureByKey[feat.key]?.value}
                inheritedLevel={inheritedFeatureByKey[feat.key]?.level}
                onSave={(v) => handleSaveFeature(feat.key, v)}
              />
            ))}

            <MetadataSection
              isSetLevel={isSetLevel}
              ownMeta={row.setMetadata ?? {}}
              inheritedFrom={setNameAncestor}
              onSave={handleSaveMetadata}
            />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Metadata rows for the unified list. Behaviour depends on level:
 *  - setName: all editable — releaseDate / totalCardCount / block /
 *    tcdbSetId / sourceUrl. (sourceUrl is a plain text input, never a link.)
 *  - other levels: read-only, inherited from the nearest setName ancestor.
 */
function MetadataSection({
  isSetLevel,
  ownMeta,
  inheritedFrom,
  onSave,
}: {
  isSetLevel: boolean;
  ownMeta: SetMetadata;
  inheritedFrom: { value: string; setMetadata?: SetMetadata } | undefined;
  onSave: (patch: Partial<SetMetadata>) => Promise<void>;
}) {
  if (isSetLevel) {
    return (
      <>
        <MetadataEditableRow
          label="Release Date"
          value={ownMeta.releaseDate}
          onSave={(v) => onSave({ releaseDate: v })}
        />
        <MetadataEditableRow
          label="Total Cards"
          value={
            ownMeta.totalCardCount !== undefined
              ? String(ownMeta.totalCardCount)
              : undefined
          }
          numeric
          onSave={(v) => {
            if (v === "") return onSave({ totalCardCount: undefined });
            const n = parseInt(v, 10);
            if (Number.isNaN(n)) return Promise.resolve();
            return onSave({ totalCardCount: n });
          }}
        />
        <MetadataEditableRow
          label="Block"
          value={ownMeta.block}
          onSave={(v) => onSave({ block: v })}
        />
        <MetadataEditableRow
          label="TCDB Set ID"
          value={ownMeta.tcdbSetId}
          onSave={(v) => onSave({ tcdbSetId: v })}
        />
        <MetadataEditableRow
          label="Source URL"
          value={ownMeta.sourceUrl}
          onSave={(v) => onSave({ sourceUrl: v })}
        />
      </>
    );
  }

  // Non-setName level: read-only inherited from the nearest set ancestor.
  const meta = inheritedFrom?.setMetadata ?? {};
  const sourceNote = inheritedFrom
    ? `From set: ${inheritedFrom.value}`
    : undefined;
  return (
    <>
      <MetadataReadonlyRow
        label="Release Date"
        value={meta.releaseDate}
        sourceNote={sourceNote}
      />
      <MetadataReadonlyRow
        label="Total Cards"
        value={
          meta.totalCardCount !== undefined
            ? String(meta.totalCardCount)
            : undefined
        }
        sourceNote={sourceNote}
      />
      <MetadataReadonlyRow
        label="Block"
        value={meta.block}
        sourceNote={sourceNote}
      />
      <MetadataReadonlyRow
        label="TCDB Set ID"
        value={meta.tcdbSetId}
        sourceNote={sourceNote}
      />
      <MetadataReadonlyRow
        label="Source URL"
        value={meta.sourceUrl}
        sourceNote={sourceNote}
      />
    </>
  );
}

/**
 * Editable metadata row, mirroring the SetFeatureRow visual idiom (aria
 * label `Value for {label}`). Commits on blur / Enter. Empty string clears
 * the field (merge-patch sends "" for strings, undefined for the number).
 */
function MetadataEditableRow({
  label,
  value,
  numeric,
  onSave,
}: {
  label: string;
  value: string | undefined;
  numeric?: boolean;
  onSave: (value: string) => Promise<unknown>;
}) {
  // NEO-39: shared reactive-safe field (see useReactiveField). Behavior
  // preserved: no-op baseline = current value; clearing the field sends ""
  // (merge-patch clears the string / unsets the number) via onEmptyCommit.
  const { inputProps, busy, error: err } = useReactiveField({
    value: value ?? "",
    onSave: (trimmed) => onSave(trimmed),
    onEmptyCommit: () => onSave(""),
  });
  // Unique per-field marker class so Maestro's inputText targets THIS field
  // rather than the first input sharing the className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();

  const isMissing = value === undefined || value === "";

  return (
    <label
      className={`flex flex-col gap-0.5 p-2 rounded border text-xs ${
        isMissing
          ? "border-amber-500/60 bg-amber-500/5"
          : "border-gray-700 bg-gray-900/30"
      }`}
      aria-label={`Set metadata ${label}`}
    >
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400">
        <span>{label}</span>
      </span>
      <input
        {...inputProps}
        type="text"
        inputMode={numeric ? "numeric" : undefined}
        disabled={busy}
        aria-label={`Value for ${label}`}
        placeholder="—"
        className={`${fieldClass()} w-full p-1 border rounded text-xs dark:bg-gray-900 dark:border-gray-700 focus:border-[#00D558] focus:outline-none`}
      />
      {err && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {err}
        </span>
      )}
    </label>
  );
}

/** Read-only metadata row — used for values inherited from a setName ancestor. */
function MetadataReadonlyRow({
  label,
  value,
  sourceNote,
}: {
  label: string;
  value: string | undefined;
  sourceNote?: string;
}) {
  const isEmpty = value === undefined || value === "";
  return (
    <div
      className="flex flex-col gap-0.5 p-2 rounded border border-gray-700 bg-gray-900/30 text-xs"
      aria-label={`Set metadata ${label}`}
    >
      <span className="text-[10px] uppercase tracking-wide text-gray-400">
        {label}
      </span>
      <span className={isEmpty ? "text-gray-600 italic" : "text-gray-200"}>
        {isEmpty ? "—" : value}
      </span>
      {sourceNote && !isEmpty && (
        <span
          className="text-[10px] text-gray-500"
          aria-label={`Inherited: ${sourceNote}`}
        >
          {sourceNote}
        </span>
      )}
    </div>
  );
}

/**
 * Editable feature row. Maestro targets `Value for {label}` — DO NOT rename.
 */
function SetFeatureRow({
  featKey,
  label,
  value,
  inherited,
  inheritedLevel,
  onSave,
}: {
  featKey: string;
  label: string;
  value: string | undefined;
  inherited: string | undefined;
  inheritedLevel: Level | undefined;
  onSave: (value: string) => Promise<unknown>;
}) {
  // NEO-39: shared reactive-safe field (see useReactiveField). Uncontrolled +
  // focus-guard + read-at-commit. Behavior preserved: no-op baseline = the
  // feature's own value; an empty input is a no-op revert (set-level has no
  // clear-key mutation — only write-time propagation), so no onEmptyCommit.
  const { inputProps, busy, error: err } = useReactiveField({
    value: value ?? "",
    onSave: (trimmed) => onSave(trimmed),
  });
  // Unique per-field marker class so Maestro's inputText targets THIS field
  // rather than the first input sharing the className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();

  const hasOwn = value !== undefined && value !== "";
  const isMissing = !hasOwn && (inherited === undefined || inherited === "");
  const inheritedLabel = inheritedLevel ? LEVEL_LABEL[inheritedLevel] : undefined;

  return (
    <label
      className={`flex flex-col gap-0.5 p-2 rounded border text-xs ${
        isMissing
          ? "border-amber-500/60 bg-amber-500/5"
          : "border-gray-700 bg-gray-900/30"
      }`}
      aria-label={`Set feature ${label}`}
    >
      <span className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400">
        <span>
          {isMissing && (
            <span
              className="text-amber-500 mr-1"
              aria-label="Missing required feature"
              title="Missing required feature"
            >
              ⚠
            </span>
          )}
          {label}
        </span>
      </span>
      <input
        {...inputProps}
        type="text"
        data-feat-key={featKey}
        disabled={busy}
        aria-label={`Value for ${label}`}
        placeholder={inherited ?? "—"}
        className={`${fieldClass()} w-full p-1 border rounded text-xs dark:bg-gray-900 dark:border-gray-700 focus:border-[#00D558] focus:outline-none`}
      />
      {!hasOwn && inherited !== undefined && inherited !== "" && (
        <span
          className="text-[10px] text-gray-500"
          aria-label={`Inherited value: ${inherited}`}
        >
          Inherited{inheritedLabel ? ` from ${inheritedLabel}` : ""}: {inherited}
        </span>
      )}
      {err && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {err}
        </span>
      )}
    </label>
  );
}
