import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import NeonButton from "../modules/NeonButton";
import type { PlatformItem } from "./ReconciliationModal";
import { Input } from "../primitives/Input";

/** Which job this dialog is doing — see `remapNotice`. */
export type BaseSetPickerMode = "initial" | "remap";

/**
 * What a RE-MAP is about to move (NEO-219).
 *
 * `setPrimarySlotId` reuses the existing primary slot key, so re-mapping
 * re-points every card already fetched through that slot at the newly picked
 * set. That is the whole reason this dialog is allowed to be destructive, so
 * the counts are stated before the operator confirms rather than after.
 */
export type BaseRemapNotice = {
  /**
   * The ROW's card count, from `getSlotCardCounts.total`.
   *
   * Not `slCards + bscCards`: a card fetched from both marketplaces occupies a
   * slot on each side, so summing the two maps double-counts it. `total` is the
   * number of distinct cards, which is what "N cards are linked" claims.
   */
  totalCards: number;
  /** Cards fetched through the CURRENT SportLots primary slot. */
  slCards: number;
  /** Cards fetched through the CURRENT BSC primary slot. */
  bscCards: number;
  /** Display label of the currently-mapped SportLots set, when there is one. */
  currentSlLabel?: string;
  /** Display label of the currently-mapped BSC set, when there is one. */
  currentBscLabel?: string;
};

type BaseSetPickerProps = {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Exactly what the operator picked. BOTH sides are optional: a BSC-only pick
   * is legitimate (SportLots may hold no base row at all), and nothing this
   * dialog did not name is ever written.
   */
  onConfirm: (selected: {
    sl?: PlatformItem;
    bsc?: PlatformItem;
  }) => Promise<void>;
  slOptions: PlatformItem[];
  bscOptions?: PlatformItem[];
  /**
   * The SET row's own BSC slug, offered as an explicit, selectable candidate.
   *
   * NEO-219: this used to be an INVISIBLE fallback that `BaseMappingForm`
   * substituted whenever the picker came back with no BSC pick — so the row a
   * Base variant ended up linked to was one the operator never saw, let alone
   * chose. It is a candidate like any other now; the only thing that makes it
   * special is that it is pre-selected when it is the sole BSC candidate.
   */
  setListing?: PlatformItem;
  setName: string;
  manufacturer?: string;
  // When true, the picker renders skeleton placeholders in the option lists
  // and disables Confirm. Lets the caller open the dialog before
  // fetchRawOptions resolves so the user gets immediate feedback.
  loading?: boolean;
  mode?: BaseSetPickerMode;
  /** Impact statement for `mode="remap"`. Ignored in `initial` mode. */
  remapNotice?: BaseRemapNotice;
  /**
   * A fixed, caller-composed alert rendered at the top of the dialog (the
   * stale-mapping refusal). Never marketplace text.
   */
  notice?: string | null;
};

/**
 * An EXACT match on the set's own name, or on the set name with the
 * manufacturer prefix stripped. These two are the only scores this dialog
 * pre-selects from — see `preselectScore`.
 */
export const EXACT_SET_NAME_SCORE = 1000;
export const PREFIX_STRIPPED_SCORE = 950;

/**
 * A bare manufacturer row ("Topps" under set "Topps Chrome").
 *
 * NEO-219 decision 7: this used to score 1000 — the SAME tier as an exact set
 * name — which made "Topps" outrank "Topps Chrome" whenever the sort was
 * stable-by-input-order, and auto-selected the brand's catch-all row as a set's
 * base. A brand name is the weakest real signal here, not the strongest: it is
 * demoted BELOW the generic "Base"/"Base Set" rows, which at least claim to be
 * a base set.
 */
export const EXACT_MANUFACTURER_SCORE = 600;

/**
 * At or above this score a row shows the "likely match" pill.
 *
 * Deliberately LOWER than the pre-select threshold, and unchanged from before
 * NEO-219: the generic "Base" / "Base Set" rows still say "likely match"
 * (`.maestro/flows/set-selector/sets-base.yaml` asserts the pill), they are
 * just no longer pre-selected on the operator's behalf.
 */
