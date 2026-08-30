import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";
import CardChecklistItem from "./CardChecklistItem";
import { compareCardNumbers } from "@/lib/cards/card-number";
import CardDetailPanel from "./CardDetailPanel";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import NeonButton from "../modules/NeonButton";
import EntityReviewWizard from "./EntityReviewWizard";
import CardPairingModal, { type PairingCard } from "./CardPairingModal";
import ChecklistSourceFilter, {
  Chip,
  type SourceChips,
  type SourceFilter,
} from "./ChecklistSourceFilter";
import CrossListingImportModal from "./CrossListingImportModal";
import { Input } from "../primitives/Input";


type CardChecklistProps = {
  variantId: GenericId<"selectorOptions">;
  // NEO-6: source-set chip data + per-card label maps derived in the
  // parent SetSelector from the variant row. Lifted out so this component
  // no longer needs its own useQuery for the row, which kept the
  // chip-data hooks above the `if (!cards) return Loading` early-return
  // and previously violated the Rules of Hooks.
  sourceChips: SourceChips;
  sourceLabelMaps: {
    bsc: Record<string, string>;
    sportlots: Record<string, string>;
  };
};

/**
 * The CONFIRMED card set, held between `resolveChecklistEntities` (action) and
 * `commitCardChecklist` (mutation) so the operator can review new
 * players/teams in EntityReviewWizard before the entities are persisted.
 *
 * These are the cards the operator paired and kept, handed over by
 * `CardPairingModal` — not the fetch's output. (It used to be the fetch's
 * output, hence the name; the fetch no longer returns cards at all.)
 *
 * `batchId` is present whenever there are unknowns — it's what the wizard
 * subscribes to (entityReviewQueue.getBatch) and what commitCardChecklist
 * reads back to resolve each name's create/link decision.
 */
type FetchPreview = {
  sportId: Id<"selectorOptions">;
  batchId?: string;
  cards: Array<{
    cardNumber: string;
    cardName: string;
    team?: string;
    teams?: string[];
    players?: string[];
    attributes?: string[];
    isRookie?: boolean;
    isRelic?: boolean;
    printRun?: number;
    autographType?: string;
    cardVariation?: string;
    // NEO-137: WIRE shape from fetchCardChecklist — ref plus the marketplace
    // SET it came from. commitCardChecklist resolves setId to a slot on this
    // card's parent row.
    platformData: {
      bsc?: { ref: string; setId?: string };
      sportlots?: { ref: string; setId?: string };
    };
    unmatched?: "bsc" | "sl";
  }>;
  unknownPlayers: string[];
  unknownTeams: string[];
};

