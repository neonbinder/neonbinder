import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useAction, useMutation, useConvex } from "convex/react";
import { userFacingMessage } from "../../lib/errors/user-facing-message";
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
import SyncReviewModal, {
  needsSyncReview,
  type SyncDiff,
  type SyncReviewResult,
} from "./sync-review-modal";
import ChecklistSourceFilter, {
  Chip,
  type SourceChips,
  type SourceFilter,
} from "./ChecklistSourceFilter";
import CrossListingImportModal from "./CrossListingImportModal";
import CardAttentionWalker from "./CardAttentionWalker";
import { needsAttention } from "./card-attention";
import { Input } from "../primitives/Input";
import TeamPicker from "./TeamPicker";


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
  /**
   * NEO-203 — the operator's content-review answers, POSITIONALLY ALIGNED with
   * `cards`.
   *
   * Not merged into the cards themselves because `resolveChecklistEntities`
   * validates its payload against the strict `previewCardValidator`, which has
   * no `applyFields`/`baseVersion`; only `commitCardChecklist` accepts those.
   * So the decisions ride alongside and `runCommit` zips them on at the last
   * moment. Empty on the unreviewed path, which is the fail-closed default the
   * server also assumes.
   */
  decisions: Array<{ applyFields?: string[]; baseVersion?: number }>;
  /** Rows the operator explicitly ticked for deletion in the review. */
  operatorDeleteIds: Array<Id<"cardChecklist">>;
  unknownPlayers: string[];
  unknownTeams: string[];
};

/** The confirmed cards, waiting on the content-diff review. */
type PendingReview = {
  sportId: Id<"selectorOptions">;
  cards: PairingCard[];
  diff: SyncDiff;
};

/**
 * NEO-203 — "the operator reviewed nothing", which is also what an unreviewed
 * commit sends. Applies no content, deletes nothing, holds nothing back.
 */
