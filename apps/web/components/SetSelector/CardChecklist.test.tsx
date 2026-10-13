/**
 * NEO-189 regression — cancelling the pairing dialog mid-fetch must stick.
 *
 * Before `syncGenerationRef`, `handleSync` only reacted to the fetch action's
 * result AFTER it resolved. Streaming (NEO-195) made the pairing modal open
 * seconds into the fetch instead of ~80s later, so Cancel now routinely lands
 * while `fetchChecklist` is still in flight. Without a guard, that action's
 * eventual (late) resolution unconditionally reopened the dialog and
 * overwrote "Sync cancelled — no cards saved." with its own result — an
 * operator who declined a sync and walked away would return to a re-opened
 * Confirm dialog on a checklist they had already refused.
 *
 * `syncGenerationRef` is bumped by Cancel; the run captures its own
 * generation before awaiting, and after the await a stale generation makes it
 * return without touching state (including the `finally` clearing
 * `syncing`/`fetchInFlight` only when still current).
 *
 * This file pins: a cancel that lands while `fetchChecklist` is in flight
 * survives that fetch resolving afterwards — the dialog does not reopen and
 * the cancelled message stands.
 *
 * It also pins the three things the fetch action's RETURN used to be
 * responsible for, now that it returns only `{ success, message,
 * candidateCount }` and the cards travel solely on the streamed
 * `getReadyCandidates` subscription:
 *
 *   - the dialog SURVIVES the action resolving (it used to hand over to
 *     `pendingPairing`, a second complete copy of the same rows; nothing
 *     hands over any more, so the stream has to keep it open by itself);
 *   - a run that produces no candidates still skips the dialog and goes
 *     straight to entity resolution, keyed on the sport row read off the
 *     ancestor chain rather than off the action's return;
 *   - a failed run closes the dialog rather than leaving a partial batch
 *     sitting there confirmable.
 *
 * --- Mocking strategy ---
 * convex/react's useQuery/useMutation/useAction are module-mocked and routed
 * by the (string-mocked) query/mutation/action reference, mirroring
 * EntityColumn.ensure-sync.test.tsx. `fetchCardChecklist` resolves via a
 * manually-controlled deferred promise so the test can cancel before it
 * settles and then settle it afterward to prove the late result is dropped.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { NO_MARKETPLACE_IDS_MESSAGE } from "../../convex/marketplaceResolvability";
import {
  PARALLEL_BUILD_HEADING_ID,
  parallelLineId,
  type ParallelBuildRunner,
} from "./ParallelBuildPanel";

// ---------------------------------------------------------------------------
// Module mocks — declared before the component import
// ---------------------------------------------------------------------------

vi.mock("../../convex/_generated/api", () => ({
  api: {
    selectorOptions: {
      getCardChecklist: "getCardChecklist",
      getSelectorOptionById: "getSelectorOptionById",
      getAncestorChain: "getAncestorChain",
      fetchCardChecklist: "fetchCardChecklist",
      // NEO-255: the content-diff query, reached through `useConvex().query`
      // rather than a hook. Every test before this ticket drove the
      // zero-candidate route and short-circuited in front of it, so the
      // reference never had to resolve; the auto-keep path goes through it.
      diffChecklistAgainstExisting: "diffChecklistAgainstExisting",
      resolveChecklistEntities: "resolveChecklistEntities",
      commitCardChecklist: "commitCardChecklist",
      addCustomCard: "addCustomCard",
      // NEO-221: the attention walker's UnreviewedNameFixer writes through
      // this one.
      updateCard: "selectorOptions.updateCard",
      // Referenced by CrossListingImportModal, which CardChecklist always
      // mounts (isOpen=false). Never asserted on here.
      getSelectorOptions: "getSelectorOptions",
      addCrossListingsByCardNumbers: "addCrossListingsByCardNumbers",
    },
    checklistCandidates: {
      getReadyCandidates: "getReadyCandidates",
      discardCandidates: "discardCandidates",
    },
    // NEO-102: reached once real card rows render (CardChecklistItem's team
    // sub-line, TeamPicker inside the attention walker's fixer) or the walker
    // opens. Routed through the same string-reference mock as everything else.
    teams: {
      getManyByIds: "teams.getManyByIds",
      pickerCandidates: "teams.pickerCandidates",
      findOrCreate: "teams.findOrCreate",
    },
    // NEO-221: UnreviewedNameFixer mounts the REAL PlayerPicker, which needs
    // all three of these to resolve.
    players: {
      getManyByIds: "players.getManyByIds",
      list: "players.list",
      findOrCreate: "players.findOrCreate",
    },
    cardChecklist: {
      suggestedTeamsForCard: "cardChecklist.suggestedTeamsForCard",
      confirmCardNoTeam: "cardChecklist.confirmCardNoTeam",
    },
    // NEO-212: SkippedNamesPanel, mounted unconditionally under the sync
    // notice. It renders nothing unless the set has skips, but the references
    // still have to resolve — hence these entries even for the many tests
    // below that never look at it.
    entityReviewSkips: {
      listForSet: "entityReviewSkips.listForSet",
      clearSkip: "entityReviewSkips.clearSkip",
    },
    // NEO-236: TeamPicker's create row opens `NewTeamDialog`, whose shared
    // `NewTeamForm` reads the sport's leagues for its League pills. The
    // reference has to resolve even though this file never asserts on it —
    // the routed `useQuery` mock returns undefined, which the form renders as
    // "Loading leagues…".
    leagues: { list: "leagues.list" },
    // NEO-287: the pause switch the solo decision subtracts before the fetch.
    marketplacePause: { getPausedPlatforms: "getPausedPlatforms" },
    // NEO-312: the parallel-build runner's own two calls. `getParallelsForBuild`
    // is reached through `useConvex().query` (the runner's `start`, exactly
    // like `diffChecklistAgainstExisting`); `buildParallelChecklist` is both
    // `useConvex().action` (the runner) and `useAction` (the parallel row's own
    // manual button) — the SAME mock backs both call shapes.
    parallelChecklistBuild: {
      getParallelsForBuild: "getParallelsForBuild",
      buildParallelChecklist: "buildParallelChecklist",
    },
  },
}));

/**
 * NEO-102 — Virtuoso renders nothing measurable under jsdom (no layout), so
 * the attention tests below could not see a card row through it. Replaced with
 * a plain map, which is what the row-level assertions actually need. Every
 * pre-existing test in this file drives the zero-candidate path with
 * `state.cards = []`, so this changes nothing for them.
 */
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => <div>{data.map((item, i) => <div key={i}>{itemContent(i, item)}</div>)}</div>,
}));

/**
 * NEO-102 (CI round 2): the entity-review wizard is stubbed down to the props
 * its PARENT owns. The real wizard would drag in the whole
 * `entityReviewQueue` query/mutation surface to prove facts about
 * CardChecklist; its own behaviour is covered by EntityReviewWizard.test.tsx.
 *
 * NEO-221 widened the stub with the three props D6/D9/D10 added — `summary`,
 * `onBack` and `commitError`/`onDismissCommitError`. Each is rendered as plain
 * text or a button so a test can read back exactly what the parent decided:
 * what the final step will claim it is saving, whether there is a pairing
 * session to return to, and whether a failed commit was reported without
 * throwing the review away.
 */
vi.mock("./EntityReviewWizard", () => ({
  default: ({
    summary,
    onConfirm,
    onCancel,
    onBack,
    commitError,
    onDismissCommitError,
    teamsOnly,
    previewCards,
    onTeamAnswersChange,
    cardsWithSettledTeam,
    cardsWithNoPlayers,
    skippedPlayerNames,
    skippedTeamNames,
    titleContext,
    existingCardIndexes,
    onTitleAnswersChange,
    onListingShortNameChange,
  }: {
    // NEO-335 Phase 2 — the titles step, reduced to the parent's half: the
    // context and positions it hands down, and the commit-field channel.
    titleContext?: unknown;
    existingCardIndexes?: number[];
    onTitleAnswersChange?: (
      fields: Array<{ listingTitleKept?: string; listingTitle?: string } | undefined> | undefined,
    ) => void;
    // NEO-335 title rules — the step's short name for titles.
    onListingShortNameChange?: (value: string | undefined) => void;
    // NEO-335 — the final step's teams section, reduced to what the parent
    // owns: whether the wizard opened teams-only, and the answer channel.
    teamsOnly?: boolean;
    previewCards?: unknown[];
    onTeamAnswersChange?: (answers: Array<{ teamNone?: true } | undefined>) => void;
    cardsWithSettledTeam?: number[];
    // NEO-335 — who the stored data says is on the cards.
    cardsWithNoPlayers?: number[];
    skippedPlayerNames?: string[];
    skippedTeamNames?: string[];
    summary: {
      cardCount: number;
      deleteCount: number;
      reviewDecisionCount: number;
    };
    onConfirm: () => void;
    onCancel: () => void;
    onBack?: () => void;
    commitError?: string | null;
    onDismissCommitError?: () => void;
  }) => (
    <div>
      <p>
        {`Wizard summary: ${summary.cardCount} cards, ${summary.deleteCount} deletions, ${summary.reviewDecisionCount} field decisions`}
      </p>
      {commitError && <p>{`Wizard commit error: ${commitError}`}</p>}
      {teamsOnly && <p>Wizard opened teams-only</p>}
      {onTeamAnswersChange && (
        <button
          type="button"
          onClick={() =>
            onTeamAnswersChange((previewCards ?? []).map(() => ({ teamNone: true })))
          }
        >
          Answer every card with no team
        </button>
      )}
      {onTeamAnswersChange && (
        <button
          type="button"
          onClick={() =>
            onTeamAnswersChange(
              (previewCards ?? []).map((_, i) => (i === 1 ? { teamNone: true } : undefined)),
            )
          }
        >
          Answer only the second card
        </button>
      )}
      {cardsWithSettledTeam && (
        <p>{`Settled-team positions: [${cardsWithSettledTeam.join(",")}]`}</p>
      )}
      {cardsWithNoPlayers && (
        <p>{`No-player positions: [${cardsWithNoPlayers.join(",")}]`}</p>
      )}
      {skippedPlayerNames && (
        <p>{`Skipped player names: [${skippedPlayerNames.join(",")}]`}</p>
      )}
      {skippedTeamNames && (
        <p>{`Skipped team names: [${skippedTeamNames.join(",")}]`}</p>
      )}
      <p>{`Title context: ${titleContext ? "yes" : "no"}`}</p>
      {existingCardIndexes && (
        <p>{`Existing positions: [${existingCardIndexes.join(",")}]`}</p>
      )}
      {onTitleAnswersChange && (
        <button
          type="button"
          onClick={() =>
            onTitleAnswersChange(
              (previewCards ?? []).map((_, i) =>
                i === 0 ? { listingTitleKept: "Kept title" } : { listingTitle: "My own title" },
              ),
            )
          }
        >
          Report title answers
        </button>
      )}
      {onTitleAnswersChange && (
        <button type="button" onClick={() => onTitleAnswersChange(undefined)}>
          Report no titles step
        </button>
      )}
      {onListingShortNameChange && (
        <button type="button" onClick={() => onListingShortNameChange("Topps Hologram")}>
          Report a short name
        </button>
      )}
      {onListingShortNameChange && (
        <button type="button" onClick={() => onListingShortNameChange(undefined)}>
          Report no short name
        </button>
      )}
      <button type="button" onClick={onConfirm}>
        Confirm entity review
      </button>
      <button type="button" onClick={onCancel}>
        Cancel entity review
      </button>
      {/* Rendered ONLY when the prop is present — that presence is itself the
          assertion in the "custom subtree has nothing to go back to" test. */}
      {onBack && (
        <button type="button" onClick={onBack}>
          Back to matching
        </button>
      )}
      {onDismissCommitError && (
        <button type="button" onClick={onDismissCommitError}>
          Dismiss commit error
        </button>
      )}
    </div>
  ),
}));

const mockFetchChecklist = vi.fn();
const mockResolveEntities = vi.fn();
const mockCommitChecklist = vi.fn();
const mockDiffChecklist = vi.fn();
const mockDiscardCandidates = vi.fn();
// NEO-312 — the parallel-build runner's two calls. Both default to a
// no-parallels / never-called shape in every describe block that does not
// reset them, so every pre-existing test in this file is unaffected: a plain
// insert or Base checklist with no `parallelBuild` prop never reaches either.
const mockGetParallelsForBuild = vi.fn();
const mockBuildParallelChecklist = vi.fn();
// NEO-208: the quick-add form's mutation. It was already listed in the `api`
// mock above but never routed to a spy, because nothing exercised the form —
// it had no component test at all before this ticket.
const mockAddCustomCard = vi.fn();
const mockFindOrCreateTeam = vi.fn();
// NEO-221 — the attention walker's UnreviewedNameFixer.
const mockUpdateCard = vi.fn();
const mockFindOrCreatePlayer = vi.fn();

// Mutable holders read lazily by the mocked hooks at call time — same shape
// as EntityColumn.ensure-sync.test.tsx's `state`.
const state: {
  cards: unknown;
  variantRow: unknown;
  ancestorChain: unknown;
  liveCandidates: unknown;
  /**
   * NEO-208: the `teams` table, for the REAL `TeamPicker` now living in the
   * quick-add form. Serves both `teams.pickerCandidates` (the typeahead's candidate pool)
   * and `teams.getManyByIds` (the chip labels) — the mocked `useQuery` ignores
   * arguments, and returning the same rows for both is exactly right here:
   * every id the picker can hold came from this pool.
   *
   * Defaults to `[]`, which is what the mock returned unconditionally before,
   * so every pre-existing test in this file is untouched.
   */
  teams: Array<{ _id: string; name: string }>;
  /**
   * NEO-221: the `players` table, for the REAL `PlayerPicker` inside
   * `UnreviewedNameFixer`. Serves `players.list` (typeahead candidates) and
   * `players.getManyByIds` (chip labels), exactly as `teams` does for
   * `TeamPicker` — the mocked `useQuery` ignores arguments.
   */
  players: Array<{ _id: string; name: string }>;
  /**
   * NEO-212: rows for `entityReviewSkips.listForSet`. `[]` — no skips — is the
   * state every pre-existing test in this file runs in, and SkippedNamesPanel
   * renders nothing for it, so the checklist is visually unchanged for them.
   */
  skippedNames: Array<{
    _id: string;
    kind: "player" | "team";
    name: string;
    skippedAt: number;
  }>;
  /** NEO-287: paused credential site keys, as `getPausedPlatforms` returns them. */
  paused: string[];
} = {
  cards: [],
  variantRow: { value: "Test Set" },
  ancestorChain: [],
  liveCandidates: null,
  teams: [],
  players: [],
  paused: [],
  skippedNames: [],
};

const pickerArgs: unknown[] = [];

vi.mock("convex/react", () => ({
  useQuery: (ref: string, args: unknown) => {
    if (ref === "teams.pickerCandidates") pickerArgs.push(args);
    if (ref === "getCardChecklist") return state.cards;
    if (ref === "getSelectorOptionById") return state.variantRow;
    if (ref === "getAncestorChain") return state.ancestorChain;
    if (ref === "getReadyCandidates") return state.liveCandidates;
    if (ref === "getPausedPlatforms") return state.paused;
    // NEO-102: the walker's fixer reads suggestions per card; [] keeps it
    // resolved-but-empty, which is the "no career history" shape.
    if (ref === "cardChecklist.suggestedTeamsForCard") return [];
    if (ref === "teams.getManyByIds") return state.teams;
    // NEO-331: the picker's candidate pool arrives ranked, as `{ team, tier }`.
    if (ref === "teams.pickerCandidates") {
      return state.teams.map((team) => ({ team, tier: 1 }));
    }
    if (ref === "players.getManyByIds" || ref === "players.list") {
      return state.players;
    }
    if (ref === "entityReviewSkips.listForSet") return state.skippedNames;
    // CrossListingImportModal's drill-down queries — never exercised here.
    return undefined;
  },
  useMutation: (ref: string) => {
    if (ref === "discardCandidates") return mockDiscardCandidates;
    if (ref === "addCustomCard") return mockAddCustomCard;
    if (ref === "teams.findOrCreate") return mockFindOrCreateTeam;
    if (ref === "players.findOrCreate") return mockFindOrCreatePlayer;
    if (ref === "selectorOptions.updateCard") return mockUpdateCard;
    return vi.fn();
  },
  useAction: (ref: string) => {
    if (ref === "fetchCardChecklist") return mockFetchChecklist;
    if (ref === "resolveChecklistEntities") return mockResolveEntities;
    // NEO-189: commitCardChecklist became an ACTION when the commit was
    // chunked server-side. Same call shape, different hook.
    if (ref === "commitCardChecklist") return mockCommitChecklist;
    // NEO-312: `ParallelBuildButton`'s own `useAction` call — the manual,
    // one-parallel build from its own row.
    if (ref === "buildParallelChecklist") return mockBuildParallelChecklist;
    return vi.fn();
  },
  // NEO-203: the content-diff review is a ONE-SHOT query (see the note on
  // `useConvex` in CardChecklist.tsx — a subscription keyed on the whole
  // confirmed card array would re-diff under the operator mid-review). Every
  // flow in this file drives the zero-candidate path, which short-circuits
  // before the diff is ever requested, so this only has to exist.
  //
  // NEO-312: the SAME client also carries the parallel-build runner's two
  // calls (`useParallelBuildRun`'s own internal `useConvex()`, and the
  // explicit client `CardChecklist` passes to `parallelRun.start`). Routed by
  // ref exactly like `useQuery`/`useAction` above; `mockDiffChecklist` still
  // receives `(ref, args)` for every OTHER ref, so every existing assertion
  // that reads `mockDiffChecklist.mock.calls[0]` is unaffected.
  useConvex: () => ({
    query: (ref: string, args?: unknown) =>
      ref === "getParallelsForBuild"
        ? mockGetParallelsForBuild(args)
        : mockDiffChecklist(ref, args),
    action: (ref: string, args?: unknown) =>
      ref === "buildParallelChecklist"
        ? mockBuildParallelChecklist(args)
        : Promise.resolve(undefined),
  }),
}));

// ---------------------------------------------------------------------------
// Component under test — imported after mocks
// ---------------------------------------------------------------------------

import CardChecklist, {
  SOLO_STREAM_TIMEOUT_MESSAGE,
  TEAMS_LATE_NOTICE,
  streamRowsArrived,
  streamTeamsLanded,
} from "./CardChecklist";

/**
 * Every live-region line on the page, hidden ones included: the sync banner
 * sits behind the pairing dialog, which may hide the page from AT queries.
 */
function liveRegionText(): string {
  return Array.from(
    document.querySelectorAll('[role="status"], [role="alert"]'),
  )
    .map((el) => el.textContent ?? "")
    .join(" | ");
}

/**
 * The fetch's own words when it published nothing because neither marketplace
 * side was resolvable — NEO-239 replaced the old "custom subtree" gate (any
 * custom ancestor skips both marketplaces) with a per-side resolvability check
 * (a side is fetched only when the ids it needs are present, otherwise skipped,
 * never guessed by name).
 *
 * Imported from the server's own constant rather than retyped, so a reworded
 * skip message cannot leave this fixture asserting a sentence the fetch stopped
 * saying. It is a PAYLOAD fixture either way: these tests drive the
 * zero-candidate route and care only that `candidateCount: 0` short-circuits
 * before anything is published, and the component renders `message` verbatim
 * without ever parsing it.
 */
const NOTHING_TO_FETCH_MESSAGE = NO_MARKETPLACE_IDS_MESSAGE;

const VARIANT_ID = "variant-1" as unknown as Id<"selectorOptions">;
const SPORT_ID = "sport-1" as unknown as Id<"selectorOptions">;
const SET_ID = "set-1" as unknown as Id<"selectorOptions">;
/** NEO-255 — a second variant, for the "operator switched sets mid-run" test. */
const OTHER_VARIANT_ID = "variant-2" as unknown as Id<"selectorOptions">;

/**
 * NEO-255 — an ancestor chain for a set with BOTH marketplaces attached.
 *
 * Every test in this file that reaches the pairing dialog now needs one, and
 * that is the point of the ticket rather than test bookkeeping: the client
 * decides whether to open the dialog at all from `attachedSidesOf` over this
 * chain, BEFORE the fetch. A chain carrying no marketplace ids is a set with
 * nothing to match, and skipping the dialog for it is now correct behaviour —
 * so a fixture that wants the dialog has to describe a set that has two
 * marketplaces to line up.
 *
 * The shape is the ordinary synced one: BSC files the set at `setName`,
 * SportLots hangs its single flat set id off the variant row.
 */
const twoSidedChain = () => [
  {
    _id: SPORT_ID,
    level: "sport",
    value: "Baseball",
    platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "1" } },
  },
  {
    _id: SET_ID,
    level: "setName",
    value: "Test Set",
    platformData: { bsc: { b0: "2024-topps" } },
  },
  {
    _id: VARIANT_ID,
    level: "variantType",
    value: "Base",
    platformData: { sportlots: { s0: "884412" } },
  },
];

/**
 * NEO-255 — the same chain with only SportLots attached: the set's BSC link is
 * gone, so there is one marketplace and nothing to match.
 */
const soloSlChain = () => [
  {
    _id: SPORT_ID,
    level: "sport",
    value: "Baseball",
    platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "1" } },
  },
  { _id: SET_ID, level: "setName", value: "Test Set", platformData: {} },
  {
    _id: VARIANT_ID,
    level: "variantType",
    value: "Base",
    platformData: { sportlots: { s0: "884412" } },
  },
];

function renderChecklist() {
  return render(
    <CardChecklist
      variantId={VARIANT_ID}
      sourceChips={{}}
      sourceLabelMaps={{ bsc: {}, sportlots: {} }}
    />,
  );
}

/**
 * NEO-255 — deliver a new `getReadyCandidates` value to the mounted component.
 *
 * The mocked `useQuery` reads `state` lazily rather than subscribing, so a new
 * batch only reaches the component (and, through its effect, the ref the
 * auto-keep path polls) on the next render. That is exactly what these tests
 * need to control: the whole point of the wait is that a batch arrives some
 * time after the fetch action resolves.
 */
async function streamCandidates(
  rerender: (ui: React.ReactElement) => void,
  value: unknown,
) {
  state.liveCandidates = value;
  await act(async () => {
    rerender(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      />,
    );
  });
}

/** A single streamed candidate, shaped like checklistCandidates.getReadyCandidates. */
const streamedCandidate = {
  cardNumber: "1",
  cardName: "Streamed Player",
  bucket: "matched" as const,
  confidence: 1,
  platformData: {
    bsc: { ref: "bsc-1" },
    sportlots: { ref: "sl-1" },
  },
};

