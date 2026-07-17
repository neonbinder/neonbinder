import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import TeamPicker from "./TeamPicker";
import PlayerPicker from "./PlayerPicker";
import CardFeaturesEditor, { CardFeatureRow } from "./CardFeaturesEditor";
import { EXPECTED_FEATURES } from "../../convex/features/expectedFeatures";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";

const AUTOGRAPHED_FEATURE = EXPECTED_FEATURES.find(
  (f) => f.key === "autographed",
)!;

/**
 * NEO-25: right-anchored card detail panel. Replaces the old per-row edit
 * modal in CardChecklistItem. ONE instance serves the whole list — selection
 * state is hoisted into CardChecklist and the parent re-keys this component on
 * `card._id`, so switching cards (arrow nav / prev-next) remounts it with fresh
 * draft state (no manual reset effect).
 *
 * Editable: cardName, teams, players, attributes (chip toggles → derives
 * isRelic, and isRookie via an OR with the checkbox below — see NEO-71
 * comment at the isRookie write site), printRun, cardVariation, listingTitle,
 * listingDescription. Per-card feature overrides live in the embedded
 * CardFeaturesEditor (persists immediately via setCardFeature, so they're NOT
 * part of this panel's dirty/Save cycle) — this now includes a Rookie
 * checkbox (NEO-71) that writes `cardChecklist.isRookie` directly and
 * independently of the RC chip above. The Autographed dropdown is the same
 * `features.autographed` control, promoted out of that collapsed editor to
 * always-visible here (previously a redundant free-text `autographType`
 * input lived here instead — removed so there's one source of truth for
 * "is this card autographed", not two disagreeing controls).
 *
 * Display-only: card images (imageUrls or placeholder), and the
 * inherited-from-set hierarchy (sport→…→variant). Per-card override of the
 * hierarchy levels themselves is deferred to NEO-21 (cross-release home set).
 */

// Attribute tokens the panel exposes as toggle chips. Any other token already
// on the card (e.g. the reconciliation tags "unmatched-bsc"/"unmatched-sl") is
// preserved untouched on save and shown read-only — `attributes` is a
// full-replacement patch, so we must not silently drop tokens we don't render.
const EDITABLE_ATTRIBUTES = ["RC", "AU", "RELIC", "SP", "SSP", "NUM"] as const;

const ATTRIBUTE_LABEL: Record<string, string> = {
  RC: "RC",
  AU: "AU",
  RELIC: "RELIC",
  SP: "SP",
  SSP: "SSP",
  NUM: "#'d",
};

type CardDetailCard = {
  _id: Id<"cardChecklist">;
  selectorOptionId: Id<"selectorOptions">;
  cardNumber: string;
  cardName: string;
  playerIds?: Array<Id<"players">>;
  teamOnCardIds?: Array<Id<"teams">>;
  attributes?: string[];
  isRookie?: boolean;
  isRelic?: boolean;
  printRun?: number;
  cardVariation?: string;
  listingTitle?: string;
  listingDescription?: string;
  imageUrls?: { front?: string; back?: string };
  platformData: { bsc?: string; sportlots?: string };
  sourcePlatformIds?: { bsc?: string; sportlots?: string };
  isCustom?: boolean;
  features?: Record<string, string>;
};

type AncestorLevel = { level: string; value: string };

type CardDetailPanelProps = {
  card: CardDetailCard;
  // Ancestor chain (sport→…→variant) already queried once in CardChecklist.
  ancestorChain?: Array<AncestorLevel>;
  ancestorSport?: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
};

