import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
 * The drill is a one-level-at-a-time wizard of BUTTONS, never a stack of
 * native <select>s. That is not a style preference — it is a hard test-harness
 * constraint. Maestro's web driver gives every <option> on the page synthetic
 * tap bounds derived only from its index inside its own parent select
 * (y = 100000 + idx * 20), so options at the same index in DIFFERENT selects
 * land on identical coordinates. Its tap resolver walks
 * document.querySelectorAll('option') and takes the first bounds match, so
 * with several selects on screen only the FIRST one in document order is ever
 * reachable — "pick Year" silently mutates Sport instead. Buttons have real
 * bounds, which is why every other drill in this directory
 * (EntityColumn/ResilientEntityColumn) is E2E-drivable. Keep it buttons.
 *
 * This modal still deliberately does NOT reuse EntityColumn: those carry
 * marketplace sync + platform-mapping machinery for BUILDING the hierarchy;
 * this modal only picks an existing, already-synced node.
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
// child at all, and the selected variantType is already a valid source. When a
// node DOES have children there the operator still gets to stop early via the
// "Use … as the source set" action: addCrossListingsByCardNumbers only requires
// the source to resolve to a variantType/insert/parallel row, not to be a leaf.
const OPTIONAL_LEVELS = new Set<Level>(["insert", "parallel"]);

// The mutation rejects anything shallower than these — cardChecklist rows only
// ever hang off a variant-level node. A source can therefore only be confirmed
// at these depths, so the UI can't build a submit the backend would reject.
const SOURCE_LEVELS = new Set<Level>(["variantType", "insert", "parallel"]);

// Long option lists can't be scrolled by the E2E driver inside a fixed overlay,
// and a tall list pushes the card-number field off a 1024x629 viewport. Above
// this count the step gets a filter box (same trick BaseSetPicker uses).
const FILTER_THRESHOLD = 8;

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

