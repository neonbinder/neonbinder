import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Input } from "../primitives/Input";
import { Textarea } from "../primitives/Textarea";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { userFacingMessage } from "@/lib/errors/user-facing-message";
import type { Id } from "../../convex/_generated/dataModel";
import TeamPicker from "./TeamPicker";
import PlayerPicker from "./PlayerPicker";
import CardFeaturesEditor, { CardFeatureRow } from "./CardFeaturesEditor";
import { EXPECTED_FEATURES } from "../../convex/features/expectedFeatures";
import {
  ASPECT_VALUE_MAX,
  LISTING_TITLE_MAX,
  TitleFieldNote,
  TitleLengthAlert,
  TitleLengthMeter,
  titleLengthState,
} from "./TitleLengthMeter";
import { useTitlePreview } from "./useTitlePreview";
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
 * inherited-from-set hierarchy (sport→…→variant). The hierarchy levels stay
 * read-only: NEO-21 resolved "this card belongs somewhere else too" with the
 * additive "Also appears in" section below (cardCrossListings) rather than by
 * letting a card override its own home set, so `selectorOptionId` remains the
 * single source of truth for release year, SKU and provenance.
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
  /**
   * NEO-208 — team names an operator typed that no `teams` row exists for yet.
   *
   * Read-only here, and shown above the picker rather than folded into it: a
   * chip in `TeamPicker` is a real `teams._id` the rest of the product can act
   * on, and putting a bare string among them would be claiming a link that
   * does not exist. The drawer's job is to make the name VISIBLE (it rendered
   * nowhere before this ticket) and to say what will happen to it.
   *
   * Not part of this panel's draft state or dirty-tracking. It is retired by
   * the server, derived from a real team write — see `updateCard`, which
   * clears it in the same patch as a non-empty `teamOnCardIds`. So an operator
   * "replaces" a pending name by picking a team and saving; there is nothing
   * here for them to edit or delete directly.
   */
  pendingTeamNames?: string[];
  attributes?: string[];
  isRookie?: boolean;
  isRelic?: boolean;
  printRun?: number;
  cardVariation?: string;
  // NEO-189: the card this one varies, when it is a variation.
  variationOfCardId?: Id<"cardChecklist">;
  listingTitle?: string;
  /**
   * NEO-101: the auto-generated title did not fit and was cut at a word
   * boundary, so what is stored is not the whole card. Set at creation and
   * cleared server-side by any write of `listingTitle` — so an operator
   * rewriting the title clears it by construction, with no flag to remember.
   */
  listingTitleTruncated?: boolean;
  listingDescription?: string;
  imageUrls?: { front?: string; back?: string };
  // NEO-137: ref = marketplace card identity, src = slot on the parent row.
  platformData: {
    bsc?: { ref: string; src?: string };
    sportlots?: { ref: string; src?: string };
  };
  isCustom?: boolean;
  features?: Record<string, string>;
};

type AncestorLevel = { level: string; value: string };