/**
 * NEO-330 — the fetch PUBLISHES the batch it reports.
 *
 * Both paths now wait, before anything can be confirmed or committed, for the
 * subscription to show a batch whose id MOVED since Sync was pressed, whose
 * size matches `candidateCount`, and whose every row is `ready`. A fixture that
 * stages its rows on `state.liveCandidates` before Sync has no batch id to move
 * from, so this stamps a fresh one at the moment the fetch resolves — which is
 * what the real action's write does — and hands the result back unchanged.
 */
let publishedBatches = 0;
function publish<T>(result: T): T {
  const staged = state.liveCandidates as {
    total: number;
    batchId?: string;
  } | null;
  if (staged && staged.total > 0) {
    state.liveCandidates = {
      ...staged,
      batchId: `published-${++publishedBatches}`,
    };
  }
  return result;
}

describe("CardChecklist — cancel during an in-flight fetch (NEO-189)", () => {
  let resolveFetch: (value: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    // The sport row the commit path keys on. It used to ride back on
    // `fetchCardChecklist`'s return; the client reads it off the ancestor
    // chain it already subscribes to, so without one here Sync refuses to run
    // at all.
    state.ancestorChain = twoSidedChain();
    // Ready candidates from the very first render, so once `fetchInFlight`
    // flips true the modal has something to stream in immediately — this is
    // what makes the dialog open "seconds in" rather than only once the
    // action resolves.
    state.liveCandidates = {
      ready: 1,
      total: 1,
      cards: [streamedCandidate],
    };
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
  });

  it("does not reopen the dialog or overwrite the cancelled message when the abandoned fetch resolves afterward", async () => {
    renderChecklist();

    // Kick off the sync — the empty-checklist state renders its own
    // "Sync card checklist" button (sortedCards.length === 0 branch).
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    // The pairing dialog opens on the streamed candidate while the fetch is
    // still in flight — this is the "opens seconds in" behavior itself.
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(screen.getByLabelText("Cancel card matching")).toBeTruthy();

    // Operator cancels mid-fetch.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Cancel card matching"));
    });

    await waitFor(() =>
      expect(screen.getByText("Sync cancelled — no cards saved.")).toBeTruthy(),
    );
    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(mockDiscardCandidates).toHaveBeenCalledTimes(1);
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });

    // The abandoned fetch NOW resolves with a result that, if it were still
    // live, would reopen the dialog and put its own message on screen.
    await act(async () => {
      resolveFetch({ success: true, message: "Fetched 1 card", candidateCount: 1, attachedSides: ["bsc", "sportlots"] });
    });

    // The dialog must NOT reopen, and the operator's own cancelled message
    // must still stand — not the late fetch's "Fetched 1 card".
    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(screen.getByText("Sync cancelled — no cards saved.")).toBeTruthy();
    expect(screen.queryByText("Fetched 1 card")).toBeNull();

    // And the abandoned run must not have gone on to resolve entities or
    // commit anything — it returned as soon as it saw it was stale.
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
  });
});

/**
 * The half of the pairing session the action's return used to own.
 *
 * `streamedPairing` was gated on `fetchInFlight` and went null the instant the
 * fetch resolved; `pendingPairing` — the whole result, sent a second time —
 * took over from there and kept the dialog on screen. With that second copy
 * gone the stream is the only source, so the session flag has to outlive the
 * fetch on its own.
 */
describe("CardChecklist — the pairing session outlives the fetch", () => {
  let resolveFetch: (value: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = { ready: 1, total: 1, cards: [streamedCandidate] };
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    mockCommitChecklist.mockResolvedValue({ count: 0 });
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
  });

  it("keeps the dialog open once the fetch resolves, and unlocks Confirm", async () => {
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    // Open mid-fetch on the streamed candidate, Confirm still gated.
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
      "Loading…",
    );

    await act(async () => {
      resolveFetch(
        publish({
          success: true,
          message: "1 matched, 0 BSC-only, 0 SL-only",
          candidateCount: 1,
          attachedSides: ["bsc", "sportlots"],
        }),
      );
    });

    // Still open — this is the assertion that fails the moment the dialog is
    // gated on the fetch rather than on the review session.
    expect(screen.queryByText(/Match Cards/)).toBeTruthy();
    // And the streaming gate lifted, which is the E2E flow's sync point.
    // NEO-330: once the published batch has settled on the subscription, not
    // in the same tick the action resolves.
    await waitFor(() =>
      expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
        "Confirm",
      ),
    );
    expect(
      screen.getByText("1 matched, 0 BSC-only, 0 SL-only"),
    ).toBeTruthy();
    // Nothing was written by merely finishing the fetch.
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockDiscardCandidates).not.toHaveBeenCalled();
  });

  /**
   * NEO-330 — on the two-marketplace path, Confirm waits for the teams too.
   *
   * The action resolves before the subscription shows its last team patch, so
   * unlocking Confirm on the action's promise let an operator confirm cards
   * whose teams were still on their way. `fetchInFlight` (the dialog's
   * `isStreaming`) now holds until the published batch is whole and every row
   * is `ready`, and the dialog keeps saying so in the words it already uses.
   */
  describe("Confirm waits for every row to be ready (NEO-330)", () => {
    const pair = (n: string, player: string, teams?: string[]) => ({
      cardNumber: n,
      cardName: player,
      players: [player],
      ...(teams ? { teams } : {}),
      bucket: "matched" as const,
      confidence: 1,
      platformData: {
        bsc: { ref: `bsc-${n}` },
        sportlots: { ref: `sl-${n}` },
      },
    });
    /** Both rows published; one team lookup has not reached the client. */
    const halfResolved = {
      batchId: "batch-330-pair",
      ready: 1,
      total: 2,
      cards: [
        pair("1", "Elly De La Cruz", ["Cincinnati Reds"]),
        pair("2", "Hunter Greene"),
      ],
    };
    const allResolved = {
      batchId: "batch-330-pair",
      ready: 2,
      total: 2,
      cards: [
        pair("1", "Elly De La Cruz", ["Cincinnati Reds"]),
        pair("2", "Hunter Greene", ["Cincinnati Reds"]),
      ],
    };
    const fetchDone = {
      success: true,
      message: "2 matched, 0 BSC-only, 0 SL-only",
      candidateCount: 2,
      attachedSides: ["bsc", "sportlots"],
    };

    beforeEach(() => {
      // Nothing on the wire when Sync is pressed: the batch has to be seen
      // arriving, which is also what gives its id something to move from.
      state.liveCandidates = null;
      mockDiffChecklist.mockResolvedValue(NOTHING_TO_REVIEW);
    });

    it("stays gated after the fetch resolves, says how far the teams have got, and unlocks once they land", async () => {
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, halfResolved);
      expect(await screen.findByText(/Match Cards/)).toBeTruthy();

      await act(async () => {
        resolveFetch(fetchDone);
      });
      // Several poll turns on a complete batch with a team still missing.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

      const confirm = screen.getByLabelText("Confirm card matches");
      expect(confirm.textContent).toBe("Loading…");
      expect(confirm.getAttribute("aria-disabled")).toBe("true");
      // The existing line, now literally true: the fetch's own promise has
      // resolved, the teams have not all landed.
      expect(
        document.getElementById("pairing-streaming-status")?.textContent,
      ).toContain("(1 of 2 done)");

      // Activating the still-focusable Confirm does nothing.
      await act(async () => {
        fireEvent.click(confirm);
      });
      expect(mockDiffChecklist).not.toHaveBeenCalled();
      expect(mockResolveEntities).not.toHaveBeenCalled();
      expect(mockCommitChecklist).not.toHaveBeenCalled();

      // The last team lands.
      await streamCandidates(rerender, allResolved);
      await waitFor(() =>
        expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
          "Confirm",
        ),
      );
      expect(document.getElementById("pairing-streaming-status")).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Confirm card matches"));
      });
      await waitFor(() => expect(mockResolveEntities).toHaveBeenCalled());
      // The late team reached the dialog's cards (its append-only absorb merges
      // `teams` onto rows already shown) and from there entity resolution.
      const cards = mockResolveEntities.mock.calls[0][0].cards;
      expect(cards).toHaveLength(2);
      for (const card of cards) {
        expect(card.teams).toEqual(["Cincinnati Reds"]);
      }
    });

    /**
     * Jason, 2026-10-11: "If a team lookup never returns then the user must
     * select a team." The wait ends; the operator's pairing survives it.
     */
    // NEO-335: a card that would save with no team now opens the wizard
    // teams-only first; confirming it unanswered commits the card teamless,
    // exactly as this path committed it before.
    it("when a team misses the wait, unlocks Confirm with the notice and commits that card with no team", async () => {
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, halfResolved);
      expect(await screen.findByText(/Match Cards/)).toBeTruthy();

      vi.useFakeTimers();
      try {
        await act(async () => {
          resolveFetch(fetchDone);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
      } finally {
        vi.useRealTimers();
      }

      // Confirm unlocks; the dialog — and the pairing in it — is still there.
      await waitFor(() =>
        expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
          "Confirm",
        ),
      );
      expect(screen.getByText(/Match Cards/)).toBeTruthy();
      expect(mockDiscardCandidates).not.toHaveBeenCalled();
      expect(liveRegionText()).not.toContain(SOLO_STREAM_TIMEOUT_MESSAGE);
      expect(liveRegionText()).toContain(TEAMS_LATE_NOTICE);

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Confirm card matches"));
      });
      await waitFor(() => expect(mockResolveEntities).toHaveBeenCalled());
      const cards = mockResolveEntities.mock.calls[0][0].cards;
      expect(cards).toHaveLength(2);
      expect(cards.find((c: { cardNumber: string }) => c.cardNumber === "1").teams).toEqual([
        "Cincinnati Reds",
      ]);
      // Never a guess: the card whose lookup never landed carries no team.
      expect(
        cards.find((c: { cardNumber: string }) => c.cardNumber === "2").teams,
      ).toBeUndefined();
      // The operator is asked about it before save (NEO-335).
      expect(await screen.findByText("Wizard opened teams-only")).toBeTruthy();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      // Said again on the line the cards land with.
      await waitFor(() =>
        expect(liveRegionText()).toMatch(/Saved \d+ cards\./),
      );
      expect(liveRegionText()).toContain(TEAMS_LATE_NOTICE);
    });

    it("with a team fence the subscription never reaches, still ends the wait with the notice (NEO-330 × NEO-333)", async () => {
      // The fence is the readiness signal, but it does not lift the bound: a
      // fence the stream never reaches ends like any other late team.
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, halfResolved);
      expect(await screen.findByText(/Match Cards/)).toBeTruthy();

      vi.useFakeTimers();
      try {
        await act(async () => {
          resolveFetch({
            ...fetchDone,
            candidateBatchId: "batch-330-pair",
            readyAfterTeams: 2,
          });
        });
        // Still locked before the bound runs out.
        expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
          "Loading…",
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
      } finally {
        vi.useRealTimers();
      }

      await waitFor(() =>
        expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
          "Confirm",
        ),
      );
      expect(mockDiscardCandidates).not.toHaveBeenCalled();
      expect(liveRegionText()).not.toContain(SOLO_STREAM_TIMEOUT_MESSAGE);
      expect(liveRegionText()).toContain(TEAMS_LATE_NOTICE);
    });

    it("drops the notice if the late teams all land before Confirm", async () => {
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, halfResolved);
      expect(await screen.findByText(/Match Cards/)).toBeTruthy();

      vi.useFakeTimers();
      try {
        await act(async () => {
          resolveFetch(fetchDone);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
      } finally {
        vi.useRealTimers();
      }
      await waitFor(() =>
        expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
          "Confirm",
        ),
      );

      // The straggler lands while the operator is still pairing.
      await streamCandidates(rerender, allResolved);
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Confirm card matches"));
      });
      await waitFor(() =>
        expect(liveRegionText()).toMatch(/Saved \d+ cards\./),
      );
      expect(liveRegionText()).not.toContain(TEAMS_LATE_NOTICE);
      for (const card of mockResolveEntities.mock.calls[0][0].cards) {
        expect(card.teams).toEqual(["Cincinnati Reds"]);
      }
    });

    it("still saves nothing when the ROWS never arrive", async () => {
      // A short batch is a partial checklist, not a late team.
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, halfResolved);
      expect(await screen.findByText(/Match Cards/)).toBeTruthy();

      vi.useFakeTimers();
      try {
        await act(async () => {
          resolveFetch({ ...fetchDone, candidateCount: 3 });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
      } finally {
        vi.useRealTimers();
      }

      await waitFor(() =>
        expect(screen.getByText(SOLO_STREAM_TIMEOUT_MESSAGE)).toBeTruthy(),
      );
      expect(screen.queryByText(/Match Cards/)).toBeNull();
      expect(mockDiscardCandidates).toHaveBeenCalledWith({
        selectorOptionId: VARIANT_ID,
      });
      expect(mockResolveEntities).not.toHaveBeenCalled();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
      expect(liveRegionText()).not.toContain(TEAMS_LATE_NOTICE);
    });

    it("cancelling while it waits ends the run with the cancel message, not the timeout", async () => {
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, halfResolved);
      await act(async () => {
        resolveFetch(fetchDone);
      });

      await act(async () => {
        fireEvent.click(screen.getByLabelText("Cancel card matching"));
      });
      await waitFor(() =>
        expect(
          screen.getByText("Sync cancelled — no cards saved."),
        ).toBeTruthy(),
      );

      // The teams landing afterwards revive nothing.
      await streamCandidates(rerender, allResolved);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      expect(screen.queryByText(/Match Cards/)).toBeNull();
      expect(screen.queryByText(SOLO_STREAM_TIMEOUT_MESSAGE)).toBeNull();
      expect(mockResolveEntities).not.toHaveBeenCalled();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
    });
  });

  it("skips the dialog entirely when the run produced no candidates, using the ancestor chain's sport", async () => {
    // The nothing-to-fetch path: neither marketplace side is resolvable at
    // this level, so `fetchCardChecklist` short-circuits before publishing
    // anything. `candidateCount` is the whole signal — the client
    // cannot read it off the subscription, whose value at that instant may
    // still predate the batch write.
    state.liveCandidates = { ready: 0, total: 0, cards: [] };
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    await act(async () => {
      resolveFetch({
        success: true,
        message: NOTHING_TO_FETCH_MESSAGE,
        candidateCount: 0,
        attachedSides: ["bsc", "sportlots"],
      });
    });

    expect(screen.queryByText(/Match Cards/)).toBeNull();
    // The sport id came off `getAncestorChain`, which the client already
    // subscribes to for its pickers — not off the fetch's return.
    expect(mockResolveEntities).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
      sportId: SPORT_ID,
      cards: [],
    });
  });

  it("closes the dialog and discards the batch when the fetch reports failure", async () => {
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();

    await act(async () => {
      resolveFetch({
        success: false,
        message: "Failed to fetch checklist: BSC timed out",
        candidateCount: 0,
        attachedSides: ["bsc", "sportlots"],
      });
    });

    // A half-published batch must not stay on screen offering Confirm.
    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(
      screen.getByText("Failed to fetch checklist: BSC timed out"),
    ).toBeTruthy();
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
  });

  it("refuses to sync a row with no sport ancestor, before spending a marketplace round-trip", async () => {
    // The action used to answer with `sportId: undefined` and the client
    // silently showed the card counts of a sync it could not finish. Reading
    // the sport off the chain lets it fail before the fetch, not after.
    state.ancestorChain = [{ _id: VARIANT_ID, level: "variantType", value: "Base" }];
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    await waitFor(() =>
      expect(screen.getByText(/no sport ancestor/)).toBeTruthy(),
    );
    expect(mockFetchChecklist).not.toHaveBeenCalled();
    expect(screen.queryByText(/Match Cards/)).toBeNull();
  });

  it("a11y: the same notice set twice is a NEW live region, so it is said again", async () => {
    // A live region announces a change. Keyed by tone alone, the second
    // identical refusal changed nothing and a screen-reader user heard silence.
    state.ancestorChain = [{ _id: VARIANT_ID, level: "variantType", value: "Base" }];
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    const first = await screen.findByText(/no sport ancestor/);

    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    await waitFor(() =>
      expect(screen.getByText(/no sport ancestor/)).not.toBe(first),
    );
    expect(screen.getAllByText(/no sport ancestor/)).toHaveLength(1);
    expect(first.isConnected).toBe(false);
  });
});

/**
 * NEO-255 — the Match Cards dialog only when TWO OR MORE marketplaces are
 * ATTACHED to the set.
 *
 * The dialog lines the same card up across two marketplaces. With exactly one
 * attached there is no second column and nothing to line up, so the operator
 * was being made to press *Keep all* and then Confirm on a screen whose only
 * possible answer was "yes, all of them". That path now runs itself: every
 * fetched card is kept as a single linked to the one attached marketplace, and
 * the run carries straight on to the content-diff review and the entity wizard
 * exactly as a Confirm would have.
 *
 * The four properties these tests exist to hold:
 *
 *   1. ATTACHED, not fetched. The decision comes from the set's slots, before
 *      the call, so an outage or an empty side can never turn a two-marketplace
 *      set into a silent auto-commit.
 *   2. The dialog NEVER MOUNTS on the one-sided path — not even during the
 *      fetch, which is when it normally appears.
 *   3. Nothing is committed until the whole streamed batch has arrived. This
 *      path commits cards the operator never sees, so a partial batch would be
 *      a partial checklist written over a real set with nobody to notice.
 *   4. A DISAGREEMENT between the client's guess and the server's answer opens
 *      the dialog. It never auto-commits on a value the two ends do not share.
 */
