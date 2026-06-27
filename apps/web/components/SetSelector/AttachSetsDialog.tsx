import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";

/**
 * Combined attach dialog (NEO-6 phase 1). Lists unmatched BSC and SL sets
 * side-by-side, each searchable + multi-select. Confirm batches the
 * selection into a single `attachPlatformIds` mutation.
 *
 * Candidate pool comes from `fetchRawOptions` for the row's level + parent
 * context, minus IDs already attached (the row's existing primary +
 * extras). Labels default to the marketplace's set name and are
 * inline-editable before confirm.
 *
 * Keyboard model:
 *   Tab     — cycle search inputs, candidate rows, footer buttons
 *   Space   — toggle the focused candidate's checkbox
 *   Enter   — confirm when focus on Confirm button (or no input focused)
 *   Escape  — cancel
 */
type Side = "bsc" | "sportlots";

type Candidate = {
  value: string;
  platformValue: string;
};

type Selection = {
  id: string;
  label: string;
};

export default function AttachSetsDialog({
  isOpen,
  level,
  parentFilters,
  parentId,
  selectorOptionId,
  alreadyAttached,
  onClose,
}: {
  isOpen: boolean;
  level: "variantType" | "insert" | "parallel";
  parentFilters: Record<string, string>;
  parentId: Id<"selectorOptions"> | undefined;
  selectorOptionId: Id<"selectorOptions">;
  alreadyAttached: { bsc: Set<string>; sportlots: Set<string> };
  onClose: () => void;
}) {
  const fetchRawOptions = useAction(api.setReconciliation.fetchRawOptions);
  const attachPlatformIds = useMutation(api.selectorOptions.attachPlatformIds);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [bscCandidates, setBscCandidates] = useState<Candidate[]>([]);
  const [slCandidates, setSlCandidates] = useState<Candidate[]>([]);
  const [bscSelected, setBscSelected] = useState<Map<string, Selection>>(new Map());
  const [slSelected, setSlSelected] = useState<Map<string, Selection>>(new Map());
  const [bscSearch, setBscSearch] = useState("");
  const [slSearch, setSlSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  // Load candidates when the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setErrorMsg(null);
    setBscSelected(new Map());
    setSlSelected(new Map());
    setBscSearch("");
    setSlSearch("");
    (async () => {
      try {
        const result = await fetchRawOptions({
          level,
          parentId,
          parentFilters,
        });
        if (cancelled) return;
        if (!result.success) {
          setErrorMsg(result.message || "Failed to load candidates");
          setBscCandidates([]);
          setSlCandidates([]);
        } else {
          // fetchRawOptions returns unmatchedBsc / unmatchedSl as the
          // candidates that were not auto-matched to any NB row. Plus
          // matched pairs — surface those too, since the operator may
          // want to attach a sibling that the reconciler did pair with
          // a *different* NB row.
          const bsc: Candidate[] = [
            ...result.unmatchedBsc,
            ...result.autoMatched.map((m) => m.bsc),
          ].filter((c) => !alreadyAttached.bsc.has(c.platformValue));
          const sl: Candidate[] = [
            ...result.unmatchedSl,
            ...result.autoMatched.map((m) => m.sl),
          ].filter((c) => !alreadyAttached.sportlots.has(c.platformValue));
          // Dedup by platformValue (auto-matched + unmatched can overlap).
          const dedup = (arr: Candidate[]) => {
            const seen = new Set<string>();
            return arr.filter((c) => {
              if (seen.has(c.platformValue)) return false;
              seen.add(c.platformValue);
              return true;
            });
          };
          setBscCandidates(dedup(bsc));
          setSlCandidates(dedup(sl));
        }
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    level,
    parentId,
    parentFilters,
    fetchRawOptions,
    alreadyAttached,
  ]);

  // Focus the confirm button when the dialog opens so Enter works without
  // tabbing first. Standing UX rule: preselect defaults + Enter to confirm.
  useEffect(() => {
    if (isOpen) {
      // Defer to next tick so the button has mounted.
      const t = setTimeout(() => confirmButtonRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  // Escape closes; Enter confirms when focus is on the confirm button
  // (handled natively by the button), AND when focus is outside any
  // text input.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!submitting) onClose();
      }
      if (e.key === "Enter") {
        const target = e.target as HTMLElement | null;
        if (target && target.tagName === "INPUT") return;
        e.preventDefault();
        void handleConfirm();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, submitting, bscSelected, slSelected]);

  const totalSelected = bscSelected.size + slSelected.size;

  const filteredBsc = useMemo(() => {
    const q = bscSearch.trim().toLowerCase();
    if (!q) return bscCandidates;
    return bscCandidates.filter((c) =>
      c.value.toLowerCase().includes(q) ||
      c.platformValue.toLowerCase().includes(q),
    );
  }, [bscCandidates, bscSearch]);

  const filteredSl = useMemo(() => {
    const q = slSearch.trim().toLowerCase();
    if (!q) return slCandidates;
    return slCandidates.filter((c) =>
      c.value.toLowerCase().includes(q) ||
      c.platformValue.toLowerCase().includes(q),
    );
  }, [slCandidates, slSearch]);

  const toggle = (
    side: Side,
    candidate: Candidate,
  ) => {
    const setter = side === "bsc" ? setBscSelected : setSlSelected;
    setter((prev) => {
      const next = new Map(prev);
      if (next.has(candidate.platformValue)) {
        next.delete(candidate.platformValue);
      } else {
        next.set(candidate.platformValue, {
          id: candidate.platformValue,
          label: candidate.value,
        });
      }
      return next;
    });
  };

  const updateLabel = (side: Side, id: string, label: string) => {
    const setter = side === "bsc" ? setBscSelected : setSlSelected;
    setter((prev) => {
      const existing = prev.get(id);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(id, { ...existing, label });
      return next;
    });
  };

  const handleConfirm = async () => {
    if (submitting || totalSelected === 0) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await attachPlatformIds({
        selectorOptionId,
        additions: {
          bsc: Array.from(bscSelected.values()),
          sportlots: Array.from(slSelected.values()),
        },
      });
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attach-sets-title"
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-700">
          <h2 id="attach-sets-title" className="text-lg font-semibold text-gray-100">
            Attach more source sets
          </h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Pick BSC and/or SL sets to attach to this NeonBinder variant.
            Cards from every attached set roll up into a single checklist;
            users can filter by source.
          </p>
        </div>

        <div className="flex-1 overflow-hidden p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <CandidateColumn
            title="BSC unmatched sets"
            side="bsc"
            candidates={filteredBsc}
            search={bscSearch}
            onSearch={setBscSearch}
            selected={bscSelected}
            onToggle={toggle}
            onLabel={updateLabel}
            loading={loading}
            ariaLabel="Search BSC sets"
          />
          <CandidateColumn
            title="SportLots unmatched sets"
            side="sportlots"
            candidates={filteredSl}
            search={slSearch}
            onSearch={setSlSearch}
            selected={slSelected}
            onToggle={toggle}
            onLabel={updateLabel}
            loading={loading}
            ariaLabel="Search SportLots sets"
          />
        </div>

        {errorMsg && (
          <div className="px-6 pb-2 text-sm text-[#FF2EB3]" role="alert">
            {errorMsg}
          </div>
        )}

        <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-4">
          <div className="text-xs text-gray-400">
            {totalSelected} set{totalSelected === 1 ? "" : "s"} selected
          </div>
          <div className="flex gap-2">
            <NeonButton
              secondary
              onClick={onClose}
              aria-label="Cancel attach sets"
            >
              Cancel
            </NeonButton>
            <NeonButton
              ref={confirmButtonRef}
              onClick={handleConfirm}
              disabled={submitting || totalSelected === 0}
              aria-label="Confirm attach sets"
            >
              {submitting ? "Attaching…" : `Attach ${totalSelected}`}
            </NeonButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function CandidateColumn({
  title,
  side,
  candidates,
  search,
  onSearch,
  selected,
  onToggle,
  onLabel,
  loading,
  ariaLabel,
}: {
  title: string;
  side: Side;
  candidates: Candidate[];
  search: string;
  onSearch: (q: string) => void;
  selected: Map<string, Selection>;
  onToggle: (side: Side, candidate: Candidate) => void;
  onLabel: (side: Side, id: string, label: string) => void;
  loading: boolean;
  ariaLabel: string;
}) {
  // Unique per-field class so Maestro inputText targets the tapped input (the
  // column search or a specific row's label) rather than the first input
  // sharing the className (see useFieldTestClass). The per-row label is keyed
  // by platformValue so each selected row's input is independently addressable.
  const fieldClass = useFieldTestClass();
  return (
    <section className="flex flex-col min-h-0">
      <header className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
        <span className="text-xs text-gray-500">{candidates.length}</span>
      </header>
      <input
        type="text"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search…"
        aria-label={ariaLabel}
        className={`${fieldClass("search")} bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 focus:border-[#00D558] focus:outline-none mb-2`}
      />
      <ul className="flex-1 overflow-y-auto space-y-1 pr-1">
        {loading && (
          <li className="text-xs text-gray-500 italic px-2 py-1">Loading…</li>
        )}
        {!loading && candidates.length === 0 && (
          <li className="text-xs text-gray-500 italic px-2 py-1">
            No unattached candidates.
          </li>
        )}
        {candidates.map((c) => {
          const sel = selected.get(c.platformValue);
          const isSelected = !!sel;
          return (
            <li key={c.platformValue}>
              <label
                className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${
                  isSelected ? "bg-gray-800 text-gray-100" : "bg-gray-800/40 text-gray-300"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(side, c)}
                  className="accent-[#00D558] mt-1"
                  aria-label={`Toggle ${c.value}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{c.value}</div>
                  <div className="text-[10px] text-gray-500 truncate">
                    id: {c.platformValue}
                  </div>
                  {isSelected && (
                    <input
                      type="text"
                      value={sel.label}
                      onChange={(e) => onLabel(side, c.platformValue, e.target.value)}
                      placeholder="Label shown on filter chip"
                      aria-label={`Edit label for ${c.value}`}
                      className={`${fieldClass(`label-${c.platformValue}`)} mt-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-100 placeholder-gray-500 focus:border-[#00D558] focus:outline-none`}
                    />
                  )}
                </div>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