export const LIKELY_MATCH_SCORE = 795;

/**
 * The one rule for "safe to pre-select".
 *
 * Pre-selection is a claim that a human need not look. Only an exact name match
 * earns that: everything below 950 is a guess, and a guess that is pre-selected
 * gets confirmed by reflex. Exported (with `scoreBaseSetMatch`) so the scoring
 * table can be tested without rendering the dialog.
 */
export function preselectScore(score: number): boolean {
  return score >= PREFIX_STRIPPED_SCORE;
}

// Returns a score indicating how likely `slValue` is the base set.
// Tiers (higher = more likely):
//   1000 — exact match on the set name
//    950 — exact match on the set name with the manufacturer prefix stripped
//    900-885 — "<setName> Base Set" / "<setName> Base"
//    800/795 — trailing "Base Set" / "Base" (generic base row)
//    600 — exact match on the MANUFACTURER (NEO-219: below generic)
//    <600 — weaker fuzzy signals
export function scoreBaseSetMatch(
  slValue: string,
  setName: string,
  manufacturer: string,
): number {
  const norm = slValue.toLowerCase().trim();
  const setNorm = setName.toLowerCase().trim();
  const mfgNorm = manufacturer.toLowerCase().trim();

  // Tier 1: exact match on set name
  if (setNorm && norm === setNorm) return EXACT_SET_NAME_SCORE;

  // Tier 2: exact match on set name with manufacturer prefix stripped
  // (e.g., setName "Topps Opening Day", mfg "Topps" → match "Opening Day")
  const stripped =
    mfgNorm && setNorm.startsWith(`${mfgNorm} `)
      ? setNorm.slice(mfgNorm.length + 1).trim()
      : "";
  if (stripped && norm === stripped) return PREFIX_STRIPPED_SCORE;

  // Tier 3: set name + "Base Set"/"Base" appended
  if (setNorm) {
    if (norm === `${setNorm} base set`) return 900;
    if (norm === `${setNorm} base`) return 895;
  }
  if (stripped) {
    if (norm === `${stripped} base set`) return 890;
    if (norm === `${stripped} base`) return 885;
  }

  // Tier 4: generic "Base Set" / "Base" row
  if (norm === "base set") return 800;
  if (norm === "base") return LIKELY_MATCH_SCORE;

  // Tier 5 (NEO-219): a bare manufacturer row. Below every tier above.
  if (mfgNorm && norm === mfgNorm) return EXACT_MANUFACTURER_SCORE;

  // Weaker fuzzy signals below
  if (setNorm && norm.startsWith(setNorm)) {
    const suffix = norm.slice(setNorm.length).trim();
    return 500 - suffix.length;
  }
  if (setNorm && norm.includes(setNorm)) return 300;

  return 0;
}

/** One row in either list, already scored and labelled. */
type Candidate = {
  /** Stable identity for selection state — the set listing needs its own. */
  key: string;
  item: PlatformItem;
  /** Visible row text. */
  label: string;
  /** `null` for the set-listing row, which is never scored (see below). */
  score: number | null;
  isSetListing: boolean;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tab-trap candidates INSIDE the dialog.
 *
 * The `.tabIndex >= 0` filter is not belt-and-braces: both option lists use a
 * roving tabIndex, so every unfocused option is a `<button tabindex="-1">` —
 * which still matches `button:not([disabled])`. Without the filter, Tab would
 * walk the operator through every marketplace row one at a time.
 */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0,
  );
}