describe("CardChecklist — one attached marketplace skips the dialog (NEO-255)", () => {
  let resolveFetch: (value: unknown) => void;

  /**
   * Two SportLots-only candidates — what a one-sided fetch publishes.
   *
   * NEO-335: each carries a team, so nothing would save teamless and the run
   * still commits with no dialog. (A teamless card on this path now opens the
   * wizard's final step — see the NEO-335 block at the end of this file.)
   */
  const slCandidates = [
    {
      cardNumber: "1",
      cardName: "Solo One",
      teams: ["Solo Team"],
      bucket: "slOnly" as const,
      platformData: { sportlots: { ref: "sl-1" } },
    },
    {
      cardNumber: "2",
      cardName: "Solo Two",
      teams: ["Solo Team"],
      bucket: "slOnly" as const,
      platformData: { sportlots: { ref: "sl-2" } },
    },
  ];

  /** The batch this run published, as the subscription reports it. */
  const arrivedBatch = {
    batchId: "batch-255",
    ready: 2,
    total: 2,
    cards: slCandidates,
  };

  /** A diff with nothing to settle, so the review is skipped as it is today. */
  const emptyDiff = {
    cards: [],
    removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 },
    conflicts: [],
    collisionInsertCount: 0,
    ambiguityBlockedCount: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = soloSlChain();
    state.skippedNames = [];
    // Nothing streamed at the moment Sync is pressed. The batch this run
    // publishes has to be seen ARRIVING — which is also what gives the "the
    // batch id must move" guard something to move from.
    state.liveCandidates = null;
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockDiffChecklist.mockResolvedValue(emptyDiff);
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    mockCommitChecklist.mockResolvedValue({ count: 2 });
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
  });

  it("keeps every fetched card as a single and commits it, with no dialog at any point", async () => {
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    // (2) No dialog while the fetch runs — which is exactly when it appears on
    // a two-sided set — and the inline progress line standing in for it.
    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(screen.getByText(/Fetching from SportLots/)).toBeTruthy();

    await streamCandidates(rerender, arrivedBatch);
    await act(async () => {
      resolveFetch({
        success: true,
        message: "0 matched, 0 BSC-only, 2 SL-only",
        candidateCount: 2,
        attachedSides: ["sportlots"],
      });
    });

    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
    expect(screen.queryByText(/Match Cards/)).toBeNull();

    // Every candidate, kept as a single marked by what it is MISSING: an
    // `slOnly` row has no BSC half, so `unmatched: "bsc"`. That value becomes
    // the committed card's `unmatched-bsc` attribute and its badge.
    const keptSingles = [
      expect.objectContaining({ cardNumber: "1", unmatched: "bsc" }),
      expect.objectContaining({ cardNumber: "2", unmatched: "bsc" }),
    ];
    expect(mockResolveEntities).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
      sportId: SPORT_ID,
      cards: keptSingles,
    });
    // The content-diff review is asked the same question a Confirm would ask
    // it, with no conflicts to zip on — a single has no second marketplace to
    // disagree with.
    expect(mockDiffChecklist).toHaveBeenCalledWith(
      "diffChecklistAgainstExisting",
      { selectorOptionId: VARIANT_ID, cards: keptSingles },
    );
    const committed = mockCommitChecklist.mock.calls[0][0];
    expect(committed.cards).toHaveLength(2);
    for (const card of committed.cards) {
      expect(card.unmatched).toBe("bsc");
      // `commitCardChecklist` throws on a card still carrying an open
      // question, so the auto-keep path must hand over committable cards.
      expect(card.nameConflict).toBeUndefined();
      expect(card.playersConflict).toBeUndefined();
    }

    await waitFor(() => expect(screen.getByText(/Saved 2 cards\./)).toBeTruthy());
    // a11y: pressing Sync disables the Sync button, and disabling the focused
    // element drops focus to <body>. On the two-sided path the dialog takes
    // focus and hands it back; here nothing does, so the run has to.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Sync card checklist"),
      ),
    );
  });

  /**
   * NEO-335 — no names to review is no longer "nothing to ask". A SportLots
   * sync of known players is the biggest source of teamless cards, so a card
   * that would save with no team opens the wizard straight onto its final
   * step instead of committing behind the operator's back.
   */
  describe("NEO-335: teamless cards with no names to review", () => {
    const teamlessBatch = {
      ...arrivedBatch,
      cards: slCandidates.map(({ teams: _teams, ...card }) => card),
    };

    async function syncTeamless(rerender: Parameters<typeof streamCandidates>[0]) {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, teamlessBatch);
      await act(async () => {
        resolveFetch({
          success: true,
          message: "0 matched, 0 BSC-only, 2 SL-only",
          candidateCount: 2,
          attachedSides: ["sportlots"],
        });
      });
      await waitFor(() => expect(mockResolveEntities).toHaveBeenCalled());
    }

    it("opens the wizard teams-only instead of committing, and commits on its Confirm with the answers on", async () => {
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);

      expect(await screen.findByText("Wizard opened teams-only")).toBeTruthy();
      expect(screen.getByText(/Wizard summary: 2 cards/)).toBeTruthy();
      expect(mockCommitChecklist).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Answer every card with no team"));
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });

      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
      const committed = mockCommitChecklist.mock.calls[0][0];
      expect(committed.batchId).toBeUndefined();
      expect(committed.cards.map((c: { teamNone?: true }) => c.teamNone)).toEqual([true, true]);
      await waitFor(() => expect(screen.queryByText(/Wizard summary/)).toBeNull());
    });

    it("an unanswered card commits exactly as it did before", async () => {
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
      for (const card of mockCommitChecklist.mock.calls[0][0].cards) {
        expect(card).not.toHaveProperty("teamNone");
        expect(card).not.toHaveProperty("teamIds");
        expect(card.teams).toBeUndefined();
      }
    });

    it("Cancel abandons the run and saves nothing", async () => {
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      fireEvent.click(screen.getByText("Cancel entity review"));
      expect(screen.getByText("Fetch cancelled — no cards saved.")).toBeTruthy();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
    });

    it("commits straight through when every teamless card re-syncs a stored row that has a team", async () => {
      // A re-sync keeps a stored row's team, so nothing would save teamless —
      // asking again on every re-sync would be asking an answered question.
      state.cards = [
        settledCard({ _id: "row-1", cardNumber: "1" }),
        settledCard({ _id: "row-2", cardNumber: "2", teamOnCardIds: undefined, teamNoneConfirmedAt: 5 }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 0, cardNumber: "1", cardName: "Solo One", bucket: "identical", existingId: "row-1", fields: [] },
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "identical", existingId: "row-2", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      expect(screen.queryByText(/Wizard summary/)).toBeNull();
    });

    it("still asks when only some of the re-synced rows already have a team", async () => {
      state.cards = [settledCard({ _id: "row-1", cardNumber: "1" })];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 0, cardNumber: "1", cardName: "Solo One", bucket: "identical", existingId: "row-1", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      expect(await screen.findByText("Wizard opened teams-only")).toBeTruthy();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
    });

    it("answers ride POSITIONALLY: only the card answered carries the answer", async () => {
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      fireEvent.click(screen.getByText("Answer only the second card"));
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
      const cards = mockCommitChecklist.mock.calls[0][0].cards;
      expect(cards[0]).not.toHaveProperty("teamNone");
      expect(cards[1].teamNone).toBe(true);
    });

    it("answers from a cancelled run never ride on the next run's commit", async () => {
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      fireEvent.click(screen.getByText("Answer every card with no team"));
      fireEvent.click(screen.getByText("Cancel entity review"));
      expect(mockCommitChecklist).not.toHaveBeenCalled();

      mockResolveEntities.mockClear();
      // The cancelled run's candidates are gone; the next run streams afresh.
      await streamCandidates(rerender, undefined);
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
      for (const card of mockCommitChecklist.mock.calls[0][0].cards) {
        expect(card).not.toHaveProperty("teamNone");
      }
    });

    it("hands the wizard the stored-team positions so a partly re-synced set asks only about the rest", async () => {
      state.cards = [settledCard({ _id: "row-2", cardNumber: "2" })];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "identical", existingId: "row-2", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      expect(screen.getByText("Settled-team positions: [1]")).toBeTruthy();
    });

    it("commits straight through when the node's set-level team covers the new cards", async () => {
      state.variantRow = { value: "Test Set", teamIds: ["team-set"] };
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      expect(screen.queryByText(/Wizard summary/)).toBeNull();
    });

    it("under a set-level team, still asks about a re-synced EXISTING teamless row (the commit only defaults new rows)", async () => {
      state.variantRow = { value: "Test Set", teamIds: ["team-set"] };
      // Card 1 re-syncs a stored row with no team; card 2 is a new row.
      state.cards = [
        settledCard({ _id: "row-1", cardNumber: "1", teamOnCardIds: undefined }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 0, cardNumber: "1", cardName: "Solo One", bucket: "identical", existingId: "row-1", fields: [] },
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "new", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      expect(await screen.findByText("Wizard opened teams-only")).toBeTruthy();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
      // Only the new row is settled by the set's team; the existing one is asked.
      expect(screen.getByText("Settled-team positions: [1]")).toBeTruthy();
    });

    it("NEO-335 Phase 2: hands the wizard the title context and the re-synced positions", async () => {
      mockResolveEntities.mockResolvedValue({
        unknownPlayers: [],
        unknownTeams: [],
        batchId: undefined,
        titleContext: { sportValue: "Baseball", setTeamNames: [], players: [], teams: [] },
      });
      state.cards = [settledCard({ _id: "row-2", cardNumber: "2", teamOnCardIds: undefined })];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "identical", existingId: "row-2", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      expect(screen.getByText("Title context: yes")).toBeTruthy();
      expect(screen.getByText("Existing positions: [1]")).toBeTruthy();
    });

    it("NEO-335 Phase 2: the titles step's answers ride positionally onto the commit", async () => {
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      fireEvent.click(screen.getByText("Answer only the second card"));
      fireEvent.click(screen.getByText("Report title answers"));
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
      const cards = mockCommitChecklist.mock.calls[0][0].cards;
      expect(cards[0].listingTitleKept).toBe("Kept title");
      expect(cards[0]).not.toHaveProperty("listingTitle");
      // Both answers on the same card: team and title.
      expect(cards[1].listingTitle).toBe("My own title");
      expect(cards[1].teamNone).toBe(true);
    });

    it("NEO-335 Phase 2: no title field rides when the titles step was not part of the sitting", async () => {
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      // Reported, then withdrawn (the wizard reports `undefined` until the
      // step has shown a card) — the commit must carry nothing of it.
      fireEvent.click(screen.getByText("Report title answers"));
      fireEvent.click(screen.getByText("Report no titles step"));
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
      for (const card of mockCommitChecklist.mock.calls[0][0].cards) {
        expect(card).not.toHaveProperty("listingTitleKept");
        expect(card).not.toHaveProperty("listingTitle");
        expect(card).not.toHaveProperty("cardVariationAnswered");
      }
    });

    it("NEO-335: the titles step's short name rides on the commit as the batch-level arg", async () => {
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      fireEvent.click(screen.getByText("Report a short name"));
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
      const args = mockCommitChecklist.mock.calls[0][0];
      expect(args.listingShortName).toBe("Topps Hologram");
      for (const card of args.cards) expect(card).not.toHaveProperty("listingShortName");
    });

    it("NEO-335: no short name reported (or withdrawn) — the commit carries no such arg", async () => {
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      fireEvent.click(screen.getByText("Report a short name"));
      fireEvent.click(screen.getByText("Report no short name"));
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
      expect(mockCommitChecklist.mock.calls[0][0]).not.toHaveProperty("listingShortName");
    });

    it("a re-synced row carrying only a pending team name is settled, not asked about", async () => {
      // A pending name already counts as a team for attention; the walker's
      // unreviewed-name step answers it, and a "no team" here would be ignored.
      state.cards = [
        settledCard({ _id: "row-1", cardNumber: "1" }),
        settledCard({
          _id: "row-2",
          cardNumber: "2",
          teamOnCardIds: undefined,
          pendingTeamNames: ["Gotham Knights"],
        }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 0, cardNumber: "1", cardName: "Solo One", bucket: "identical", existingId: "row-1", fields: [] },
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "identical", existingId: "row-2", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      expect(screen.queryByText(/Wizard summary/)).toBeNull();
    });

    /**
     * NEO-335 (CI run 38285320710, STEP 10) — a team name an earlier save
     * skipped as "not a team" has no review row on a re-sync (the gate drops
     * it), so it must not pass for a team that resolved without review.
     */
    async function syncPrintingSoloTeam(rerender: Parameters<typeof streamCandidates>[0]) {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, arrivedBatch);
      await act(async () => {
        resolveFetch({
          success: true,
          message: "0 matched, 0 BSC-only, 2 SL-only",
          candidateCount: 2,
          attachedSides: ["sportlots"],
        });
      });
      await waitFor(() => expect(mockResolveEntities).toHaveBeenCalled());
    }

    it("cards printing a team name with no review row commit straight through", async () => {
      const { rerender } = renderChecklist();
      await syncPrintingSoloTeam(rerender);
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      expect(screen.queryByText(/Wizard summary/)).toBeNull();
    });

    it("…unless the set's skip records rule that name 'not a team': the wizard opens teams-only", async () => {
      state.skippedNames = [{ _id: "skip-1", kind: "team", name: "Solo Team", skippedAt: 1 }];
      const { rerender } = renderChecklist();
      await syncPrintingSoloTeam(rerender);
      expect(await screen.findByText("Wizard opened teams-only")).toBeTruthy();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
      expect(screen.getByText("Skipped team names: [Solo Team]")).toBeTruthy();
    });

    it("a re-synced row whose only pending team name the set skipped is NOT settled", async () => {
      // A save before the server fix stamped the skipped name as pending; it
      // is no team waiting, so the card is asked about.
      state.skippedNames = [
        { _id: "skip-1", kind: "team", name: "gotham  KNIGHTS", skippedAt: 1 },
      ];
      state.cards = [
        settledCard({ _id: "row-1", cardNumber: "1" }),
        settledCard({
          _id: "row-2",
          cardNumber: "2",
          teamOnCardIds: undefined,
          pendingTeamNames: ["Gotham Knights"],
        }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 0, cardNumber: "1", cardName: "Solo One", bucket: "identical", existingId: "row-1", fields: [] },
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "identical", existingId: "row-2", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      expect(await screen.findByText("Wizard opened teams-only")).toBeTruthy();
      expect(screen.getByText("Settled-team positions: [0]")).toBeTruthy();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
    });

    it("a re-synced row whose only pending player name the set skipped is playerless", async () => {
      state.skippedNames = [
        { _id: "skip-1", kind: "player", name: "Chris Potter", skippedAt: 1 },
      ];
      state.cards = [
        settledCard({
          _id: "row-1",
          cardNumber: "1",
          teamOnCardIds: undefined,
          pendingPlayerNames: ["Chris Potter"],
        }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 0, cardNumber: "1", cardName: "Solo One", bucket: "identical", existingId: "row-1", fields: [] },
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "new", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      expect(screen.getByText("No-player positions: [0]")).toBeTruthy();
    });

    /**
     * The re-sync of an already-saved set, as the E2E drives it
     * (checklist-one-marketplace-skips-match-dialog STEP 10): the incoming
     * cards differ from the stored rows, so the content review opens, and
     * "Skip changes" applies nothing.
     */
    async function syncThroughReview(
      rerender: Parameters<typeof streamCandidates>[0],
      decide: "skip" | { applyFieldOf: RegExp },
    ) {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, teamlessBatch);
      await act(async () => {
        resolveFetch({
          success: true,
          message: "0 matched, 0 BSC-only, 2 SL-only",
          candidateCount: 2,
          attachedSides: ["sportlots"],
        });
      });
      if (decide === "skip") {
        const skip = await screen.findByRole("button", { name: /Skip reviewing changes/ });
        await act(async () => {
          fireEvent.click(skip);
        });
      } else {
        fireEvent.click(await screen.findByRole("checkbox", { name: decide.applyFieldOf }));
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: "Apply selected changes" }));
        });
      }
      await screen.findByText("Wizard opened teams-only");
    }

    const contentChange = (name: string, oldValue: string, newValue: string) => ({
      name,
      tier: 1,
      oldValue,
      newValue,
      source: "sportlots",
      foldEqual: false,
    });

    it("the stored-team positions survive the content review's Skip", async () => {
      state.cards = [
        settledCard({ _id: "row-1", cardNumber: "1", teamOnCardIds: undefined }),
        settledCard({ _id: "row-2", cardNumber: "2" }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 0, cardNumber: "1", cardName: "Solo One", bucket: "identical", existingId: "row-1", baseVersion: 1, fields: [] },
          {
            index: 1,
            cardNumber: "2",
            cardName: "Solo Two",
            bucket: "contentChanges",
            existingId: "row-2",
            baseVersion: 1,
            fields: [contentChange("teamOnCardIds", "Gotham Knights", "")],
          },
        ],
      });
      const { rerender } = renderChecklist();
      await syncThroughReview(rerender, "skip");
      expect(screen.getByText("Settled-team positions: [1]")).toBeTruthy();
    });

    it("hands the wizard the re-synced rows the save keeps with nobody on them", async () => {
      // Card 1 re-syncs a stored row with no players (its printed name was
      // skipped as "not a person" in the first save); card 2 re-syncs a row
      // that has a player. Neither has a team, so both are asked about — but
      // only card 1 belongs on the no-players line.
      state.cards = [
        settledCard({ _id: "row-1", cardNumber: "1", teamOnCardIds: undefined }),
        settledCard({
          _id: "row-2",
          cardNumber: "2",
          teamOnCardIds: undefined,
          playerIds: ["player-1"],
        }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          {
            index: 0,
            cardNumber: "1",
            cardName: "Solo One",
            bucket: "contentChanges",
            existingId: "row-1",
            baseVersion: 1,
            fields: [contentChange("playerIds", "", "Chris Potter")],
          },
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "identical", existingId: "row-2", baseVersion: 1, fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncThroughReview(rerender, "skip");
      expect(screen.getByText("Settled-team positions: []")).toBeTruthy();
      expect(screen.getByText("No-player positions: [0]")).toBeTruthy();
    });

    it("a row whose incoming players were ACCEPTED in the review is not playerless", async () => {
      state.cards = [
        settledCard({ _id: "row-1", cardNumber: "1", teamOnCardIds: undefined }),
        settledCard({ _id: "row-2", cardNumber: "2", teamOnCardIds: undefined }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          {
            index: 0,
            cardNumber: "1",
            cardName: "Solo One",
            bucket: "contentChanges",
            existingId: "row-1",
            baseVersion: 1,
            fields: [contentChange("playerIds", "", "Chris Potter")],
          },
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "identical", existingId: "row-2", baseVersion: 1, fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncThroughReview(rerender, { applyFieldOf: /to #1 Solo One/ });
      expect(screen.getByText("No-player positions: [1]")).toBeTruthy();
    });

    it("a stored row still holding a pending player name, and a NEW card, are never playerless", async () => {
      state.cards = [
        settledCard({
          _id: "row-1",
          cardNumber: "1",
          teamOnCardIds: undefined,
          pendingPlayerNames: ["Chris Potter"],
        }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 0, cardNumber: "1", cardName: "Solo One", bucket: "identical", existingId: "row-1", fields: [] },
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "new", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      expect(screen.getByText("No-player positions: []")).toBeTruthy();
    });

    it("hands the wizard the set's skipped PLAYER names, and not its skipped team names", async () => {
      state.skippedNames = [
        { _id: "skip-1", kind: "player", name: "Chris Potter", skippedAt: 1 },
        { _id: "skip-2", kind: "team", name: "Team Photo", skippedAt: 1 },
      ];
      const { rerender } = renderChecklist();
      await syncTeamless(rerender);
      await screen.findByText("Wizard opened teams-only");
      expect(screen.getByText("Skipped player names: [Chris Potter]")).toBeTruthy();
    });
  });

  /**
   * NEO-335 Phase 2 (D7) — no names and no teamless cards, but a NEW card
   * whose title the walker would flag: the wizard opens on its titles step
   * instead of committing (everything pre-save; the walker is a safety net).
   */
  describe("NEO-335 Phase 2: titles to look at with no names to review", () => {
    /** A set name long enough that every new card's title is trimmed. */
    const longTitles = {
      sportValue: "Baseball",
      setNameValue:
        "Chrome Update Series Sapphire Edition Platinum Anniversary Collectors Box Hobby Exclusive",
      inheritedFeatures: { manufacturer: "Topps", season: "2026" },
      setTeamNames: [],
      players: [],
      teams: [],
    };

    async function syncTeamed(rerender: Parameters<typeof streamCandidates>[0]) {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, arrivedBatch);
      await act(async () => {
        resolveFetch({
          success: true,
          message: "0 matched, 0 BSC-only, 2 SL-only",
          candidateCount: 2,
          attachedSides: ["sportlots"],
        });
      });
      await waitFor(() => expect(mockResolveEntities).toHaveBeenCalled());
    }

    it("opens the wizard (the no-names entry) when a new card's title needs a look", async () => {
      mockResolveEntities.mockResolvedValue({
        unknownPlayers: [],
        unknownTeams: [],
        batchId: undefined,
        titleContext: longTitles,
      });
      const { rerender } = renderChecklist();
      await syncTeamed(rerender);
      expect(await screen.findByText("Wizard opened teams-only")).toBeTruthy();
      expect(screen.getByText("Title context: yes")).toBeTruthy();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
    });

    it("commits straight through when no title needs a look", async () => {
      mockResolveEntities.mockResolvedValue({
        unknownPlayers: [],
        unknownTeams: [],
        batchId: undefined,
        titleContext: { ...longTitles, setNameValue: "Chrome" },
      });
      const { rerender } = renderChecklist();
      await syncTeamed(rerender);
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      expect(screen.queryByText(/Wizard summary/)).toBeNull();
    });

    it("commits straight through when every long-titled card re-syncs a stored row (it keeps its title)", async () => {
      mockResolveEntities.mockResolvedValue({
        unknownPlayers: [],
        unknownTeams: [],
        batchId: undefined,
        titleContext: longTitles,
      });
      state.cards = [
        settledCard({ _id: "row-1", cardNumber: "1" }),
        settledCard({ _id: "row-2", cardNumber: "2" }),
      ];
      mockDiffChecklist.mockResolvedValue({
        ...emptyDiff,
        cards: [
          { index: 0, cardNumber: "1", cardName: "Solo One", bucket: "identical", existingId: "row-1", fields: [] },
          { index: 1, cardNumber: "2", cardName: "Solo Two", bucket: "identical", existingId: "row-2", fields: [] },
        ],
      });
      const { rerender } = renderChecklist();
      await syncTeamed(rerender);
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      expect(screen.queryByText(/Wizard summary/)).toBeNull();
    });

    it("commits straight through with no title context at all (an older server answer)", async () => {
      const { rerender } = renderChecklist();
      await syncTeamed(rerender);
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      expect(screen.queryByText(/Wizard summary/)).toBeNull();
    });
  });

  it("says what it kept and why, in place of the matching step", async () => {
    // The operator knows this dialog exists. A step that silently does not
    // happen reads as a step that failed, so the banner has to account for it.
    // It stands for the whole commit, which is where this test catches it.
    let finishCommit: (value: unknown) => void = () => {};
    mockCommitChecklist.mockImplementation(
      () => new Promise((resolve) => (finishCommit = resolve)),
    );
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    await streamCandidates(rerender, arrivedBatch);
    await act(async () => {
      resolveFetch({
        success: true,
        message: "0 matched, 0 BSC-only, 2 SL-only",
        candidateCount: 2,
        attachedSides: ["sportlots"],
      });
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          "Kept all 2 cards from SportLots. Nothing to match, no other marketplace attached.",
        ),
      ).toBeTruthy(),
    );
    // The fetch's own three-bucket count is not what an operator on this path
    // needs to read — two of the three buckets cannot occur here.
    expect(screen.queryByText(/0 matched, 0 BSC-only/)).toBeNull();

    await act(async () => {
      finishCommit({ count: 2 });
    });
  });

  it("does not commit until the whole streamed batch has arrived", async () => {
    // (3) The action's `candidateCount` is the contract, and the subscription
    // has to agree with it before a single card is promoted.
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    // Half the batch on the wire so far.
    await streamCandidates(rerender, {
      batchId: "batch-255",
      ready: 1,
      total: 1,
      cards: [slCandidates[0]],
    });
    await act(async () => {
      resolveFetch({
        success: true,
        message: "0 matched, 0 BSC-only, 2 SL-only",
        candidateCount: 2,
        attachedSides: ["sportlots"],
      });
    });

    // Nothing written, and no dialog either — the run is still waiting.
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
    expect(screen.queryByText(/Match Cards/)).toBeNull();

    // The rest arrives.
    await streamCandidates(rerender, arrivedBatch);
    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
    expect(mockCommitChecklist.mock.calls[0][0].cards).toHaveLength(2);
  });

  it("cancelling a one-sided fetch discards the batch and commits nothing", async () => {
    // The dialog's Cancel is not on screen, so the inline line carries it —
    // and it has to be the same abort: supersede the run, bin the candidates,
    // and survive the fetch resolving afterwards.
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    expect(screen.getByText(/Fetching from SportLots/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Cancel checklist fetch"));
    });

    await waitFor(() =>
      expect(screen.getByText("Sync cancelled — no cards saved.")).toBeTruthy(),
    );
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
    // The progress line goes with the run it was reporting.
    expect(screen.queryByText(/Fetching from SportLots/)).toBeNull();
    // a11y: the Cancel the operator pressed has just unmounted under their own
    // focus, and no dialog opened to take it. Without the restore, focus lands
    // on <body> and a keyboard operator restarts from the top of the document.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Sync card checklist"),
      ),
    );

    // The abandoned fetch now comes back with a full, committable batch.
    await streamCandidates(rerender, arrivedBatch);
    await act(async () => {
      resolveFetch({
        success: true,
        message: "0 matched, 0 BSC-only, 2 SL-only",
        candidateCount: 2,
        attachedSides: ["sportlots"],
      });
    });

    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
    expect(screen.getByText("Sync cancelled — no cards saved.")).toBeTruthy();
    expect(screen.queryByText(/Match Cards/)).toBeNull();
  });

  it("two attached marketplaces still open the dialog and commit nothing on their own", async () => {
    // (1) The unchanged path, asserted from this block so a regression in
    // either direction fails here.
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = {
      batchId: "batch-255",
      ready: 1,
      total: 1,
      cards: [streamedCandidate],
    };
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(screen.queryByText(/Fetching from SportLots/)).toBeNull();

    await act(async () => {
      resolveFetch({
        success: true,
        message: "1 matched, 0 BSC-only, 0 SL-only",
        candidateCount: 1,
        attachedSides: ["bsc", "sportlots"],
      });
    });

    expect(screen.getByText(/Match Cards/)).toBeTruthy();
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
  });

  it("opens the dialog instead of auto-keeping when the server reports two sides", async () => {
    // (4) The disagreement. The client read one attached side off a
    // subscription that was a moment behind; the server, reading the same
    // slots at fetch time, saw two. The honest answer to "I am not sure how
    // many marketplaces this set has" is the dialog, never a silent commit.
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    expect(screen.queryByText(/Match Cards/)).toBeNull();

    await streamCandidates(rerender, arrivedBatch);
    await act(async () => {
      resolveFetch({
        success: true,
        message: "0 matched, 1 BSC-only, 1 SL-only",
        candidateCount: 2,
        attachedSides: ["bsc", "sportlots"],
      });
    });

    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
    // The progress line is gone — the dialog is the surface now.
    expect(screen.queryByText(/Fetching from SportLots/)).toBeNull();
  });

  /**
   * NEO-255 security review — the batch, not the mapping, has the last word on
   * whether an operator is needed.
   *
   * `attachedSides === ["bsc"]` ought to guarantee every returned row is a BSC
   * single, and does not quite: `fetchSportLotsChecklist` still falls back to a
   * name-keyed DB lookup for the SportLots set id when no SL slot is attached
   * (NEO-256, filed separately), so SportLots rows can come back, pair, and
   * carry a real disagreement. Auto-keeping those would drop the operator's
   * only chance to answer "which of these two names is this card" — and the
   * losing answer would then read as settled NB data on every later re-sync.
   */
  it("hands over to the dialog when the one-sided batch contains a matched pair", async () => {
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    expect(screen.queryByText(/Match Cards/)).toBeNull();

    await streamCandidates(rerender, {
      batchId: "batch-255",
      ready: 2,
      total: 2,
      cards: [
        slCandidates[0],
        // A pair, on a set that reports one attached marketplace.
        {
          cardNumber: "2",
          cardName: "Paired Anyway",
          bucket: "matched" as const,
          confidence: 1,
          platformData: { bsc: { ref: "bsc-2" }, sportlots: { ref: "sl-2" } },
        },
      ],
    });
    await act(async () => {
      resolveFetch({
        success: true,
        message: "1 matched, 0 BSC-only, 1 SL-only",
        candidateCount: 2,
        attachedSides: ["sportlots"],
      });
    });

    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
    // The fetch's own counts stand, as they do on the two-sided path — the
    // "Kept all …" sentence would be a claim about something that did not
    // happen.
    expect(screen.getByText("1 matched, 0 BSC-only, 1 SL-only")).toBeTruthy();
    expect(screen.queryByText(/Kept all/)).toBeNull();
    expect(screen.queryByText(/Fetching from SportLots/)).toBeNull();
  });

  it("hands over to the dialog when an unpaired row carries a name conflict", async () => {
    // The same guard read off the conflict rather than the bucket. Both are
    // checked because either one on its own is a disagreement the operator
    // has to settle, and `candidatesToPairingCards` drops both.
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    await streamCandidates(rerender, {
      batchId: "batch-255",
      ready: 2,
      total: 2,
      cards: [
        slCandidates[0],
        {
          ...slCandidates[1],
          nameConflict: { bsc: "Ken Griffey Jr.", sportlots: "Ken Griffey" },
        },
      ],
    });
    await act(async () => {
      resolveFetch({
        success: true,
        message: "0 matched, 0 BSC-only, 2 SL-only",
        candidateCount: 2,
        attachedSides: ["sportlots"],
      });
    });

    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
    expect(screen.queryByText(/Kept all/)).toBeNull();
  });

  it("abandons the run when the operator switches variant mid-await", async () => {
    // `awaitStreamedBatch` polls a subscription keyed on the CURRENT variant
    // while `handlePairingConfirm` writes to the variant the run captured.
    // Without the variant check in `abandoned()`, a switch mid-await commits
    // one set's cards onto another — and this path has no operator in front of
    // it to notice.
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    await act(async () => {
      resolveFetch({
        success: true,
        message: "0 matched, 0 BSC-only, 2 SL-only",
        candidateCount: 2,
        attachedSides: ["sportlots"],
      });
    });
    // Still waiting: the batch has not arrived.
    expect(mockCommitChecklist).not.toHaveBeenCalled();

    // The operator moves to another variant, and THAT variant's subscription
    // happens to be showing a complete batch of the same size.
    state.liveCandidates = arrivedBatch;
    await act(async () => {
      rerender(
        <CardChecklist
          variantId={OTHER_VARIANT_ID}
          sourceChips={{}}
          sourceLabelMaps={{ bsc: {}, sportlots: {} }}
        />,
      );
    });

    // Give the poll several turns to do the wrong thing if it is going to.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
    expect(screen.queryByText(/Kept all/)).toBeNull();
  });

  it("parks focus on the progress line when the run starts", async () => {
    // a11y (WCAG 2.4.3): pressing Sync disables the Sync button, which blurs
    // focus to <body>, and this path mounts no dialog to catch it. Without the
    // park a keyboard operator spends the whole fetch at the top of the
    // document with nothing announcing that anything began.
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    await waitFor(() => {
      const parked = document.activeElement as HTMLElement | null;
      expect(parked).not.toBe(document.body);
      // The container itself, named by its own status line.
      expect(parked?.getAttribute("aria-labelledby")).toBe("solo-fetch-status");
      expect(parked?.getAttribute("tabindex")).toBe("-1");
    });
    // …and Cancel is inside it, so a single Tab reaches the way out.
    expect(
      (document.activeElement as HTMLElement).contains(
        screen.getByLabelText("Cancel checklist fetch"),
      ),
    ).toBe(true);
  });

  it("does not steal focus the operator is already holding", async () => {
    // The other half of the park: it fires only when focus is on <body>. An
    // operator who has tabbed somewhere keeps it.
    renderChecklist();
    const addCard = screen.getByLabelText("Open add card form");
    addCard.focus();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    await waitFor(() =>
      expect(screen.getByText(/Fetching from SportLots/)).toBeTruthy(),
    );
    expect(document.activeElement).toBe(addCard);
  });

  it("a one-sided run that publishes nothing still skips straight to entity resolution", async () => {
    // The pre-existing `candidateCount === 0` short-circuit is untouched by
    // this ticket, and has to stay reachable from the one-sided path too.
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    await act(async () => {
      resolveFetch({
        success: true,
        message: NOTHING_TO_FETCH_MESSAGE,
        candidateCount: 0,
        attachedSides: ["sportlots"],
      });
    });

    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(screen.queryByText(/Fetching from SportLots/)).toBeNull();
    expect(mockResolveEntities).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
      sportId: SPORT_ID,
      cards: [],
    });
  });

  it("a failed one-sided fetch closes the run and discards, as a two-sided one does", async () => {
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    expect(screen.getByText(/Fetching from SportLots/)).toBeTruthy();

    await act(async () => {
      resolveFetch({
        success: false,
        message: "Failed to fetch checklist: SportLots timed out",
        candidateCount: 0,
        attachedSides: ["sportlots"],
      });
    });

    expect(
      screen.getByText("Failed to fetch checklist: SportLots timed out"),
    ).toBeTruthy();
    expect(screen.queryByText(/Fetching from SportLots…/)).toBeNull();
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
    expect(mockCommitChecklist).not.toHaveBeenCalled();
  });

  it("NEO-287: a paused attached side is subtracted, so a two-marketplace set takes the solo path", async () => {
    // Both marketplaces are attached — this chain opens the Match Cards
    // dialog on every other test — but SportLots is paused, so THIS run has
    // nothing from SportLots to line up. The client subtracts the pause
    // before the fetch (no dialog, not even during the fetch), the server
    // reports the same subtraction back (`attachedSides` still lists both,
    // `pausedSides` names the one it did not ask), and the two agree on one
    // remaining side: the auto-keep path, with the pause named in the line.
    state.ancestorChain = twoSidedChain();
    state.paused = ["sportlots"];
    const bscCandidates = [
      // NEO-335: teamed, so the solo path still commits with no dialog.
      {
        cardNumber: "1",
        cardName: "Paused One",
        teams: ["Paused Team"],
        bucket: "bscOnly" as const,
        platformData: { bsc: { ref: "bsc-1" } },
      },
      {
        cardNumber: "2",
        cardName: "Paused Two",
        teams: ["Paused Team"],
        bucket: "bscOnly" as const,
        platformData: { bsc: { ref: "bsc-2" } },
      },
    ];
    // Hold the commit open so the kept line is still standing when it is
    // read — "Saved N cards." replaces it once the commit lands.
    let finishCommit: (value: unknown) => void = () => {};
    mockCommitChecklist.mockImplementation(
      () => new Promise((resolve) => (finishCommit = resolve)),
    );
    try {
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));

      expect(screen.queryByText(/Match Cards/)).toBeNull();
      expect(screen.getByText(/Fetching from BSC/)).toBeTruthy();

      await streamCandidates(rerender, {
        batchId: "batch-287",
        ready: 2,
        total: 2,
        cards: bscCandidates,
      });
      await act(async () => {
        resolveFetch({
          success: true,
          message: "0 matched, 2 BSC-only, 0 SL-only",
          candidateCount: 2,
          attachedSides: ["bsc", "sportlots"],
          pausedSides: ["sportlots"],
        });
      });

      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      expect(screen.queryByText(/Match Cards/)).toBeNull();
      expect(
        screen.getByText(
          "Kept all 2 cards from BSC. Nothing to match — SportLots is on pause: nothing from SportLots was asked for or changed.",
        ),
      ).toBeTruthy();
      const committed = mockCommitChecklist.mock.calls[0][0];
      expect(committed.cards).toHaveLength(2);
      for (const card of committed.cards) expect(card.unmatched).toBe("sl");
      await act(async () => {
        finishCommit({ count: 2 });
      });
    } finally {
      state.paused = [];
    }
  });

  it("NEO-287: the server's paused list must agree — a pause the client did not see opens the dialog", async () => {
    // The client read no pause (stale subscription), so it expected both
    // sides; the server paused one. The two answers differ, and a
    // disagreement never auto-commits: the ordinary review opens instead.
    state.ancestorChain = twoSidedChain();
    state.paused = [];
    state.liveCandidates = {
      batchId: "batch-287b",
      ready: 1,
      total: 1,
      cards: [streamedCandidate],
    };
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    await act(async () => {
      resolveFetch({
        success: true,
        message: "0 matched, 2 BSC-only, 0 SL-only",
        candidateCount: 2,
        attachedSides: ["bsc", "sportlots"],
        pausedSides: ["sportlots"],
      });
    });
    expect(screen.getByText(/Match Cards/)).toBeTruthy();
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
  });

  /**
   * NEO-330 — the teams have to land before anything is committed.
   *
   * A Convex action's promise resolves before the client's subscription shows
   * its last writes. The fetch publishes its rows and THEN patches each BSC
   * team lookup in, so the instant `fetchChecklist` resolves the subscription
   * can show the right batch id and the right count with no teams on it. The
   * old gate accepted that snapshot, entity resolution saw no team names, and
   * a small set lost every team. The server now writes `ready` per row, so
   * `ready === total` is "the teams are in".
   */
  describe("waits for every row to be ready (NEO-330)", () => {
    /** BSC attached at the set, nothing on the variant: one marketplace. */
    const soloBscChain = () => [
      {
        _id: SPORT_ID,
        level: "sport",
        value: "Baseball",
        platformData: { bsc: { b0: "baseball" } },
      },
      {
        _id: SET_ID,
        level: "setName",
        value: "Test Set",
        platformData: { bsc: { b0: "2024-topps" } },
      },
      { _id: VARIANT_ID, level: "variantType", value: "Base", platformData: {} },
    ];

    const bscCard = (n: string, player: string, teams?: string[]) => ({
      cardNumber: n,
      cardName: player,
      players: [player],
      ...(teams ? { teams } : {}),
      bucket: "bscOnly" as const,
      platformData: { bsc: { ref: `bsc-${n}` } },
    });

    /** Right batch, right count — and the team lookup not yet visible. */
    const prePatch = {
      batchId: "batch-330",
      ready: 0,
      total: 2,
      cards: [bscCard("1", "Elly De La Cruz"), bscCard("2", "Hunter Greene")],
    };
    /** The same batch once the lookup chunk's patch has reached the client. */
    const patched = {
      batchId: "batch-330",
      ready: 2,
      total: 2,
      cards: [
        bscCard("1", "Elly De La Cruz", ["Cincinnati Reds"]),
        bscCard("2", "Hunter Greene", ["Cincinnati Reds"]),
      ],
    };

    const fetchDone = {
      success: true,
      message: "0 matched, 2 BSC-only, 0 SL-only",
      candidateCount: 2,
      attachedSides: ["bsc"],
    };

    beforeEach(() => {
      state.ancestorChain = soloBscChain();
    });

    it("does not commit a complete batch whose teams have not landed, and hands entity resolution the teams once they do", async () => {
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      expect(screen.getByText(/Fetching from BSC/)).toBeTruthy();

      await streamCandidates(rerender, prePatch);
      await act(async () => {
        resolveFetch(fetchDone);
      });

      // Several poll turns on the pre-patch snapshot: the count agrees, the
      // batch id moved, and it must still not commit.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      expect(mockResolveEntities).not.toHaveBeenCalled();
      expect(mockDiffChecklist).not.toHaveBeenCalled();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
      expect(screen.queryByText(/Match Cards/)).toBeNull();

      // The patch lands.
      await streamCandidates(rerender, patched);
      await waitFor(() => expect(mockResolveEntities).toHaveBeenCalled());

      // The teams reach entity resolution ON the cards, which is also where the
      // player gate's card-team tie-break (`cardTeamNamesByPlayer`) reads them.
      expect(mockResolveEntities).toHaveBeenCalledWith({
        selectorOptionId: VARIANT_ID,
        sportId: SPORT_ID,
        cards: [
          expect.objectContaining({
            cardNumber: "1",
            players: ["Elly De La Cruz"],
            teams: ["Cincinnati Reds"],
            unmatched: "sl",
          }),
          expect.objectContaining({
            cardNumber: "2",
            players: ["Hunter Greene"],
            teams: ["Cincinnati Reds"],
            unmatched: "sl",
          }),
        ],
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      for (const card of mockCommitChecklist.mock.calls[0][0].cards) {
        expect(card.teams).toEqual(["Cincinnati Reds"]);
      }
    });

    // NEO-335: teamless cards now open the wizard teams-only before save;
    // confirmed unanswered, they commit with no team, as before.
    it("when the teams miss the wait, commits anyway with no team on those cards, and says so", async () => {
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, prePatch);

      // Fake the clock only for the wait itself: `awaitStreamedBatch` reads
      // `Date.now()` for its deadline and polls on `setTimeout`.
      vi.useFakeTimers();
      try {
        await act(async () => {
          resolveFetch(fetchDone);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
      } finally {
        vi.useRealTimers();
      }

      expect(await screen.findByText("Wizard opened teams-only")).toBeTruthy();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(screen.getByText("Confirm entity review"));
      });
      await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
      expect(liveRegionText()).not.toContain(SOLO_STREAM_TIMEOUT_MESSAGE);
      // Never a guess: what arrived is what commits.
      for (const card of mockResolveEntities.mock.calls[0][0].cards) {
        expect(card.teams).toBeUndefined();
      }
      for (const card of mockCommitChecklist.mock.calls[0][0].cards) {
        expect(card.teams).toBeUndefined();
      }
      await waitFor(() =>
        expect(liveRegionText()).toMatch(/Saved \d+ cards\./),
      );
      expect(liveRegionText()).toContain(TEAMS_LATE_NOTICE);
      expect(screen.queryByText(/Fetching from BSC/)).toBeNull();
    });

    it("still saves nothing when the ROWS never arrive", async () => {
      const { rerender } = renderChecklist();
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
      await streamCandidates(rerender, patched);

      vi.useFakeTimers();
      try {
        await act(async () => {
          resolveFetch({ ...fetchDone, candidateCount: 3 });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
      } finally {
        vi.useRealTimers();
      }

      await waitFor(() =>
        expect(screen.getByText(SOLO_STREAM_TIMEOUT_MESSAGE)).toBeTruthy(),
      );
      expect(mockResolveEntities).not.toHaveBeenCalled();
      expect(mockCommitChecklist).not.toHaveBeenCalled();
      // The session is binned exactly as a short batch's always was.
      expect(mockDiscardCandidates).toHaveBeenCalledWith({
        selectorOptionId: VARIANT_ID,
      });
      expect(screen.queryByText(/Fetching from BSC/)).toBeNull();
    });
  });
});

/**
 * NEO-189 — the "Saved N cards" message must not paint before the client's
 * queries have caught up with the commit.
 *
 * `commitCardChecklist` became an ACTION when the commit was chunked
 * server-side. `useAction`'s promise resolves the moment the server returns;
 * `useMutation`'s only resolves once the client's subscribed queries reflect
 * the mutation's writes. So the message that used to be safe to paint right
 * after the commit now races `getCardChecklist`'s repaint — and
 * a flow that waits for "Saved N cards" and then IMMEDIATELY asserts a "#NNN"
 * card row is visible (the retired `setup.yaml` did this for 335 cards; since
 * NEO-339 the Base commit is the scripted seed, `npm run setbuild`, and the
 * Maestro flows that commit a checklist still read the message).
 *
 * The fix is ordering, not a new sync primitive: `discardCandidates` is still
 * a mutation, and its resolution guarantees the client reflects every write
 * that preceded it — including the action's internal commit mutations. These
 * tests pin that ordering, and pin that a discard failure after a SUCCESSFUL
 * commit still reports the cards as saved.
 */
describe("CardChecklist — commit paints 'Saved' only after the queries catch up", () => {
  let resolveFetch: (value: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    // The no-candidates path: the fetch short-circuits, the client skips the
    // pairing dialog and runs straight through resolveEntities → runCommit.
    // Shortest route to the commit under test.
    state.liveCandidates = { ready: 0, total: 0, cards: [] };
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    mockCommitChecklist.mockResolvedValue({ count: 335 });
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
  });

  /** Drive the fetch → resolve → commit path to the point of the discard. */
  async function runToCommit() {
    renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    await act(async () => {
      resolveFetch({
        success: true,
        message: NOTHING_TO_FETCH_MESSAGE,
        candidateCount: 0,
        attachedSides: ["bsc", "sportlots"],
      });
    });
  }

  it("withholds 'Saved N cards' until discardCandidates — the mutation carrying the repaint guarantee — has resolved", async () => {
    let resolveDiscard!: () => void;
    mockDiscardCandidates.mockImplementation(
      () => new Promise<void>((resolve) => (resolveDiscard = resolve)),
    );

    await runToCommit();

    // The action has returned, but the mutation behind it has not. If the
    // message were set here the E2E flow's "#NNN" assertion would be racing
    // the checklist subscription.
    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockDiscardCandidates).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Saved 335 cards/)).toBeNull();

    await act(async () => {
      resolveDiscard();
    });

    expect(screen.getByText("Saved 335 cards.")).toBeTruthy();
  });

  it("still reports the cards as saved when the post-commit discard fails", async () => {
    // The commit succeeded — the rows are in cardChecklist. Reporting
    // "Commit failed" here would tell the operator to re-run a sync that
    // already worked.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockDiscardCandidates.mockRejectedValue(new Error("discard blew up"));

    await runToCommit();

    await waitFor(() =>
      expect(screen.getByText(/^Saved 335 cards\./)).toBeTruthy(),
    );
    expect(screen.queryByText(/Commit failed/)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports 'Commit failed' when the commit action itself throws, and never claims a save", async () => {
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockCommitChecklist.mockRejectedValue(new Error("chunk 3 timed out"));

    await runToCommit();

    await waitFor(() =>
      expect(screen.getByText("Commit failed: chunk 3 timed out")).toBeTruthy(),
    );
    expect(screen.queryByText(/Saved/)).toBeNull();
    expect(mockDiscardCandidates).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEO-102 — the set-level "needs attention" pass
//
// The count, the filter and the walker's entry points. All three read the same
// derived rule (card-attention.ts) off the live getCardChecklist rows, which is
// why fixing a card needs nothing invalidated: the row changes and the count
// follows.
// ---------------------------------------------------------------------------

/** A stored row that needs a team: a lookup ran, found nothing, nobody answered. */
function attentionCard(overrides: Record<string, unknown> = {}) {
  return {
    _id: "card-a" as unknown as Id<"cardChecklist">,
    selectorOptionId: VARIANT_ID,
    cardNumber: "1",
    cardName: "AL Leaders ERA LL",
    platformData: { bsc: { ref: "bsc-1" } },
    teamCheckDoneAt: 1_000,
    ...overrides,
  };
}

/** A settled row: its lookup ran and found a team. */
function settledCard(overrides: Record<string, unknown> = {}) {
  return {
    _id: "card-b" as unknown as Id<"cardChecklist">,
    selectorOptionId: VARIANT_ID,
    cardNumber: "2",
    cardName: "Tarik Skubal",
    platformData: { bsc: { ref: "bsc-2" } },
    teamCheckDoneAt: 1_000,
    teamOnCardIds: ["team-1"],
    ...overrides,
  };
}

/**
 * Renders and drives a commit all the way through, via the ZERO-CANDIDATE
 * path: the fetch short-circuits (`candidateCount: 0`), the client skips the
 * pairing dialog and runs straight through resolveEntities → runCommit. It is
 * the shortest route to a landed commit, which is what puts the post-commit
 * banner — and its attention call-to-action — on screen.
 *
 * Set `state.cards` before calling; the commit mock does not change them (the
 * live `getCardChecklist` subscription is what the count reads).
 */
async function commitZeroCandidatePath() {
  state.liveCandidates = { ready: 0, total: 0, cards: [] };
  mockResolveEntities.mockResolvedValue({
    unknownPlayers: [],
    unknownTeams: [],
    batchId: undefined,
  });
  // NEO-221 (D12): the commit now reports how many names its batch never had
  // a decision for. Zero here — the "nothing was skipped" shape every
  // pre-existing assertion in this file runs in.
  mockCommitChecklist.mockResolvedValue({ count: 2, unreviewedNameCount: 0 });
  mockDiscardCandidates.mockResolvedValue(undefined);
  let resolveFetch!: (value: unknown) => void;
  mockFetchChecklist.mockImplementation(
    () => new Promise((resolve) => (resolveFetch = resolve)),
  );

  const rendered = renderChecklist();
  fireEvent.click(screen.getByLabelText("Sync card checklist"));
  await act(async () => {
    resolveFetch({
      success: true,
      message: NOTHING_TO_FETCH_MESSAGE,
      candidateCount: 0,
      attachedSides: ["bsc", "sportlots"],
    });
  });
  await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
  return rendered;
}

/**
 * Drives the same zero-candidate route as `commitZeroCandidatePath`, but stops
 * one step short: `resolveChecklistEntities` reports an unknown player, so the
 * entity-review wizard opens instead of the commit running — and the operator
 * cancels it. NOTHING is saved on this path, which is exactly why the banner
 * it leaves behind must not offer to fix anything.
 */
async function cancelEntityReviewPath() {
  state.liveCandidates = { ready: 0, total: 0, cards: [] };
  mockResolveEntities.mockResolvedValue({
    unknownPlayers: [{ name: "Unknown Guy" }],
    unknownTeams: [],
    batchId: "batch-1",
  });
  mockDiscardCandidates.mockResolvedValue(undefined);
  let resolveFetch!: (value: unknown) => void;
  mockFetchChecklist.mockImplementation(
    () => new Promise((resolve) => (resolveFetch = resolve)),
  );

  const rendered = renderChecklist();
  fireEvent.click(screen.getByLabelText("Sync card checklist"));
  await act(async () => {
    resolveFetch({
      success: true,
      message: NOTHING_TO_FETCH_MESSAGE,
      candidateCount: 0,
      attachedSides: ["bsc", "sportlots"],
    });
  });
  await waitFor(() => expect(mockResolveEntities).toHaveBeenCalledTimes(1));
  return rendered;
}

describe("CardChecklist — NEO-102 attention count and walker (NEO-335: one 'N need you' control)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [attentionCard(), settledCard()];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
  });

  /** The header's one attention control; its visible text is its name. */
  const needsYou = (name: string | RegExp = /^\d+ needs? you$/) =>
    screen.getByRole("button", { name });
  const queryNeedsYou = () => screen.queryByRole("button", { name: /^\d+ needs? you$/ });

  it("counts the flagged rows and marks only those rows in the grid", () => {
    renderChecklist();

    expect(needsYou("1 needs you")).toBeTruthy();
    expect(screen.getAllByLabelText(/needs attention/)).toHaveLength(1);
    // NEO-272: the mark names the row's identity — number AND card name — so
    // twenty-five same-numbered rows no longer all announce the same sentence.
    expect(
      screen.getByLabelText(/Card 1, AL Leaders ERA LL needs attention/),
    ).toBeTruthy();
  });

  it("announces the count in a live region, since the pill's own text changes silently", () => {
    renderChecklist();

    const announced = screen
      .getAllByRole("status")
      .map((el) => el.textContent ?? "")
      .join(" | ");
    expect(announced).toContain("1 card needs you on this checklist");
  });

  it("hides the row entirely when nothing needs attention", () => {
    state.cards = [settledCard()];
    renderChecklist();

    expect(queryNeedsYou()).toBeNull();
    expect(screen.queryByText(/needs? you/)).toBeNull();
  });

  it("offers no grid filter any more — every row stays listed", () => {
    renderChecklist();

    expect(
      screen.queryByRole("button", { name: /Show only cards needing attention/ }),
    ).toBeNull();
    expect(screen.getByText("AL Leaders ERA LL")).toBeTruthy();
    expect(screen.getByText("Tarik Skubal")).toBeTruthy();
  });

  it("opens the walker from the header, any time", async () => {
    renderChecklist();

    fireEvent.click(needsYou());

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Tidy up this set");
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(
      "#1 AL Leaders ERA LL",
    );
  });

  /**
   * NEO-331 — both surfaces that hold a TeamPicker for a card on this
   * checklist hand it THIS checklist's row as `contextOptionId`, so the
   * candidates rank by the set's league and year. Pinned through the args the
   * picker's `teams.pickerCandidates` query is called with: with the quick-add
   * form closed, the opened surface's picker is the only one mounted.
   */
  it("NEO-331: the card detail panel's TeamPicker ranks by THIS checklist's row (contextOptionId = variantId)", () => {
    renderChecklist();
    pickerArgs.length = 0;

    fireEvent.click(screen.getByLabelText(/^Edit card .*Tarik Skubal/));

    expect(screen.getAllByLabelText("Add team")).toHaveLength(1);
    expect(pickerArgs.length).toBeGreaterThan(0);
    for (const args of pickerArgs) {
      expect(args).toMatchObject({ contextOptionId: VARIANT_ID });
    }
  });

  it("NEO-331: the attention walker's TeamPicker ranks by THIS checklist's row (contextOptionId = variantId)", async () => {
    renderChecklist();
    pickerArgs.length = 0;

    fireEvent.click(
      screen.getByRole("button", { name: /^[0-9]+ needs? you$/ }),
    );
    const dialog = await screen.findByRole("dialog");

    // The flagged card has no team, so the walker opens on the team fixer.
    expect(within(dialog).getAllByLabelText("Add team")).toHaveLength(1);
    expect(pickerArgs.length).toBeGreaterThan(0);
    for (const args of pickerArgs) {
      expect(args).toMatchObject({ contextOptionId: VARIANT_ID });
    }
  });

  it("does not open the walker on its own", () => {
    renderChecklist();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  /**
   * `walkerOpenedByHand` is the only thing that mounts the walker — see the
   * state block in CardChecklist.tsx. Nothing in
   * CardAttentionWalker.test.tsx exercises this seam: that file drives the
   * walker directly with `isOpen` pinned true, never through the parent, so
   * a change that reintroduced an automatic open would go unnoticed there.
   */
  it("opened BY HAND, stays open and shows All clear once the last flagged row is fixed elsewhere", () => {
    const { rerender } = renderChecklist();

    fireEvent.click(needsYou());
    expect(screen.getByRole("dialog")).toBeTruthy();

    // The BSC pass (or another tab) answers the one flagged card — nothing
    // the walker itself did.
    state.cards = [settledCard()];
    rerender(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/All clear/)).toBeTruthy();
  });

  /**
   * NEO-102 regression — the walker used to ARM itself on a completed commit
   * and open across the grid the moment the background BSC team pass flagged
   * a row. Two E2E flows (checklist-fetch-unknown-entities-link-existing,
   * checklist-fetch-wizard-add-career-team) commit a custom set whose one
   * card has no team, so it was flagged immediately and the walker's
   * `fixed inset-0` overlay swallowed the flow's next tap on the grid. The
   * commit says what it saved; the header pill offers the walker.
   *
   * NEO-335: the banner no longer carries its own "K need attention — Fix
   * them one at a time" button. The header pill is the one way in.
   */
  it("after a commit, does NOT open the walker, and the banner offers no button — the header pill carries the count", async () => {
    await commitZeroCandidatePath();

    const banner = screen.getByText(/Saved 2 cards\./);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(banner).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /one at a time/ })).toBeNull();
    expect(needsYou("1 needs you")).toBeTruthy();
  });

  it("the header pill carries the live count after a commit", async () => {
    state.cards = [attentionCard(), attentionCard({ _id: "card-c", cardNumber: "3" })];
    await commitZeroCandidatePath();

    expect(needsYou("2 need you")).toBeTruthy();
  });

  it("after a commit that flagged nothing, the banner is there and the pill is not", async () => {
    state.cards = [settledCard()];
    await commitZeroCandidatePath();

    expect(screen.getByText(/Saved 2 cards\./)).toBeTruthy();
    expect(queryNeedsYou()).toBeNull();
  });

  it("the pill leaves once the count reaches zero, and the banner stays", async () => {
    const { rerender } = await commitZeroCandidatePath();
    expect(needsYou()).toBeTruthy();

    // The BSC pass (or another tab) answers the one flagged card.
    state.cards = [settledCard()];
    rerender(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      />,
    );

    expect(queryNeedsYou()).toBeNull();
    expect(screen.getByText(/Saved 2 cards\./)).toBeTruthy();
  });

  /**
   * CI round 2 regression (flow `checklist-fetch-cancel-dialog`): the cancel
   * banner once grew an attention CTA, offering to fix cards the operator
   * had just declined to save, and broke the flow's exact-text assertion on
   * that element. NEO-335 retired the banner CTA altogether; this keeps the
   * exact text pinned so it cannot come back on any notice.
   */
  it("leaves the cancelled-review banner exactly as written", async () => {
    await cancelEntityReviewPath();
    // Precondition: there IS something needing attention.
    expect(needsYou("1 needs you")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel entity review" }));

    // Exact match: `getByText` compares the element's whole text content, so
    // anything appended inside the banner would fail this outright.
    expect(screen.getByText("Fetch cancelled — no cards saved.")).toBeTruthy();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEO-208 — the quick-add form's Team field
//
// This is the FIRST component coverage the quick-add form has ever had, which
// is most of why NEO-208 shipped as a bug: the old free-text Team box wrote
// `addCustomCard({ teams: [typedName] })` → `pendingTeamNames`, a column
// nothing rendered, and no test looked at either end of that.
//
// The form now uses the REAL `TeamPicker` — the same component the card drawer
// and the attention walker's fixer use — deliberately un-stubbed here. Two
// things depend on the real one: the picker's value is React STATE in
// CardChecklist and has to survive the reactive `getCardChecklist` re-renders
// that broke controlled inputs in NEO-36, and the aria-labels Maestro drives
// ("Add team", "Search teams", "Add <name>") are the real component's.
// ---------------------------------------------------------------------------

const YANKEES = { _id: "team-yankees", name: "New York Yankees" };
const METS = { _id: "team-mets", name: "New York Mets" };
/**
 * NEO-220 — the quick-add form's PlayerPicker exposes DIFFERENT accessible
 * names from the card drawer's and the attention walker's, because
 * CardChecklist mounts more than one of these pickers and neither hides the
 * other. Mirrored from `QUICK_ADD_PLAYER_LABELS` in CardChecklist.tsx;
 * spelled out here rather than imported so a rename has to be made
 * deliberately in both places, and so this file records what the E2E flows
 * actually target.
 */
const QA_ROOT = "Players on the new card";
const QA_TRIGGER = "Add a player to the new card";
const QA_SEARCH = "Find a player for the new card";

/** NEO-220 — the quick-add form's PlayerPicker candidate pool. */
const JUDGE = { _id: "player-judge", name: "Aaron Judge" };
const LINDOR = { _id: "player-lindor", name: "Francisco Lindor" };

/** Pick a player through the real picker's popover, by its display name. */
function pickPlayer(name: string) {
  fireEvent.click(screen.getByLabelText(QA_TRIGGER));
  fireEvent.click(screen.getByLabelText(`Add ${name}`));
}

/** Open the form and return its container element. */
function openAddForm(): HTMLElement {
  fireEvent.click(screen.getByLabelText("Open add card form"));
  const heading = screen.getByRole("heading", { name: "Add Card" });
  return heading.parentElement as HTMLElement;
}

/** Pick a team through the real picker's popover, by its display name. */
function pickTeam(name: string) {
  fireEvent.click(screen.getByLabelText("Add team"));
  fireEvent.click(screen.getByLabelText(`Add ${name}`));
}

function fillCardNumber(value: string) {
  fireEvent.change(screen.getByLabelText("Card number"), {
    target: { value },
  });
}

describe("CardChecklist — NEO-208 quick-add Team picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [YANKEES, METS];
    mockAddCustomCard.mockResolvedValue("new-card-1");
  });

  it("NEO-331: the quick-add picker ranks by THIS checklist's row (contextOptionId = variantId)", () => {
    pickerArgs.length = 0;
    renderChecklist();
    openAddForm();

    expect(pickerArgs.length).toBeGreaterThan(0);
    expect(pickerArgs.at(-1)).toMatchObject({ contextOptionId: VARIANT_ID });
  });

  it("renders a TeamPicker, not a free-text Team box", () => {
    renderChecklist();
    openAddForm();

    // The old field's accessible name. Its absence is the regression pin: a
    // revert to the textbox brings this label back.
    expect(screen.queryByLabelText("Team")).toBeNull();
    expect(screen.getByLabelText("Team picker")).toBeTruthy();
    expect(screen.getByLabelText("Add team")).toBeTruthy();
  });

  it("keeps each field's reserved Maestro marker class on its picker wrapper", () => {
    // Maestro's web driver re-finds a tapped element by an XPath built from
    // its class (see useFieldTestClass). Neither picker is an <input>, but the
    // "team" and "players" keys stay claimed so no other field in this form
    // can be handed one, and each class stays a stable handle for scoping a
    // query to that box.
    const form = (() => {
      renderChecklist();
      return openAddForm();
    })();

    // Read the base off a field that is still a real <input>, rather than
    // hardcoding a `useId()` value. NEO-220: that used to be the players
    // textbox; it is a picker now, so the card-number field is the one left —
    // and its SUFFIX is unreadable ("cardNumber" sanitizes to "card-umber",
    // since the key sanitizer replaces the capital rather than lowercasing
    // it), so match the `mb-field-<base>` prefix instead. `useId()` is
    // stripped to alphanumerics by the hook, so the base never contains a
    // hyphen and this cannot over-match.
    const base = screen
      .getByLabelText("Card number")
      .className.split(/\s+/)
      .map((c) => /^(mb-field-[a-z0-9]+)-/.exec(c)?.[1])
      .find((b): b is string => !!b)!;

    const teamWrapper = form.querySelector(`.${base}-team`);
    expect(teamWrapper).toBeTruthy();
    expect(teamWrapper!.contains(screen.getByLabelText("Team picker"))).toBe(
      true,
    );

    const playersWrapper = form.querySelector(`.${base}-players`);
    expect(playersWrapper).toBeTruthy();
    expect(
      playersWrapper!.contains(screen.getByLabelText(QA_ROOT)),
    ).toBe(true);
  });

  it("sends the picked ids as teamOnCardIds, and no `teams` name array", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("501");
    pickTeam("New York Yankees");
    pickTeam("New York Mets");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard).toHaveBeenCalledTimes(1);
    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args.teamOnCardIds).toEqual([YANKEES._id, METS._id]);
    // The legacy free-text shape must not ride along — a row carrying both
    // would state its team twice (see addCustomCard).
    expect(args).not.toHaveProperty("teams");
  });

  it("sends NEITHER teamOnCardIds nor teams when no team was picked", async () => {
    // "No answer about teams" is what leaves the card correctly badged as
    // needing one. An empty array would read as a deliberate "no team".
    renderChecklist();
    openAddForm();
    fillCardNumber("502");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args).not.toHaveProperty("teamOnCardIds");
    expect(args).not.toHaveProperty("teams");
  });

  it("still forwards the other fields unchanged", async () => {
    state.players = [JUDGE, LINDOR];
    renderChecklist();
    openAddForm();
    fillCardNumber("503");
    fireEvent.change(screen.getByLabelText("Card name"), {
      target: { value: "Subway Series" },
    });
    pickPlayer("Aaron Judge");
    pickPlayer("Francisco Lindor");
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    // NEO-220: `players` (the typed name array) is gone from this call
    // entirely — the whole argument list is asserted, so its return would
    // fail here.
    expect(mockAddCustomCard).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
      cardNumber: "503",
      cardName: "Subway Series",
      playerIds: [JUDGE._id, LINDOR._id],
      teamOnCardIds: [YANKEES._id],
    });
  });

  /**
   * The NEO-36 pin, and the reason the picker's value is allowed to be React
   * state at all.
   *
   * That ticket found controlled TEXT inputs being wiped by reactive
   * `getCardChecklist` re-renders: a keystroke and a re-render race, and the
   * re-render wins with the stale value. A picker has no such window — its
   * value changes only in whole chips, one discrete setState each — so state
   * is safe here. This test is what proves it rather than asserting it, by
   * driving exactly the event that broke the text fields: new query data
   * arriving underneath an open form.
   */
  it("keeps the picked chips across a re-render with new getCardChecklist data", async () => {
    const { rerender } = renderChecklist();
    openAddForm();
    fillCardNumber("504");
    pickTeam("New York Yankees");

    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();

    // A background sync lands: `getCardChecklist` answers with rows it did not
    // have before, and CardChecklist re-renders under the operator.
    state.cards = [settledCard()];
    rerender(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      />,
    );

    // The form is still open and the chip is still on it.
    expect(screen.getByRole("heading", { name: "Add Card" })).toBeTruthy();
    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();

    // And it is still what gets submitted — the value the operator can see.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });
    expect(mockAddCustomCard.mock.calls[0][0].teamOnCardIds).toEqual([
      YANKEES._id,
    ]);
  });

  it("resets the picker when the form is cancelled", () => {
    // The text fields reset by being unmounted; the picker is React state and
    // does not, so a cancelled card's team must be cleared explicitly or it
    // silently rides along on the next one.
    renderChecklist();
    openAddForm();
    pickTeam("New York Yankees");
    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Cancel new card"));
    openAddForm();

    expect(screen.queryByLabelText("Team: New York Yankees")).toBeNull();
  });

  it("resets the picker on OPEN too, not only on cancel", () => {
    // Belt for the same failure from the other side: whatever route hid the
    // form, opening it is a fresh card.
    renderChecklist();
    openAddForm();
    pickTeam("New York Yankees");
    fireEvent.click(screen.getByLabelText("Cancel new card"));

    openAddForm();
    expect(screen.queryByLabelText(/^Team: /)).toBeNull();
    expect(screen.queryByLabelText(/^Remove team /)).toBeNull();
  });

  it("closes the form and clears the picker after a successful add", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("505");
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(screen.queryByRole("heading", { name: "Add Card" })).toBeNull();

    openAddForm();
    expect(screen.queryByLabelText("Team: New York Yankees")).toBeNull();
  });

  it("submits nothing at all without a card number", async () => {
    renderChecklist();
    openAddForm();
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard).not.toHaveBeenCalled();
    // And the form stays open with the team still picked, so the operator
    // fixes the one missing field rather than re-entering everything.
    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();
  });

  it("keeps autoFocus on the card number field", () => {
    // The form's whole point is speed: an operator adding twenty cards types
    // a number, tabs, types a name. Whatever the Team field became, the
    // landing point must not move.
    renderChecklist();
    openAddForm();

    expect(document.activeElement).toBe(screen.getByLabelText("Card number"));
  });

  it("keeps the keyboard order: number, name, player picker, team picker, buttons", () => {
    // NEO-220: the Players textbox became a picker, so its tab stop is the
    // picker's own "+ Add player" trigger. The ORDER is what must not move —
    // an operator adding twenty cards has this sequence in their fingers.
    const form = (() => {
      renderChecklist();
      return openAddForm();
    })();

    const focusables = Array.from(
      form.querySelectorAll<HTMLElement>("input, button"),
    ).map((el) => el.getAttribute("aria-label"));

    expect(focusables).toEqual([
      "Card number",
      "Card name",
      QA_TRIGGER,
      "Add team",
      "Submit new card",
      "Cancel new card",
    ]);
  });

  it("dedupes ids before sending, even though the picker refuses a duplicate chip", () => {
    // Belt on the client side of a server-side dedupe. `TeamPicker.addChip`
    // already refuses a repeat, so this asserts the property rather than
    // trying to force the picker into an impossible state.
    renderChecklist();
    openAddForm();
    pickTeam("New York Yankees");
    // Re-open the popover and confirm the picked team is out of the pool, so
    // no second chip is reachable from the UI at all.
    fireEvent.click(screen.getByLabelText("Add team"));
    expect(screen.queryByLabelText("Add New York Yankees")).toBeNull();
    expect(screen.getByLabelText("Add New York Mets")).toBeTruthy();
  });

  it("lets a chip be removed again before submitting", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("506");
    pickTeam("New York Yankees");
    fireEvent.click(screen.getByLabelText("Remove team New York Yankees"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0]).not.toHaveProperty(
      "teamOnCardIds",
    );
  });

  it("leaves the form open when the mutation fails, so nothing typed is lost", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAddCustomCard.mockRejectedValue(new Error("server said no"));

    renderChecklist();
    openAddForm();
    fillCardNumber("507");
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(screen.getByRole("heading", { name: "Add Card" })).toBeTruthy();
    expect(screen.getByLabelText("Team: New York Yankees")).toBeTruthy();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("passes the ancestor chain's sport to the picker, so the typeahead is scoped", () => {
    // `sportId` is what filters the candidate pool AND what tags a team the
    // operator creates from the popover. Without it the picker lists the whole
    // teams table and its "+ Create" option is disabled — which is what a
    // sport-less row should get, and is asserted separately below.
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    // NEO-236: the affordance is now a row that OPENS the New Team dialog —
    // `Create team {name}` moved onto that dialog's own Create button.
    expect(screen.getByLabelText("New team Savannah Bananas")).toBeTruthy();
  });

  it("cannot create a team from a row with no sport ancestor", () => {
    state.ancestorChain = [
      { _id: VARIANT_ID, level: "variantType", value: "Base" },
    ];
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    // NEO-96: a team must reference a real sport row. No sport, no create.
    expect(screen.queryByRole("button", { name: /^New team / })).toBeNull();
  });

  /**
   * Creating a NEW team from the quick-add form's popover — the escape hatch
   * `TeamPicker` gives every consumer (see its own module docstring) — was
   * untested end-to-end from THIS form specifically. `teams.findOrCreate`'s
   * resolved id has to make it all the way to `addCustomCard`'s
   * `teamOnCardIds`, through the same React-state chip list the picked-from-
   * the-list case uses.
   */
  it("creates a new team from the popover, then sends the freshly created id on submit", async () => {
    mockFindOrCreateTeam.mockImplementation(
      async ({ name }: { name: string; sportId: unknown }) => {
        const newTeam = { _id: "team-bananas", name };
        state.teams = [...state.teams, newTeam];
        return newTeam._id;
      },
    );
    renderChecklist();
    openAddForm();
    fillCardNumber("520");
    fireEvent.click(screen.getByLabelText("Add team"));
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });

    // NEO-236: two steps now — the row opens the dialog, and the dialog's own
    // Create button is what writes. The second press is where the League gets
    // answered, which is the whole reason the inline form was replaced.
    fireEvent.click(screen.getByLabelText("New team Savannah Bananas"));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create team Savannah Bananas" }),
      );
    });

    expect(mockFindOrCreateTeam).toHaveBeenCalledWith({
      name: "Savannah Bananas",
      sportId: SPORT_ID,
    });
    // The picker's own "createAndAdd" chips it immediately — same as picking
    // an existing match.
    expect(screen.getByLabelText("Team: Savannah Bananas")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0].teamOnCardIds).toEqual([
      "team-bananas",
    ]);
  });

  it("cancelling after creating a team leaves the team CREATED server-side but sends nothing on submit", async () => {
    // The mutation already ran — cancel only clears the FORM's local chip
    // list, which is all NEO-208's reset-on-close guarantees. It does not,
    // and cannot, undo a write that already committed.
    mockFindOrCreateTeam.mockImplementation(
      async ({ name }: { name: string; sportId: unknown }) => {
        const newTeam = { _id: "team-bananas", name };
        state.teams = [...state.teams, newTeam];
        return newTeam._id;
      },
    );
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    fireEvent.change(screen.getByLabelText("Search teams"), {
      target: { value: "Savannah Bananas" },
    });
    fireEvent.click(screen.getByLabelText("New team Savannah Bananas"));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create team Savannah Bananas" }),
      );
    });
    expect(mockFindOrCreateTeam).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Cancel new card"));
    openAddForm();
    fillCardNumber("521");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    // No second team created, and the cancelled pick never reaches this card.
    expect(mockFindOrCreateTeam).toHaveBeenCalledTimes(1);
    expect(mockAddCustomCard.mock.calls[0][0]).not.toHaveProperty(
      "teamOnCardIds",
    );
  });

  it("submitting while the picker popover is still open still sends the picked team", async () => {
    // `addChip` deliberately leaves the popover open after a pick (so a
    // second team can be added without re-opening it) — this is the state the
    // form is normally IN at the moment an operator hits Add, not an edge
    // case reached only by skipping a close.
    renderChecklist();
    openAddForm();
    fillCardNumber("522");
    pickTeam("New York Yankees");
    // The popover is still open — its search box is still on screen.
    expect(screen.getByLabelText("Search teams")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0].teamOnCardIds).toEqual([
      YANKEES._id,
    ]);
  });

  // a11y (WCAG 2.4.11 Focus Not Obscured): the picker's popover is
  // `absolute top-full z-10` and opens right above this form's "Add"/
  // "Cancel" buttons — the same overlap TeamPicker's own pointerdown-outside
  // comment documents for MissingTeamFixer's "Save & Next"/"No team on this
  // card" buttons, just reached here by Tab instead of a mouse click
  // elsewhere. Without a keyboard-equivalent close, tabbing out of an open
  // popover lands focus on a button the popover is still visually covering.
  it("closes the team popover when Tab moves focus onto Submit (2.4.11)", async () => {
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    const searchInput = screen.getByLabelText("Search teams");

    // Let the picker's own open-time autofocus effect land first. It moves
    // focus into the search input on a `setTimeout(0)` queued by the same
    // click; a real Tab key can't outrun that the way synchronous test code
    // racing the same macrotask queue can, so without waiting for it here,
    // that autofocus can win the race and re-steal focus into the popover a
    // moment after our manual Tab-out below, masking the close this test
    // means to check.
    await waitFor(() => expect(document.activeElement).toBe(searchInput));

    // Tab from inside the popover lands on the next focusable element in DOM
    // order — the quick-add form's "Add" button — without the popover's own
    // state changing on its own. Move focus there directly, the same
    // observable effect a real Tab key press has. The close is deferred
    // (TeamPicker reads `document.activeElement` a tick after the blur, not
    // off the blur event's own `relatedTarget` — see its comment), so this
    // needs an `act(async ...)` to flush that timer.
    await act(async () => {
      screen.getByLabelText("Submit new card").focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByLabelText("Search teams")).toBeNull();
    // And the trigger is back to its closed state, not stuck mid-open.
    expect(
      screen.getByLabelText("Add team").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  /*
   * NEO-272 — the popover is portalled to `document.body` now, and the overlap
   * the test above exists for is DELIBERATE and unchanged: the popover is
   * anchored under its trigger, the trigger sits directly above Add/Cancel, so
   * an open list is drawn over them. That is why closing on a Tab-out (and on
   * a press elsewhere) is the behaviour that matters here, not where the
   * element lives in the tree.
   *
   * What the portal changes is that no scrolling ancestor can CLIP the list —
   * the reason it was made in the first place, for the hosts that do scroll
   * (the attention walker's body, the card drawer's). happy-dom computes no
   * layout, so this asserts the structural property that makes clipping
   * impossible rather than a pixel nobody here can measure.
   */
  it("portals the team popover out of the form it covers (NEO-272)", () => {
    const { container } = renderChecklist();
    const form = openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));

    const popover = screen.getByRole("listbox").parentElement as HTMLElement;
    // The trigger is in the form. The list it opens is not — in either the
    // form or the page subtree around it.
    expect(form.contains(screen.getByLabelText("Add team"))).toBe(true);
    expect(form.contains(popover)).toBe(false);
    expect(container.contains(popover)).toBe(false);
    expect(popover.parentElement?.parentElement).toBe(document.body);
    // Same box as ever, and above the page rather than behind it.
    expect(popover.className).toContain("w-64");
    expect(popover.className).toContain("z-[55]");
  });

  it("keeps the popover open when focus moves between controls inside it", async () => {
    // Regression guard on the fix above: closing on "focus left the root"
    // must not also fire for focus moving from one in-picker control to
    // another (e.g. the search input to a match option), which is ordinary
    // keyboard use, not a Tab-out.
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText("Add team"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Search teams")),
    );

    await act(async () => {
      screen.getByLabelText("Add New York Yankees").focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByLabelText("Search teams")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-220 — the quick-add form's Players field is a real PlayerPicker.
//
// The players twin of the NEO-208 block above, and deliberately the same cases
// so a divergence between the two fields shows up as one block passing and the
// other failing.
//
// The defect: a typed name went to `addCustomCard.players` →
// `pendingPlayerNames`, so the card was born NAMING a player it did not link
// to — which `deriveCardAttention` badges as an `unreviewedName`, sending the
// attention walker to ask the operator about a player they had just typed in.
// Picked ids make the card born LINKED, and a linked card starts answered.
//
// Driven through the REAL `PlayerPicker` throughout, so the aria-labels
// Maestro targets are the real ones.
// ---------------------------------------------------------------------------
describe("CardChecklist — NEO-220 quick-add Player picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [YANKEES, METS];
    state.players = [JUDGE, LINDOR];
    mockAddCustomCard.mockResolvedValue("new-card-1");
  });

  it("renders a PlayerPicker, not a free-text Players box", () => {
    renderChecklist();
    openAddForm();

    // The old field's accessible name. Its absence is the regression pin: a
    // revert to the textbox brings this label back.
    expect(screen.queryByLabelText("Players")).toBeNull();
    expect(screen.getByLabelText(QA_ROOT)).toBeTruthy();
    expect(screen.getByLabelText(QA_TRIGGER)).toBeTruthy();
  });

  it("labels the field, so the picker is not an unexplained row of chips", () => {
    renderChecklist();
    const form = openAddForm();
    expect(form.textContent).toContain("Players (optional)");
  });

  it("names its controls distinctly from every other PlayerPicker on the page", () => {
    // CardChecklist mounts more than one PlayerPicker — the quick-add form's
    // and, when a card is open, the drawer's — and neither hides the other. So
    // the quick-add instance must not answer to the default names, and, just
    // as importantly, must not CONTAIN them: Maestro's `id:` selector is a
    // regex find over the aria-label, so a suffixed label would make a flow
    // targeting the default match both elements.
    renderChecklist();
    openAddForm();

    for (const [distinct, base] of [
      [QA_ROOT, "Player picker"],
      [QA_TRIGGER, "Add player"],
    ] as const) {
      expect(screen.getByLabelText(distinct)).toBeTruthy();
      expect(distinct.includes(base)).toBe(false);
      expect(base.includes(distinct)).toBe(false);
    }
    // The defaults are not present at all while only this form is open.
    expect(screen.queryByLabelText("Player picker")).toBeNull();
    expect(screen.queryByLabelText("Add player")).toBeNull();

    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    expect(screen.getByLabelText(QA_SEARCH)).toBeTruthy();
    expect(QA_SEARCH.includes("Search players")).toBe(false);
    expect(screen.queryByLabelText("Search players")).toBeNull();
  });

  it("sends the picked ids as playerIds, and no `players` name array", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("601");
    pickPlayer("Aaron Judge");
    pickPlayer("Francisco Lindor");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard).toHaveBeenCalledTimes(1);
    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args.playerIds).toEqual([JUDGE._id, LINDOR._id]);
    // The legacy free-text shape must not ride along — a row carrying both
    // would name the same player twice, once in a spelling that links to
    // nothing (see addCustomCard).
    expect(args).not.toHaveProperty("players");
  });

  it("sends NEITHER playerIds nor players when nobody was picked", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("602");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args).not.toHaveProperty("playerIds");
    expect(args).not.toHaveProperty("players");
  });

  /**
   * The NEO-36 pin, for the same reason the Team block carries one: the
   * picker's value is React STATE, which is the deviation from this form's
   * uncontrolled-fields rule. That rule exists because a keystroke and a
   * reactive `getCardChecklist` re-render race. A picker changes only in whole
   * chips, one discrete setState each, so there is no half-typed value for a
   * re-render to overwrite — proved here by driving exactly the event that
   * broke the text fields.
   */
  it("keeps the picked chips across a re-render with new getCardChecklist data", async () => {
    const { rerender } = renderChecklist();
    openAddForm();
    fillCardNumber("603");
    pickPlayer("Aaron Judge");

    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();

    state.cards = [settledCard()];
    rerender(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Add Card" })).toBeTruthy();
    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });
    expect(mockAddCustomCard.mock.calls[0][0].playerIds).toEqual([JUDGE._id]);
  });

  it("resets the picker when the form is cancelled, and again on open", () => {
    // The text fields reset by being unmounted; the picker is React state and
    // does not, so a cancelled card's players must be cleared explicitly or
    // they silently ride along on the next one. Both edges, because whatever
    // route hid the form, opening it is a fresh card.
    renderChecklist();
    openAddForm();
    pickPlayer("Aaron Judge");
    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Cancel new card"));
    openAddForm();

    expect(screen.queryByLabelText(/^Player: /)).toBeNull();
    expect(screen.queryByLabelText(/^Remove player /)).toBeNull();
  });

  it("closes the form and clears the picker after a successful add", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("604");
    pickPlayer("Aaron Judge");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(screen.queryByRole("heading", { name: "Add Card" })).toBeNull();

    openAddForm();
    expect(screen.queryByLabelText("Player: Aaron Judge")).toBeNull();
  });

  it("lets a chip be removed again before submitting", async () => {
    renderChecklist();
    openAddForm();
    fillCardNumber("605");
    pickPlayer("Aaron Judge");
    fireEvent.click(screen.getByLabelText("Remove player Aaron Judge"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0]).not.toHaveProperty("playerIds");
  });

  it("keeps a picked player when the mutation fails, so nothing is lost", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAddCustomCard.mockRejectedValue(new Error("server said no"));

    renderChecklist();
    openAddForm();
    fillCardNumber("606");
    pickPlayer("Aaron Judge");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(screen.getByRole("heading", { name: "Add Card" })).toBeTruthy();
    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("passes the ancestor chain's sport to the picker, so the typeahead is scoped", () => {
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.change(screen.getByLabelText(QA_SEARCH), {
      target: { value: "Rookie Nobody" },
    });

    expect(screen.getByLabelText("Create player Rookie Nobody")).toBeTruthy();
  });

  it("cannot create a player from a row with no sport ancestor", () => {
    state.ancestorChain = [
      { _id: VARIANT_ID, level: "variantType", value: "Base" },
    ];
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.change(screen.getByLabelText(QA_SEARCH), {
      target: { value: "Rookie Nobody" },
    });

    // NEO-96: a player must reference a real sport row. No sport, no create.
    expect(screen.queryByLabelText(/^Create player /)).toBeNull();
  });

  /**
   * The escape hatch that makes this field usable at all on a hand-added card:
   * a brand-new rookie, or anyone the marketplace sync has never named, is not
   * in the `players` table yet. `players.findOrCreate`'s resolved id has to
   * reach `addCustomCard.playerIds` through the same React-state chip list a
   * picked-from-the-list player takes.
   */
  it("creates a new player from the popover, then sends the fresh id on submit", async () => {
    mockFindOrCreatePlayer.mockImplementation(
      async ({ name }: { name: string; sportId: unknown }) => {
        const created = { _id: "player-rookie", name };
        state.players = [...state.players, created];
        return created._id;
      },
    );
    renderChecklist();
    openAddForm();
    fillCardNumber("610");
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.change(screen.getByLabelText(QA_SEARCH), {
      target: { value: "Rookie Nobody" },
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Create player Rookie Nobody"));
    });

    expect(mockFindOrCreatePlayer).toHaveBeenCalledWith({
      name: "Rookie Nobody",
      sportId: SPORT_ID,
    });
    expect(screen.getByLabelText("Player: Rookie Nobody")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0].playerIds).toEqual([
      "player-rookie",
    ]);
  });

  it("surfaces a refused create inline instead of silently doing nothing", async () => {
    // Before this the handler was a bare try/finally: "Creating…" flipped
    // back, no chip appeared, no reason was given, and the rejection went
    // unhandled. The popover must still be the SAME open popover afterwards —
    // a close/reopen would throw the message away with it.
    mockFindOrCreatePlayer.mockRejectedValue(new Error("nope"));
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.change(screen.getByLabelText(QA_SEARCH), {
      target: { value: "Rookie Nobody" },
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Create player Rookie Nobody"));
    });

    expect(screen.getByRole("alert").textContent).toBe(
      "Could not create player.",
    );
    expect(screen.getByLabelText(QA_SEARCH)).toBeTruthy();
    expect(screen.queryByLabelText(/^Player: /)).toBeNull();
  });

  it("submitting while the picker popover is still open still sends the picked player", async () => {
    // `addChip` deliberately leaves the popover open so a second player can be
    // added on a multi-player card — this is the state the form is normally IN
    // when an operator hits Add, not an edge case.
    renderChecklist();
    openAddForm();
    fillCardNumber("611");
    pickPlayer("Aaron Judge");
    expect(screen.getByLabelText(QA_SEARCH)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    expect(mockAddCustomCard.mock.calls[0][0].playerIds).toEqual([JUDGE._id]);
  });

  // a11y (WCAG 2.4.11 Focus Not Obscured). This picker's popover is
  // `absolute top-full z-10` and now opens directly over the Team row and the
  // Add/Cancel buttons below it. `PlayerPicker` had no keyboard-equivalent
  // close before NEO-220 — it had no outside-close of any kind — so tabbing
  // out of an open popover landed focus on a control the popover was still
  // visually covering.
  it("closes the player popover when Tab moves focus onto Submit (2.4.11)", async () => {
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    const searchInput = screen.getByLabelText(QA_SEARCH);

    // Let the picker's own open-time autofocus effect land first; it runs on a
    // `setTimeout(0)` queued by the same click, and synchronous test code can
    // outrun it in a way a real Tab press cannot — which would let the
    // autofocus re-steal focus and mask the close this test checks.
    await waitFor(() => expect(document.activeElement).toBe(searchInput));

    // Moving focus directly is the same observable effect a real Tab has. The
    // close is deferred (a `document.activeElement` read a tick after the
    // blur, not the blur's own `relatedTarget`), so this needs an async act to
    // flush that timer.
    await act(async () => {
      screen.getByLabelText("Submit new card").focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByLabelText(QA_SEARCH)).toBeNull();
    expect(
      screen.getByLabelText(QA_TRIGGER).getAttribute("aria-expanded"),
    ).toBe("false");
  });

  /* NEO-272 — as for the Team picker above: the popover is portalled so no
     scrolling host can clip it, and the overlap with the Team row and
     Add/Cancel is unchanged and deliberate. The listbox role and this
     instance's own accessible name travel with it, which is what both a
     screen reader and a Maestro `id:` selector read it by. */
  it("portals the player popover out of the form it covers (NEO-272)", () => {
    const { container } = renderChecklist();
    const form = openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));

    const popover = screen.getByLabelText("Player results for the new card");
    expect(form.contains(screen.getByLabelText(QA_TRIGGER))).toBe(true);
    expect(form.contains(popover)).toBe(false);
    expect(container.contains(popover)).toBe(false);
    expect(popover.parentElement?.parentElement).toBe(document.body);
    expect(popover.getAttribute("role")).toBe("listbox");
  });

  it("keeps the popover open when focus moves between controls inside it", async () => {
    // Regression guard on the fix above: "focus left the root" must not also
    // fire for focus moving from one in-picker control to another, which is
    // ordinary keyboard use.
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText(QA_SEARCH),
      ),
    );

    await act(async () => {
      screen.getByLabelText("Add Aaron Judge").focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByLabelText(QA_SEARCH)).toBeTruthy();
  });

  it("picks a highlighted player with Enter, so the field is keyboard-only operable", async () => {
    // The whole flow without a mouse: open the popover, type, Enter. Arrow
    // keys move the highlight; Enter takes it.
    renderChecklist();
    openAddForm();
    fillCardNumber("612");
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    const search = screen.getByLabelText(QA_SEARCH);
    fireEvent.change(search, { target: { value: "Francisco" } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(screen.getByLabelText("Player: Francisco Lindor")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });
    expect(mockAddCustomCard.mock.calls[0][0].playerIds).toEqual([LINDOR._id]);
  });

  it("closes the popover on Escape without picking anything", () => {
    renderChecklist();
    openAddForm();
    fireEvent.click(screen.getByLabelText(QA_TRIGGER));
    fireEvent.keyDown(screen.getByLabelText(QA_SEARCH), {
      key: "Escape",
    });

    expect(screen.queryByLabelText(QA_SEARCH)).toBeNull();
    expect(screen.queryByLabelText(/^Player: /)).toBeNull();
  });

  it("removes the last chip on Backspace in an empty search box", () => {
    renderChecklist();
    openAddForm();
    pickPlayer("Aaron Judge");
    pickPlayer("Francisco Lindor");

    fireEvent.keyDown(screen.getByLabelText(QA_SEARCH), {
      key: "Backspace",
    });

    expect(screen.getByLabelText("Player: Aaron Judge")).toBeTruthy();
    expect(screen.queryByLabelText("Player: Francisco Lindor")).toBeNull();
  });

  it("keeps the two pickers independent — a player pick is not a team pick", async () => {
    // Both pickers are chip rows with near-identical markup sitting one row
    // apart. This pins that the ids land in the right argument.
    renderChecklist();
    openAddForm();
    fillCardNumber("613");
    pickPlayer("Aaron Judge");
    pickTeam("New York Yankees");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Submit new card"));
    });

    const args = mockAddCustomCard.mock.calls[0][0];
    expect(args.playerIds).toEqual([JUDGE._id]);
    expect(args.teamOnCardIds).toEqual([YANKEES._id]);
  });
});

