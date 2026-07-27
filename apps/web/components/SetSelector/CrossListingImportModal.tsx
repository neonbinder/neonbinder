import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../modules/NeonButton";

/**
 * NEO-21: link cards that were physically printed in one product into a
 * DIFFERENT product's checklist (2021 Score #301-320 shipped inside 2022
 * Chronicles packs, so they complete the Score checklist while living in the
 * Chronicles set).
 *
 * The operator has the *guest* checklist open — that's `targetVariantId`.
 * Here they drill to the *source* (home) set the cards actually live in and
 * name the card numbers. Nothing is created: addCrossListingsByCardNumbers
 * only links rows that already exist under the source, which is why the
 * `notFound` list is spelled out in full on the result screen rather than
 * silently dropped — a missing number means that source set hasn't been
 * fetched/committed yet, and the operator needs to know exactly which.
 *
 * The drill-down here is deliberately a plain stack of <select>s rather than
 * the main page's EntityColumn/ResilientEntityColumn. Those carry marketplace
 * sync + platform-mapping machinery for BUILDING the hierarchy; this modal
 * only picks an existing, already-synced node.
 */

const LEVELS = [
  "sport",
  "year",
  "manufacturer",
  "setName",
  "variantType",
  "insert",
  "parallel",
] as const;

type Level = (typeof LEVELS)[number];

const LEVEL_LABEL: Record<Level, string> = {
  sport: "Sport",
  year: "Year",
  manufacturer: "Manufacturer",
  setName: "Set",
  variantType: "Variant",
  insert: "Insert",
  parallel: "Parallel",
};

// Deepest levels are optional — plenty of variants have no insert/parallel
// child at all, and the selected variantType is already a valid source.
const OPTIONAL_LEVELS = new Set<Level>(["insert", "parallel"]);

// A fat-fingered range ("1-999999") would otherwise build a huge array and
// hand the mutation tens of thousands of lookups. Cap it and tell the user.
const MAX_EXPANDED_NUMBERS = 1000;

type ParseResult =
  { ok: true; numbers: string[] } | { ok: false; error: string };

/**
 * Parse a range/list like "301-320" or "301,303,305-310" into a flat list of
 * card numbers.
 *
 * Only all-digit `N-M` chunks expand as ranges; anything else passes through
 * exactly as typed, so suffixed numbers ("301A") and hyphenated identifiers
 * that aren't numeric ranges ("RC-1") survive untouched. Duplicates collapse
 * so an overlapping list doesn't ask the backend the same question twice.
 *
 * MAX_EXPANDED_NUMBERS caps the RUNNING total across every chunk, not each
 * range in isolation — several individually-small ranges ("1-999,1000-1999,
 * ...") would otherwise slip past a per-chunk check and still add up to an
 * oversized batch. The mutation enforces the same cap server-side too, so
 * this is a fast, friendly rejection rather than the only guard.
 */
export function parseCardNumbers(input: string): ParseResult {
  const numbers: string[] = [];
  const seen = new Set<string>();
  let overCap = false;

  const push = (value: string) => {
    if (seen.has(value)) return;
    seen.add(value);
    numbers.push(value);
  };

  for (const rawChunk of input.split(",")) {
    if (numbers.length > MAX_EXPANDED_NUMBERS) {
      overCap = true;
      break;
    }
    const chunk = rawChunk.trim();
    if (!chunk) continue;

    const range = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (end < start) {
        return {
          ok: false,
          error: `Invalid range "${chunk}" — end is before start.`,
        };
      }
      if (numbers.length + (end - start + 1) > MAX_EXPANDED_NUMBERS) {
        overCap = true;
        break;
      }
      for (let n = start; n <= end; n++) push(String(n));
      continue;
    }

    push(chunk);
  }

  if (overCap) {
    return {
      ok: false,
      error: `That expands to more than ${MAX_EXPANDED_NUMBERS} cards total. Narrow it down.`,
    };
  }
  if (numbers.length === 0) {
    return { ok: false, error: "Enter at least one card number." };
  }
  return { ok: true, numbers };
}

type LinkResult = {
  linked: string[];
  alreadyLinked: string[];
  notFound: string[];
};

type CrossListingImportModalProps = {
  isOpen: boolean;
  onClose: () => void;
  /** The guest checklist currently open — cards get linked INTO this one. */
  targetVariantId: Id<"selectorOptions">;
};