const NO_SYNC_DECISIONS: SyncReviewResult = {
  applyFieldsByIndex: {},
  baseVersionByIndex: {},
  operatorDeleteIds: [],
  heldBackIndices: [],
  conflictResolutions: [],
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
  // NEO-189: an ACTION, not a mutation. The commit is chunked server-side
  // (prelude → N chunk mutations → finalize) because a 712-card checklist blew
  // Convex's per-mutation system-operation budget; see the header comment on
  // `commitCardChecklist` in convex/selectorOptions.ts. Call shape is
  // unchanged.
  const commitChecklist = useAction(api.selectorOptions.commitCardChecklist);
  const resolveEntities = useAction(
    api.selectorOptions.resolveChecklistEntities,
  );
  const addCustomCard = useMutation(api.selectorOptions.addCustomCard);
  /**
   * NEO-203 — the content diff is fetched ONCE, imperatively, between pairing
   * and the entity wizard.
   *
   * A `useQuery` subscription would be wrong twice over: its argument is the
   * whole confirmed card array (a new subscription key on every keystroke of
   * the pairing session), and a live diff would move under the operator while
   * they review it — the very thing `baseVersion` exists to detect. One
   * snapshot, reviewed, then re-checked server-side at write time.
   */
  const convex = useConvex();

  const [syncing, setSyncing] = useState(false);
  const [committing, setCommitting] = useState(false);
  /**
   * a11y: mirrors the `role`/`aria-live` status-vs-alert pattern documented
   * for `apps/web/app/print/placeholders/intake.tsx`'s upload notice — same
   * two things that pattern gets right: the element's `role` switches between
   * `"status"` (routine) and `"alert"` (failure) rather than staying a plain
   * `<div>` with neither, and a `key={tone}` forces React to remount the node
   * on a tone change so AT doesn't miss it re-announcing (some screen readers
   * cache a live region's politeness from the moment it entered the tree).
   * `setSyncMessage` below is a thin wrapper so the many existing call sites
   * keep passing a bare string — only the handful that report a real failure
   * pass the second `"error"` argument.
   */
  const [syncNotice, setSyncNotice] = useState<{
    text: string;
    tone: "status" | "error";
    /**
     * NEO-102: which notice this is, structurally — NOT inferred from the
     * text. Only the post-commit success notice ("Saved N cards." and its
     * NEO-203 note variants) carries `"committed"`, and only that notice
     * grows the attention call-to-action below. An earlier cut keyed the CTA
     * off `tone === "status"`, which is every routine notice there is: after
     * the operator cancelled the entity-review wizard on a set holding a
     * teamless custom card, "Fetch cancelled — no cards saved." grew a CTA
     * offering to fix cards that were never saved. Leave this undefined for
     * every other notice.
     */
    kind?: "committed";
  } | null>(null);
  const setSyncMessage = useCallback(
    (text: string | null, tone: "status" | "error" = "status") => {
      setSyncNotice(text === null ? null : { text, tone });
    },
    [],
  );
  /**
   * The one setter that marks a notice as the result of a successful commit.
   * Kept separate from `setSyncMessage` so no future call site can opt into
   * the CTA by accident — reaching it means a commit actually landed.
   */
  const setCommittedMessage = useCallback((text: string) => {
    setSyncNotice({ text, tone: "status", kind: "committed" });
  }, []);
  const [showAddForm, setShowAddForm] = useState(false);
  // NEO-36: the add-card form's TEXT fields are UNCONTROLLED (refs, read at
  // submit) rather than controlled React state. CardChecklist re-renders on
  // every reactive getCardChecklist update; under parallel-worker load those
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
  const playersRef = useRef<HTMLInputElement>(null);
  /**
   * NEO-208 — the quick-add form's picked teams. React STATE, not a ref, and
   * that is the one place this form deviates from the NEO-36 rule above.
   *
   * The rule exists because of a race between a KEYSTROKE and a re-render: a
   * controlled text input renders `value={state}`, so a reactive
   * `getCardChecklist` update landing between a keypress and its state commit
   * re-rendered the field back to the stale value and silently ate the
   * character. A picker has no such window — its value changes only in whole
   * chips, from a click or an Enter inside the popover, and each of those is a
   * single discrete `setState`. There is never a half-typed value living only
   * in the DOM for a re-render to overwrite, and React state survives
   * re-renders by definition (only a REMOUNT clears it, and this form's
   * container is not remounted by a query update).
   *
   * A ref would not work here anyway: the chips have to re-render when they
   * change, which is exactly what a ref does not do.
   *
   * Reset at both edges of the form's life — opening it and cancelling it —
   * because the text fields reset by being unmounted and this must not
   * silently carry a previous card's teams into the next one. See
   * `openAddForm` / `closeAddForm`.
   */
  const [addFormTeamIds, setAddFormTeamIds] = useState<Array<Id<"teams">>>([]);
  /**
   * a11y (NEO-203 audit follow-up) — the durable "restore focus here" target
   * for `SyncReviewModal`. That modal mounts only after `handlePairingConfirm`
   * unmounts `CardPairingModal` and then `await`s a real Convex query
   * (`diffChecklistAgainstExisting`); by the time it mounts, whatever
   * `CardPairingModal`'s own trigger was has already lost focus to `<body>`
   * across that async gap, so `SyncReviewModal`'s own
   * `document.activeElement`-at-mount capture is unreliable here. This button
   * — the one that actually starts the whole fetch→pair→review→commit
   * pipeline — is what a keyboard/screen-reader user should land back on
   * once the pipeline finishes (Skip or Apply); it stays mounted for the
   * modal's entire lifetime (only ONE of the two `NeonButton`s below is ever
   * rendered at a time, both share this ref, and neither depends on the
   * pipeline's own state).
   */
  const syncButtonRef = useRef<HTMLButtonElement>(null);
  // Unique per-field marker class so Maestro's inputText targets the tapped
  // add-card field, not the first input (see useFieldTestClass).
  const fieldClass = useFieldTestClass();
  const [pendingPreview, setPendingPreview] = useState<FetchPreview | null>(null);
  // NEO-203 — confirmed cards parked in front of the content-diff review.
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(null);
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
  /**
   * NEO-102 — the "needs attention" pass.
   *
   * `attentionOnly` filters the grid down to the flagged rows (same Chip
   * pattern as the cross-release toggle). `walkerOpenedByHand` is the ONLY
   * thing that opens the walker: the operator pressed one of its two
   * buttons (the header row's "Fix them one at a time", or the post-commit
   * banner's inline call-to-action).
   *
   * Nothing opens the walker on its own. An earlier revision armed it on a
   * commit and let a derived `walkerOpen` pop the modal the moment the
   * background BSC team pass flagged its first row. That is an interruption
   * the operator never asked for: it lands over whatever they moved on to
   * (it needed an `activeElement` guard just to avoid stealing focus mid
   * keystroke), and it broke every flow that commits and then touches the
   * grid, because the modal's `fixed inset-0` overlay swallowed the next
   * click. The count is instead advertised REACTIVELY — the banner CTA and
   * the header chip both read `attentionCount` off the live subscription, so
   * rows the BSC pass flags seconds after the commit still get announced,
   * without taking the screen.
   */
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [walkerOpenedByHand, setWalkerOpenedByHand] = useState(false);
  const [showCrossListingModal, setShowCrossListingModal] = useState(false);

  // Reset filter + close the detail panel when the variant changes — chips and
  // selection for one variant don't apply to another.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset-on-prop-change: one variant's chips and selection do not apply to another
    setSourceFilter({ bsc: null, sportlots: null });
    setSelectedCardId(null);
    setHideCrossListed(false);
    setPairingOpen(false);
    // NEO-203: a diff computed against one variant's rows is meaningless
    // against another's.
    setPendingReview(null);
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
        "error",
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
        setSyncMessage(result.message, "error");
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
        "error",
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
   *
   * NEO-203 inserts ONE step in front of that: the content-diff review. The
   * cards are compared server-side against the NB rows they will land on, and
   * if anything is genuinely different — or anything upstream stopped listing a
   * card NeonBinder holds — the operator settles it before entity resolution
   * runs. Skipped entirely when there is nothing to settle, on the same
   * precedent as the `candidateCount === 0` short-circuit above: a dialog an
   * operator can only click through is a step, not a safeguard.
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
        "error",
      );
      return;
    }
    const sportId = ancestorSportId;
    setPairingOpen(false);
    setCommitting(true);
    try {
      // Nothing incoming means nothing to diff, and — critically — it must NOT
      // be read as "upstream removed every card": the custom-subtree path
      // reaches here with an empty set by design.
      if (result.cards.length > 0) {
        const diff = await convex.query(
          api.selectorOptions.diffChecklistAgainstExisting,
          { selectorOptionId: variantId, cards: result.cards },
        );
        if (needsSyncReview(diff)) {
          setPendingReview({ sportId, cards: result.cards, diff });
          return;
        }
      }
      await resolveAndCommit(sportId, result.cards, NO_SYNC_DECISIONS);
    } catch (error) {
      setSyncMessage(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "error",
      );
    } finally {
      setCommitting(false);
    }
  };

  /**
   * The operator's answers on the review screen, applied to the confirmed set:
   * held-back cards dropped, accepted fields attached, deletions carried
   * through. Also the path taken when the review is skipped (Escape, "Skip
   * changes", or nothing to review) — with an empty result, which applies
   * nothing and deletes nothing.
   */
  const resolveAndCommit = async (
    sportId: Id<"selectorOptions">,
    cards: PairingCard[],
    review: SyncReviewResult,
  ) => {
    const heldBack = new Set(review.heldBackIndices);
    const kept = cards
      .map((card, index) => ({ card, index }))
      .filter(({ index }) => !heldBack.has(index));
    const { unknownPlayers, unknownTeams, batchId } = await resolveEntities({
      selectorOptionId: variantId,
      sportId,
      cards: kept.map(({ card }) => card),
    });
    const preview: FetchPreview = {
      sportId,
      batchId,
      cards: kept.map(({ card }) => card),
      decisions: kept.map(({ index }) => ({
        applyFields: review.applyFieldsByIndex[index],
        baseVersion: review.baseVersionByIndex[index],
      })),
      operatorDeleteIds: review.operatorDeleteIds,
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
  };

  const handleSyncReviewDone = async (review: SyncReviewResult) => {
    if (!pendingReview) return;
    const { sportId, cards } = pendingReview;
    setPendingReview(null);
    setCommitting(true);
    try {
      await resolveAndCommit(sportId, cards, review);
    } catch (error) {
      setSyncMessage(
        `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        "error",
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
        // NEO-203: the operator's per-field answer rides on the card, and ONLY
        // where they actually accepted something. A card with no accepted
        // fields is sent byte-identical to how it was sent before this feature
        // existed, which is what keeps the unreviewed path fail-closed on both
        // ends of the wire.
        cards: preview.cards.map((card, i) => {
          const decision = preview.decisions[i];
          return decision?.applyFields?.length
            ? {
                ...card,
                applyFields: decision.applyFields,
                baseVersion: decision.baseVersion,
              }
            : card;
        }),
        batchId: preview.batchId,
        ...(preview.operatorDeleteIds.length > 0
          ? { operatorDeleteIds: preview.operatorDeleteIds }
          : {}),
      });
      // NEO-195: the candidates have been promoted into cardChecklist, so the
      // staging rows have done their job. Dropping them here rather than
      // leaving them for the next fetch's clear-stale step keeps the table
      // empty between syncs.
      //
      // NEO-189: this await must stay BEFORE the "Saved" message. Now that
      // `commitCardChecklist` is an action, `useAction`'s promise resolves as
      // soon as the server returns — unlike `useMutation`, it carries no
      // guarantee that the client's subscribed queries have caught up. But
      // `discardCandidates` IS a mutation, and a mutation's resolution does
      // guarantee the client reflects every write that preceded it on the
      // server — which includes all of the action's internal commit
      // mutations. So awaiting the discard first restores, for free, the
      // repaint guarantee the mutation used to give us. .maestro/flows/
      // setup.yaml waits for "Saved N cards" and then immediately asserts a
      // "#NNN" card row is visible; painting the message any earlier races
      // that assertion against the `getCardChecklist` subscription.
      let discardError: unknown;
      try {
        await discardCandidates({ selectorOptionId: variantId });
      } catch (error) {
        // The cards ARE saved — the commit already succeeded. A failed
        // discard leaves stale staging rows (the next fetch's clear-stale
        // step sweeps them), so it must never be reported as "Commit
        // failed".
        discardError = error;
        console.warn("Failed to discard checklist candidates:", error);
      }
      // NEO-92: no more "enriching in background" note — every created
      // player/team was already enriched during the review wizard, before
      // this commit ran.
      // NEO-203: everything the commit had to REFUSE or defer gets said out
      // loud, in the same banner as the count. Each of these is a decision the
      // server made on the operator's behalf, and every one of them is
      // invisible otherwise — a stale decision in particular looks exactly
      // like "my edit didn't take" if nothing reports it. Appended only when
      // non-zero, so an ordinary sync still reads "Saved N cards."
      const notes: string[] = [];
      if (result.operatorDeleted) {
        notes.push(`Deleted ${result.operatorDeleted}.`);
      }
      if (result.staleDecisions) {
        notes.push(
          `${result.staleDecisions} changed under review — not applied; re-sync to see them again.`,
        );
      }
      if (result.conflicts?.length) {
        notes.push(
          `${result.conflicts.length} linked to two cards — not saved.`,
        );
      }
      if (result.collisionInserts) {
        notes.push(`${result.collisionInserts} saved as new rows.`);
      }
      if (result.unmatchedExistingCount) {
        notes.push(
          `${result.unmatchedExistingCount} no longer listed upstream (kept).`,
        );
      }
      setCommittedMessage(
        [
          discardError
            ? `Saved ${result.count} cards. (Could not clear staged candidates.)`
            : `Saved ${result.count} cards.`,
          ...notes,
        ].join(" "),
      );
      // NEO-102: the commit itself never knows whether a card has a team — the
      // BSC team pass runs after it, and a BSC-linked card is not even flagged
      // until that pass has been and gone. So no COUNT is decided here — only
      // that this notice is the one allowed to carry the call-to-action
      // (`setCommittedMessage`). The banner grows it for as long as
      // `attentionCount > 0`, which the live subscription keeps current —
      // including for rows flagged well after this handler returned.
    } catch (error) {
      // NEO-189: the commit is phased server-side and labels its failures with
      // the phase that broke ("prelude", "chunk 2/3 (cards 151-300 of 375)",
      // "finalize") — which tells the operator how much of the checklist
      // landed. That label rides a ConvexError, because production redacts a
      // plain Error down to "Server Error"; `userFacingMessage` is what reads
      // it back. The `.message` fallback keeps every other failure reading
      // exactly as it did before.
      setSyncMessage(
        `Commit failed: ${userFacingMessage(
          error,
          error instanceof Error ? error.message : "Unknown error",
        )}`,
        "error",
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

  /**
   * NEO-208 — the two edges of the quick-add form's life. The text fields
   * reset by being unmounted; `addFormTeamIds` is React state and does not, so
   * both entry and exit clear it explicitly. Every path that hides the form
   * goes through `closeAddForm` (open, cancel, successful submit) so a picked
   * team can never survive into the next card.
   */
  const openAddForm = useCallback(() => {
    setAddFormTeamIds([]);
    setShowAddForm(true);
  }, []);
  const closeAddForm = useCallback(() => {
    setShowAddForm(false);
    setAddFormTeamIds([]);
  }, []);

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
    const cardName = (cardNameRef.current?.value ?? "").trim();
    // NEO-208: dedupe here as well as server-side. `TeamPicker.addChip`
    // already refuses a duplicate, so this is belt — but the mutation's own
    // dedupe is what the row is written from, and sending a clean array keeps
    // the two from ever disagreeing about which chip the operator meant.
    const teamOnCardIds = [...new Set(addFormTeamIds)];
    try {
      const newId = await addCustomCard({
        selectorOptionId: variantId,
        cardNumber,
        cardName: cardName || `Card #${cardNumber}`,
        ...(players.length > 0 ? { players } : {}),
        // NEO-208: the picked teams as real `teams` ids, so the card is born
        // LINKED. This replaces the old free-text Team box, whose typed name
        // became `pendingTeamNames` and then rendered NOWHERE until the next
        // sync happened to resolve it — the invisibility this ticket fixes.
        // Nothing is sent when the picker is empty: an absent `teamOnCardIds`
        // and an absent `teams` together mean "no answer about teams", which
        // is what leaves the card correctly badged as needing one. Note we
        // never send the legacy `teams` name array from here any more.
        ...(teamOnCardIds.length > 0 ? { teamOnCardIds } : {}),
      });
      // Closing the form unmounts it; the uncontrolled inputs reset to empty
      // on the next open, and `closeAddForm` clears the picker.
      closeAddForm();
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

  /**
   * NEO-102 — how many stored rows need a human, derived (see
   * card-attention.ts). Recomputed from the live subscription, so fixing a
   * card in the walker drops the count without anything having to invalidate
   * it.
   */
  const attentionCount = useMemo(
    () => (cards ?? []).filter((c) => needsAttention(c)).length,
    [cards],
  );

  /**
   * NEO-102 — the single entry point into the walker.
   *
   * Both buttons that offer it (the header row's "Fix them one at a time" and
   * the post-commit banner's inline CTA) call this, so there is exactly one
   * way the dialog can come up and it is always a deliberate press.
   */
  const openAttentionWalker = useCallback(() => {
    setWalkerOpenedByHand(true);
  }, []);

  /** Both paths out of the walker: the operator is done, or deferred the rest. */
  const closeAttentionWalker = useCallback(() => {
    setWalkerOpenedByHand(false);
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
        // NEO-102: same shape as the two filters above — one predicate, no
        // separate list. A variation whose parent is filtered out still
        // renders at top level, which is what keeps a flagged variation
        // reachable while this filter is on.
        if (attentionOnly && !needsAttention(c)) return false;
        return true;
      })
      .sort((a, b) => compareCardNumbers(a.cardNumber, b.cardNumber));
  }, [cards, sourceFilter, hideCrossListed, attentionOnly]);

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
                onClick={openAddForm}
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
                  ref={syncButtonRef}
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
            {/* NEO-208 — the same TeamPicker the card drawer and the
                attention walker's fixer use, in place of the free-text "Team
                (optional)" box. A typed name used to land in
                `pendingTeamNames`, which NOTHING rendered: the operator saw
                their team vanish and the row still badged "no team on this
                card yet". The picker's ids make the card born linked.

                The wrapper keeps the field's reserved `fieldClass("team")`
                marker even though the picker is not an <input>: Maestro's web
                driver re-finds a tapped element by an XPath built from its
                class (see useFieldTestClass), the "team" key stays claimed so
                no other field in this form can be handed it, and the class is
                a stable handle for a flow that needs to scope a query to this
                field's box. Keyboard order is unchanged — the picker's own
                "+ Add team" trigger takes the tab stop the textbox had, and
                the card-number field above still holds autoFocus. */}
            <div className={`${fieldClass("team")} w-full`}>
              {/* The only labelled field in this form, and deliberately so:
                  every other one is a text box whose placeholder says what it
                  is, which a picker has no equivalent of. It also carries the
                  "(optional)" the old box's placeholder did — leaving a card
                  teamless is a legitimate answer, just not a silent one (the
                  row is then badged, per deriveCardAttention). Matches the card
                  drawer's Teams label so the two read as the same field.
                  No `htmlFor`: the picker is a chip row, not one input, and its
                  controls carry their own aria-labels. */}
              <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
                Team (optional)
              </label>
              <TeamPicker
                value={addFormTeamIds}
                onChange={setAddFormTeamIds}
                sportId={ancestorSportId}
              />
            </div>
            <div className="flex gap-2">
              <NeonButton onClick={handleAddCard} aria-label="Submit new card">
                Add
              </NeonButton>
              <NeonButton
                cancel
                onClick={closeAddForm}
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

        {syncNotice && (
          // a11y (WCAG 4.1.3): this is the post-sync/post-commit result
          // banner — "Saved N cards.", the NEO-203 notes (deletions, stale
          // decisions, conflicts, collision inserts), and every failure
          // message. None of that was previously announced to a screen-
          // reader user at all. `key`/`role`/`aria-live` mirror
          // intake.tsx's notice pattern exactly (see setSyncNotice's own
          // comment above) — `role="alert"` already implies an assertive
          // live region, so `aria-live` is left `undefined` rather than
          // also set to "polite" for that case.
          <div
            key={syncNotice.tone}
            role={syncNotice.tone === "error" ? "alert" : "status"}
            aria-live={syncNotice.tone === "error" ? undefined : "polite"}
            aria-atomic="true"
            className={
              // a11y (1.4.3): mirrors the status box below it exactly (same
              // structure, pink swapped in for blue) rather than the brand's
              // literal `#FF2EB3` — this container renders in BOTH light and
              // dark (`bg-white dark:bg-gray-800`, unlike the always-dark
              // review modal), and pink text at any low opacity measures
              // under 4.5:1 against both a near-white light background and
              // this file's `gray-800` dark one. Tailwind's `pink-*` scale,
              // paired the same way `blue-*` already is below, measures
              // 6.7:1 light / 10.1:1 dark.
              syncNotice.tone === "error"
                ? "p-2 mb-3 bg-pink-100 dark:bg-pink-900/30 border border-pink-300 dark:border-pink-700 rounded-md text-pink-800 dark:text-pink-200 text-sm"
                : "p-2 mb-3 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 rounded-md text-blue-800 dark:text-blue-200 text-sm"
            }
          >
            {syncNotice.text}
            {/* NEO-102 — the post-commit call-to-action, in place of the
                walker opening itself.

                Rendered inline in this banner because this is where the
                operator is already looking the instant a commit lands, and
                ONLY on the notice `runCommit` marks `kind: "committed"` —
                never on tone alone. Tone is far too broad: "Fetch cancelled —
                no cards saved." is also a `status` notice, and a set holding
                a teamless custom card turned that into an offer to fix cards
                the operator had just declined to save. The tone still matters
                for the live region itself: the count is REACTIVE (the
                background BSC team pass keeps flagging rows for seconds
                after the commit), and `aria-atomic` means every change
                re-announces the whole region — polite in a role="status", but
                assertively interrupting in the role="alert" a failure banner
                becomes, which is a second reason the CTA never appears on
                one.

                a11y: a real <button> inside the existing live region, so it
                is in the tab order and announced with the region it belongs
                to. Its visible text IS its accessible name — no aria-label —
                which keeps it distinct from the header row's button and
                satisfies 2.5.3 trivially. The header row's own sr-only
                role="status" line still carries the count when no banner is
                showing, which is most of the time.

                a11y (1.4.3 / 1.4.11): deliberately NOT the header button's
                `hover:text-[#00D558] focus:outline-none` treatment. Neon
                green measures 1.65:1 against this banner's `bg-blue-100`
                light background, so recolouring the text on hover/focus
                would drop it below 4.5:1, and suppressing the outline on top
                of that would leave no focus indicator at all. Hover changes
                only the underline STYLE (no colour change, so contrast is
                unchanged), and the UA focus ring is left in place. */}
            {syncNotice.kind === "committed" && attentionCount > 0 && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={openAttentionWalker}
                  className="rounded-sm font-semibold underline decoration-dotted hover:decoration-solid"
                >
                  {`${attentionCount} need attention — Fix them one at a time`}
                </button>
              </>
            )}
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

        {/* NEO-102 — the set-level attention row. Only rendered when there is
            something to say (or the filter is on and has emptied the grid, so
            the operator always has the control that got them there).

            Two controls, deliberately, because they answer two questions: the
            Chip filters the grid to the flagged rows ("which ones?"), and the
            link opens the walker ("fix them"). Overloading one control would
            make it impossible to look at the list without being put into a
            modal. */}
        {(attentionCount > 0 || attentionOnly) && (
          <div className="flex items-center gap-2 flex-wrap mb-3">
            {/* a11y (1.4.3): text-gray-400 with no dark: variant measures
                2.60:1 against this container's light-mode bg-white (needs
                4.5:1). text-gray-500 dark:text-gray-400 is the pairing this
                same file already uses for secondary text that must survive
                both themes (see the `lastSynced` line above) — 4.84:1 light /
                6.82:1 dark, both pass. The sibling "Cross-release" label a few
                lines up has the identical (unfixed) defect; out of scope here
                since it predates this commit — flagged in the audit report. */}
            <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide w-24 shrink-0">
              Attention
            </span>
            <Chip
              label={`${attentionCount} need attention`}
              ariaLabel={`Show only cards needing attention${attentionOnly ? " (on)" : ""}`}
              title="Cards with a question nobody has answered yet — start with no team on the card"
              active={attentionOnly}
              onClick={() => setAttentionOnly((v) => !v)}
            />
            {attentionCount > 0 && (
              <button
                type="button"
                onClick={openAttentionWalker}
                aria-label={`Fix cards needing attention one at a time (${attentionCount})`}
                // a11y (1.4.3): same gray-400-with-no-dark:-variant fix as the
                // label above.
                className="text-xs text-gray-500 dark:text-gray-400 underline decoration-dotted hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
              >
                Fix them one at a time
              </button>
            )}
            {/*
              The chip's own label changes silently — a screen reader is never
              told that the count went from 5 to 4 when a card is fixed. This
              is the live region that says it. Visually hidden because the chip
              beside it already carries the number on screen; saying it twice
              would be clutter, and saying it nowhere would be a regression.

              role="status" with no explicit aria-live, per
              accessibility-auditor/live-region-role-pattern.md: the role
              already implies a polite live region, and this line never
              switches to role="alert".
            */}
            <p className="sr-only" role="status">
              {attentionCount} {attentionCount === 1 ? "card needs" : "cards need"}{" "}
              attention on this checklist
            </p>
          </div>
        )}

        {sortedCards.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-gray-500 dark:text-gray-400 mb-4">
              No cards in this checklist yet.
            </p>
            <NeonButton
              ref={syncButtonRef}
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

      {/* NEO-102 — the attention pass. Opened only by hand (header row or the
          post-commit banner's CTA), and kept mounted only while open; it
          takes the FULL row list and derives its own queue, so rows arriving
          from the background BSC pass join it without the walker losing the
          card on screen. */}
      {walkerOpenedByHand && cards && (
        <CardAttentionWalker
          isOpen
          cards={cards}
          sportId={ancestorSportId}
          // a11y: the durable restore target, because the control that opened
          // this may not survive the sitting — both entry points unmount at
          // `attentionCount === 0`, which is exactly the state the walker is
          // in when the operator closes it from the all-clear step. Restoring
          // to the walker's own activeElement-at-mount capture would then be
          // restoring to a detached node. This Sync button is always mounted.
          restoreFocusRef={syncButtonRef}
          onClose={closeAttentionWalker}
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

      {pendingReview && (
        <SyncReviewModal
          isOpen
          diff={pendingReview.diff}
          setLabel={variantRow?.value}
          saving={committing}
          // a11y: see syncButtonRef's own comment — this modal opens across
          // an async gap from whatever CardPairingModal's trigger was, so its
          // own document.activeElement-at-mount capture cannot be trusted.
          restoreFocusRef={syncButtonRef}
          // Escape and "Skip changes" are the SAME non-destructive forward
          // step: carry on with nothing extra applied. Deliberately not the
          // pairing modal's abort — see the note at the top of
          // sync-review-modal.tsx.
          onSkip={() => void handleSyncReviewDone(NO_SYNC_DECISIONS)}
          onConfirm={(review) => void handleSyncReviewDone(review)}
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