type CardDetailPanelProps = {
  card: CardDetailCard;
  // Ancestor chain (sport→…→variant) already queried once in CardChecklist.
  ancestorChain?: Array<AncestorLevel>;
  ancestorSport?: string;
  /** NEO-96: sport-level selectorOptions row id, for the entity pickers. */
  ancestorSportId?: Id<"selectorOptions">;
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
  ancestorSportId,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: CardDetailPanelProps) {
  const updateCard = useMutation(api.selectorOptions.updateCard);
  const setCardFeature = useMutation(api.selectorOptions.setCardFeature);
  const setVariationParent = useMutation(
    api.selectorOptions.setCardVariationParent,
  );
  // NEO-189: the other cards in this checklist, so a variation can be pointed
  // at the one it varies. Convex dedupes same-arg queries, so this rides along
  // with the checklist the panel is already open inside.
  const siblingCards = useQuery(api.selectorOptions.getCardChecklist, {
    selectorOptionId: card.selectorOptionId,
  });
  const [parentError, setParentError] = useState<string | null>(null);
  const [parentNumber, setParentNumber] = useState("");
  // a11y: announced once a link/clear actually commits — see the effect below.
  // This is the ONLY feedback a screen reader gets for either action: there is
  // no Save step for this field (it writes immediately), and the visual swap
  // from input → static text (or back) is silent otherwise.
  const [parentStatus, setParentStatus] = useState<string | null>(null);
  const parentCard = useMemo(
    () =>
      card.variationOfCardId
        ? (siblingCards ?? []).find((c) => c._id === card.variationOfCardId)
        : undefined,
    [card.variationOfCardId, siblingCards],
  );

  // a11y: focus targets either side of the input ↔ static-text swap below.
  // Whichever element had focus when a link/clear commits gets removed from
  // the DOM (input unmounts on link, the Clear button unmounts on clear), and
  // an unmounted focused element drops focus to <body> with no further
  // warning — costly in a tool built around long keyboard-driven review
  // sessions. The effect below moves focus to the element that replaces it.
  const parentInputRef = useRef<HTMLInputElement | null>(null);
  const clearButtonRef = useRef<HTMLButtonElement | null>(null);
  // Tracks the previous linked state so the focus/announce effect only fires
  // on a real transition, not on this component's initial mount (every
  // remount — e.g. arrow-key nav to the next card — would otherwise steal
  // focus and announce a link that isn't new).
  const prevVariationOfIdRef = useRef(card.variationOfCardId);
  useEffect(() => {
    const prev = prevVariationOfIdRef.current;
    const curr = card.variationOfCardId;
    if (prev === curr) return;
    prevVariationOfIdRef.current = curr;
    if (curr) {
      requestAnimationFrame(() => clearButtonRef.current?.focus());
      // Reacting to an external system (the setVariationParent mutation
      // committing and this card's reactive query updating), not deriving
      // render state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setParentStatus(
        parentCard
          ? `Linked as a variation of #${parentCard.cardNumber}.`
          : "Linked.",
      );
    } else if (prev) {
      requestAnimationFrame(() => parentInputRef.current?.focus());
      setParentStatus("Variation link cleared.");
    }
    // parentCard intentionally omitted: it derives from curr + siblingCards,
    // and re-running this on every siblingCards tick would re-focus/re-announce
    // on unrelated reactive updates, not just on curr actually changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.variationOfCardId]);

  /**
   * Resolve a typed card number to a sibling and set (or clear) the link.
   *
   * An empty value clears. A number that matches nothing is reported rather
   * than silently ignored — a typo that quietly does nothing is worse than one
   * that says so.
   */
  const applyVariationParent = async (raw: string) => {
    setParentError(null);
    const wanted = raw.trim();
    try {
      if (!wanted) {
        await setVariationParent({ cardId: card._id });
        setParentNumber("");
        return;
      }
      const match = (siblingCards ?? []).find(
        (c) => c.cardNumber.toLowerCase() === wanted.toLowerCase(),
      );
      if (!match) {
        setParentError(`No card #${wanted} in this checklist.`);
        return;
      }
      await setVariationParent({ cardId: card._id, parentCardId: match._id });
      setParentNumber("");
    } catch (err) {
      // The mutation refuses self-parenting, cross-checklist parents and
      // nesting, and each refusal is a ConvexError carrying the reason. Read
      // `data`, never `.message`: production redacts a plain Error to "Server
      // Error", and even a surviving message arrives wrapped in
      // "[CONVEX M(...)] [Request ID: ...]" noise.
      setParentError(
        userFacingMessage(err, "Could not set the parent card"),
      );
    }
  };
  // NEO-21: every guest set this card is cross-listed into. A property of the
  // card itself, so it renders whether the panel was opened from the card's
  // home checklist or from one of its guest checklists.
  const crossListings = useQuery(api.selectorOptions.getCrossListingsForCard, {
    cardChecklistId: card._id,
  });
  const removeCrossListing = useMutation(
    api.selectorOptions.removeCrossListing,
  );
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

  // ----- NEO-101 length limits -----------------------------------------
  // The title is the ONLY field here with a hard cap: an over-length title is
  // rejected by the marketplace at listing time rather than trimmed, and this
  // panel plus the attention walker are the only two places an operator can
  // write one. `updateCard` enforces the same constant server-side, so this is
  // a courtesy that explains the refusal early, not the enforcement itself.
  const titleState = titleLengthState(listingTitle.length, LISTING_TITLE_MAX, true);
  const variationOverCap = cardVariation.length > ASPECT_VALUE_MAX;
  const uid = useId();
  const titleAlertId = `${uid}-title-limit`;
  const variationAlertId = `${uid}-variation-limit`;
  const titleDirty = listingTitle !== (card.listingTitle ?? "");

  // Regenerate. Lazy: no preview is fetched until the operator asks for one,
  // because the drawer opens for every card they arrow through.
  const preview = useTitlePreview(card._id, setListingTitle);

  const toggleAttribute = (token: string) => {
    setAttributes((prev) =>
      prev.includes(token)
        ? prev.filter((t) => t !== token)
        : [...prev, token],
    );
  };

  const handleSave = async () => {
    // Guard as well as the button's aria-disabled: the button stays in the tab
    // order while over the cap (so the reason is reachable by keyboard), which
    // means it stays activatable too.
    if (saving || titleState.over) return;
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
        // Trimmed here as well as server-side so what the operator sees after a
        // save is what they saved — a trailing space is otherwise invisible and
        // makes the panel look dirty the moment it reopens.
        listingTitle: listingTitle.trim(),
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
            <Input
              bare
              ref={cardNameInputRef}
              type="text"
              value={cardName}
              onChange={(e) => setCardName(e.target.value)}
              className={`${fieldClass("cardName")} w-full p-1.5 text-sm`}
              placeholder="Card name"
              aria-label="Card name"
            />
          </div>

          {/* Teams */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Teams
            </label>
            {/* NEO-208 — unresolved typed names, above the picker and
                read-only. TEXT ONLY, never an anchor or a button: there is no
                action to offer. The name is retired server-side when a real
                team is saved (updateCard clears `pendingTeamNames` in the same
                patch as a non-empty `teamOnCardIds`), so the two things that
                can happen to it are stated in the hint rather than wired to a
                control the operator would have to find. */}
            {(card.pendingTeamNames?.length ?? 0) > 0 && (
              <div className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                <div className="flex flex-wrap gap-x-2">
                  {/* Index-qualified key, not the name itself: `pendingTeamNames`
                      is not deduplicated, and legacy rows written before
                      NEO-208 can carry the same typed name twice. A bare
                      `key={name}` then hands React duplicate sibling keys —
                      a dev-mode warning, and the second entry silently
                      dropped/mis-reconciled in the render. This list is
                      read-only and never reordered, so the index is a stable
                      identity here. */}
                  {card.pendingTeamNames!.map((name, index) => (
                    <span key={`${index}-${name}`}>
                      {name}{" "}
                      {/* a11y: this MUST stay `text-gray-500 dark:text-gray-400`
                          (the container's own pair, two lines up) and never the
                          reverse — `text-gray-400 dark:text-gray-500` measures
                          2.54:1 on this panel's light-mode `bg-white` and 3.04:1
                          on its `dark:bg-gray-800`, both under WCAG 1.4.3's
                          4.5:1 floor for normal text (script-verified). The
                          reversed pair was in here before; if you're tempted to
                          dim this relative to the name, use weight/size, not a
                          lighter gray in light mode. */}
                      <span className="text-gray-500 dark:text-gray-400">
                        (unconfirmed)
                      </span>
                    </span>
                  ))}
                </div>
                {/* Same a11y note as above — text-gray-500 (light) /
                    text-gray-400 (dark) is the pair that clears 4.5:1 against
                    this panel's bg-white / dark:bg-gray-800; the reverse fails
                    both. */}
                <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                  Typed on the card before it was linked — resolves at the next
                  sync, or pick a team to replace it.
                </p>
              </div>
            )}
            <TeamPicker value={teamIds} onChange={setTeamIds} sportId={ancestorSportId} />
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

          {/* Listing title + description (marketplace-agnostic).

              NEO-101: the header row is a <div>, not the <label> it used to be,
              because Regenerate lives in it and a <button> inside a <label> is
              a click-target fight. Nothing is lost: the label carried no
              `htmlFor` and never wrapped the input, so the field's accessible
              name has always come from its `aria-label` — which is also the
              handle every Maestro flow taps (`id: "Card title"`), so it and the
              field's position in the drawer are both unchanged. */}
          <div>
            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              <span>Card title</span>
              <span className="flex items-center gap-2">
                <TitleLengthMeter length={listingTitle.length} soft />
                <button
                  type="button"
                  onClick={() => preview.request(titleDirty)}
                  // a11y (2.5.3, audit fix): the visible text also becomes
                  // "Rebuilding…"/"Replace?", neither a substring of a fully
                  // static name. "Replace?" is kept as the fixed string on
                  // purpose — this exact query
                  // (`getByLabelText("Regenerate card title")`) is asserted
                  // while `confirming` is true in
                  // CardDetailPanel.titleLimits.test.tsx, so changing it here
                  // would desync from that locked test. The confirm text
                  // below (already wired via aria-describedby) covers the
                  // gap for screen-reader users.
                  aria-label={
                    preview.loading ? "Regenerate card title — rebuilding" : "Regenerate card title"
                  }
                  aria-describedby={
                    preview.confirming ? `${uid}-regen-confirm` : undefined
                  }
                  // a11y (1.4.3, audit fix): #00B7FF alone measures 2.28:1
                  // against this drawer's light-mode `bg-white` (fails
                  // 4.5:1) — this panel is genuinely bi-themed
                  // (`bg-white dark:bg-gray-800`), unlike TitleFixer's
                  // always-dark walker dialog. #0369A1 measures 5.93:1
                  // against white; #00B7FF unchanged for dark mode (6.44:1
                  // against gray-800).
                  className="rounded px-1 uppercase tracking-wide text-[#0369A1] dark:text-[#00B7FF] underline decoration-dotted hover:text-black dark:hover:text-white focus:outline-none focus:ring-1 focus:ring-[#00B7FF]"
                >
                  {preview.loading
                    ? "Rebuilding…"
                    : preview.confirming
                      ? "Replace?"
                      : "Regenerate"}
                </button>
              </span>
            </div>
            <Input
              bare
              type="text"
              value={listingTitle}
              onChange={(e) => {
                setListingTitle(e.target.value);
                // Typing is the operator changing their mind about replacing
                // the draft — drop the pending confirm rather than leaving a
                // second click armed against text they just wrote.
                preview.cancelConfirm();
              }}
              // No maxLength, deliberately: it would silently swallow the tail
              // of a pasted title, and an over-length title the operator cannot
              // SEE is one they cannot fix. Let it overflow and say so.
              className={`${fieldClass("cardTitle")} w-full p-1.5 text-sm`}
              placeholder="Listing title reused across marketplaces"
              aria-label="Card title"
              aria-invalid={titleState.over || undefined}
              aria-describedby={titleState.over ? titleAlertId : undefined}
            />
            <TitleLengthAlert id={titleAlertId} length={listingTitle.length} />
            {preview.confirming && (
              <p
                id={`${uid}-regen-confirm`}
                role="status"
                aria-atomic="true"
                // a11y (1.4.3, audit fix): same light/dark split as the
                // Regenerate button above, same reason — this panel is
                // bi-themed and #00B7FF alone fails 4.5:1 against its
                // light-mode `bg-white`.
                className="mt-1 text-[10px] text-[#0369A1] dark:text-[#00B7FF]"
              >
                Regenerate again to replace the title you have typed.
              </p>
            )}
            {card.listingTitleTruncated && (
              <TitleFieldNote>Auto title was cut short — rewrite it</TitleFieldNote>
            )}
            {preview.dropped.length > 0 && (
              <TitleFieldNote>
                Left out to fit: {preview.dropped.join(", ")}
              </TitleFieldNote>
            )}
            {preview.chips.length > 0 && (
              // What the title was built from. Plain text, never links: a card's
              // variation text is operator- and marketplace-sourced content, so
              // it is something to read, not something to follow.
              <ul
                aria-label="Title built from"
                className="mt-1.5 flex flex-wrap gap-1"
              >
                {preview.chips.map((chip, idx) => (
                  <li
                    key={`${chip.label}-${chip.value}-${idx}`}
                    // a11y (1.4.3, audit fix): this exact chip className,
                    // unchanged, is also what TitleFixer.tsx renders — safe
                    // there (always-dark surface) but not here. Composited
                    // over this panel's light-mode `bg-white`, the original
                    // `bg-gray-800/60 text-gray-200` measured 3.27:1 (fails
                    // 4.5:1) and the label's `text-gray-400` measured 1.56:1
                    // (fails badly). Light-mode values below measure 9.36:1
                    // / 6.87:1 against their own `bg-gray-100`; dark-mode
                    // values are the untouched originals.
                    className="rounded-full border border-gray-300 bg-gray-100 dark:border-gray-700 dark:bg-gray-800/60 px-2 py-0.5 text-[10px] text-gray-700 dark:text-gray-200"
                  >
                    <span className="mr-1 uppercase tracking-wide text-gray-600 dark:text-gray-400">
                      {chip.label}
                    </span>
                    {chip.value}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-gray-400 mt-1">
              Stored once and reused by every marketplace listing.
            </p>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Card description
            </label>
            <Textarea
              bare
              value={listingDescription}
              onChange={(e) => setListingDescription(e.target.value)}
              rows={3}
              className={`${fieldClass("cardDescription")} w-full p-1.5 text-sm resize-y`}
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
              <Input
                bare
                type="number"
                value={printRun}
                onChange={(e) => setPrintRun(e.target.value)}
                className={`${fieldClass("printRun")} w-full p-1.5 text-sm`}
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
            {/* NEO-101: warn-only. This is the field most likely to be sent as
                a marketplace item-specific value, which caps at 65 — but which
                NB field maps to which aspect is not settled, so the counter
                tells the truth and the save goes through either way. */}
            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              <span>Variation</span>
              <TitleLengthMeter
                length={cardVariation.length}
                max={ASPECT_VALUE_MAX}
              />
            </div>
            <Input
              bare
              type="text"
              value={cardVariation}
              onChange={(e) => setCardVariation(e.target.value)}
              className={`${fieldClass("cardVariation")} w-full p-1.5 text-sm`}
              placeholder="e.g. Gold Refractor"
              aria-label="Card variation"
              aria-describedby={variationOverCap ? variationAlertId : undefined}
            />
            <TitleLengthAlert
              id={variationAlertId}
              length={cardVariation.length}
              max={ASPECT_VALUE_MAX}
              what="Variation"
              blocking={false}
            />
          </div>

          {/* NEO-189 — which card this one is a variation OF.

              The import derives this from the card number (BSC suffixes it,
              SportLots brackets the description), but that cannot cover a
              variation whose number shares no stem with its parent, or a set
              being built by hand. This is the escape hatch, and the only way a
              custom set gets variations at all.

              A CARD NUMBER, not a picker. A checklist runs to hundreds of
              cards, so a dropdown would be hundreds of options to scroll and
              toggle pills are not an option at that size. The operator already
              thinks "this is a variation of #1" — typing 1 is both faster and
              how they hold the problem. It is also keyboard-first, which this
              app requires.

              A choice made here is marked manual and the next sync leaves it
              alone — see setCardVariationParent. */}
          <div>
            {/* a11y: no `htmlFor` here — the Input primitive deliberately
                never emits its own `id` (see components/primitives/Input.tsx)
                because Maestro's resource-id falls back to aria-label when no
                id is set, and `.maestro/flows/set-selector/
                variation-link-group-and-unlink.yaml` targets this exact field
                by its aria-label text. Adding an id to satisfy `htmlFor` would
                switch Maestro's resource-id to that id and break the flow, so
                this label stays a purely visual caption — same pattern every
                other field in this panel already uses — and the input's own
                `aria-label` below carries the accessible name instead. */}
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Variation of
            </label>
            {parentCard ? (
              <div className="flex items-center gap-2">
                <span className="text-sm flex-1 truncate">
                  #{parentCard.cardNumber} {parentCard.cardName}
                </span>
                <button
                  ref={clearButtonRef}
                  type="button"
                  onClick={() => void applyVariationParent("")}
                  className="text-xs px-2 py-1 rounded border border-gray-600 hover:bg-gray-700"
                  aria-label="Clear variation parent"
                >
                  Clear
                </button>
              </div>
            ) : (
              <Input
                bare
                ref={parentInputRef}
                type="text"
                value={parentNumber}
                onChange={(e) => setParentNumber(e.target.value)}
                onBlur={() => void applyVariationParent(parentNumber)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void applyVariationParent(parentNumber);
                  }
                }}
                className="w-full p-1.5 text-sm"
                placeholder="Card number, e.g. 1"
                aria-label="Card number this one is a variation of"
              />
            )}
            {parentError && (
              // a11y: NOT the brand `#FF2EB3` used for errors/destructive
              // actions elsewhere in this file (e.g. the Cancel/Discard
              // buttons) — measured contrast for that hex against this
              // panel's own background is 3.34:1 on white and 4.4:1 on
              // dark:bg-gray-800, both under WCAG 1.4.3's 4.5:1 minimum for
              // normal-size text. This is a systemic app-wide issue (the same
              // hex is used as text-on-light elsewhere already), out of scope
              // to fix everywhere here, but an *error message* specifically
              // has to be legible, so this instance uses a darkened/lightened
              // variant in the same hue: 5.55:1 on white, 5.87:1 on
              // dark:bg-gray-800.
              <p className="text-xs text-[#C2178A] dark:text-[#FF6FCB] mt-1" role="alert">
                {parentError}
              </p>
            )}
            {/* a11y: the only feedback a screen reader gets that the link
                (or clear) actually committed — see the effect that sets this
                and moves focus, above. `aria-live="polite"` rather than
                `role="alert"` because this is a success confirmation, not
                something demanding interruption. */}
            {parentStatus && !parentError && (
              <p
                className="text-xs text-gray-600 dark:text-gray-300 mt-1"
                role="status"
                aria-live="polite"
              >
                {parentStatus}
              </p>
            )}
          </div>

          {/* Players */}
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Players
            </label>
            <PlayerPicker
              value={playerIds}
              onChange={setPlayerIds}
              sportId={ancestorSportId}
            />
          </div>

          {/* Inherited from set (read-only) — where this card was printed.
              Cross-release membership is additive and lives in "Also appears
              in" below; these levels are never overridden per-card. */}
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

          {/* NEO-21: guest sets this card also completes. Unlinking here drops
              only the junction row — the card itself stays in the set it was
              printed in, which is why this is separate from any delete. */}
          {crossListings && crossListings.length > 0 && (
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
                Also appears in
              </label>
              <ul className="rounded border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
                {crossListings.map((link) => (
                  <li
                    key={link._id}
                    className="flex items-center justify-between px-2.5 py-1.5 text-xs gap-3"
                  >
                    <span className="text-gray-500 dark:text-gray-400 truncate">
                      {link.setLabel}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void removeCrossListing({ crossListingId: link._id });
                      }}
                      aria-label={`Unlink card from ${link.setLabel}`}
                      title="Remove this card from that set — the card itself is not deleted"
                      className="px-2 py-0.5 rounded text-[#FF2EB3] hover:bg-[#FF2EB3]/10 border border-transparent hover:border-[#FF2EB3]/50 shrink-0"
                    >
                      Unlink
                    </button>
                  </li>
                ))}
              </ul>
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
              // aria-disabled rather than `disabled` for the over-cap case:
              // native disabled drops the button out of the tab order, and the
              // alert explaining WHY it is inert is reached through this
              // button's aria-describedby — so disabling it natively would
              // hide the reason from exactly the person who needs it (the
              // NEO-189 stranding finding). `saving` keeps the native
              // attribute: that state is momentary and self-explanatory.
              aria-disabled={titleState.over || undefined}
              aria-describedby={titleState.over ? titleAlertId : undefined}
              aria-label="Save card edit"
              className={`px-3 py-1.5 text-xs bg-[#00D558] text-black rounded hover:bg-[#00D558]/85 disabled:opacity-50 font-semibold ${
                titleState.over ? "opacity-50 cursor-not-allowed" : ""
              }`}
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