/**
 * NEO-212 — the checklist mounts `SkippedNamesPanel` with its own variant id.
 *
 * Only the wiring is pinned here: that the panel appears for a set WITH skips
 * and stays entirely absent for one without, scoped to the right set. The
 * panel's own list, undo, announcement and failure handling are covered by
 * SkippedNamesPanel.test.tsx.
 */
describe("CardChecklist — NEO-212 skipped-names disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [];
    state.skippedNames = [];
  });

  it("shows nothing when the set has no skipped names", () => {
    renderChecklist();
    expect(screen.queryByText(/Skipped names/)).toBeNull();
  });

  it("shows the disclosure, with its count, when the set has skipped names", () => {
    state.skippedNames = [
      {
        _id: "skip-1",
        kind: "player",
        name: "Checklist",
        skippedAt: Date.parse("2026-09-03T12:00:00Z"),
      },
    ];
    renderChecklist();

    expect(
      screen.getByLabelText("Skipped names (1) — not players or teams"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Unskip Checklist")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// NEO-221 — the orchestration half of "you cannot lose a review session by
// accident" (plan §3 WP-D: D6, D9, D10, D12 client).
//
// Everything here is about what CardChecklist DOES with the wizard, not what
// the wizard looks like: which props it hands over, what survives a trip back
// to matching, and what a failed commit costs. The wizard itself is the stub
// at the top of this file.
// ---------------------------------------------------------------------------

/** A `SyncDiff` with nothing to settle, so `needsSyncReview` is false. */
const NOTHING_TO_REVIEW = {
  cards: [],
  conflicts: [],
  removedUpstream: { fullyOrphaned: [] },
};

/** A BSC-only candidate — something the operator can KEEP in the pairing dialog. */
const bscOnlyCandidate = {
  cardNumber: "2",
  cardName: "BSC Only Player",
  bucket: "bscOnly" as const,
  confidence: 1,
  platformData: { bsc: { ref: "bsc-2" } },
};

/**
 * Drives a REAL pairing session all the way to an open wizard: two streamed
 * candidates (one matched, one BSC-only), the operator confirms the pairing,
 * the content diff has nothing to settle, and entity resolution reports an
 * unknown player.
 *
 * Distinct from `cancelEntityReviewPath` above, which reaches the same wizard
 * through the ZERO-candidate short-circuit — no pairing session ever exists on
 * that route, which is exactly why it must not be offered a way back to one.
 */
async function pairedEntityReviewPath() {
  state.liveCandidates = {
    ready: 2,
    total: 2,
    cards: [streamedCandidate, bscOnlyCandidate],
  };
  mockFetchChecklist.mockImplementation(async () =>
    publish({
    success: true,
    message: "Fetched 2 cards",
    candidateCount: 2,
    attachedSides: ["bsc", "sportlots"],
    }),
  );
  mockDiffChecklist.mockResolvedValue(NOTHING_TO_REVIEW);
  mockResolveEntities.mockResolvedValue({
    unknownPlayers: [{ name: "Unknown Guy" }],
    unknownTeams: [],
    batchId: "batch-1",
  });
  mockDiscardCandidates.mockResolvedValue(undefined);

  const rendered = renderChecklist();
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
  });
  expect(await screen.findByText(/Match Cards/)).toBeTruthy();
  return rendered;
}

/** Press Confirm in the pairing dialog and wait for the wizard to take over. */
async function confirmPairing() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Confirm card matches"));
  });
  await waitFor(() => expect(screen.getByText(/Wizard summary/)).toBeTruthy());
}

