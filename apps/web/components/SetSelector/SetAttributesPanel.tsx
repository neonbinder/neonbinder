import { useEffect, useMemo, useState } from "react";
import { useReactiveField } from "../forms/useReactiveField";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  EXPECTED_FEATURES,
  type ExpectedFeature,
} from "../../convex/features/expectedFeatures";
import { FeatureValueControl } from "./FeatureValueControl";

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
 *     `setSelectorOptionFeature`, a single-row patch on THIS node only
 *     (NEO-71-74: write-once feature snapshots). A row's `features` is
 *     already the complete resolved value — computed once via copy-down at
 *     the node's own creation — so this panel reads it directly, with no
 *     client-side ancestor-chain merge for feature values.
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
 * Collapsible so it never pushes the card list off-screen. Collapsed shows
 * a single summary bar (breadcrumb + an "N missing" amber badge + an
 * "Edit attributes" toggle). Default collapsed only when `defaultCollapsed`
 * (cards present); expanded otherwise so the setName-with-no-cards flow
 * needs no extra tap.
 *
 * Save flow (features):
 *   1. User types a new value into a row.
 *   2. Blur / Enter triggers the mutation (patches this row only).
 *   3. Toast renders "Saved {label}".
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
      if (f.hiddenAtLevels?.includes("set")) return false;
      if (
        f.applicableAtLevels &&
        !f.applicableAtLevels.includes(row?.level as Level)
      ) {
        return false;
      }
      if (!f.applicableSports) return true;
      if (!ancestorSport) return true;
      return f.applicableSports.includes(ancestorSport);
    });
  }, [ancestorSport, row?.level]);

  // Count applicable features with no own value. `row.features` is already
  // the complete resolved snapshot (write-once, from creation time), so
  // "own" is the only signal — no inherited fallback to check.
  const missingCount = useMemo(() => {
    if (!row) return 0;
    const features = row.features ?? {};
    return applicable.reduce((acc, feat) => {
      const own = features[feat.key];
      const hasOwn = own !== undefined && own !== "";
      return acc + (hasOwn ? 0 : 1);
    }, 0);
  }, [row, applicable]);

  if (!row || !chain) return null;

  const leafLevel = row.level as Level;
  const isSetLevel = leafLevel === "setName";
  const features = row.features ?? {};

  // Breadcrumb: "Attributes for {leaf} ({levelLabel}) — a › b › c".
  const breadcrumb = chain.map((c) => c.value).join(" › ");
  const headerTitle = `Attributes for ${row.value} (${LEVEL_LABEL[leafLevel]})`;

  const handleSaveFeature = async (
    key: string,
    label: string,
    value: string,
  ) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (features[key] === trimmed) return; // no-op
    // Optimistic "Saved {label}" confirmation, matching handleSaveMetadata's
    // pattern — the mutation is now a single-row patch (NEO-71-74), no
    // propagation counts to report.
    setToast(`Saved ${label}`);
    setTimeout(() => setToast(null), 6000);
    try {
      await setSelectorOptionFeature({ selectorOptionId, key, value: trimmed });
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
                feat={feat}
                value={features[feat.key]}
                onSave={(v) => handleSaveFeature(feat.key, feat.label, v)}
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
  feat,
  value,
  onSave,
}: {
  feat: ExpectedFeature;
  value: string | undefined;
  onSave: (value: string) => Promise<unknown>;
}) {
  const label = feat.label;
  // Unique per-field marker class so Maestro's inputText targets THIS field
  // rather than the first input sharing the className (see useFieldTestClass).
  const fieldClass = useFieldTestClass();

  // `value` is this row's own `features[key]` — already the complete
  // resolved value (write-once, from creation time). No inherited fallback.
  const hasOwn = value !== undefined && value !== "";
  const isMissing = !hasOwn;

  // "boolean" has no typed target at the set level (no set-level isRookie
  // column) and is filtered out via `hiddenAtLevels` before reaching here —
  // this is a defensive fallback, not an expected path.
  if (feat.inputType === "boolean") {
    console.warn(
      `SetFeatureRow: unexpected boolean-type feature "${feat.key}" at set level; rendering read-only.`,
    );
    return (
      <div
        className="flex flex-col gap-0.5 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
        aria-label={`Set feature ${label}`}
      >
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          {label}
        </span>
        <span className="text-gray-300">{value ?? "—"}</span>
      </div>
    );
  }

  if (feat.inputType === "derived") {
    const resolved = value ?? "—";
    return (
      <div
        className="flex flex-col gap-0.5 p-2 rounded border text-xs border-gray-700 bg-gray-900/30"
        aria-label={`Set feature ${label}`}
      >
        <span className="text-[10px] uppercase tracking-wide text-gray-400">
          {label}
        </span>
        <span aria-label={`Value for ${label}`} className="text-gray-300">
          {resolved}
        </span>
      </div>
    );
  }

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
      <FeatureValueControl
        feat={feat}
        value={value ?? ""}
        onSave={onSave}
        ariaLabel={`Value for ${label}`}
        placeholder="—"
        dataFeatKey={feat.key}
        className={`${fieldClass()} w-full p-1 border rounded text-xs dark:bg-gray-900 dark:border-gray-700 focus:border-[#00D558] focus:outline-none`}
      />
    </label>
  );
}