// Human label for each hierarchy level shown in the inherited section.
const LEVEL_LABEL: Record<string, string> = {
  sport: "Sport",
  year: "Year",
  manufacturer: "Manufacturer",
  setName: "Set",
  variantType: "Variant",
  insert: "Insert",
  parallel: "Parallel",
};

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export default function CardDetailPanel({
  card,
  ancestorChain,
  ancestorSport,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: CardDetailPanelProps) {
  const updateCard = useMutation(api.selectorOptions.updateCard);
  const setCardFeature = useMutation(api.selectorOptions.setCardFeature);
  const cardNameInputRef = useRef<HTMLInputElement | null>(null);
  // Unique per-field marker class so Maestro's inputText targets the tapped
  // field rather than the first input in the drawer (see useFieldTestClass).
  const fieldClass = useFieldTestClass();

  // ----- editable draft state (initialized fresh on each remount) -----
  const [cardName, setCardName] = useState(card.cardName);
  const [teamIds, setTeamIds] = useState<Array<Id<"teams">>>(
    card.teamOnCardIds ?? [],
  );
  const [attributes, setAttributes] = useState<string[]>(card.attributes ?? []);
  const [printRun, setPrintRun] = useState<string>(
    card.printRun != null ? String(card.printRun) : "",
  );
  const [cardVariation, setCardVariation] = useState(card.cardVariation ?? "");
  const [playerIds, setPlayerIds] = useState<Array<Id<"players">>>(
    card.playerIds ?? [],
  );
  const [listingTitle, setListingTitle] = useState(card.listingTitle ?? "");
  const [listingDescription, setListingDescription] = useState(
    card.listingDescription ?? "",
  );
  const [saving, setSaving] = useState(false);
  // pendingAction: which exit the operator requested while dirty. The inline
  // discard bar resolves it (Discard → run it; Keep editing → clear).
  const [pendingAction, setPendingAction] = useState<
    null | "close" | "prev" | "next"
  >(null);

  // ----- dirty tracking (features are excluded — they persist immediately) -
  const dirty =
    cardName !== card.cardName ||
    !arraysEqual(teamIds, card.teamOnCardIds ?? []) ||
    !arraysEqual(playerIds, card.playerIds ?? []) ||
    !arraysEqual(attributes, card.attributes ?? []) ||
    printRun !== (card.printRun != null ? String(card.printRun) : "") ||
    cardVariation !== (card.cardVariation ?? "") ||
    listingTitle !== (card.listingTitle ?? "") ||
    listingDescription !== (card.listingDescription ?? "");

  const toggleAttribute = (token: string) => {
    setAttributes((prev) =>
      prev.includes(token)
        ? prev.filter((t) => t !== token)
        : [...prev, token],
    );
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const parsedPrintRun = printRun.trim() === "" ? undefined : Number(printRun);
      await updateCard({
        id: card._id,
        cardName,
        teamOnCardIds: teamIds,
        playerIds,
        // Full-replacement: send the entire desired token array. Derive the
        // denormalized booleans from it so they can't drift (matches
        // fetchCardChecklist / commitCardChecklist semantics).
        attributes,
        // NEO-71: the embedded CardFeaturesEditor's Rookie checkbox writes
        // isRookie directly and can autosave between this panel's mount and
        // this Save click. OR (never AND-downgrade) so Save can still turn
        // isRookie on via the RC chip, but can never silently revert a
        // `true` the checkbox already set — `card` is the live reactive
        // prop, so it reflects the checkbox's write by the time Save fires.
        isRookie: attributes.includes("RC") || card.isRookie === true,
        isRelic: attributes.includes("RELIC"),
        ...(parsedPrintRun != null && !Number.isNaN(parsedPrintRun)
          ? { printRun: parsedPrintRun }
          : {}),
        cardVariation,
        // "" clears the stored value; undefined would leave it untouched.
        listingTitle,
        listingDescription,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // Guarded exit: if dirty, stash the requested action and surface the inline
  // discard confirm instead of leaving. Otherwise perform it immediately.
  const requestExit = (action: "close" | "prev" | "next") => {
    if (dirty) {
      setPendingAction(action);
      return;
    }
    runAction(action);
  };

  const runAction = (action: "close" | "prev" | "next") => {
    if (action === "close") onClose();
    else if (action === "prev") onPrev();
    else onNext();
  };

  const focusedInEditable = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    return (
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable
    );
  };

  // Focus the card-name input on mount (each remount = new card).
  useEffect(() => {
    cardNameInputRef.current?.focus();
  }, []);

  // Keyboard: Escape closes; Arrow Up/Down move card selection — both routed
  // through the dirty guard. Listening on document covers focus inside the
  // TeamPicker popover too. Arrows are ignored while typing in a field (so the
  // caret can move) and while the discard bar is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Escape is an explicit dismiss — discard and close immediately
        // (matches the old edit modal + the ticket's "Escape to close
        // panel"). If the discard confirm is showing, Escape dismisses it.
        if (pendingAction) {
          setPendingAction(null);
        } else {
          onClose();
        }
        return;
      }
      if (pendingAction) return;
      if (focusedInEditable()) return;
      if (e.key === "ArrowDown" && hasNext) {
        e.preventDefault();
        requestExit("next");
      } else if (e.key === "ArrowUp" && hasPrev) {
        e.preventDefault();
        requestExit("prev");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, pendingAction, hasPrev, hasNext]);

  // Read-only tokens we render but don't expose as toggles (preserved on save).
  const readOnlyTokens = useMemo(
    () =>
      attributes.filter(
        (t) => !(EDITABLE_ATTRIBUTES as readonly string[]).includes(t),
      ),
    [attributes],
  );

  const inheritedLevels = (ancestorChain ?? []).filter(
    (a) => LEVEL_LABEL[a.level],
  );

  const front = card.imageUrls?.front;
  const back = card.imageUrls?.back;
  const hasImages = Boolean(front || back);

  return createPortal(
    // NEO-71-74 QA fix: see BaseSetPicker.tsx for why this nested <Theme> is
    // needed — createPortal(document.body) escapes the root Theme's CSS scope.
    <Theme>
    <div className="fixed inset-0 z-50">
      {/* Backdrop. Clicking it requests close (dirty-guarded). The panel is a
          sibling layered above, so taps inside the panel never reach here —
          e.g. tapping the Card name input to dismiss the TeamPicker popover
          does not close the panel. */}
      <div
        className="absolute inset-0 bg-black/60"
        aria-hidden="true"
        onClick={() => requestExit("close")}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`card-detail-title-${card._id}`}
        className="absolute top-0 right-0 h-full w-full sm:w-[30rem] max-w-[95vw] bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 shadow-xl flex flex-col animate-slide-in-right"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center gap-2">
          <h2
            id={`card-detail-title-${card._id}`}
            className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1 truncate"
          >
            Card #{card.cardNumber}
            {card.isCustom && (
              <span className="ml-2 text-[10px] uppercase tracking-wide text-blue-500">
                Custom
              </span>
            )}
          </h2>
          <button
            onClick={() => requestExit("prev")}
            disabled={!hasPrev}
            aria-label="Previous card"
            title="Previous card (↑)"
            className="px-2 py-1 text-sm rounded text-gray-500 hover:text-[#00B7FF] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ↑
          </button>
          <button
            onClick={() => requestExit("next")}
            disabled={!hasNext}
            aria-label="Next card"
            title="Next card (↓)"
            className="px-2 py-1 text-sm rounded text-gray-500 hover:text-[#00B7FF] disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ↓
          </button>
          <button
            onClick={() => requestExit("close")}
            aria-label="Close card detail"
            title="Close (Esc)"
            className="px-2 py-1 text-lg leading-none rounded text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none"
          >
            ×
          </button>
        </div>

        {/* Scrollable body. No overflow clipping on the TeamPicker section is
            handled by giving the whole body a single scroll container; the
            popover renders within it. */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
          {/* Card name */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Card name
            </label>
            <input
              ref={cardNameInputRef}
              type="text"
              value={cardName}
              onChange={(e) => setCardName(e.target.value)}
              className={`${fieldClass("cardName")} w-full p-1.5 border rounded text-sm dark:bg-gray-700 dark:border-gray-600`}
              placeholder="Card name"
              aria-label="Card name"
            />
          </div>

          {/* Teams */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Teams
            </label>
            <TeamPicker value={teamIds} onChange={setTeamIds} sport={ancestorSport} />
          </div>

          {/* Per-card feature overrides (persists immediately via setCardFeature).
              Kept directly under Teams — matching the old inline edit modal — so
              the collapsed "Show features editor" toggle is above the fold and
              reachable without scrolling the drawer body. */}
          <div>
            <CardFeaturesEditor
              cardChecklistId={card._id}
              cardFeatures={card.features}
              ancestorSport={ancestorSport}
              cardIsRookie={card.isRookie}
            />
          </div>

          {/* Listing title + description (marketplace-agnostic) */}
          <div>
            <label className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              <span>Card title</span>
              <span
                className={
                  listingTitle.length > 80 ? "text-[#FF2EB3]" : "text-gray-400"
                }
              >
                {listingTitle.length} chars
              </span>
            </label>
            <input
              type="text"
              value={listingTitle}
              onChange={(e) => setListingTitle(e.target.value)}
              className={`${fieldClass("cardTitle")} w-full p-1.5 border rounded text-sm dark:bg-gray-700 dark:border-gray-600`}
              placeholder="Listing title reused across marketplaces"
              aria-label="Card title"
            />
            <p className="text-[10px] text-gray-400 mt-1">
              Stored once and reused by every marketplace listing.
            </p>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Card description
            </label>
            <textarea
              value={listingDescription}
              onChange={(e) => setListingDescription(e.target.value)}
              rows={3}
              className={`${fieldClass("cardDescription")} w-full p-1.5 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 resize-y`}
              placeholder="Listing description reused across marketplaces"
              aria-label="Card description"
            />
          </div>

          {/* Attributes */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Attributes
            </label>
            <div className="flex flex-wrap gap-1.5">
              {EDITABLE_ATTRIBUTES.map((token) => {
                const active = attributes.includes(token);
                return (
                  <button
                    key={token}
                    type="button"
                    aria-label={`Toggle ${token}`}
                    aria-pressed={active}
                    onClick={() => toggleAttribute(token)}
                    className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                      active
                        ? "bg-[#00D558] text-black border-[#00D558] font-semibold"
                        : "bg-transparent text-gray-500 border-gray-300 dark:border-gray-600 hover:border-[#00D558] hover:text-[#00D558]"
                    }`}
                  >
                    {ATTRIBUTE_LABEL[token]}
                  </button>
                );
              })}
              {readOnlyTokens.map((token) => (
                <span
                  key={token}
                  title="Set during marketplace reconciliation — not editable here"
                  className="text-xs px-2 py-0.5 rounded border bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-700"
                >
                  {token === "unmatched-bsc"
                    ? "SL only"
                    : token === "unmatched-sl"
                      ? "BSC only"
                      : token}
                </span>
              ))}
            </div>
          </div>

          {/* Print run / autograph. Autographed is the same features.autographed
              control CardFeaturesEditor uses elsewhere (via the shared
              CardFeatureRow), promoted to always-visible here instead of
              hidden behind "Show features" — this used to be a separate
              free-text autographType input with its own On-Card/Sticker/Cut
              vocabulary, disagreeing with this dropdown's None/On Card/
              Sticker/Label options. Removed in favor of one control. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
                Print run (/N)
              </label>
              <input
                type="number"
                value={printRun}
                onChange={(e) => setPrintRun(e.target.value)}
                className={`${fieldClass("printRun")} w-full p-1.5 border rounded text-sm dark:bg-gray-700 dark:border-gray-600`}
                placeholder="e.g. 99"
                aria-label="Print run"
                min={0}
              />
            </div>
            <CardFeatureRow
              feat={AUTOGRAPHED_FEATURE}
              cardValue={card.features?.autographed}
              cardIsRookie={undefined}
              onSave={async (value) => {
                await setCardFeature({
                  cardChecklistId: card._id,
                  key: "autographed",
                  value,
                });
              }}
              onSaveBoolean={async () => {}}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Variation
            </label>
            <input
              type="text"
              value={cardVariation}
              onChange={(e) => setCardVariation(e.target.value)}
              className={`${fieldClass("cardVariation")} w-full p-1.5 border rounded text-sm dark:bg-gray-700 dark:border-gray-600`}
              placeholder="e.g. Gold Refractor"
              aria-label="Card variation"
            />
          </div>

          {/* Players */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Players
            </label>
            <PlayerPicker
              value={playerIds}
              onChange={setPlayerIds}
              sport={ancestorSport}
            />
          </div>

          {/* Inherited from set (read-only). Per-card override of these levels
              is NEO-21's scope; here they're context only. */}
          {inheritedLevels.length > 0 && (
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
                Inherited from set
              </label>
              <dl className="rounded border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
                {inheritedLevels.map((lvl) => (
                  <div
                    key={lvl.level}
                    className="flex items-center justify-between px-2.5 py-1.5 text-xs"
                  >
                    <dt className="text-gray-400">{LEVEL_LABEL[lvl.level]}</dt>
                    <dd className="text-gray-500 dark:text-gray-400 truncate ml-3">
                      {lvl.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Images (bottom — display only; no fetch/upload here per the ticket) */}
          <div className="flex gap-3">
            {hasImages ? (
              <>
                {front && (
                  <img
                    src={front}
                    alt={`${card.cardName} front`}
                    className="h-40 w-auto rounded border border-gray-200 dark:border-gray-700 object-contain bg-gray-100 dark:bg-gray-900"
                  />
                )}
                {back && (
                  <img
                    src={back}
                    alt={`${card.cardName} back`}
                    className="h-40 w-auto rounded border border-gray-200 dark:border-gray-700 object-contain bg-gray-100 dark:bg-gray-900"
                  />
                )}
              </>
            ) : (
              <div className="h-40 w-28 rounded border border-dashed border-gray-300 dark:border-gray-600 flex items-center justify-center text-[10px] text-center text-gray-400 px-2">
                No image yet
              </div>
            )}
          </div>
        </div>

        {/* Footer: inline discard confirm when dirty-and-leaving, else actions */}
        {pendingAction ? (
          <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between gap-3 bg-amber-50 dark:bg-amber-900/20">
            <span className="text-xs text-gray-600 dark:text-gray-300">
              Discard unsaved changes?
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingAction(null)}
                aria-label="Keep editing"
                className="px-3 py-1.5 text-xs rounded bg-gray-600 text-white hover:bg-gray-700"
              >
                Keep editing
              </button>
              <button
                onClick={() => {
                  const action = pendingAction;
                  setPendingAction(null);
                  runAction(action);
                }}
                aria-label="Discard changes"
                className="px-3 py-1.5 text-xs rounded bg-[#FF2EB3] text-white hover:bg-[#FF2EB3]/85"
              >
                Discard changes
              </button>
            </div>
          </div>
        ) : (
          <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex gap-2 justify-end">
            <button
              onClick={onClose}
              aria-label="Cancel card edit"
              className="px-3 py-1.5 text-xs bg-gray-600 text-white rounded hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              aria-label="Save card edit"
              className="px-3 py-1.5 text-xs bg-[#00D558] text-black rounded hover:bg-[#00D558]/85 disabled:opacity-50 font-semibold"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
    </Theme>,
    document.body,
  );
}