describe("CardChecklist — NEO-221 D6: what the wizard is told it will save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /**
   * The wizard used to be handed `cardCount` alone. Deletions and accepted
   * field changes are the IRREVERSIBLE half of a commit and they were decided
   * one dialog earlier, so the final step has to account for them too.
   */
  it("derives the summary from the preview, not just its card count", async () => {
    await pairedEntityReviewPath();
    await confirmPairing();

    expect(
      screen.getByText(
        "Wizard summary: 1 cards, 0 deletions, 0 field decisions",
      ),
    ).toBeTruthy();
  });
});

describe("CardChecklist — NEO-221 D9: Back to matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  it("re-opens the pairing dialog and closes the wizard", async () => {
    await pairedEntityReviewPath();
    await confirmPairing();
    expect(screen.queryByText(/Match Cards/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to matching" }));
    });

    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
  });

  /**
   * The whole point of parking rather than unmounting. `CardPairingModal`'s
   * `if (!isOpen) return null` sits BELOW its hooks, so a modal that is merely
   * hidden keeps its reducer — every link, keep and rename the operator made.
   * Read back through the CARDS the second Confirm produces: a kept BSC-only
   * card is in the confirmed set both times, which it could not be if the
   * reducer had been re-seeded from `initialData`.
   */
  it("keeps the pairing session's own state — the kept card survives the round trip", async () => {
    await pairedEntityReviewPath();

    fireEvent.click(screen.getByLabelText("Keep all BSC-only cards"));
    await confirmPairing();
    expect(mockResolveEntities.mock.calls[0][0].cards).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to matching" }));
    });
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();

    await confirmPairing();
    expect(mockResolveEntities).toHaveBeenCalledTimes(2);
    expect(mockResolveEntities.mock.calls[1][0].cards).toHaveLength(2);
  });

  /**
   * Back is NOT an abort. It leaves the batch alone (so `startBatch` resumes
   * the same review with the same decisions) and it leaves the candidates
   * alone — discarding them would empty the very dialog it goes back to.
   */
  it("does not discard the candidates it is going back to", async () => {
    await pairedEntityReviewPath();
    await confirmPairing();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to matching" }));
    });

    expect(mockDiscardCandidates).not.toHaveBeenCalled();
  });

  /**
   * The custom-subtree path reaches the wizard with `candidateCount === 0` —
   * nothing was ever paired, so there is nowhere to go back TO and the footer
   * must offer only Cancel.
   */
  it("is not offered when there was no pairing session", async () => {
    await cancelEntityReviewPath();

    expect(screen.getByText(/Wizard summary/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to matching" })).toBeNull();
  });
});