export default function CrossListingImportModal({
  isOpen,
  onClose,
  targetVariantId,
}: CrossListingImportModalProps) {
  const addCrossListings = useMutation(
    api.selectorOptions.addCrossListingsByCardNumbers,
  );

  // One slot per level in LEVELS; null = nothing chosen at that depth yet.
  const [picked, setPicked] = useState<Array<Id<"selectorOptions"> | null>>(
    () => LEVELS.map(() => null),
  );
  const [cardNumberInput, setCardNumberInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LinkResult | null>(null);

  const firstSelectRef = useRef<HTMLSelectElement | null>(null);

  // Each level's options come from the level above's selection. Hooks can't be
  // conditional, so every level queries unconditionally and skips until its
  // parent exists. Convex dedupes identical args, so re-renders are free.
  const sportOptions = useQuery(api.selectorOptions.getSelectorOptions, {
    level: "sport",
  });
  const yearOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[0] ? { level: "year", parentId: picked[0] } : "skip",
  );
  const manufacturerOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[1] ? { level: "manufacturer", parentId: picked[1] } : "skip",
  );
  const setNameOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[2] ? { level: "setName", parentId: picked[2] } : "skip",
  );
  const variantTypeOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[3] ? { level: "variantType", parentId: picked[3] } : "skip",
  );
  const insertOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[4] ? { level: "insert", parentId: picked[4] } : "skip",
  );
  const parallelOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[5] ? { level: "parallel", parentId: picked[5] } : "skip",
  );

  const optionsByLevel = [
    sportOptions,
    yearOptions,
    manufacturerOptions,
    setNameOptions,
    variantTypeOptions,
    insertOptions,
    parallelOptions,
  ];

  // The deepest node the operator actually chose is the source set.
  const sourceSelectorOptionId = useMemo(() => {
    for (let i = picked.length - 1; i >= 0; i--) {
      if (picked[i]) return picked[i];
    }
    return null;
  }, [picked]);

  // Reset everything when the modal is reopened so a previous import's result
  // banner and selections don't bleed into the next one.
  useEffect(() => {
    if (!isOpen) return;
    setPicked(LEVELS.map(() => null));
    setCardNumberInput("");
    setError(null);
    setResult(null);
    setSubmitting(false);
  }, [isOpen]);

  // Focus the first control on open (matches BaseSetPicker's autoFocus).
  useEffect(() => {
    if (!isOpen) return;
    const id = requestAnimationFrame(() => firstSelectRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, submitting, onClose]);

  // Choosing a level invalidates everything below it — the old deeper picks
  // belong to a different parent chain (same rule as the main drill-down).
  const handlePick = (levelIndex: number, value: string) => {
    setResult(null);
    setError(null);
    setPicked((prev) => {
      const next = [...prev];
      next[levelIndex] = value ? (value as Id<"selectorOptions">) : null;
      for (let i = levelIndex + 1; i < next.length; i++) next[i] = null;
      return next;
    });
  };

  const handleSubmit = async () => {
    setError(null);
    setResult(null);

    if (!sourceSelectorOptionId) {
      setError("Pick the set these cards were printed in.");
      return;
    }
    if (sourceSelectorOptionId === targetVariantId) {
      setError("Source and target are the same set — pick a different source.");
      return;
    }

    const parsed = parseCardNumbers(cardNumberInput);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setSubmitting(true);
    try {
      const res = await addCrossListings({
        sourceSelectorOptionId,
        targetSelectorOptionId: targetVariantId,
        cardNumbers: parsed.numbers,
      });
      setResult(res);
    } catch (e) {
      setError(
        `Import failed: ${e instanceof Error ? e.message : "Unknown error"}`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    // Nested <Theme> is required for any createPortal(document.body) dialog in
    // this directory — see the NEO-71-74 note in BaseSetPicker.tsx.
    <Theme>
      <div
        className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
        onClick={() => {
          if (!submitting) onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add cross-release cards"
          className="bg-gray-900 border border-gray-700 rounded-xl max-w-lg w-full max-h-[85vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 py-4 border-b border-gray-700">
            <h2 className="text-xl font-semibold text-white">
              Add Cross-Release Cards
            </h2>
            <p className="text-sm text-gray-400 mt-1">
              Link cards printed in another product into this checklist. The
              cards stay owned by the set they were printed in — this only adds
              them to this set&apos;s display.
            </p>
          </div>

          {/* The form wraps the body AND the footer so "Link Cards" is a real
              type="submit" — that's what makes Enter from the card-number
              field confirm, rather than a synthetic key handler. */}
          <form
            className="flex-1 min-h-0 flex flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div className="space-y-2">
                <div className="text-xs text-purple-400 font-medium uppercase tracking-wide">
                  Source set (where the cards were printed)
                </div>
                {LEVELS.map((level, i) => {
                  // Show a level once its parent is chosen. Optional deepest
                  // levels stay hidden unless the source actually has children
                  // there — most variants have neither insert nor parallel.
                  const parentChosen = i === 0 || picked[i - 1] !== null;
                  if (!parentChosen) return null;
                  const options = optionsByLevel[i];
                  if (
                    OPTIONAL_LEVELS.has(level) &&
                    (!options || options.length === 0)
                  ) {
                    return null;
                  }
                  const loading = options === undefined;
                  return (
                    <label key={level} className="flex items-center gap-2">
                      <span className="text-xs text-gray-400 w-24 shrink-0">
                        {LEVEL_LABEL[level]}
                      </span>
                      <select
                        ref={i === 0 ? firstSelectRef : undefined}
                        value={picked[i] ?? ""}
                        disabled={loading || submitting}
                        onChange={(e) => handlePick(i, e.target.value)}
                        aria-label={`Source ${LEVEL_LABEL[level]}`}
                        className="flex-1 px-3 py-2 text-sm bg-gray-800 border border-gray-600 rounded-lg text-gray-200 disabled:opacity-50"
                      >
                        <option value="">
                          {loading
                            ? "Loading…"
                            : `Select ${LEVEL_LABEL[level]}…`}
                        </option>
                        {(options ?? []).map((opt) => (
                          <option key={opt._id} value={opt._id}>
                            {opt.value}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>

              <label className="block space-y-1.5">
                <span className="block text-xs text-purple-400 font-medium uppercase tracking-wide">
                  Card numbers
                </span>
                <input
                  type="text"
                  value={cardNumberInput}
                  onChange={(e) => {
                    setCardNumberInput(e.target.value);
                    setError(null);
                  }}
                  disabled={submitting}
                  placeholder="e.g. 301-320 or 301,303,305-310"
                  aria-label="Card numbers to cross-list"
                  className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-600 rounded-lg text-gray-200 placeholder-gray-500 disabled:opacity-50"
                />
                <span className="block text-xs text-gray-500">
                  Ranges expand to every number between. Separate entries with
                  commas.
                </span>
              </label>

              {error && (
                <div
                  role="alert"
                  className="p-2 rounded-md border border-[#FF2EB3] bg-[#FF2EB3]/10 text-[#FF2EB3] text-sm"
                >
                  {error}
                </div>
              )}

              {result && (
                <div
                  role="status"
                  className="p-3 rounded-md border border-gray-700 bg-gray-800/60 text-sm space-y-1"
                >
                  <div className="text-[#00D558]">
                    Linked {result.linked.length} card
                    {result.linked.length === 1 ? "" : "s"}.
                  </div>
                  {result.alreadyLinked.length > 0 && (
                    <div className="text-gray-400">
                      Already linked: {result.alreadyLinked.join(", ")}
                    </div>
                  )}
                  {/* Spelled out in full on purpose: a number that isn't in the
                    source set is the one failure mode this flow can't fix on
                    its own, and a bare count would hide which ones. */}
                  {result.notFound.length > 0 && (
                    <div className="text-amber-400">
                      Not found in source set: {result.notFound.join(", ")} —
                      fetch or commit that set first.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-700 flex justify-end gap-3">
              <NeonButton
                type="button"
                cancel
                onClick={onClose}
                disabled={submitting}
                aria-label="Cancel cross-release import"
              >
                {result ? "Close" : "Cancel"}
              </NeonButton>
              <NeonButton
                type="submit"
                disabled={submitting || !sourceSelectorOptionId}
                aria-label="Link cross-release cards"
              >
                {submitting ? "Linking…" : "Link Cards"}
              </NeonButton>
            </div>
          </form>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