export default function BaseSetPicker({
  isOpen,
  onClose,
  onConfirm,
  slOptions,
  bscOptions = [],
  setListing,
  setName,
  manufacturer = "",
  loading = false,
  mode = "initial",
  remapNotice,
  notice,
}: BaseSetPickerProps) {
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [userPicked, setUserPicked] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");
  const [selectedBscKey, setSelectedBscKey] = useState<string | null>(null);
  const [userPickedBsc, setUserPickedBsc] = useState(false);
  // Roving tabIndex position per list (WAI-ARIA listbox pattern).
  const [slFocusIndex, setSlFocusIndex] = useState(0);
  const [bscFocusIndex, setBscFocusIndex] = useState(0);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const slRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const bscRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const triggerRef = useRef<HTMLElement | null>(null);
  const initialFocusDone = useRef(false);

  const sortedSlOptions = useMemo(() => {
    const scored = slOptions.map((opt) => ({
      ...opt,
      score: scoreBaseSetMatch(opt.value, setName, manufacturer),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }, [slOptions, setName, manufacturer]);

  /**
   * BSC candidates = the marketplace's own rows, plus the set-listing row.
   *
   * The set listing is deliberately UNSCORED (`score: null`). Scoring it would
   * hand it `EXACT_SET_NAME_SCORE` (its label IS the set name) and it would
   * pre-select itself over every real BSC row — which is precisely the silent
   * substitution NEO-219 removed. Its one pre-selection rule lives below.
   */
  const bscCandidates = useMemo<Candidate[]>(() => {
    const scored: Candidate[] = bscOptions
      .map((opt) => ({
        key: `bsc:${opt.platformValue}:${opt.value}`,
        item: opt,
        label: opt.value,
        score: scoreBaseSetMatch(opt.value, setName, manufacturer),
        isSetListing: false,
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    if (setListing) {
      scored.push({
        key: "bsc:set-listing",
        item: setListing,
        label: `${setName} — set listing (BSC)`,
        score: null,
        isSetListing: true,
      });
    }
    return scored;
  }, [bscOptions, setListing, setName, manufacturer]);

  useEffect(() => {
    if (userPicked) return;
    const top = sortedSlOptions[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-selects only an EXACT name match; latched by userPicked so it always yields to the operator
    setSelectedValue(top && preselectScore(top.score) ? top.value : null);
  }, [sortedSlOptions, userPicked]);

  useEffect(() => {
    if (userPickedBsc) return;
    // Decision 4: the set listing is pre-selected only when it is the SOLE
    // BSC candidate — there is nothing else it could be, and making the
    // operator pick the only row on offer is ceremony, not safety.
    if (bscCandidates.length === 1 && bscCandidates[0].isSetListing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sole-candidate pre-select; latched by userPickedBsc
      setSelectedBscKey(bscCandidates[0].key);
      return;
    }
    const top = bscCandidates.find((c) => !c.isSetListing);
    setSelectedBscKey(
      top && top.score !== null && preselectScore(top.score) ? top.key : null,
    );
  }, [bscCandidates, userPickedBsc]);

  const filteredSlOptions = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return sortedSlOptions;

    const queryTokens = q.split(/\s+/).filter(Boolean);

    const scoreQueryMatch = (value: string): number => {
      const v = value.toLowerCase();
      if (v === q) return 1000;
      if (v.startsWith(q + " ") || v === q) return 900;
      if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(v))
        return 800;
      if (v.includes(q)) return 700;
      // All tokens present as whole words
      const allTokensMatch = queryTokens.every((tok) =>
        new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(v),
      );
      if (allTokensMatch) return 600 - (v.length - q.length);
      // All tokens present anywhere
      const allTokensLoose = queryTokens.every((tok) => v.includes(tok));
      if (allTokensLoose) return 400 - (v.length - q.length);
      return -1;
    };

    return sortedSlOptions
      .map((opt) => ({ ...opt, queryScore: scoreQueryMatch(opt.value) }))
      .filter((opt) => opt.queryScore >= 0)
      .sort((a, b) => {
        if (b.queryScore !== a.queryScore) return b.queryScore - a.queryScore;
        return a.value.length - b.value.length;
      });
  }, [sortedSlOptions, searchFilter]);

  const selectedSl = slOptions.find((o) => o.value === selectedValue);
  const selectedBsc = bscCandidates.find((c) => c.key === selectedBscKey)?.item;
  const hasPick = !!selectedSl || !!selectedBsc;

  // `override` exists for Enter-on-an-option: that keystroke both selects and
  // confirms, and the selection setState is not visible to this call.
  const doConfirm = async (override?: {
    sl?: PlatformItem;
    bsc?: PlatformItem;
  }) => {
    const sl = override && "sl" in override ? override.sl : selectedSl;
    const bsc = override && "bsc" in override ? override.bsc : selectedBsc;
    if (!sl && !bsc) return;
    if (confirming || loading) return;
    setConfirming(true);
    try {
      await onConfirm({ sl, bsc });
    } finally {
      setConfirming(false);
    }
  };

  const showSearch = slOptions.length > 8;

  // Initial focus: the search box when it is rendered, otherwise the first
  // SportLots option, otherwise the first BSC option. Re-runs when `loading`
  // flips because the option lists do not exist during the skeleton phase.
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (initialFocusDone.current) return;
    if (!triggerRef.current) {
      triggerRef.current = document.activeElement as HTMLElement | null;
    }
    const target =
      searchRef.current ?? slRefs.current[0] ?? bscRefs.current[0] ?? null;
    if (!target) return;
    target.focus();
    initialFocusDone.current = true;
  }, [isOpen, loading, showSearch, filteredSlOptions.length, bscCandidates.length]);

  // Restore focus to whatever opened the dialog (WCAG 2.4.3).
  useEffect(() => {
    return () => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  const focusOption = (side: "sl" | "bsc", index: number) => {
    const refs = side === "sl" ? slRefs : bscRefs;
    const el = refs.current[index];
    if (!el) return;
    if (side === "sl") setSlFocusIndex(index);
    else setBscFocusIndex(index);
    el.focus();
  };

  const selectSl = (value: string) => {
    setSelectedValue(value);
    setUserPicked(true);
  };
  const selectBsc = (key: string) => {
    setSelectedBscKey(key);
    setUserPickedBsc(true);
  };

  /**
   * The keyboard contract for an option row.
   *
   * Arrow/Home/End MOVE, Space SELECTS, Enter selects-and-confirms. Enter is
   * scoped to a focused option on purpose: the previous build listened on
   * `window`, so Enter pressed anywhere on the page — including in the search
   * box, including with the dialog merely open behind another surface —
   * committed whatever happened to be pre-selected.
   */
  const onOptionKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    side: "sl" | "bsc",
    index: number,
    count: number,
    onSelect: () => void,
    confirmOverride: { sl?: PlatformItem; bsc?: PlatformItem },
  ) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      focusOption(side, Math.min(index + 1, count - 1));
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusOption(side, Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusOption(side, 0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusOption(side, count - 1);
      return;
    }
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      onSelect();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onSelect();
      void doConfirm(confirmOverride);
    }
  };

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (!confirming) {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = focusableIn(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!isOpen) return null;

  const isRemap = mode === "remap";
  const remapTotal = remapNotice ? remapNotice.totalCards : 0;
  const showRemapBreakdown =
    !!remapNotice && remapNotice.slCards > 0 && remapNotice.bscCards > 0;
  const currentMapping = remapNotice
    ? [
        remapNotice.currentSlLabel
          ? `SportLots — ${remapNotice.currentSlLabel}`
          : null,
        remapNotice.currentBscLabel
          ? `BSC — ${remapNotice.currentBscLabel}`
          : null,
      ].filter((s): s is string => s !== null)
    : [];

  const confirmLabel = confirming
    ? "Saving..."
    : loading
      ? // Keep the loading label distinct: five Maestro flows treat the flip to
        // "Confirm Base Set" as the signal that the marketplace round-trip
        // finished, and `base-mapping-cancel-recovers.yaml` uses it as the
        // picker's loaded signal.
        "Loading…"
      : isRemap
        ? "Re-map Base Set"
        : "Confirm Base Set";

  return createPortal(
    // NEO-71-74 QA fix: createPortal renders straight to document.body, outside
    // the DOM subtree the app's root <Theme> (src/main.tsx) puts its
    // `.radix-themes` class + CSS vars on. Without re-establishing Theme scope
    // here, NeonButton/Radix components render with the right classes but no
    // resolved radius/spacing/color tokens (border-radius: 0, padding: 0).
    // A nested <Theme> with no props inherits accentColor/radius/appearance
    // from the ambient Theme via context and re-applies the class at this
    // portal root. Same fix applied to every other createPortal(document.body)
    // dialog in components/SetSelector/.
    <Theme>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="base-set-picker-title"
        aria-describedby="base-set-picker-description"
        className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 outline-none"
        onKeyDown={onDialogKeyDown}
        onClick={() => {
          if (!confirming) onClose();
        }}
      >
        <div
          className="bg-gray-900 border border-gray-700 rounded-xl max-w-lg w-full max-h-[85vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-700">
            <h2
              id="base-set-picker-title"
              className="text-xl font-semibold text-white"
            >
              Select Base Set
            </h2>
            <p
              id="base-set-picker-description"
              className="text-sm text-gray-400 mt-1"
            >
              Choose the SportLots and BSC sets that hold{" "}
              <strong className="text-gray-200">{setName}</strong>&rsquo;s base
              cards. Only what you pick is linked; nothing else changes.
            </p>
            {isRemap && remapNotice && (
              <div className="mt-2 text-sm text-amber-300">
                <p>
                  {remapTotal > 0
                    ? `${remapTotal} cards are linked through the current mapping; their refs will point at the new set.`
                    : "No cards are linked through the current mapping yet."}
                </p>
                {showRemapBreakdown && (
                  <p className="text-xs text-amber-200/80 mt-0.5">
                    {remapNotice.slCards} through SportLots,{" "}
                    {remapNotice.bscCards} through BSC.
                  </p>
                )}
                {currentMapping.length > 0 && (
                  <p className="text-xs text-gray-400 mt-0.5">
                    Currently mapped: {currentMapping.join(" · ")}
                  </p>
                )}
              </div>
            )}
          </div>

          {notice && (
            <div
              role="alert"
              className="mx-6 mt-4 p-3 rounded-md border border-amber-600 bg-amber-900/25 text-sm text-amber-200"
            >
              {notice}
            </div>
          )}

          {/* BSC candidates */}
          {loading && (
            <div className="px-6 pt-4">
              <div className="text-xs text-blue-400 font-medium uppercase tracking-wide mb-1.5">
                BSC base
              </div>
              <div className="h-9 rounded-lg bg-gray-800/60 border border-gray-700 animate-pulse" />
            </div>
          )}
          {!loading && (
            <div className="px-6 pt-4">
              <div
                className="text-xs text-blue-400 font-medium uppercase tracking-wide mb-1.5"
                id="bsc-base-list-label"
              >
                BSC base
              </div>
              {bscCandidates.length === 0 ? (
                <p className="text-sm text-gray-500">
                  BSC returned no base set for {setName}
                </p>
              ) : (
                <div
                  role="listbox"
                  aria-labelledby="bsc-base-list-label"
                  className="space-y-1 max-h-32 overflow-y-auto"
                >
                  {bscCandidates.map((cand, i) => {
                    const selected = selectedBscKey === cand.key;
                    return (
                      <button
                        key={cand.key}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-label={`BSC base candidate: ${cand.label}`}
                        tabIndex={i === bscFocusIndex ? 0 : -1}
                        ref={(el) => {
                          bscRefs.current[i] = el;
                        }}
                        onFocus={() => setBscFocusIndex(i)}
                        onClick={() => selectBsc(cand.key)}
                        onKeyDown={(e) =>
                          onOptionKeyDown(
                            e,
                            "bsc",
                            i,
                            bscCandidates.length,
                            () => selectBsc(cand.key),
                            { sl: selectedSl, bsc: cand.item },
                          )
                        }
                        className={`w-full text-left px-3 py-1.5 rounded-md border transition-all text-sm focus:outline-none focus:ring-2 focus:ring-[#00B7FF] ${
                          selected
                            ? "border-blue-400 bg-blue-900/30 ring-1 ring-blue-400"
                            : "border-gray-600 bg-gray-800 hover:border-gray-400"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-gray-200">{cand.label}</span>
                          {cand.score !== null &&
                            cand.score >= LIKELY_MATCH_SCORE && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-700 shrink-0">
                                likely match
                              </span>
                            )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* SL Search */}
          <div className="px-6 pt-3">
            <div
              className="text-xs text-purple-400 font-medium uppercase tracking-wide mb-1.5"
              id="sl-base-list-label"
            >
              SportLots base
            </div>
            {showSearch && (
              <Input
                bare
                ref={searchRef}
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                onKeyDown={(e) => {
                  // Enter in the search box moves to the first result. It never
                  // confirms — typing a filter and pressing Enter must not
                  // commit a mapping the operator has not looked at.
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  focusOption("sl", 0);
                }}
                className="w-full px-3 py-2 text-sm"
                placeholder="Search SportLots sets..."
              />
            )}
          </div>

          {/* SL List */}
          <div className="flex-1 overflow-y-auto px-6 py-3 space-y-1.5">
            {loading ? (
              <>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={`skel-${i}`}
                    className="h-10 rounded-lg bg-gray-800/60 border border-gray-700 animate-pulse"
                    style={{ animationDelay: `${i * 60}ms` }}
                  />
                ))}
              </>
            ) : slOptions.length === 0 ? (
              <p className="text-sm text-gray-500 py-4">
                SportLots returned no base set for {setName}
              </p>
            ) : (
              <>
                <div
                  role="listbox"
                  aria-labelledby="sl-base-list-label"
                  className="space-y-1.5"
                >
                  {filteredSlOptions.map((opt, i) => {
                    const selected = selectedValue === opt.value;
                    return (
                      <button
                        key={`${opt.platformValue}-${opt.value}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-label={`SportLots base candidate: ${opt.value}`}
                        tabIndex={i === slFocusIndex ? 0 : -1}
                        ref={(el) => {
                          slRefs.current[i] = el;
                        }}
                        onFocus={() => setSlFocusIndex(i)}
                        onClick={() => selectSl(opt.value)}
                        onKeyDown={(e) =>
                          onOptionKeyDown(
                            e,
                            "sl",
                            i,
                            filteredSlOptions.length,
                            () => selectSl(opt.value),
                            {
                              sl: slOptions.find((o) => o.value === opt.value),
                              bsc: selectedBsc,
                            },
                          )
                        }
                        className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all text-sm focus:outline-none focus:ring-2 focus:ring-[#00D558] ${
                          selected
                            ? "border-[#00D558] bg-[#00D558]/10 ring-1 ring-[#00D558]"
                            : "border-gray-600 bg-gray-800 hover:border-gray-400"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-gray-200">{opt.value}</span>
                          {opt.score >= LIKELY_MATCH_SCORE && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-700 shrink-0">
                              likely match
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {filteredSlOptions.length === 0 && (
                  <p className="text-sm text-gray-500 py-4 text-center">
                    No matching sets found
                  </p>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3">
            {/* The disabled-state REASON lives here rather than on the button:
                the confirm label is a Maestro landmark in five flows and has to
                stay constant. */}
            <p className="text-xs text-gray-500" role="status">
              {loading
                ? "Loading marketplace options…"
                : hasPick
                  ? ""
                  : "Pick a SportLots or BSC set to continue."}
            </p>
            <div className="flex justify-end gap-3 shrink-0">
              <NeonButton cancel onClick={onClose} disabled={confirming}>
                Cancel
              </NeonButton>
              <NeonButton
                onClick={() => void doConfirm()}
                disabled={!hasPick || confirming || loading}
              >
                {confirmLabel}
              </NeonButton>
            </div>
          </div>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