describe("CardChecklist — NEO-221 D9/D10: aborting the review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /**
   * `discardCandidates` used to fire when the operator CONFIRMED the pairing.
   * It cannot any more — a parked session can still be returned to — so it
   * moved to the two ends of the pipeline. This is the abort end.
   */
  it("closes the parked pairing session and discards its candidates", async () => {
    await pairedEntityReviewPath();
    await confirmPairing();
    expect(mockDiscardCandidates).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel entity review" }));
    });

    expect(screen.getByText("Fetch cancelled — no cards saved.")).toBeTruthy();
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
    // Closed for good: the dialog does not come back, parked or otherwise.
    expect(screen.queryByText(/Match Cards/)).toBeNull();
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
  });
});

describe("CardChecklist — NEO-221 D10: a commit that fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /**
   * The review is the expensive thing on screen — potentially hundreds of
   * create/link decisions. Clearing `pendingPreview` on a rejection threw all
   * of it away and closed the wizard over a message the operator could no
   * longer act on.
   */
  it("keeps the wizard open and hands it the failure", async () => {
    await cancelEntityReviewPath();
    mockCommitChecklist.mockRejectedValue(new Error("chunk 2/3 timed out"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm entity review" }));
    });

    expect(screen.getByText(/Wizard summary/)).toBeTruthy();
    expect(
      screen.getByText("Wizard commit error: chunk 2/3 timed out"),
    ).toBeTruthy();
    expect(screen.getByText(/Commit failed: chunk 2\/3 timed out/)).toBeTruthy();
  });

  /** Retry is the same commit, re-sent: the batch is untouched server-side. */
  it("retrying re-sends the commit, and a second attempt can land", async () => {
    await cancelEntityReviewPath();
    mockCommitChecklist.mockRejectedValueOnce(new Error("chunk 2/3 timed out"));
    mockCommitChecklist.mockResolvedValue({ count: 1, unreviewedNameCount: 0 });
    mockDiscardCandidates.mockResolvedValue(undefined);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm entity review" }));
    });
    expect(screen.getByText(/Wizard commit error/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm entity review" }));
    });

    expect(mockCommitChecklist).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
    expect(screen.getByText(/Saved 1 cards\./)).toBeTruthy();
  });

  it("dismissing the failure clears it without closing the wizard", async () => {
    await cancelEntityReviewPath();
    mockCommitChecklist.mockRejectedValue(new Error("chunk 2/3 timed out"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm entity review" }));
    });
    expect(screen.getByText(/Wizard commit error/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss commit error" }));

    expect(screen.queryByText(/Wizard commit error/)).toBeNull();
    expect(screen.getByText(/Wizard summary/)).toBeTruthy();
  });
});