export default function CardChecklist({
  variantId,
  sourceChips,
  sourceLabelMaps,
}: CardChecklistProps) {
  const cards = useQuery(api.selectorOptions.getCardChecklist, {
    selectorOptionId: variantId,
  });
  // Names the set in the pairing dialog's header. That dialog is modal and can
  // be hundreds of rows long — without this it says only "Match Cards" and an
  // operator who steps away has no way to tell which set they came back to.
  // Convex dedupes same-arg queries, so this costs no extra round trip.
  const variantRow = useQuery(api.selectorOptions.getSelectorOptionById, {
    id: variantId,
  });
  // NEO-26: walk the ancestor chain once at this layer so every
  // CardChecklistItem below can hand the resolved sport to TeamPicker
  // (typeahead filter) + CardFeaturesEditor (applicability filter).
  // Convex deduplicates same-arg queries, so the additional hook here
  // does not cost a round trip beyond what the existing query graph
  // already pays.
  const ancestorChain = useQuery(api.selectorOptions.getAncestorChain, {
    id: variantId,
  });
  const ancestorSport = ancestorChain?.find((c) => c.level === "sport")?.value;
  // NEO-96: the row ID, which is what teams/players now reference. The chain
  // already carried `_id` — this line is the only place it used to be thrown
  // away, which is why the pickers ended up matching on a display string.
  const ancestorSportId = ancestorChain?.find((c) => c.level === "sport")?._id;
  const fetchChecklist = useAction(api.selectorOptions.fetchCardChecklist);
  // NEO-195: the fetch publishes candidates as they become reviewable, so the
  // modal fills in live instead of waiting ~80s for the whole thing.
  const liveCandidates = useQuery(
    api.checklistCandidates.getReadyCandidates,
    { selectorOptionId: variantId },
  );
  const discardCandidates = useMutation(
    api.checklistCandidates.discardCandidates,
  );
  const commitChecklist = useMutation(api.selectorOptions.commitCardChecklist);
  const resolveEntities = useAction(
    api.selectorOptions.resolveChecklistEntities,
  );
  const addCustomCard = useMutation(api.selectorOptions.addCustomCard);

  const [syncing, setSyncing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  // NEO-36: the add-card form fields are UNCONTROLLED (refs, read at submit)
  // rather than controlled React state. CardChecklist re-renders on every
  // reactive getCardChecklist update; under parallel-worker load those
  // externally-triggered re-renders contend with — and reset — controlled
  // inputs, intermittently wiping the last-typed field (the player) before it
  // commits to state, so handleAddCard submitted the card without it. React
  // never reconciles an uncontrolled input's value, so the DOM holds exactly
  // what the user typed and handleAddCard reads it directly at submit —
  // "what you see is what you submit". The Players field carries comma-
  // separated names forwarded to addCustomCard.players → pendingPlayerNames →
  // the UnknownEntitiesDialog on the next fetch.
  const cardNumberRef = useRef<HTMLInputElement>(null);
  const cardNameRef = useRef<HTMLInputElement>(null);
  const teamRef = useRef<HTMLInputElement>(null);
  const playersRef = useRef<HTMLInputElement>(null);
  // Unique per-field marker class so Maestro's inputText targets the tapped
  // add-card field, not the first input (see useFieldTestClass).
  const fieldClass = useFieldTestClass();
  const [pendingPreview, setPendingPreview] = useState<FetchPreview | null>(null);
  /**
   * NEO-137/NEO-195 — is a pairing review open?
   *
   * The CARDS are not held here. They live in `checklistCandidates` and arrive
   * on the `getReadyCandidates` subscription; this is only the session flag
   * that says the operator is reviewing them. It replaces the `pendingPairing`
   * state that used to hold a whole second copy of the fetch result — see the
   * note on `streamedPairing` below.
   *
   * Distinct from `fetchInFlight`, which ends when the action resolves. This
   * one outlives the fetch: the dialog stays open until the operator confirms
   * or cancels.
   */
  const [pairingOpen, setPairingOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>({
    bsc: null,
    sportlots: null,
  });
  // NEO-25: which card (if any) is open in the detail panel. Tracked by id —
  // sortedCards re-sorts on every reactive update, so an index would silently
  // point at a different card after any list mutation.
  const [selectedCardId, setSelectedCardId] =
    useState<Id<"cardChecklist"> | null>(null);
  // NEO-21: let the operator collapse the checklist back to just this set's
  // own cards. Local to this component — nothing above needs it.
  const [hideCrossListed, setHideCrossListed] = useState(false);
  const [showCrossListingModal, setShowCrossListingModal] = useState(false);

  // Reset filter + close the detail panel when the variant changes — chips and
  // selection for one variant don't apply to another.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset-on-prop-change: one variant's chips and selection do not apply to another
    setSourceFilter({ bsc: null, sportlots: null });
    setSelectedCardId(null);
    setHideCrossListed(false);
    setPairingOpen(false);
  }, [variantId]);

  // Virtuoso scroll handle + a one-shot flag so when the user adds a card
  // via the form, the just-added row is scrolled into view. New cards sort
  // to the end of the list (sortOrder = max + 1), and Virtuoso only renders
  // rows in/near the viewport — without this the user (and Maestro) would
  // see no visible feedback after submit. Cleared once `cards` length has
  // grown.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const newCardIdRef = useRef<Id<"cardChecklist"> | null>(null);
  const prevCardCountRef = useRef(0);
  // NEO-195: true from the moment a sync starts until the action resolves.
  // Distinct from `syncing`, which also covers the commit phase.
  const [fetchInFlight, setFetchInFlight] = useState(false);
  // NEO-195 — which sync run is current. Bumped whenever the operator cancels,
  // so a run whose result arrives afterwards knows it was abandoned.
  //
  // Streaming made this necessary. Before it, Cancel could only happen AFTER
  // the action had already resolved, so nothing was in flight to come back.
  // Now the modal opens on the first ready candidate — seconds in — and Cancel
  // lands mid-fetch. Without a guard the action resolves ~70s later and
  // unconditionally re-opens the dialog over the full result, overwriting
  // "Sync cancelled — no cards saved.": an operator who declined a sync and
  // walked away returns to an open Confirm on a checklist they had refused.
  //
  // A ref, not state: the check runs inside an async closure that captured its
  // own render's values, which is exactly where a state read would be stale.
  const syncGenerationRef = useRef(0);

  /**
   * Three-phase pipeline (NEO-137 moved pairing to the front):
   *   1. fetchChecklist → publishes three buckets of CANDIDATES to
   *      `checklistCandidates` as it reconciles them, and answers with a
   *      count and a status message. No NB card exists yet, and the cards
   *      themselves arrive on the `getReadyCandidates` subscription rather
   *      than in this promise (NEO-195).
   *   2. CardPairingModal → operator confirms pairs and keeps any deliberate
   *      single-marketplace card. Everything else is discarded, which is what
   *      keeps a shared SportLots set's sibling-owned cards from being
   *      invented under this row.
   *   3. resolveChecklistEntities on the CONFIRMED set → if unknowns, the
   *      review wizard runs → commit.
   *
   * Entity/Wikidata work deliberately happens AFTER pairing: creating players
   * and teams for candidates the operator is about to discard would enrich
   * data for cards that never exist.
   */
  const handleSync = async () => {
    // NEO-96: the sport row every downstream step keys on. It used to ride
    // back on the fetch action's return; the client walks the same ancestor
    // chain for its own pickers, so reading it here removes a third copy of
    // one fact rather than adding a lookup. Checked BEFORE the fetch: an
    // orphaned chain used to burn two live marketplace round-trips and then
    // report the card counts of a sync that could not proceed.
    if (!ancestorSportId) {
      setSyncMessage(
        "Cannot sync — this row has no sport ancestor, so cards cannot be attributed to a sport.",
      );
      return;
    }
    const generation = ++syncGenerationRef.current;
    const abandoned = () => syncGenerationRef.current !== generation;
    setSyncing(true);
    // NEO-195: opens the modal on the first streamed candidates, and gates
    // Confirm until the action resolves — reviewing early is the point,
    // committing a partial checklist is not.
    setFetchInFlight(true);
    setPairingOpen(true);
    setSyncMessage(null);
    try {
      const result = await fetchChecklist({ selectorOptionId: variantId });
      // Cancelled while the fetch was still running: leave the operator's own
      // message standing and drop the result on the floor.
      if (abandoned()) return;
      if (!result.success) {
        setPairingOpen(false);
        setSyncMessage(result.message);
        await discardCandidates({ selectorOptionId: variantId });
        return;
      }
      if (result.candidateCount === 0) {
        // A custom subtree has no marketplace cards at all, so there is
        // nothing to pair. Showing an empty pairing dialog would be a step
        // the operator can only click through — go straight to entity
        // resolution, which is where a custom card's own pendingPlayerNames
        // surface.
        //
        // Read off the action's own count, NOT off `liveCandidates`: the
        // subscription's value at this instant may still predate the batch
        // write, and mistaking a not-yet-delivered batch for an empty one
        // would commit an empty checklist over a real set.
        setPairingOpen(false);
        await handlePairingConfirm({ cards: [] });
        return;
      }
      setSyncMessage(result.message);
    } catch (error) {
      // Same abandonment rule as the resolved path: a cancelled run that
      // rejects afterwards must not overwrite "Sync cancelled — no cards
      // saved." with its own failure. The action converts its own errors into
      // `{ success: false }`, so reaching here means the CALL failed (network,
      // auth) and whatever it had published is a partial batch nobody should
      // be offered — close the review rather than leaving it confirmable.
      if (abandoned()) return;
      setPairingOpen(false);
      setSyncMessage(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      // Only the CURRENT run may clear these — a superseded run finishing later
      // would otherwise unlock Confirm on whatever is open now.
      if (!abandoned()) {
        setSyncing(false);
        setFetchInFlight(false);
      }
    }
  };

  /**
   * Operator confirmed the pairing. Only now do the confirmed cards become
   * candidates for entity resolution and commit.
   */
  const handlePairingConfirm = async (result: { cards: PairingCard[] }) => {
    // Guarded again rather than trusted from `handleSync`: this is also the
    // modal's own onConfirm, which can fire minutes later — long enough for
    // the ancestor-chain subscription to have changed under it. Says so out
    // loud, because the operator has just pressed Confirm and a bare `return`
    // would read as the button doing nothing.
    if (!ancestorSportId) {
      setSyncMessage(
        "Cannot save — this row has no sport ancestor, so cards cannot be attributed to a sport.",
      );
      return;
    }
    const sportId = ancestorSportId;
    setPairingOpen(false);
    setCommitting(true);
    try {
      const { unknownPlayers, unknownTeams, batchId } = await resolveEntities({
        selectorOptionId: variantId,
        sportId,
        cards: result.cards,
      });
      const preview: FetchPreview = {
        sportId,
        batchId,
        cards: result.cards,
        unknownPlayers,
        unknownTeams,
      };
      if (unknownPlayers.length === 0 && unknownTeams.length === 0) {
        await runCommit(preview);
      } else {
        // Stash preview; the review wizard handles the rest.
        setPendingPreview(preview);
        setSyncMessage(
          `${unknownPlayers.length} new players + ${unknownTeams.length} new teams need confirmation`,
        );
      }
    } catch (error) {
      setSyncMessage(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setCommitting(false);
    }
  };

  const runCommit = async (preview: FetchPreview) => {
    setCommitting(true);
    try {
      const result = await commitChecklist({
        selectorOptionId: variantId,
        sportId: preview.sportId,
        cards: preview.cards,
        batchId: preview.batchId,
      });
      // NEO-92: no more "enriching in background" note — every created
      // player/team was already enriched during the review wizard, before
      // this commit ran.
      setSyncMessage(`Saved ${result.count} cards.`);
      // NEO-195: the candidates have been promoted into cardChecklist, so the
      // staging rows have done their job. Dropping them here rather than
      // leaving them for the next fetch's clear-stale step keeps the table
      // empty between syncs.
      await discardCandidates({ selectorOptionId: variantId });
    } catch (error) {
      setSyncMessage(
        `Commit failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setCommitting(false);
    }
  };

  const handleWizardConfirm = async () => {
    if (!pendingPreview) return;
    await runCommit(pendingPreview);
    setPendingPreview(null);
  };

  const handleAddCard = async () => {
    // Read the live DOM values at submit (uncontrolled inputs) — see NEO-36
    // note above. This is immune to re-render timing: the value submitted is
    // exactly what the field shows.
    const cardNumber = cardNumberRef.current?.value.trim() ?? "";
    if (!cardNumber) return;
    const players = (playersRef.current?.value ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    const teamTrimmed = (teamRef.current?.value ?? "").trim();
    const cardName = (cardNameRef.current?.value ?? "").trim();
    try {
      const newId = await addCustomCard({
        selectorOptionId: variantId,
        cardNumber,
        cardName: cardName || `Card #${cardNumber}`,
        // NEO-26: legacy `team: string` arg removed. The team string
        // is surfaced via `teams` → pendingTeamNames → UnknownEntitiesDialog
        // confirmation on the next sync, which materializes a teams
        // entity link via `teamOnCardIds[]`.
        ...(players.length > 0 ? { players } : {}),
        ...(teamTrimmed ? { teams: [teamTrimmed] } : {}),
      });
      // Closing the form unmounts it; the uncontrolled inputs reset to empty
      // on the next open, so no manual field clearing is needed.
      setShowAddForm(false);
      newCardIdRef.current = newId;
    } catch (error) {
      console.error("Failed to add card:", error);
    }
  };

  // After the addCustomCard mutation resolves, Convex's reactive query
  // refreshes `cards` with the new row. The new card's position in the
  // sorted list is NOT necessarily the last index — addCustomCard calls
  // restampCardChecklistSortOrders which slots the card by natural
  // cardNumber order. Find the new card by id and scroll Virtuoso to it.
  // "center" keeps the row away from the sticky binder-header at y≈84,
  // where Maestro's bounds-then-tap window races Virtuoso's height
  // recompute (edit-and-delete-card.yaml regression).
  useEffect(() => {
    const count = cards?.length ?? 0;
    const targetId = newCardIdRef.current;
    if (targetId && count > prevCardCountRef.current && cards) {
      const idx = cards.findIndex((c) => c._id === targetId);
      if (idx >= 0) {
        // The data prop on Virtuoso below is sortedCards, so the scroll index
        // has to be computed against the SAME ordering. NEO-21 changed that
        // ordering from sortOrder to natural card-number order; leaving this
        // on sortOrder would scroll to whatever row happened to sit at the
        // old index.
        const sortedIdx = [...cards]
          .sort((a, b) => compareCardNumbers(a.cardNumber, b.cardNumber))
          .findIndex((c) => c._id === targetId);
        if (sortedIdx >= 0) {
          requestAnimationFrame(() => {
            virtuosoRef.current?.scrollToIndex({
              index: sortedIdx,
              align: "center",
              behavior: "auto",
            });
          });
        }
        newCardIdRef.current = null;
      }
    }
    prevCardCountRef.current = count;
  }, [cards?.length, cards]);

  // Memoize the filtered/sorted view so unrelated re-renders (this component
  // re-renders on every reactive getCardChecklist update) reuse the same array
  // reference instead of handing Virtuoso a fresh `data` prop each time, which
  // churns the list and widens the reflow window a Maestro tap can land in.
  // Guarded for the not-yet-loaded case so the hook stays above the early
  // return (Rules of Hooks). Sort semantics are unchanged.
  // NEO-189: which parents are showing their variations. Collapsed by default
  // — the point of the grouping is that a 908-row set reads as its 725 real
  // cards until you ask for more.
  const [expandedParents, setExpandedParents] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleVariations = useCallback((id: Id<"cardChecklist">) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id as string)) next.delete(id as string);
      else next.add(id as string);
      return next;
    });
  }, []);

  const sortedCards = useMemo(() => {
    if (!cards) return [];
    return [...cards]
      .filter((c) => {
        // NEO-137: the filter compares SLOT keys — `platformData.<side>.src`
        // is the slot on this card's parent row, and the chips are keyed the
        // same way.
        if (sourceFilter.bsc && c.platformData?.bsc?.src !== sourceFilter.bsc) {
          return false;
        }
        if (
          sourceFilter.sportlots &&
          c.platformData?.sportlots?.src !== sourceFilter.sportlots
        ) {
          return false;
        }
        if (hideCrossListed && c.isCrossListed) return false;
        return true;
      })
      .sort((a, b) => compareCardNumbers(a.cardNumber, b.cardNumber));
  }, [cards, sourceFilter, hideCrossListed]);

  // NEO-189 — variations hang off their parent instead of sitting flat in the
  // scroll.
  //
  // 2021 Topps Heritage is 908 cards of which 183 are variations. Flat, that
  // buries five near-identical "Bryce Harper" rows between #13 and #14 and the
  // checklist stops reading as a checklist. Collapsed by default, the list is
  // its 725 real cards again, and a parent says how many it is holding.
  //
  // `displayRows` is the flattened, virtualization-friendly view: every parent
  // in card order, each followed by its variations only while it is open.
  // Virtuoso keeps working on a flat array, so nothing here costs the list its
  // windowing.
  //
  // A variation whose parent is NOT in the filtered list renders at TOP level
  // rather than vanishing. Source filters and the cross-listing toggle can
  // remove a parent while keeping its children, and a row you cannot see is a
  // row you cannot fix — the same reason commitCardChecklist reports ambiguous
  // groups instead of dropping them.
  // a11y (NEO-189): id → card number over the FULL unfiltered `cards`, used to
  // label a variation row with its parent's number even when that parent has
  // been filtered out of `sortedCards` (an orphaned variation, rendered at top
  // level below) or lives outside the current virtualized viewport.
  const cardNumberById = useMemo(() => {
    const map = new Map<string, string>();
    for (const card of cards ?? []) {
      map.set(card._id as string, card.cardNumber);
    }
    return map;
  }, [cards]);

  const variationsByParent = useMemo(() => {
    const map = new Map<string, typeof sortedCards>();
    for (const card of sortedCards) {
      if (!card.variationOfCardId) continue;
      const key = card.variationOfCardId as string;
      const bucket = map.get(key);
      if (bucket) bucket.push(card);
      else map.set(key, [card]);
    }
    return map;
  }, [sortedCards]);

  const displayRows = useMemo(() => {
    const presentIds = new Set(sortedCards.map((c) => c._id as string));
    // NEO-189: the open card's parent counts as expanded, whatever the toggle
    // says.
    //
    // Setting "Variation of" from the detail panel moves that card under its
    // parent, and a collapsed parent would hide it — the panel would blink shut
    // the moment the operator made the link, reading as the app losing their
    // work rather than filing it. Derived rather than pushed into
    // `expandedParents` so this never fights the operator's own toggle: close
    // the parent and it stays closed once the selection moves on.
    const selectedParentId = selectedCardId
      ? (sortedCards.find((c) => c._id === selectedCardId)
          ?.variationOfCardId as string | undefined)
      : undefined;
    const isExpanded = (id: string) =>
      expandedParents.has(id) || id === selectedParentId;
    const rows: Array<{
      card: (typeof sortedCards)[number];
      isVariation: boolean;
      variationCount: number;
      expanded: boolean;
      // a11y (NEO-189): the parent's card number, so CardChecklistItem can say
      // "Variation of #11" in text rather than relying on indentation + a
      // border colour alone — see the prop's own doc comment. Looked up from
      // the FULL `cards` list, not `sortedCards`, so an orphaned variation
      // (its parent filtered out, see below) still gets a correct number
      // instead of `undefined`.
      parentCardNumber?: string;
    }> = [];
    for (const card of sortedCards) {
      // Rendered under its parent below, unless that parent is filtered out.
      if (card.variationOfCardId && presentIds.has(card.variationOfCardId as string)) {
        continue;
      }
      const children = variationsByParent.get(card._id as string) ?? [];
      rows.push({
        card,
        isVariation: !!card.variationOfCardId,
        variationCount: children.length,
        expanded: children.length > 0 && isExpanded(card._id as string),
        parentCardNumber: card.variationOfCardId
          ? cardNumberById.get(card.variationOfCardId as string)
          : undefined,
      });
      if (children.length > 0 && isExpanded(card._id as string)) {
        for (const child of children) {
          rows.push({
            card: child,
            isVariation: true,
            variationCount: 0,
            expanded: false,
            parentCardNumber: card.cardNumber,
          });
        }
      }
    }
    return rows;
  }, [sortedCards, variationsByParent, expandedParents, selectedCardId, cardNumberById]);

  // Only worth showing the toggle when this checklist actually has visiting
  // cards (mirrors ChecklistSourceFilter's `anyMulti` guard). Derived from
  // `cards`, not `sortedCards` — otherwise hiding them would remove the very
  // control needed to bring them back.
  const hasCrossListed = useMemo(
    () => (cards ?? []).some((c) => c.isCrossListed),
    [cards],
  );
  /**
   * NEO-195 — the live candidate view, shaped like the modal's initialData.
   *
   * This is now the ONLY source for the dialog. It used to hand over to
   * `pendingPairing` — a second, complete copy of the same rows returned by
   * the action ~70s later — the moment the fetch resolved. That copy was pure
   * cost: `CardPairingModal` absorbs `initialData` append-only, so every row
   * in it was already known and its contents were dropped, and keeping the two
   * in step meant widening two wires for every field the screen learned to
   * show (NEO-199 did exactly that).
   *
   * Gated on `pairingOpen`, NOT on `fetchInFlight`: the review outlives the
   * fetch, and gating on the fetch is what made a second source necessary in
   * the first place.
   *
   * Gated on `total`, not `ready`. `ready` counts rows whose TEAM has
   * resolved, and teams gate Confirm, not visibility (see
   * convex/checklistCandidates.ts) — waiting on it here would hold the dialog
   * shut for the first enrichment chunk and, worse, make "did the dialog open
   * at all" depend on whether team enrichment got anywhere.
   *
   * A candidate carries its bucket, so the three columns come straight off it
   * rather than being re-derived here.
   */
  const streamedPairing = useMemo(() => {
    if (!pairingOpen || !liveCandidates || liveCandidates.total === 0) {
      return null;
    }
    const toCard = (c: (typeof liveCandidates.cards)[number]): PairingCard => ({
      cardNumber: c.cardNumber,
      cardName: c.cardName,
      teams: c.teams,
      players: c.players,
      attributes: c.attributes,
      isRookie: c.isRookie,
      isRelic: c.isRelic,
      printRun: c.printRun,
      autographType: c.autographType,
      cardVariation: c.cardVariation,
      // NEO-189: without this the modal commits every variation as a
      // standalone card — the flag has to survive the whole path.
      isVariation: c.isVariation,
      platformData: c.platformData,
      // NEO-199: the losing name from a server-side merge. Absent on every row
      // the two marketplaces agree about, which is nearly all of them; where it
      // is present the modal raises the same choice a hand-linked conflict gets.
      nameConflict: c.nameConflict,
      unmatched:
        c.bucket === "bscOnly" ? "sl" : c.bucket === "slOnly" ? "bsc" : undefined,
    });
    return {
      autoMatched: liveCandidates.cards
        .filter((c) => c.bucket === "matched")
        .map((c) => ({ card: toCard(c), confidence: c.confidence ?? 1 })),
      unmatchedBsc: liveCandidates.cards
        .filter((c) => c.bucket === "bscOnly")
        .map(toCard),
      unmatchedSl: liveCandidates.cards
        .filter((c) => c.bucket === "slOnly")
        .map(toCard),
    };
  }, [pairingOpen, liveCandidates]);

  const lastSynced = useMemo(() => {
    if (!cards || cards.length === 0) return null;
    return Math.max(
      ...cards.map((c: { lastUpdated: number }) => c.lastUpdated),
    );
  }, [cards]);

  if (!cards) {
    return (
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
        <h2 className="text-xl font-semibold mb-4">Cards</h2>
        <div className="text-gray-500">Loading checklist...</div>
      </div>
    );
  }

  // NEO-25: resolve the open card from its id against the live sorted list.
  //
  // NEO-189: indexed against `displayRows`, NOT `sortedCards`. Virtuoso renders
  // displayRows, and selectByIndex hands its index straight to
  // `scrollToIndex` — indexing the two differently would scroll to a different
  // row than the one it selected the moment any set has a variation in it.
  //
  // Prev/next therefore walks what is actually on screen: a collapsed
  // variation is not steppable, which is the same rule as not being clickable.
  const selectedIndex = selectedCardId
    ? displayRows.findIndex((r) => r.card._id === selectedCardId)
    : -1;
  const selectedCard = selectedIndex >= 0 ? displayRows[selectedIndex].card : null;

  // Move selection to a list position and keep it in view. "center" matches
  // the add-card scroll and dodges the sticky binder-header at y≈84.
  const selectByIndex = (idx: number) => {
    if (idx < 0 || idx >= displayRows.length) return;
    setSelectedCardId(displayRows[idx].card._id);
    virtuosoRef.current?.scrollToIndex({
      index: idx,
      align: "center",
      behavior: "auto",
    });
  };

  const busy = syncing || committing;
  const fetchLabel = syncing
    ? "Fetching..."
    : committing
      ? "Saving..."
      : sortedCards.length === 0
        ? "Fetch from Marketplaces"
        : "Refresh";

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <h2 className="text-xl font-semibold">
            Cards{" "}
            {cards.length > 0 && (
              <span className="text-sm font-normal text-gray-500">
                ({cards.length})
              </span>
            )}
          </h2>
          {!showAddForm && (
            <div className="flex gap-2">
              <NeonButton
                onClick={() => setShowAddForm(true)}
                aria-label="Open add card form"
              >
                Add Card
              </NeonButton>
              <NeonButton
                secondary
                onClick={() => setShowCrossListingModal(true)}
                aria-label="Open add cross-release cards form"
              >
                Add Cross-Release Cards
              </NeonButton>
              {sortedCards.length > 0 && (
                <NeonButton
                  secondary
                  onClick={handleSync}
                  disabled={busy}
                  aria-label="Sync card checklist"
                >
                  {fetchLabel}
                </NeonButton>
              )}
            </div>
          )}
        </div>

        {/* Add Card Form — rendered inline right under the header so the
            inputs are immediately visible after the user taps "Add Card".
            Previously this lived below the 70vh Virtuoso list, which on
            headless 1024×629 viewports put Player name 440–800px off-screen
            and broke every flow that wanted to add a custom card. */}
        {showAddForm && (
          <div className="bg-gray-50 dark:bg-gray-900/40 p-4 mb-4 rounded-lg space-y-3">
            <h3 className="font-semibold text-sm">Add Card</h3>
            <div className="flex gap-2">
              <Input
                bare
                type="text"
                ref={cardNumberRef}
                className={`${fieldClass("cardNumber")} w-20 p-2 text-sm`}
                placeholder="#"
                aria-label="Card number"
                autoFocus
              />
              <Input
                bare
                type="text"
                ref={cardNameRef}
                className={`${fieldClass("cardName")} flex-1 p-2 text-sm`}
                placeholder="Player name"
                aria-label="Card name"
              />
            </div>
            <Input
              bare
              type="text"
              ref={playersRef}
              className={`${fieldClass("players")} w-full p-2 text-sm`}
              placeholder="Player(s) — comma separated, optional"
              aria-label="Players"
            />
            <Input
              bare
              type="text"
              ref={teamRef}
              className={`${fieldClass("team")} w-full p-2 text-sm`}
              placeholder="Team (optional)"
              aria-label="Team"
            />
            <div className="flex gap-2">
              <NeonButton onClick={handleAddCard} aria-label="Submit new card">
                Add
              </NeonButton>
              <NeonButton
                cancel
                onClick={() => setShowAddForm(false)}
                aria-label="Cancel new card"
              >
                Cancel
              </NeonButton>
            </div>
          </div>
        )}

        {lastSynced && (
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-3">
            Last synced:{" "}
            {new Date(lastSynced).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
            {/* eslint-disable-next-line react-hooks/purity -- Date.now() for a
                "last synced > 7d" badge. Advisory only, and the value it sits
                next to comes from a live query that re-renders this. */}
            {Date.now() - lastSynced > 7 * 24 * 60 * 60 * 1000 && (
              <span className="ml-1 text-amber-500">(stale)</span>
            )}
          </div>
        )}

        {syncMessage && (
          <div className="p-2 mb-3 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md text-blue-800 dark:text-blue-200 text-sm">
            {syncMessage}
          </div>
        )}

        <ChecklistSourceFilter
          chips={sourceChips}
          filter={sourceFilter}
          onChange={setSourceFilter}
        />

        {/* NEO-21: only rendered when guest cards are actually present, so a
            normal single-release checklist is visually unchanged. */}
        {hasCrossListed && (
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide w-24 shrink-0">
              Cross-release
            </span>
            <Chip
              label="Hide cross-release cards"
              ariaLabel={`Hide cross-release cards${hideCrossListed ? " (on)" : ""}`}
              title="Show only cards printed in this set"
              active={hideCrossListed}
              onClick={() => setHideCrossListed((v) => !v)}
            />
          </div>
        )}

        {sortedCards.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-gray-500 dark:text-gray-400 mb-4">
              No cards in this checklist yet.
            </p>
            <NeonButton
              onClick={handleSync}
              disabled={busy}
              aria-label="Sync card checklist"
            >
              {fetchLabel}
            </NeonButton>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={displayRows}
            computeItemKey={(_, row) => row.card._id}
            itemContent={(_, row) => (
              <div className="pb-1.5">
                <CardChecklistItem
                  card={row.card}
                  sourceLabelMaps={sourceLabelMaps}
                  isSelected={row.card._id === selectedCardId}
                  onEdit={(id) => setSelectedCardId(id)}
                  variationCount={row.variationCount}
                  isVariation={row.isVariation}
                  isExpanded={row.expanded}
                  parentCardNumber={row.parentCardNumber}
                  onToggleVariations={
                    row.variationCount > 0 ? toggleVariations : undefined
                  }
                />
              </div>
            )}
            // Open at the end of the list (most-recent / highest sortOrder).
            // Custom cards always sort to the bottom, and the E2E reload
            // checks (team-picker Test 7, features-propagation Step E)
            // look for a just-saved card after re-navigation — without
            // this, Virtuoso renders only the top ~10 rows and the test
            // card is unreachable to Maestro's page-level
            // `scrollUntilVisible`. Initial-bottom also matches how a
            // real operator returns to a checklist: they want to see what
            // they were last working on, not browse from #001 every time.
            initialTopMostItemIndex={
              displayRows.length > 0 ? displayRows.length - 1 : 0
            }
            style={{ height: "min(70vh, 800px)" }}
            increaseViewportBy={{ top: 200, bottom: 400 }}
          />
        )}
      </div>

      {/* NEO-25: card detail panel. Keyed on the card id so switching cards
          (arrow nav / prev-next) remounts it with fresh draft state. */}
      {selectedCard && (
        <CardDetailPanel
          key={selectedCard._id}
          card={selectedCard}
          ancestorChain={ancestorChain}
          ancestorSport={ancestorSport}
          ancestorSportId={ancestorSportId}
          onClose={() => setSelectedCardId(null)}
          onPrev={() => selectByIndex(selectedIndex - 1)}
          onNext={() => selectByIndex(selectedIndex + 1)}
          hasPrev={selectedIndex > 0}
          hasNext={selectedIndex >= 0 && selectedIndex < displayRows.length - 1}
        />
      )}

      <CrossListingImportModal
        isOpen={showCrossListingModal}
        onClose={() => setShowCrossListingModal(false)}
        targetVariantId={variantId}
      />

      {streamedPairing && (
        <CardPairingModal
          isOpen
          onClose={async () => {
            // Supersede any in-flight fetch so its result cannot reopen this
            // dialog behind the operator (see syncGenerationRef).
            syncGenerationRef.current++;
            setPairingOpen(false);
            setFetchInFlight(false);
            setSyncing(false);
            setSyncMessage("Sync cancelled — no cards saved.");
            // NEO-195: candidates are worthless once the operator has walked
            // away. Leaving them would make the NEXT fetch's clear-stale step
            // do the work instead, one sync later and less obviously.
            await discardCandidates({ selectorOptionId: variantId });
          }}
          onConfirm={handlePairingConfirm}
          setLabel={variantRow?.value}
          // One source, live for the whole review — during the fetch and after
          // it. The modal absorbs updates append-only, so rows that arrive
          // late join without disturbing a decision already made.
          initialData={streamedPairing}
          isStreaming={fetchInFlight}
          streamProgress={
            liveCandidates
              ? { ready: liveCandidates.ready, total: liveCandidates.total }
              : undefined
          }
        />
      )}

      {pendingPreview?.batchId && (
        <EntityReviewWizard
          isOpen={pendingPreview !== null}
          selectorOptionId={variantId}
          batchId={pendingPreview.batchId}
          cardCount={pendingPreview.cards.length}
          saving={committing}
          onConfirm={handleWizardConfirm}
          onCancel={() => {
            setPendingPreview(null);
            setSyncMessage("Fetch cancelled — no cards saved.");
          }}
        />
      )}
    </div>
  );
}