/** One drilled level: the node's id plus the text the operator saw. */
type Picked = { id: Id<"selectorOptions">; value: string };

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
  // Picks are always a contiguous prefix — choosing a level clears every
  // deeper one, because those belonged to a different parent chain.
  const [picked, setPicked] = useState<Array<Picked | null>>(() =>
    LEVELS.map(() => null),
  );
  // The single level whose option list is on screen right now.
  const [activeIndex, setActiveIndex] = useState(0);
  // Which level the operator settled on as the source. Null = still drilling.
  const [confirmedIndex, setConfirmedIndex] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [cardNumberInput, setCardNumberInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LinkResult | null>(null);

  const stepControlsRef = useRef<HTMLDivElement | null>(null);
  const optionListRef = useRef<HTMLDivElement | null>(null);
  const cardNumberRef = useRef<HTMLInputElement | null>(null);
  const lastFocusKeyRef = useRef<string | null>(null);

  // Each level's options come from the level above's selection. Hooks can't be
  // conditional, so every level queries unconditionally and skips until its
  // parent exists. Convex dedupes identical args, so re-renders are free.
  const sportOptions = useQuery(api.selectorOptions.getSelectorOptions, {
    level: "sport",
  });
  const yearOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[0] ? { level: "year", parentId: picked[0].id } : "skip",
  );
  const manufacturerOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[1] ? { level: "manufacturer", parentId: picked[1].id } : "skip",
  );
  const setNameOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[2] ? { level: "setName", parentId: picked[2].id } : "skip",
  );
  const variantTypeOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[3] ? { level: "variantType", parentId: picked[3].id } : "skip",
  );
  const insertOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[4] ? { level: "insert", parentId: picked[4].id } : "skip",
  );
  const parallelOptions = useQuery(
    api.selectorOptions.getSelectorOptions,
    picked[5] ? { level: "parallel", parentId: picked[5].id } : "skip",
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

  const activeLevel = LEVELS[activeIndex];
  const activeOptions = optionsByLevel[activeIndex];
  const activeLoading = activeOptions === undefined;

  const confirmedPick = confirmedIndex !== null ? picked[confirmedIndex] : null;
  const sourceSelectorOptionId = confirmedPick?.id ?? null;

  // Everything picked so far, in order, for the breadcrumb.
  const crumbs = useMemo(
    () =>
      picked
        .map((pick, index) => ({ pick, index }))
        .filter(
          (entry): entry is { pick: Picked; index: number } =>
            entry.pick !== null,
        ),
    [picked],
  );

  const filteredOptions = useMemo(() => {
    const list = activeOptions ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((opt) => opt.value.toLowerCase().includes(q));
  }, [activeOptions, filter]);

  // Reset everything when the modal is reopened so a previous import's result
  // banner and selections don't bleed into the next one.
  useEffect(() => {
    if (!isOpen) return;
    setPicked(LEVELS.map(() => null));
    setActiveIndex(0);
    setConfirmedIndex(null);
    setFilter("");
    setCardNumberInput("");
    setError(null);
    setResult(null);
    setSubmitting(false);
  }, [isOpen]);

  // A filter typed for one level means nothing at the next one.
  useEffect(() => {
    setFilter("");
  }, [activeIndex]);

  // Auto-stop at the parent when an OPTIONAL level turns out to be empty: most
  // variants have no insert/parallel children at all, and the parent is
  // already a valid source, so there is nothing to ask the operator.
  useEffect(() => {
    if (confirmedIndex !== null) return;
    if (!OPTIONAL_LEVELS.has(LEVELS[activeIndex])) return;
    const parent = picked[activeIndex - 1];
    if (!parent) return;
    if (activeOptions === undefined) return; // still loading
    if (activeOptions.length === 0) setConfirmedIndex(activeIndex - 1);
  }, [activeIndex, activeOptions, confirmedIndex, picked]);

  // Keep the keyboard in the flow: each new step takes focus (filter box if
  // there is one, else the first option), and once the source is settled focus
  // lands on the card numbers — the actual next thing to do. preventScroll so
  // focusing never yanks the modal body around.
  useEffect(() => {
    if (!isOpen) {
      lastFocusKeyRef.current = null;
      return;
    }
    if (confirmedPick === null && activeLoading) return;
    const focusKey =
      confirmedPick !== null ? "confirmed" : `step-${activeIndex}`;
    if (lastFocusKeyRef.current === focusKey) return;
    lastFocusKeyRef.current = focusKey;
    const raf = requestAnimationFrame(() => {
      const target =
        confirmedPick !== null
          ? cardNumberRef.current
          : (stepControlsRef.current?.querySelector<HTMLElement>("input") ??
            optionListRef.current?.querySelector<HTMLElement>("button"));
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [isOpen, activeIndex, activeLoading, confirmedPick]);

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
  const handlePick = (
    levelIndex: number,
    option: { _id: Id<"selectorOptions">; value: string },
  ) => {
    setResult(null);
    setError(null);
    setPicked((prev) => {
      const next = [...prev];
      next[levelIndex] = { id: option._id, value: option.value };
      for (let i = levelIndex + 1; i < next.length; i++) next[i] = null;
      return next;
    });
    if (levelIndex < LEVELS.length - 1) {
      // Whether a deeper level even exists is unknown until its options come
      // back; the auto-stop effect settles that.
      setConfirmedIndex(null);
      setActiveIndex(levelIndex + 1);
    } else {
      // Nothing below parallel — this pick IS the source.
      setConfirmedIndex(levelIndex);
    }
  };

  // Breadcrumb jump-back: re-open that level's list and drop everything under
  // it, so a chain can never mix picks from two different parents.
  const handleJumpBack = (levelIndex: number) => {
    setResult(null);
    setError(null);
    setConfirmedIndex(null);
    setActiveIndex(levelIndex);
    setPicked((prev) => {
      const next = [...prev];
      for (let i = levelIndex + 1; i < next.length; i++) next[i] = null;
      return next;
    });
  };

  const handleConfirmSource = (levelIndex: number) => {
    setResult(null);
    setError(null);
    setConfirmedIndex(levelIndex);
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

  // The optional level on screen has children, so the operator is being asked
  // to go deeper — but its parent is already a legitimate source. Offer both.
  const stopParent =
    confirmedPick === null &&
    OPTIONAL_LEVELS.has(activeLevel) &&
    activeIndex > 0 &&
    SOURCE_LEVELS.has(LEVELS[activeIndex - 1]) &&
    !activeLoading &&
    (activeOptions?.length ?? 0) > 0
      ? picked[activeIndex - 1]
      : null;

  const parentValue = activeIndex > 0 ? picked[activeIndex - 1]?.value : null;

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
          <div className="px-6 py-3 border-b border-gray-700">
            <h2 className="text-lg font-semibold text-white">
              Add Cross-Release Cards
            </h2>
            {/* Kept to two lines on purpose: a fixed overlay can't be scrolled
                by the E2E driver, so every fixed pixel here is a pixel the
                option list below loses on a 1024x629 viewport. */}
            <p className="text-xs text-gray-400 mt-0.5">
              Link cards printed in another product into this checklist. They
              stay owned by the set they were printed in.
            </p>
          </div>

          {/* The form wraps the body AND the footer so "Link Cards" is a real
              type="submit" — that's what makes Enter from the card-number
              field confirm, rather than a synthetic key handler. Every other
              control in here is type="button" so it can never submit. */}
          <form
            className="flex-1 min-h-0 flex flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            {/* Column layout, not a plain scroll box: the option list is the
                only part allowed to flex/scroll, so the card-number field and
                the banners stay on screen at any viewport height. */}
            <div className="flex-1 min-h-0 flex flex-col gap-3 px-6 py-3">
              <div ref={stepControlsRef} className="shrink-0 space-y-1.5">
                <div className="text-xs text-purple-400 font-medium uppercase tracking-wide">
                  Source set (where the cards were printed)
                </div>

                {/* What's picked so far. Each chip jumps back to that level,
                    which is the only way to change an earlier answer. */}
                {crumbs.length > 0 && (
                  <nav
                    aria-label="Source set path"
                    className="flex flex-wrap items-center gap-1"
                  >
                    {crumbs.map(({ pick, index }, position) => (
                      <Fragment key={LEVELS[index]}>
                        {position > 0 && (
                          <span
                            aria-hidden="true"
                            className="text-gray-600 text-xs"
                          >
                            ›
                          </span>
                        )}
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => handleJumpBack(index)}
                          aria-label={`Change ${LEVEL_LABEL[LEVELS[index]]}`}
                          title={`Change ${LEVEL_LABEL[LEVELS[index]]}`}
                          className={`px-2 py-0.5 rounded-md border text-xs transition-colors disabled:opacity-50 ${
                            confirmedIndex === index
                              ? "border-[#00D558] bg-[#00D558]/10 text-[#00D558]"
                              : "border-gray-600 bg-gray-800 text-gray-300 hover:border-gray-400"
                          }`}
                        >
                          {pick.value}
                        </button>
                      </Fragment>
                    ))}
                  </nav>
                )}

                {confirmedPick ? (
                  <div className="px-3 py-1.5 rounded-lg border border-[#00D558] bg-[#00D558]/10 text-sm text-[#00D558]">
                    Source set: {confirmedPick.value}
                  </div>
                ) : (
                  <>
                    <div className="text-xs text-gray-400">
                      {parentValue
                        ? `Pick ${LEVEL_LABEL[activeLevel]} under ${parentValue}`
                        : `Pick ${LEVEL_LABEL[activeLevel]}`}
                    </div>

                    {/* First focusable control of the step: type, press Enter,
                        top match is picked. */}
                    {!activeLoading &&
                      (activeOptions?.length ?? 0) > FILTER_THRESHOLD && (
                        <input
                          type="text"
                          value={filter}
                          onChange={(e) => setFilter(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            // Never let Enter here submit the form.
                            e.preventDefault();
                            const top = filteredOptions[0];
                            if (top) handlePick(activeIndex, top);
                          }}
                          disabled={submitting}
                          placeholder={`Filter ${LEVEL_LABEL[activeLevel]}…`}
                          aria-label={`Filter ${LEVEL_LABEL[activeLevel]} options`}
                          className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-600 rounded-lg text-gray-200 placeholder-gray-500 disabled:opacity-50"
                        />
                      )}

                    {/* Above the (scrollable) list so it is always reachable
                        without scrolling: stopping here is a real answer, not
                        a fallback — the mutation accepts any variant-level
                        node, leaf or not. */}
                    {stopParent && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => handleConfirmSource(activeIndex - 1)}
                        aria-label={`Use ${stopParent.value} as the source set`}
                        className="w-full text-left px-3 py-1.5 rounded-lg border border-[#00B7FF] bg-[#00B7FF]/10 text-sm text-[#00B7FF] hover:bg-[#00B7FF]/20 transition-colors disabled:opacity-50"
                      >
                        Use {stopParent.value} as the source set
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* One level's options — the flexible, scrollable region. */}
              {!confirmedPick &&
                (activeLoading ? (
                  <div className="shrink-0 text-sm text-gray-500 py-2 text-center">
                    Loading…
                  </div>
                ) : filteredOptions.length === 0 ? (
                  <div className="shrink-0 text-sm text-gray-500 py-2 text-center">
                    {(activeOptions?.length ?? 0) === 0
                      ? parentValue
                        ? `No ${LEVEL_LABEL[activeLevel]} options under ${parentValue}.`
                        : `No ${LEVEL_LABEL[activeLevel]} options yet.`
                      : `No ${LEVEL_LABEL[activeLevel]} matches "${filter}".`}
                  </div>
                ) : (
                  <div
                    ref={optionListRef}
                    className="flex-1 min-h-24 max-h-64 overflow-y-auto space-y-1 pr-0.5"
                  >
                    {filteredOptions.map((opt) => (
                      <button
                        key={opt._id}
                        type="button"
                        disabled={submitting}
                        onClick={() => handlePick(activeIndex, opt)}
                        aria-label={`Pick ${LEVEL_LABEL[activeLevel]} ${opt.value}`}
                        className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-all disabled:opacity-50 ${
                          picked[activeIndex]?.id === opt._id
                            ? "border-[#00D558] bg-[#00D558]/10 ring-1 ring-[#00D558] text-gray-100"
                            : "border-gray-600 bg-gray-800 text-gray-200 hover:border-gray-400"
                        }`}
                      >
                        {opt.value}
                      </button>
                    ))}
                  </div>
                ))}

              <div className="shrink-0 space-y-3">
                <label className="block space-y-1">
                  <span className="block text-xs text-purple-400 font-medium uppercase tracking-wide">
                    Card numbers
                  </span>
                  <input
                    ref={cardNumberRef}
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
                    Ranges expand; separate entries with commas.
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
                    {/* Spelled out in full on purpose: a number that isn't in
                      the source set is the one failure mode this flow can't
                      fix on its own, and a bare count would hide which ones. */}
                    {result.notFound.length > 0 && (
                      <div className="text-amber-400">
                        Not found in source set: {result.notFound.join(", ")} —
                        fetch or commit that set first.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-3 border-t border-gray-700 flex justify-end gap-3">
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
