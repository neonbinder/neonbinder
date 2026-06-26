import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import AttachSetsDialog from "./AttachSetsDialog";

/**
 * Per-row attached-sets panel (NEO-6 phase 1). Renders chip stacks for the
 * BSC and SL IDs attached to a variantType / insert / parallel row, with
 * the reconciliation primary clearly marked. Operator can:
 *   • Open the combined attach dialog to add more BSC/SL IDs.
 *   • Rename the label on any chip inline (Enter to save, Escape to cancel).
 *   • Remove any non-primary chip with the × button.
 *
 * Keyboard model:
 *   Tab     — cycles between chip controls and the Attach button.
 *   Enter   — confirms rename when editing a label.
 *   Escape  — cancels label edit; on the wrapping page, closes dialog.
 */
type Side = "bsc" | "sportlots";

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export default function MultiSourcePanel({
  selectorOptionId,
}: {
  selectorOptionId: Id<"selectorOptions">;
}) {
  const row = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: selectorOptionId,
  });
  const chain = useQuery(api.selectorOptions.getAncestorChain, {
    id: selectorOptionId,
  });
  const detach = useMutation(api.selectorOptions.detachPlatformId);
  const rename = useMutation(api.selectorOptions.renamePlatformLabel);

  const [dialogOpen, setDialogOpen] = useState(false);

  if (!row || !chain) return null;
  if (
    row.level !== "variantType" &&
    row.level !== "insert" &&
    row.level !== "parallel"
  ) {
    return null;
  }

  const bscIds = toArray(row.platformData.bsc);
  const slIds = toArray(row.platformData.sportlots);
  const primaryBsc = row.primaryPlatformId?.bsc ?? bscIds[0];
  const primarySl = row.primaryPlatformId?.sportlots ?? slIds[0];

  // Show the panel only when at least one side has a primary — otherwise
  // there's nothing to attach extras to yet.
  const hasAnyPrimary = !!primaryBsc || !!primarySl;
  if (!hasAnyPrimary) return null;

  // Build parentFilters for the attach dialog from the ancestor chain.
  const parentFilters: Record<string, string> = {};
  for (const ancestor of chain) {
    if (ancestor._id !== row._id) {
      parentFilters[ancestor.level] = ancestor.value;
    }
  }

  const alreadyAttached = {
    bsc: new Set(bscIds),
    sportlots: new Set(slIds),
  };

  return (
    <div className="border border-gray-700 rounded-lg bg-gray-900/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">
            Multi-source sets
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Cards fetched for this variant come from every attached BSC and
            SportLots set. Users can filter the checklist by source.
          </p>
        </div>
        <NeonButton
          secondary
          size="2"
          onClick={() => setDialogOpen(true)}
          aria-label="Attach more source sets"
        >
          Attach more…
        </NeonButton>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SideColumn
          title="BSC"
          ids={bscIds}
          labels={row.platformLabels?.bsc ?? {}}
          primaryId={primaryBsc}
          onDetach={(id) =>
            detach({ selectorOptionId, side: "bsc", id })
          }
          onRename={(id, label) =>
            rename({ selectorOptionId, side: "bsc", id, label })
          }
        />
        <SideColumn
          title="SportLots"
          ids={slIds}
          labels={row.platformLabels?.sportlots ?? {}}
          primaryId={primarySl}
          onDetach={(id) =>
            detach({ selectorOptionId, side: "sportlots", id })
          }
          onRename={(id, label) =>
            rename({ selectorOptionId, side: "sportlots", id, label })
          }
        />
      </div>

      <AttachSetsDialog
        isOpen={dialogOpen}
        level={row.level as "variantType" | "insert" | "parallel"}
        parentFilters={parentFilters}
        parentId={row.parentId}
        selectorOptionId={selectorOptionId}
        alreadyAttached={alreadyAttached}
        onClose={() => setDialogOpen(false)}
      />
    </div>
  );
}

function SideColumn({
  title,
  ids,
  labels,
  primaryId,
  onDetach,
  onRename,
}: {
  title: string;
  ids: string[];
  labels: Record<string, string>;
  primaryId: string | undefined;
  onDetach: (id: string) => Promise<unknown>;
  onRename: (id: string, label: string) => Promise<unknown>;
}) {
  const chips = useMemo(() => {
    return ids.map((id) => ({
      id,
      label: labels[id] ?? id,
      isPrimary: id === primaryId,
    }));
  }, [ids, labels, primaryId]);

  return (
    <div>
      <header className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
        {title}
      </header>
      {chips.length === 0 ? (
        <div className="text-xs text-gray-500 italic">No sets attached.</div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {chips.map((chip) => (
            <Chip
              key={chip.id}
              chip={chip}
              onDetach={onDetach}
              onRename={onRename}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Chip({
  chip,
  onDetach,
  onRename,
}: {
  chip: { id: string; label: string; isPrimary: boolean };
  onDetach: (id: string) => Promise<unknown>;
  onRename: (id: string, label: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chip.label);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const commitRename = async () => {
    if (busy) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === chip.label) {
      setEditing(false);
      setDraft(chip.label);
      return;
    }
    setBusy(true);
    try {
      await onRename(chip.id, trimmed);
      setEditing(false);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDetach = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onDetach(chip.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <li
      className={`flex items-center gap-2 px-3 py-1.5 rounded border ${
        chip.isPrimary
          ? "border-[#00D558] bg-[#00D558]/10"
          : "border-gray-700 bg-gray-800"
      }`}
    >
      {chip.isPrimary && (
        <span
          className="text-[10px] uppercase font-bold text-[#00D558]"
          aria-label="Primary source"
        >
          Primary
        </span>
      )}
      {editing ? (
        <input
          type="text"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
              setDraft(chip.label);
            }
          }}
          onBlur={commitRename}
          aria-label={`Edit label for ${chip.id}`}
          className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-2 py-0.5 text-sm text-gray-100 focus:border-[#00D558] focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(chip.label);
            setEditing(true);
          }}
          aria-label={`Rename label for ${chip.id}`}
          className="flex-1 min-w-0 text-left truncate text-sm text-gray-100 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
        >
          {chip.label}
        </button>
      )}
      <span className="text-[10px] text-gray-500 truncate" aria-hidden>
        {chip.id}
      </span>
      {!chip.isPrimary && (
        <button
          type="button"
          onClick={handleDetach}
          disabled={busy}
          aria-label={`Detach ${chip.label}`}
          className="text-gray-400 hover:text-[#FF2E9A] focus:text-[#FF2E9A] focus:outline-none px-1"
        >
          ×
        </button>
      )}
      {err && (
        <span className="text-[10px] text-[#FF2EB3]" role="alert">
          {err}
        </span>
      )}
    </li>
  );
}