describe("CardChecklist — NEO-221 D12: names nobody reviewed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /**
   * The cards ARE saved, so this is a NOTE on the success banner rather than a
   * failure — but it is the only announcement that some of them landed with no
   * player or team link at all.
   */
  it("appends the unreviewed-names sentence to the commit banner", async () => {
    state.liveCandidates = { ready: 0, total: 0, cards: [] };
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    // A COUNT and nothing else: the names themselves stay on the cards
    // (`pendingPlayerNames`/`pendingTeamNames`), which is where the attention
    // walker's fixer reads them from. Shipping them back through the commit
    // return as well would be a second copy that can only go stale.
    mockCommitChecklist.mockResolvedValue({ count: 2, unreviewedNameCount: 3 });
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockFetchChecklist.mockResolvedValue({
      success: true,
      message: "Custom selector subtree — no marketplace data available.",
      candidateCount: 0,
      attachedSides: ["bsc", "sportlots"],
    });

    renderChecklist();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
    });
    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));

    expect(
      screen.getByText(
        "Saved 2 cards. 3 names were not reviewed; those cards have no player/team link.",
      ),
    ).toBeTruthy();
  });

  it("says nothing extra when every name was reviewed", async () => {
    await commitZeroCandidatePath();

    expect(screen.getByText("Saved 2 cards.")).toBeTruthy();
  });

  /**
   * The attention count and the walker's fixer, end to end through the parent.
   *
   * DEPENDS ON WP-C: `deriveCardAttention` has to know the `unreviewedName`
   * kind before a row carrying `pendingPlayerNames` is counted at all, and
   * `updateCard` has to accept the pending arrays before the fixer's write can
   * clear them. That is why the plan lands C and D together.
   */
  it("counts a card whose names were never reviewed, and links them in the walker", async () => {
    state.players = [{ _id: "player-1", name: "Yordan Alvarez" }];
    state.cards = [
      settledCard({
        _id: "card-unreviewed" as unknown as Id<"cardChecklist">,
        cardNumber: "9",
        cardName: "Yordan Alvrez",
        pendingPlayerNames: ["Yordan Alvrez"],
      }),
    ];
    mockUpdateCard.mockResolvedValue(null);

    renderChecklist();

    fireEvent.click(screen.getByRole("button", { name: "1 needs you" }));

    // The unreviewed name is shown — an operator cannot link a misspelling
    // they cannot see. Scoped to the fixer's own list: the grid row behind the
    // dialog carries the same text.
    const names = await screen.findByRole("list", {
      name: "Typed on this card, not linked yet",
    });
    expect(names.textContent).toContain("Yordan Alvrez");

    // Link the real player through the walker's picker and save. The
    // attention walker's `UnreviewedNameFixer` mounts a DEFAULT-labelled
    // PlayerPicker — only the quick-add form's instance is renamed (NEO-220),
    // and this is the test that says so.
    fireEvent.click(screen.getByLabelText("Add player"));
    fireEvent.click(screen.getByLabelText("Add Yordan Alvarez"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Save & Next/ }));
    });

    expect(mockUpdateCard).toHaveBeenCalledWith({
      id: "card-unreviewed",
      playerIds: ["player-1"],
      teamOnCardIds: ["team-1"],
      pendingPlayerNames: [],
      pendingTeamNames: [],
    });
  });
});

// ---------------------------------------------------------------------------
// NEO-221 — the failure paths out of a PARKED pairing session.
//
// `handlePairingConfirm` parks the session (D9) so the wizard can offer "Back
// to matching". Three routes then leave no dialog on screen at all, and each
// one used to leave the session parked forever: nothing could reach it, its
// candidates were never discarded, and — because `startCandidateBatch` clears
// and rewrites in ONE transaction — the next Sync re-showed the SAME modal
// instance, whose append-only absorb stacked the new batch beside the stale
// one. Confirm then shipped cards from a checklist the operator was no longer
// looking at.
// ---------------------------------------------------------------------------

/** A second fetch's candidate, sharing nothing with the first batch. */
const freshCandidate = {
  cardNumber: "7",
  cardName: "Fresh Player",
  bucket: "matched" as const,
  confidence: 1,
  platformData: { bsc: { ref: "bsc-7" }, sportlots: { ref: "sl-7" } },
};

/**
 * Sync again after a failure and assert the dialog that comes back holds ONLY
 * the new batch.
 *
 * This is the bleed itself, observed from the operator's seat: a stale row
 * surviving into the next session is a card that can be committed onto a set
 * it was never fetched for.
 */
async function resyncAndExpectOnlyTheNewBatch() {
  state.liveCandidates = { ready: 1, total: 1, cards: [freshCandidate] };
  // NEO-330: the re-sync reports the batch it actually published, so its
  // dialog settles rather than waiting out the budget on a stale count.
  mockFetchChecklist.mockImplementation(async () =>
    publish({
      success: true,
      message: "Fetched 1 card",
      candidateCount: 1,
      attachedSides: ["bsc", "sportlots"],
    }),
  );
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
  });

  expect(await screen.findByText(/Match Cards/)).toBeTruthy();
  expect(screen.getByText(/Fresh Player/)).toBeTruthy();
  expect(screen.queryByText(/Streamed Player/)).toBeNull();
  expect(screen.queryByText(/BSC Only Player/)).toBeNull();
}

describe("CardChecklist — NEO-221: a parked session that nothing can reach", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /** (a) The content diff — or entity resolution — throws. */
  it("closes and discards when the step after pairing throws", async () => {
    await pairedEntityReviewPath();
    mockDiffChecklist.mockRejectedValue(new Error("diff exploded"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });

    expect(screen.getByText("Error: diff exploded")).toBeTruthy();
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
    // No dialog is on screen, so the session has to end itself.
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
    await resyncAndExpectOnlyTheNewBatch();
  });

  /**
   * (b) The commit fails on the path with NO unknowns — so no wizard opens,
   * and `commitError` has nothing to render it. The banner is the only place
   * the operator sees this, and the session still has to end.
   */
  it("closes when a commit fails with no wizard to report it", async () => {
    // NEO-335: the node's set-level team covers every new card, so nothing
    // would save teamless and no wizard opens — the path this test is about.
    state.variantRow = { value: "Test Set", teamIds: ["team-set"] };
    await pairedEntityReviewPath();
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    mockCommitChecklist.mockRejectedValue(new Error("chunk 2/3 timed out"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });

    expect(screen.getByText(/Commit failed: chunk 2\/3 timed out/)).toBeTruthy();
    expect(screen.queryByText(/Wizard summary/)).toBeNull();
    await resyncAndExpectOnlyTheNewBatch();
  });

  /** (c) The content review was shown, skipped, and the step after it threw. */
  it("closes and discards when the step after the content review throws", async () => {
    await pairedEntityReviewPath();
    mockDiffChecklist.mockResolvedValue({
      cards: [],
      removedUpstream: {
        fullyOrphaned: [
          {
            id: "row-gone" as unknown as Id<"cardChecklist">,
            cardNumber: "5",
            cardName: "Gone Card",
            sides: ["bsc"],
          },
        ],
        partialOrphanCount: 0,
      },
      conflicts: [],
      collisionInsertCount: 0,
      ambiguityBlockedCount: 0,
    });
    mockResolveEntities.mockRejectedValue(new Error("resolve exploded"));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });
    // The content review takes over from the pairing dialog.
    await screen.findByText(/Gone Card/);

    await act(async () => {
      // Its accessible name is the aria-label, not the visible "Skip changes".
      fireEvent.click(
        screen.getByRole("button", { name: /Skip reviewing changes/ }),
      );
    });

    expect(screen.getByText("Error: resolve exploded")).toBeTruthy();
    expect(mockDiscardCandidates).toHaveBeenCalledWith({
      selectorOptionId: VARIANT_ID,
    });
    await resyncAndExpectOnlyTheNewBatch();
  });
});

/**
 * NEO-251 — the disagreement reaches the DIFF and stops there.
 *
 * This is the wiring half of a rule whose two ends are already proven
 * elsewhere, and it is the half that was missing:
 *
 *  - `convex/diffChecklistAgainstExisting.test.ts` proves the diff suppresses a
 *    field when the incoming card carries the conflict and the stored value is
 *    the side the merge did NOT pick (the operator settled it last sync).
 *  - `convex/playersConflict.guards.test.ts` proves `commitCardChecklist`
 *    THROWS on a card still carrying `playersConflict`.
 *
 * So the conflict must reach exactly one of the two calls. `CardPairingModal`
 * hands back committable cards plus an index-keyed `conflictsByIndex`, and
 * `withConflicts` puts them together for the diff query alone. Without this
 * test the server-side suppression is unreachable in production and nothing
 * fails.
 */
describe("CardChecklist — NEO-251: conflicts reach the diff, not the commit", () => {
  const conflictedCandidate = {
    ...streamedCandidate,
    // NEO-335: teamed, so the no-unknowns commit still goes straight through.
    teams: ["Giants"],
    players: ["Mike Yastrzemski"],
    playersConflict: {
      bsc: ["Mike Yastrzemski"],
      sportlots: ["Mike Yastrzemski", "Carl Yastrzemski"],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    state.teams = [];
    state.players = [];
    state.skippedNames = [];
  });

  /** Stream one conflicted matched candidate and press Confirm. */
  async function confirmConflictedPairing() {
    state.liveCandidates = {
      ready: 1,
      total: 1,
      cards: [conflictedCandidate],
    };
    mockFetchChecklist.mockImplementation(async () =>
      publish({
      success: true,
      message: "Fetched 1 card",
      candidateCount: 1,
      attachedSides: ["bsc", "sportlots"],
      }),
    );
    // Nothing to settle — which is the POINT on the re-sync this models: the
    // stored row already carries SportLots' roster because the operator chose
    // it last time, so the server suppresses the field and the review is
    // skipped entirely.
    mockDiffChecklist.mockResolvedValue(NOTHING_TO_REVIEW);
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: "batch-1",
    });
    mockCommitChecklist.mockResolvedValue({ saved: 1 });
    mockDiscardCandidates.mockResolvedValue(undefined);

    renderChecklist();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
    });
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });
  }

  it("hands the diff both marketplaces' rosters", async () => {
    await confirmConflictedPairing();

    await waitFor(() => expect(mockDiffChecklist).toHaveBeenCalled());
    const [, args] = mockDiffChecklist.mock.calls[0];
    expect(args.cards[0].playersConflict).toEqual({
      bsc: ["Mike Yastrzemski"],
      sportlots: ["Mike Yastrzemski", "Carl Yastrzemski"],
    });
    // The card still carries the merge's default, exactly as the server sent
    // it — the conflict ADDS the loser, it does not swap the winner.
    expect(args.cards[0].players).toEqual(["Mike Yastrzemski"]);
  });

  it("hands entity resolution and the commit a card with no conflict on it", async () => {
    await confirmConflictedPairing();

    await waitFor(() => expect(mockResolveEntities).toHaveBeenCalled());
    expect(mockResolveEntities.mock.calls[0][0].cards[0]).not.toHaveProperty(
      "playersConflict",
    );

    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
    expect(mockCommitChecklist.mock.calls[0][0].cards[0]).not.toHaveProperty(
      "playersConflict",
    );
  });

  /**
   * THE FLIP, end to end through the real pairing dialog.
   *
   * The operator opens the re-sync and moves this row to SportLots. What must
   * reach the diff is the card carrying THEIR choice and NO conflict entry:
   * the entry means "nobody settled this", and with it in place the server
   * suppresses `playerIds`, the review is skipped, the commit runs with no
   * `applyFields`, and the flip is discarded without a word.
   *
   * The two halves of this rule are proven separately —
   * `CardPairingModal.test.tsx` pins that a touched row withholds its entry,
   * and `convex/diffChecklistAgainstExisting.test.ts` pins that a card without
   * one reports the change. This is the wiring that has to hold them together.
   */
  it("a row the operator FLIPPED reaches the diff with no conflict on it", async () => {
    state.liveCandidates = { ready: 1, total: 1, cards: [conflictedCandidate] };
    mockFetchChecklist.mockImplementation(async () =>
      publish({
      success: true,
      message: "Fetched 1 card",
      candidateCount: 1,
      attachedSides: ["bsc", "sportlots"],
      }),
    );
    mockDiffChecklist.mockResolvedValue(NOTHING_TO_REVIEW);
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: "batch-1",
    });
    mockCommitChecklist.mockResolvedValue({ saved: 1 });
    mockDiscardCandidates.mockResolvedValue(undefined);

    renderChecklist();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
    });
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();

    // Settle it the other way, in the real dialog.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("radio", {
          name: /^SportLots: Mike Yastrzemski \/ Carl Yastrzemski/,
        }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });

    await waitFor(() => expect(mockDiffChecklist).toHaveBeenCalled());
    const [, args] = mockDiffChecklist.mock.calls[0];
    expect(args.cards[0].players).toEqual([
      "Mike Yastrzemski",
      "Carl Yastrzemski",
    ]);
    // No entry — so the server has nothing to suppress against, and the change
    // is reported like any other.
    expect(args.cards[0].playersConflict).toBeUndefined();
  });

  /**
   * The re-pick, which `chosen` cannot distinguish from an untouched row: the
   * operator confirms BSC over a stored SportLots roster. The card is
   * unchanged, and the conflict must still be withheld.
   */
  it("a row the operator RE-PICKED on its default also arrives with no conflict", async () => {
    state.liveCandidates = { ready: 1, total: 1, cards: [conflictedCandidate] };
    mockFetchChecklist.mockImplementation(async () =>
      publish({
      success: true,
      message: "Fetched 1 card",
      candidateCount: 1,
      attachedSides: ["bsc", "sportlots"],
      }),
    );
    mockDiffChecklist.mockResolvedValue(NOTHING_TO_REVIEW);
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: "batch-1",
    });
    mockCommitChecklist.mockResolvedValue({ saved: 1 });
    mockDiscardCandidates.mockResolvedValue(undefined);

    renderChecklist();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
    });
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("radio", { name: /^BSC: Mike Yastrzemski —/ }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });

    await waitFor(() => expect(mockDiffChecklist).toHaveBeenCalled());
    const [, args] = mockDiffChecklist.mock.calls[0];
    expect(args.cards[0].players).toEqual(["Mike Yastrzemski"]);
    expect(args.cards[0].playersConflict).toBeUndefined();
  });

  it("leaves an agreeing card untouched on the way to the diff", async () => {
    state.liveCandidates = { ready: 1, total: 1, cards: [streamedCandidate] };
    mockFetchChecklist.mockImplementation(async () =>
      publish({
      success: true,
      message: "Fetched 1 card",
      candidateCount: 1,
      attachedSides: ["bsc", "sportlots"],
      }),
    );
    mockDiffChecklist.mockResolvedValue(NOTHING_TO_REVIEW);
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: "batch-1",
    });
    mockCommitChecklist.mockResolvedValue({ saved: 1 });
    mockDiscardCandidates.mockResolvedValue(undefined);

    renderChecklist();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Sync card checklist"));
    });
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Confirm card matches"));
    });

    await waitFor(() => expect(mockDiffChecklist).toHaveBeenCalled());
    const [, args] = mockDiffChecklist.mock.calls[0];
    // `toBeUndefined`, not `not.toHaveProperty`: the candidate→PairingCard
    // mapping assigns both fields unconditionally, so an agreeing row carries
    // the KEYS with no value. That is what `v.optional` accepts and what the
    // modal's `seedMatched` treats as "nothing to lift" — the assertion that
    // matters is that no disagreement was invented.
    expect(args.cards[0].playersConflict).toBeUndefined();
    expect(args.cards[0].nameConflict).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NEO-312 — the parallel-build runner's effect on THIS checklist: the Sync
// slot on a parallel row, the held-controls a11y contract while a build
// touches this checklist (the insert's own run) or this row's own manual
// build is in flight, and the auto-run that follows a landed commit on an
// insert (never on a Base row, which passes no `parallelBuild` at all).
// ---------------------------------------------------------------------------

const INSERT_ROW_ID = "insert-row-1" as unknown as Id<"selectorOptions">;

/** A `ParallelBuildResult` with every field `builtText`/`buildNotice` read. */
function parallelBuiltResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "built",
    copied: 3,
    notCopied: 0,
    unlinked: { bsc: 0, sportlots: 0 },
    ambiguous: { bsc: 0, sportlots: 0 },
    sidesFetched: ["bsc"],
    sidesSkipped: [],
    earlierLinksMissing: { bsc: 0, sportlots: 0 },
    stillListedNotRelinked: { bsc: 0, sportlots: 0 },
    legacyLinksRemoved: { bsc: 0, sportlots: 0 },
    skippedChangedSource: 0,
    extraOnMarketplace: {
      bsc: { count: 0, cards: [] },
      sportlots: { count: 0, cards: [] },
    },
    cards: { leftOff: [], unlinked: { bsc: [], sportlots: [] }, ambiguous: { bsc: [], sportlots: [] } },
    rebuilt: false,
    ...overrides,
  };
}

function renderParallelRow() {
  return render(
    <CardChecklist
      variantId={VARIANT_ID}
      sourceChips={{}}
      sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      parallelBuild={{ role: "parallel", sourceId: INSERT_ROW_ID, sourceValue: "Anime" }}
    />,
  );
}

function renderInsertRow() {
  return render(
    <CardChecklist
      variantId={VARIANT_ID}
      sourceChips={{}}
      sourceLabelMaps={{ bsc: {}, sportlots: {} }}
      parallelBuild={{ role: "insert" }}
    />,
  );
}

describe("CardChecklist — NEO-312 a parallel row's Sync slot builds instead of fetching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Anime Kanji" };
    state.ancestorChain = [];
    state.liveCandidates = null;
    mockGetParallelsForBuild.mockResolvedValue({ parallels: [], truncated: false });
  });

  it("shows Build from {insert} in place of Sync, and calling it never reaches fetchCardChecklist or Match Cards", async () => {
    renderParallelRow();

    // No ordinary Sync control exists on a parallel row at all.
    expect(screen.queryByLabelText("Sync card checklist")).toBeNull();
    const button = screen.getByRole("button", { name: "Build from Anime" });

    mockBuildParallelChecklist.mockResolvedValue(parallelBuiltResult());
    fireEvent.click(button);

    await waitFor(() =>
      expect(mockBuildParallelChecklist).toHaveBeenCalledWith({ parallelId: VARIANT_ID }),
    );
    expect(mockFetchChecklist).not.toHaveBeenCalled();
    expect(screen.queryByText(/Match Cards/)).toBeNull();
  });
});

