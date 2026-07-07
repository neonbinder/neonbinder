import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { api } from "../../convex/_generated/api";
import type { GenericId } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";
import CardChecklistItem from "./CardChecklistItem";
import CardDetailPanel from "./CardDetailPanel";
import { useFieldTestClass } from "@/src/hooks/useFieldTestClass";
import NeonButton from "../modules/NeonButton";
import UnknownEntitiesDialog from "./UnknownEntitiesDialog";
import ChecklistSourceFilter, {
  type SourceChips,
  type SourceFilter,
} from "./ChecklistSourceFilter";

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
 * Preview shape returned by fetchCardChecklist. We hold this in component
 * state between fetch (action) and commit (mutation) so the user can
 * confirm new players/teams in UnknownEntitiesDialog before the entities
 * are persisted.
 */
type FetchPreview = {
  sport: string;
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
    platformData: { bsc?: string; sportlots?: string };
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
  const fetchChecklist = useAction(api.selectorOptions.fetchCardChecklist);
  const commitChecklist = useMutation(api.selectorOptions.commitCardChecklist);
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
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>({
    bsc: null,
    sportlots: null,
  });
  // NEO-25: which card (if any) is open in the detail panel. Tracked by id —
  // sortedCards re-sorts on every reactive update, so an index would silently
  // point at a different card after any list mutation.
  const [selectedCardId, setSelectedCardId] =
    useState<Id<"cardChecklist"> | null>(null);

  // Reset filter + close the detail panel when the variant changes — chips and
  // selection for one variant don't apply to another.
  useEffect(() => {
    setSourceFilter({ bsc: null, sportlots: null });
    setSelectedCardId(null);
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

  /**
   * Two-phase pipeline:
   *   1. fetchChecklist → preview (no DB writes; player/team strings, not IDs)
   *   2. If unknowns: open dialog → user confirms subset → commit
   *      Otherwise: commit immediately with empty confirmedNew*.
   * Either way, commitCardChecklist is the only path that writes
   * cardChecklist rows + new player/team entities.
   */
  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await fetchChecklist({ selectorOptionId: variantId });
      if (!result.success || !result.sport) {
        setSyncMessage(result.message);
        return;
      }
      const preview: FetchPreview = {
        sport: result.sport,
        cards: result.cards,
        unknownPlayers: result.unknownPlayers,
        unknownTeams: result.unknownTeams,
      };
      if (preview.unknownPlayers.length === 0 && preview.unknownTeams.length === 0) {
        await runCommit(preview, [], []);
        setSyncMessage(`Saved ${result.cards.length} cards.`);
      } else {
        // Stash preview; dialog handles the rest.
        setPendingPreview(preview);
        setSyncMessage(result.message);
      }
    } catch (error) {
      setSyncMessage(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setSyncing(false);
    }
  };

  const runCommit = async (
    preview: FetchPreview,
    confirmedPlayers: string[],
    confirmedTeams: string[],
  ) => {
    setCommitting(true);
    try {
      const result = await commitChecklist({
        selectorOptionId: variantId,
        sport: preview.sport,
        cards: preview.cards,
        confirmedNewPlayers: confirmedPlayers,
        confirmedNewTeams: confirmedTeams,
      });
      const enrichmentNote =
        result.createdPlayerIds.length || result.createdTeamIds.length
          ? ` (${result.createdPlayerIds.length} players + ${result.createdTeamIds.length} teams enriching from Wikidata in background)`
          : "";
      setSyncMessage(`Saved ${result.count} cards.${enrichmentNote}`);
    } catch (error) {
      setSyncMessage(
        `Commit failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    } finally {
      setCommitting(false);
    }
  };

  const handleConfirmUnknowns = async (
    confirmedPlayers: string[],
    confirmedTeams: string[],
  ) => {
    if (!pendingPreview) return;
    await runCommit(pendingPreview, confirmedPlayers, confirmedTeams);
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
        // The data prop on Virtuoso below is sortedCards, which sorts by
        // sortOrder ascending. cards from Convex carry sortOrder fields,
        // so a sort-aware index is needed. Compute it via cardsBySortOrder.
        const sortedIdx = [...cards]
          .sort((a, b) => a.sortOrder - b.sortOrder)
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
  const sortedCards = useMemo(() => {
    if (!cards) return [];
    return [...cards]
      .filter((c) => {
        if (sourceFilter.bsc && c.sourcePlatformIds?.bsc !== sourceFilter.bsc) {
          return false;
        }
        if (
          sourceFilter.sportlots &&
          c.sourcePlatformIds?.sportlots !== sourceFilter.sportlots
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [cards, sourceFilter]);
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
  const selectedIndex = selectedCardId
    ? sortedCards.findIndex((c) => c._id === selectedCardId)
    : -1;
  const selectedCard = selectedIndex >= 0 ? sortedCards[selectedIndex] : null;

  // Move selection to a list position and keep it in view. "center" matches
  // the add-card scroll and dodges the sticky binder-header at y≈84.
  const selectByIndex = (idx: number) => {
    if (idx < 0 || idx >= sortedCards.length) return;
    setSelectedCardId(sortedCards[idx]._id);
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
              <input
                type="text"
                ref={cardNumberRef}
                className={`${fieldClass("cardNumber")} w-20 p-2 border rounded-md text-sm dark:bg-gray-700 dark:border-gray-600`}
                placeholder="#"
                aria-label="Card number"
                autoFocus
              />
              <input
                type="text"
                ref={cardNameRef}
                className={`${fieldClass("cardName")} flex-1 p-2 border rounded-md text-sm dark:bg-gray-700 dark:border-gray-600`}
                placeholder="Player name"
                aria-label="Card name"
              />
            </div>
            <input
              type="text"
              ref={playersRef}
              className={`${fieldClass("players")} w-full p-2 border rounded-md text-sm dark:bg-gray-700 dark:border-gray-600`}
              placeholder="Player(s) — comma separated, optional"
              aria-label="Players"
            />
            <input
              type="text"
              ref={teamRef}
              className={`${fieldClass("team")} w-full p-2 border rounded-md text-sm dark:bg-gray-700 dark:border-gray-600`}
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
            data={sortedCards}
            computeItemKey={(_, card) => card._id}
            itemContent={(_, card) => (
              <div className="pb-1.5">
                <CardChecklistItem
                  card={card}
                  sourceLabelMaps={sourceLabelMaps}
                  isSelected={card._id === selectedCardId}
                  onEdit={(id) => setSelectedCardId(id)}
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
              sortedCards.length > 0 ? sortedCards.length - 1 : 0
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
          onClose={() => setSelectedCardId(null)}
          onPrev={() => selectByIndex(selectedIndex - 1)}
          onNext={() => selectByIndex(selectedIndex + 1)}
          hasPrev={selectedIndex > 0}
          hasNext={selectedIndex >= 0 && selectedIndex < sortedCards.length - 1}
        />
      )}

      <UnknownEntitiesDialog
        isOpen={pendingPreview !== null}
        unknownPlayers={pendingPreview?.unknownPlayers ?? []}
        unknownTeams={pendingPreview?.unknownTeams ?? []}
        sport={pendingPreview?.sport ?? ""}
        saving={committing}
        onConfirm={handleConfirmUnknowns}
        onCancel={() => {
          setPendingPreview(null);
          setSyncMessage("Fetch cancelled — no cards saved.");
        }}
      />
    </div>
  );
}