describe("CardChecklist — NEO-312 held controls (a11y 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [settledCard()];
    state.variantRow = { value: "Anime" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = { ready: 0, total: 0, cards: [] };
  });

  it("Add Card and Add Cross-Release Cards are not held before any build starts", () => {
    mockGetParallelsForBuild.mockResolvedValue({ parallels: [], truncated: false });
    renderInsertRow();
    expect(
      screen.getByLabelText("Open add card form").getAttribute("aria-disabled"),
    ).toBeNull();
    expect(
      screen
        .getByLabelText("Open add cross-release cards form")
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("holds Add Card, Add Cross-Release Cards and the card list — described by the insert's panel heading — while the insert's own run touches this checklist", async () => {
    // A plan with one parallel so the run stays "running" (never resolves)
    // and `runTouchesThis` is true for the INSERT row itself.
    mockGetParallelsForBuild.mockResolvedValue({
      truncated: false,
      parallels: [
        { _id: "parallel-a", value: "Anime Gold", sides: { bsc: true, sportlots: false }, hasCards: false },
      ],
    });
    mockResolveEntities.mockResolvedValue({ unknownPlayers: [], unknownTeams: [], batchId: undefined });
    mockCommitChecklist.mockResolvedValue({ count: 1, unreviewedNameCount: 0 });
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockBuildParallelChecklist.mockImplementation(() => new Promise(() => {})); // never resolves — stays "running"
    let resolveFetch!: (value: unknown) => void;
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );

    renderInsertRow();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    await act(async () => {
      resolveFetch({
        success: true,
        message: NOTHING_TO_FETCH_MESSAGE,
        candidateCount: 0,
        attachedSides: ["bsc", "sportlots"],
      });
    });
    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
    // The run has started and is building "Anime Gold" — still "running"
    // because the action never resolves.
    await waitFor(() =>
      expect(mockGetParallelsForBuild).toHaveBeenCalledWith({ sourceId: VARIANT_ID }),
    );

    const addCard = await screen.findByLabelText("Open add card form");
    await waitFor(() => expect(addCard.getAttribute("aria-disabled")).toBe("true"));
    expect(addCard.getAttribute("aria-describedby")).toBe(PARALLEL_BUILD_HEADING_ID);

    const addCrossRelease = screen.getByLabelText("Open add cross-release cards form");
    expect(addCrossRelease.getAttribute("aria-disabled")).toBe("true");
    expect(addCrossRelease.getAttribute("aria-describedby")).toBe(PARALLEL_BUILD_HEADING_ID);

    const group = screen.getByRole("group", { hidden: true });
    expect(group.getAttribute("aria-disabled")).toBe("true");
    expect(group.getAttribute("aria-describedby")).toBe(PARALLEL_BUILD_HEADING_ID);
  });

  it("holds Add Card and Add Cross-Release Cards — described by this parallel's own note — while its OWN manual build is in flight, and not otherwise", async () => {
    state.cards = [];
    mockGetParallelsForBuild.mockResolvedValue({ parallels: [], truncated: false });
    mockBuildParallelChecklist.mockImplementation(() => new Promise(() => {})); // never resolves

    renderParallelRow();
    const addCardBefore = screen.getByLabelText("Open add card form");
    expect(addCardBefore.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Build from Anime" }));

    await waitFor(() =>
      expect(mockBuildParallelChecklist).toHaveBeenCalledWith({ parallelId: VARIANT_ID }),
    );
    const addCard = screen.getByLabelText("Open add card form");
    await waitFor(() => expect(addCard.getAttribute("aria-disabled")).toBe("true"));
    // Mirrors CardChecklist.tsx's own private `MANUAL_BUILD_NOTE_ID` constant
    // (not exported — it names this component's own hidden note, never the
    // panel's heading, which is the OTHER-row case above).
    expect(addCard.getAttribute("aria-describedby")).toBe("parallel-build-own-note");
    const addCrossRelease = screen.getByLabelText("Open add cross-release cards form");
    expect(addCrossRelease.getAttribute("aria-disabled")).toBe("true");
    expect(addCrossRelease.getAttribute("aria-describedby")).toBe("parallel-build-own-note");
  });

  /** A hosted runner whose `run` is a fixed, already-built state — no fetch/commit driving needed. */
  function hostedRunner(run: ParallelBuildRunner["run"]): ParallelBuildRunner {
    return {
      run,
      active: run?.phase === "running" || run?.phase === "stopping",
      inFlight: new Set(),
      start: vi.fn(),
      stop: vi.fn(),
      buildOne: vi.fn(),
    };
  }

  it("a run active on a DIFFERENT insert entirely never holds this checklist", () => {
    const foreign = hostedRunner({
      startedFrom: "some-other-insert" as unknown as Id<"selectorOptions">,
      sourceId: "some-other-insert" as unknown as Id<"selectorOptions">,
      sourceValue: "Other Insert",
      sourceKind: "insert",
      entries: [
        { id: "other-parallel" as unknown as Id<"selectorOptions">, value: "X", line: { kind: "building" } },
      ],
      truncated: false,
      phase: "running",
      atIndex: 0,
      announcement: "",
    });
    render(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
        parallelRun={foreign}
      />,
    );
    expect(
      screen.getByLabelText("Open add card form").getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("holds a parallel still WAITING in the insert's run — described by its own ledger line, not the heading", () => {
    const run = {
      startedFrom: INSERT_ROW_ID,
      sourceId: INSERT_ROW_ID,
      sourceValue: "Anime",
      sourceKind: "insert" as const,
      entries: [{ id: VARIANT_ID, value: "Anime Kanji", line: { kind: "waiting" as const } }],
      truncated: false,
      phase: "running" as const,
      atIndex: 0,
      announcement: "",
    };
    render(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
        parallelBuild={{ role: "parallel", sourceId: INSERT_ROW_ID, sourceValue: "Anime" }}
        parallelRun={hostedRunner(run)}
      />,
    );
    const addCard = screen.getByLabelText("Open add card form");
    expect(addCard.getAttribute("aria-disabled")).toBe("true");
    expect(addCard.getAttribute("aria-describedby")).toBe(parallelLineId(VARIANT_ID));
  });
});

describe("CardChecklist — NEO-312 the auto-run after a commit (J1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Anime" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
  });

  async function driveZeroCandidateCommit() {
    state.liveCandidates = { ready: 0, total: 0, cards: [] };
    mockResolveEntities.mockResolvedValue({ unknownPlayers: [], unknownTeams: [], batchId: undefined });
    mockCommitChecklist.mockResolvedValue({ count: 2, unreviewedNameCount: 0 });
    mockDiscardCandidates.mockResolvedValue(undefined);
    let resolveFetch!: (value: unknown) => void;
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    await act(async () => {
      resolveFetch({
        success: true,
        message: NOTHING_TO_FETCH_MESSAGE,
        candidateCount: 0,
        attachedSides: ["bsc", "sportlots"],
      });
    });
    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalledTimes(1));
  }

  it("starts the run after a successful commit on an INSERT row", async () => {
    mockGetParallelsForBuild.mockResolvedValue({ parallels: [], truncated: false });
    renderInsertRow();
    await driveZeroCandidateCommit();
    await waitFor(() =>
      expect(mockGetParallelsForBuild).toHaveBeenCalledWith({ sourceId: VARIANT_ID }),
    );
  });

  it("never starts a run after a successful commit on a Base row (no parallelBuild prop)", async () => {
    renderChecklist();
    await driveZeroCandidateCommit();
    expect(mockGetParallelsForBuild).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NEO-321 — Base's parallels. D3: a base-parallel row (an insert-level row
// under the Parallel variant type) builds from Base instead of fetching; and
// while the section's run is live the BASE checklist is held, because the
// run is copying it.
// ---------------------------------------------------------------------------

describe("CardChecklist — NEO-321 a base-parallel row builds from Base (D3)", () => {
  const BASE_ID = "base-row-1" as unknown as Id<"selectorOptions">;

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Gold Wave" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = null;
    mockGetParallelsForBuild.mockResolvedValue({ parallels: [], truncated: false });
  });

  function renderBaseParallel(...args: [] | [string | undefined]) {
    // An explicit `undefined` means "Base's name has not loaded", not "default".
    const sourceValue = args.length ? args[0] : "Base";
    return render(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
        parallelBuild={{ role: "parallel", sourceId: BASE_ID, sourceValue }}
      />,
    );
  }

  it("an empty base-parallel shows Build from Base, and no Fetch from Marketplaces or Match Cards", () => {
    renderBaseParallel();
    expect(screen.getByRole("button", { name: "Build from Base" })).toBeTruthy();
    expect(screen.queryByText("Fetch from Marketplaces")).toBeNull();
    expect(screen.queryByLabelText("Sync card checklist")).toBeNull();
    expect(screen.queryByText(/Match Cards/)).toBeNull();
  });

  it("a base-parallel that already has cards shows Rebuild from Base, and no Refresh", () => {
    state.cards = [settledCard()];
    renderBaseParallel();
    expect(screen.getByRole("button", { name: "Rebuild from Base" })).toBeTruthy();
    expect(screen.queryByText("Refresh")).toBeNull();
    expect(screen.queryByLabelText("Sync card checklist")).toBeNull();
  });

  it("the button's label follows the source's name, never a literal", () => {
    renderBaseParallel("Flagship");
    expect(screen.getByRole("button", { name: "Build from Flagship" })).toBeTruthy();
  });

  it("pressing it builds this row by id and never reaches the marketplace fetch", async () => {
    mockBuildParallelChecklist.mockResolvedValue(parallelBuiltResult());
    renderBaseParallel();
    fireEvent.click(screen.getByRole("button", { name: "Build from Base" }));

    await waitFor(() =>
      expect(mockBuildParallelChecklist).toHaveBeenCalledWith({ parallelId: VARIANT_ID }),
    );
    expect(mockFetchChecklist).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();
  });

  it("until Base's name is known a Loading… stand-in holds the slot: busy, inert, and no fetch to fall back on", async () => {
    renderBaseParallel(undefined);
    const standIn = screen.getByRole("button", { name: "Loading…" });
    expect(standIn.getAttribute("aria-disabled")).toBe("true");
    expect(standIn.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(standIn);
    expect(mockBuildParallelChecklist).not.toHaveBeenCalled();
    expect(mockFetchChecklist).not.toHaveBeenCalled();
    expect(screen.queryByText("Fetch from Marketplaces")).toBeNull();
    expect(screen.queryByLabelText("Sync card checklist")).toBeNull();
  });

  it("with no single Base the stand-in says Can't build yet, is described by the reason, and is never actionable", () => {
    render(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
        parallelBuild={{ role: "parallel", unavailableReasonId: "why-not" }}
      />,
    );
    const standIn = screen.getByRole("button", { name: "Can't build yet" });
    expect(standIn.getAttribute("aria-disabled")).toBe("true");
    expect(standIn.getAttribute("aria-describedby")).toBe("why-not");
    expect(standIn.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(standIn);
    expect(mockBuildParallelChecklist).not.toHaveBeenCalled();
    expect(mockFetchChecklist).not.toHaveBeenCalled();
  });
});

describe("CardChecklist — NEO-321 the Base checklist is held while a base run is live", () => {
  const PARALLEL_TYPE_ID = "vt-parallel" as unknown as Id<"selectorOptions">;
  const OTHER_PARALLEL = "gold-wave" as unknown as Id<"selectorOptions">;

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [settledCard()];
    state.variantRow = { value: "Base" };
    state.ancestorChain = twoSidedChain();
    state.liveCandidates = { ready: 0, total: 0, cards: [] };
  });

  function baseRun(
    phase: "running" | "stopping" | "finished",
    entries: Array<{ id: Id<"selectorOptions">; line: { kind: "waiting" } | { kind: "building" } }> = [],
  ): ParallelBuildRunner {
    const run = {
      // Started from the Parallel variant type; the source is THIS row.
      startedFrom: PARALLEL_TYPE_ID,
      sourceId: VARIANT_ID,
      sourceValue: "Base",
      sourceKind: "base" as const,
      entries: entries.map((e) => ({ ...e, value: "Gold Wave" })),
      truncated: false,
      phase,
      atIndex: 0,
      announcement: "",
    };
    return {
      run,
      active: phase === "running" || phase === "stopping",
      inFlight: new Set(),
      start: vi.fn(),
      stop: vi.fn(),
      buildOne: vi.fn(),
    };
  }

  function renderBase(runner: ParallelBuildRunner, panelElsewhere = false) {
    return render(
      <CardChecklist
        variantId={VARIANT_ID}
        sourceChips={{}}
        sourceLabelMaps={{ bsc: {}, sportlots: {} }}
        parallelRun={runner}
        parallelPanelElsewhere={panelElsewhere}
      />,
    );
  }

  it("holds Add Card, Add Cross-Release Cards and the card list, described by the panel heading", () => {
    renderBase(baseRun("running", [{ id: OTHER_PARALLEL, line: { kind: "building" } }]));

    const addCard = screen.getByLabelText("Open add card form");
    expect(addCard.getAttribute("aria-disabled")).toBe("true");
    expect(addCard.getAttribute("aria-describedby")).toBe(PARALLEL_BUILD_HEADING_ID);
    const addCross = screen.getByLabelText("Open add cross-release cards form");
    expect(addCross.getAttribute("aria-disabled")).toBe("true");
    expect(addCross.getAttribute("aria-describedby")).toBe(PARALLEL_BUILD_HEADING_ID);
    const group = screen.getByRole("group", { hidden: true });
    expect(group.getAttribute("aria-disabled")).toBe("true");
    expect(group.getAttribute("aria-describedby")).toBe(PARALLEL_BUILD_HEADING_ID);
  });

  it("holds Sync too: a new Base save mid-copy would change what the run is copying", () => {
    renderBase(baseRun("running", [{ id: OTHER_PARALLEL, line: { kind: "building" } }]));
    const sync = screen.getByLabelText("Sync card checklist") as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
  });

  it("holds while Stop is pending too", () => {
    renderBase(baseRun("stopping", [{ id: OTHER_PARALLEL, line: { kind: "building" } }]));
    expect(
      screen.getByLabelText("Open add card form").getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("does not hold once the run has finished", () => {
    renderBase(baseRun("finished", [{ id: OTHER_PARALLEL, line: { kind: "building" } }]));
    expect(
      screen.getByLabelText("Open add card form").getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("draws the ledger itself unless the section already shows it", () => {
    const runner = baseRun("running", [{ id: OTHER_PARALLEL, line: { kind: "building" } }]);
    const { unmount } = renderBase(runner, false);
    expect(document.getElementById(PARALLEL_BUILD_HEADING_ID)).toBeTruthy();
    unmount();

    renderBase(runner, true);
    // One panel per page: the section owns it, but the held controls still
    // point at its heading by id.
    expect(document.getElementById(PARALLEL_BUILD_HEADING_ID)).toBeNull();
    expect(
      screen.getByLabelText("Open add card form").getAttribute("aria-describedby"),
    ).toBe(PARALLEL_BUILD_HEADING_ID);
  });
});

/**
 * NEO-333 — the BSC team lookup is the fetch's LAST step, and Convex resolves
 * an action's promise without waiting for subscriptions to catch up. The row
 * count matched ~70s earlier, so a client that waited on the count alone took
 * its snapshot before the teams landed: the review wizard never saw BSC's
 * teams, and the commit saved team-less cards.
 *
 * The fetch now returns a fence — the batch it wrote and the `ready` count the
 * server saw after its last team write — and both paths wait for the
 * subscription to reach it before they hand cards on.
 */
describe("CardChecklist — the team fence (NEO-333)", () => {
  let resolveFetch: (value: unknown) => void;

  /** Only BSC attached: the set's BSC link, and no SportLots set id. */
  const soloBscChain = () => [
    {
      _id: SPORT_ID,
      level: "sport",
      value: "Baseball",
      platformData: { bsc: { b0: "baseball" }, sportlots: { s0: "1" } },
    },
    {
      _id: SET_ID,
      level: "setName",
      value: "Test Set",
      platformData: { bsc: { b0: "2024-topps" } },
    },
    { _id: VARIANT_ID, level: "variantType", value: "Base", platformData: {} },
  ];

  const bscCandidate = (n: string, teams?: string[]) => ({
    cardNumber: n,
    cardName: `BSC Card ${n}`,
    bucket: "bscOnly" as const,
    platformData: { bsc: { ref: `bsc-${n}` } },
    ...(teams ? { teams, teamResolved: true } : { teamResolved: false }),
  });

  /** Every row there, no team resolved yet — the state the count matched on. */
  const rowsWithoutTeams = {
    batchId: "batch-333",
    ready: 0,
    total: 2,
    cards: [bscCandidate("1"), bscCandidate("2")],
  };
  /** The same batch once the lookup's writes have reached the client. */
  const rowsWithTeams = {
    batchId: "batch-333",
    ready: 2,
    total: 2,
    cards: [
      bscCandidate("1", ["Cleveland Guardians", "Washington Nationals"]),
      bscCandidate("2", ["San Diego Padres"]),
    ],
  };
  const fencedResult = {
    success: true,
    message: "0 matched, 2 BSC-only, 0 SL-only",
    candidateCount: 2,
    candidateBatchId: "batch-333",
    readyAfterTeams: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.cards = [];
    state.variantRow = { value: "Test Set" };
    state.liveCandidates = null;
    mockDiscardCandidates.mockResolvedValue(undefined);
    mockDiffChecklist.mockResolvedValue({
      cards: [],
      removedUpstream: { fullyOrphaned: [], partialOrphanCount: 0 },
      conflicts: [],
      collisionInsertCount: 0,
      ambiguityBlockedCount: 0,
    });
    mockResolveEntities.mockResolvedValue({
      unknownPlayers: [],
      unknownTeams: [],
      batchId: undefined,
    });
    mockCommitChecklist.mockResolvedValue({ count: 2 });
    mockFetchChecklist.mockImplementation(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
  });

  it("one marketplace: waits for the teams, not just the rows, before it hands the cards on", async () => {
    state.ancestorChain = soloBscChain();
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));

    // The rows arrived long ago; the action resolves before the team writes
    // reach the subscription.
    await streamCandidates(rerender, rowsWithoutTeams);
    await act(async () => {
      resolveFetch({ ...fencedResult, attachedSides: ["bsc"] });
    });

    // The count matches, but the fence does not: nothing handed on yet.
    expect(mockResolveEntities).not.toHaveBeenCalled();
    expect(mockCommitChecklist).not.toHaveBeenCalled();

    // The team writes land.
    await streamCandidates(rerender, rowsWithTeams);
    await waitFor(() => expect(mockResolveEntities).toHaveBeenCalled());
    // The wizard's entity resolution sees BSC's teams — a dual-team card as
    // two names — and so does the commit.
    expect(mockResolveEntities.mock.calls[0][0].cards).toEqual([
      expect.objectContaining({
        cardNumber: "1",
        teams: ["Cleveland Guardians", "Washington Nationals"],
      }),
      expect.objectContaining({ cardNumber: "2", teams: ["San Diego Padres"] }),
    ]);
    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
    expect(
      mockCommitChecklist.mock.calls[0][0].cards.map(
        (c: { teams?: string[] }) => c.teams,
      ),
    ).toEqual([
      ["Cleveland Guardians", "Washington Nationals"],
      ["San Diego Padres"],
    ]);
  });

  it("one marketplace: a fence below total is met — rows that never needed a lookup do not hang it", async () => {
    // NEO-255 refused to gate on readiness because rows that arrived with a
    // team already parsed stay `pending` for good, so `ready` never reaches
    // `total`. The fence is the server's own post-lookup count, which those
    // rows are not in.
    state.ancestorChain = soloBscChain();
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    await streamCandidates(rerender, {
      ...rowsWithTeams,
      ready: 1,
      cards: [
        rowsWithTeams.cards[0],
        // Parsed at fetch time, never looked up, still `pending`.
        { ...rowsWithTeams.cards[1], teamResolved: false },
      ],
    });
    await act(async () => {
      resolveFetch({ ...fencedResult, readyAfterTeams: 1, attachedSides: ["bsc"] });
    });

    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
    expect(mockCommitChecklist.mock.calls[0][0].cards).toHaveLength(2);
  });

  it("one marketplace: a fence naming another batch is never met by this one", async () => {
    // Same count, teams and all — but not the batch this run wrote.
    state.ancestorChain = soloBscChain();
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    await streamCandidates(rerender, { ...rowsWithTeams, batchId: "batch-old" });
    await act(async () => {
      resolveFetch({ ...fencedResult, attachedSides: ["bsc"] });
    });
    expect(mockResolveEntities).not.toHaveBeenCalled();

    await streamCandidates(rerender, rowsWithTeams);
    await waitFor(() => expect(mockCommitChecklist).toHaveBeenCalled());
  });

  it("two marketplaces: Confirm stays locked until the teams have reached the dialog", async () => {
    state.ancestorChain = twoSidedChain();
    const { rerender } = renderChecklist();
    fireEvent.click(screen.getByLabelText("Sync card checklist"));
    await streamCandidates(rerender, rowsWithoutTeams);
    expect(await screen.findByText(/Match Cards/)).toBeTruthy();

    await act(async () => {
      resolveFetch({ ...fencedResult, attachedSides: ["bsc", "sportlots"] });
    });
    // The fetch is done, but a Confirm pressed now would hand on cards whose
    // teams the dialog has not absorbed.
    expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
      "Loading…",
    );

    await streamCandidates(rerender, rowsWithTeams);
    await waitFor(() =>
      expect(screen.getByLabelText("Confirm card matches").textContent).toBe(
        "Confirm",
      ),
    );
    expect(screen.getByText("0 matched, 2 BSC-only, 0 SL-only")).toBeTruthy();
  });
});

/**
 * NEO-330 × NEO-333 — the two halves of "has the stream caught up". Rows
 * decide whether anything may be saved; teams decide whether the wait ended
 * on time (`teamsLate`). The fence, when sent, is the team signal; without one
 * the per-row `ready === total` gate stands in.
 */
describe("CardChecklist — stream readiness helpers", () => {
  const live = (over: Partial<{ batchId: string; total: number; ready: number }> = {}) => ({
    batchId: "b-new",
    total: 3,
    ready: 2,
    cards: [{}, {}, {}],
    ...over,
  });

  it("rows: the fence's batch must be the one on screen", () => {
    expect(streamRowsArrived(live(), { count: 3, batchId: "b-new" }, "b-old")).toBe(true);
    expect(streamRowsArrived(live(), { count: 3, batchId: "b-other" }, "b-old")).toBe(false);
  });

  it("rows: with no fence batch, the batch must have moved", () => {
    expect(streamRowsArrived(live({ batchId: "b-old" }), { count: 3 }, "b-old")).toBe(false);
    expect(streamRowsArrived(live(), { count: 3 }, "b-old")).toBe(true);
  });

  it("rows: a short count is never final", () => {
    expect(streamRowsArrived(live({ total: 2 }), { count: 3, batchId: "b-new" }, undefined)).toBe(false);
  });

  it("teams: a fence is met at the server's own count, never total", () => {
    expect(streamTeamsLanded(live({ ready: 2 }), { count: 3, readyAfterTeams: 2 })).toBe(true);
    expect(streamTeamsLanded(live({ ready: 1 }), { count: 3, readyAfterTeams: 2 })).toBe(false);
  });

  it("teams: with no fence, every row must be ready", () => {
    expect(streamTeamsLanded(live({ ready: 2 }), { count: 3 })).toBe(false);
    expect(streamTeamsLanded(live({ ready: 3 }), { count: 3 })).toBe(true);
  });
});
