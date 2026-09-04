import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { normalizeEntityName } from "../../convex/lib/entityNearMatch";
// NEO-212 security review: an enrichment `wikidataId` arrives from
// query.wikidata.org, so it is external input on its way into an `href`.
// `wikidataUrl` returns null unless it is really a `Q<digits>` id — see
// lib/players/wikidata-id.ts.
import { wikidataUrl, wikipediaUrl } from "../../lib/players/wikidata-id";
import { isEditableTarget } from "../../lib/dom/is-editable-target";
import NeonButton from "../modules/NeonButton";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { CopyButton } from "../primitives/CopyButton";
import {
  NearMatchPanel,
  hasExact,
  type NearMatch,
} from "../entities/NearMatchPanel";
import EntityLinkSearch from "./EntityLinkSearch";
import CareerTeamEntry, { type CareerTeamDraft } from "./CareerTeamEntry";
import { deriveStagedTeamNames } from "./entity-review-staging";
import {
  countPendingUndecided,
  describeDecision,
  resolveNav,
  summarizeDecisions,
  type NavState,
} from "./entity-review-nav";

/**
 * NEO-92: step-through review wizard, replaces the old single-screen
 * UnknownEntitiesDialog (a flat checkbox list of every unknown name at
 * once, no per-name info). Presents ONE player/team at a time, showing
 * whatever the background Wikidata lookup (entityReviewQueue.ts +
 * adapters/wikidata.ts's runEntityReviewLookup, drained by the NEO-99
 * Wikidata pool) has already found — fully reactive via `getBatch`, so a
 * row's status flips live as the pool drains without polling.
 *
 * Every name resolves to exactly one of THREE decisions:
 *   - "Add as New" — recordDecision({action:"create"}); commitCardChecklist
 *     seeds the new row directly from this row's cached enrichment, minus any
 *     Wikidata career team the operator unchecked (excludedCareerTeamNames).
 *   - "Link to Existing…" — EntityLinkSearch picks a real existing row;
 *     recordDecision({action:"link", linked*Id}); no new row is created.
 *   - NEO-212 "Skip — not a person/team" — recordDecision({action:"skip"}).
 *     The checklist string is not a person or a franchise at all ("Checklist",
 *     "Team Card", a subset header that landed in the player column). Nothing
 *     is created and nothing is linked; the card keeps the raw name as free
 *     text and commit records it in `entityReviewSkips` so the same string
 *     does not come back on the next fetch of this set.
 * All three are patched immediately (recordDecision), not just kept in local
 * React state — wizard progress survives a page refresh.
 *
 * "Add All Remaining as New" (recordAllRemainingAsCreate) is the bulk
 * fast path for the common case — a first-time real-set sync can surface
 * hundreds of genuinely-new names (every rookie in a brand-new set), where
 * one-at-a-time review only has value for the names that look wrong. Its
 * NEO-212 twin, "Skip Remaining" (recordAllRemainingAsSkip), is the same fast
 * path for the opposite batch: a column that turned out to be headers rather
 * than people. Nothing is written to players/teams/cardChecklist until the
 * final Confirm & Save either way — these only mark decisions early.
 *
 * NEO-212 also puts a `NearMatchPanel` in front of the create action. The
 * wizard used to ask "does this exact normalized key already exist?" and,
 * getting no, offered a green "Add as New" with nothing else on screen — so
 * "NY Yankees" became a second Yankees row next to "New York Yankees". The
 * panel shows the soft matches, and the PRIMARY action changes shape with
 * them: an exact match demotes create to a text link and promotes "Link to
 * {name}" to the green button; close matches leave create as the primary but
 * strip its green. "Add as New {Player|Team}" is an E2E contract and is the
 * accessible name of the primary in both no-match and close-only states.
 *
 * ## NEO-220 / NEO-221 — you cannot lose a review session by accident
 *
 * Four defects, one promise. Each is implemented at a named seam rather than
 * spread through the JSX, so the next change has one place to look:
 *
 * 1. **The presented row is pinned state, not a derivation** (`nav`, and the
 *    pure rule in `entity-review-nav.ts`). A reactive `rows` meant a sibling
 *    lookup landing could swap the row out mid-review, taking staged career
 *    teams with it, and a decide issued during that swap recorded against a
 *    row nobody was looking at.
 * 2. **One decision at a time, keyed to the row** (`decide`). The guard is a
 *    REF, not the `decidingRowId` state: two clicks in one frame both read the
 *    same stale render closure, so a state flag never sees the first one. A
 *    rejected decide now surfaces inline instead of becoming an unhandled
 *    rejection, and `recordDecision` throws before patching, so the row is
 *    still undecided by construction.
 * 3. **Back-navigation** (`history`, `clearDecision`). A misclick used to be
 *    permanent for the life of the batch — a derived "first undecided" cannot
 *    present a row that already has a decision.
 * 4. **Escape and Cancel ask first** (`requestClose` + `ConfirmDialog`), and
 *    Escape inside a field never reaches the dialog at all
 *    (`isEditableTarget`). The dialog-level Enter shortcut is GONE: it fired
 *    from any non-input target, so Enter on the focused Cancel button both
 *    committed the batch and cancelled it.
 *
 * Cancel only ever deletes this batch's entityReviewQueue rows
 * (cancelBatch) — players/teams/cardChecklist are never touched during
 * review. It now calls `onCancel` only after that succeeded: telling the
 * parent "cancelled" while the batch is still on the server is a lie the
 * operator pays for on the next sync.
 */

/**
 * Mirrors RESOLVE_NAMES_MAX in convex/teams.ts.
 *
 * `teams.resolveNames` REFUSES an over-length list rather than truncating it,
 * because a truncated answer is a wrong count and the whole point of the
 * summary line is that the count is right. A thrown Convex error inside
 * `useQuery` unmounts the wizard mid-review, so the over-length case skips the
 * query and shows no summary — no line at all is honest; a wrong one is not.
 */
const MAX_RESOLVE_NAMES = 64;

/** Past this many decided rows the history list collapses behind a disclosure. */
const DECIDED_LIST_INLINE_MAX = 5;

/**
 * Bounds on the armed "keep adding as lookups finish" loop (NEO-221 security
 * review). See the effect for why each exists.
 *
 * The debounce is long on purpose. This is not a typeahead — nobody is watching
 * for the result of a keystroke — and every 500ms shaved off it is one more
 * mutation per drained row.
 */
const AUTO_ADD_DEBOUNCE_MS = 1500;
/** Settled-undecided rows that fire immediately instead of waiting out the debounce. */
const AUTO_ADD_BATCH_THRESHOLD = 5;
/** Hard cap on automatic re-calls per arming. */
const AUTO_ADD_MAX_CALLS = 50;

/** A Convex rejection's message, or a written-for-the-operator fallback. */
const errorMessage = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

/** What the final step is about to write, as counted by the PARENT. */
export type EntityReviewSummary = {
  /** Cards this fetch will save once committed. */
  cardCount: number;
  /** Cards the operator marked for deletion in the checklist diff. */
  deleteCount: number;
  /** Sync-review rows with at least one field accepted (NEO-203). */
  reviewDecisionCount: number;
};

export default function EntityReviewWizard({
  isOpen,
  selectorOptionId,
  batchId,
  summary,
  onConfirm,
  onCancel,
  onBack,
  saving,
  commitError,
  onDismissCommitError,
}: {
  isOpen: boolean;
  selectorOptionId: Id<"selectorOptions">;
  batchId: string;
  /** What Confirm & Save is about to do, counted by the parent. */
  summary: EntityReviewSummary;
  /** All rows decided, user clicked "Confirm & Save". Parent calls commitCardChecklist. */
  onConfirm: () => void;
  /**
   * ABORT. Called only after `cancelBatch` actually succeeded — the parent may
   * treat it as "this batch is gone". A failed cancel keeps the dialog open and
   * says so rather than pretending.
   */
  onCancel: () => void;
  /**
   * NEO-220 — step BACK to card matching without discarding anything. Present
   * only when there is a parked pairing session to return to; when it is
   * absent the footer shows only "Cancel (Esc)".
   */
  onBack?: () => void;
  /** True while commitCardChecklist is in flight. Disables the final Save button. */
  saving?: boolean;
  /**
   * A commit that failed. The batch is untouched, so the operator can retry or
   * go back and change a decision — rendered on the final step instead of the
   * confirm button, so there is exactly one thing to press.
   */
  commitError?: string | null;
  /** Dismiss `commitError` and return to reviewing. */
  onDismissCommitError?: () => void;
}) {
  const rows = useQuery(
    api.entityReviewQueue.getBatch,
    isOpen ? { selectorOptionId, batchId } : "skip",
  );
  const recordDecision = useMutation(api.entityReviewQueue.recordDecision);
  const clearDecision = useMutation(api.entityReviewQueue.clearDecision);
  const cancelBatch = useMutation(api.entityReviewQueue.cancelBatch);
  const recordAllRemainingAsCreate = useMutation(
    api.entityReviewQueue.recordAllRemainingAsCreate,
  );
  const recordAllRemainingAsSkip = useMutation(
    api.entityReviewQueue.recordAllRemainingAsSkip,
  );

  const [linkingOpen, setLinkingOpen] = useState(false);
  // Manual career-team entries the admin has staged for the CURRENT player
  // row (only ever populated for a player). Held here (not in CareerTeamEntry)
  // so it resets per-row alongside linkingOpen and is passed through to
  // recordDecision on "Add as New Player".
  const [stagedCareerTeams, setStagedCareerTeams] = useState<CareerTeamDraft[]>([]);
  /**
   * NEO-212 — Wikidata career-team proposals the operator has UNCHECKED, keyed
   * by review-row id.
   *
   * Keyed rather than reset per row on purpose: a decision the operator has
   * already expressed ("this player never played for that team") survives them
   * stepping back to the row to change something else, which NEO-221's
   * back-navigation now actually lets them do.
   */
  const [excludedCareerTeamsByRow, setExcludedCareerTeamsByRow] = useState<
    Record<string, string[]>
  >({});

  /**
   * NEO-221 — WHICH ROW IS ON SCREEN. See `entity-review-nav.ts` for the rule
   * and for why this is state rather than `rows.find(...)`.
   *
   * `navRef` mirrors it so `decide` can compare against the CURRENT value
   * rather than the one captured by the render that drew the button. That
   * comparison is the whole "a decision cannot land on a row you are no longer
   * looking at" guarantee, and a render-closure read would defeat it exactly
   * when it matters — during the swap.
   */
  const [nav, setNav] = useState<NavState>({ rowId: null, explicit: false });
  const navRef = useRef<NavState>(nav);

  /**
   * Rows this session decided one at a time, oldest first. Drives "Back" and
   * the decided list. State rather than a ref because the Back control's
   * visibility depends on it.
   *
   * Bulk decisions are deliberately NOT recorded here: "Back" means "the row I
   * just judged", and after "Add All Remaining as New" that is not any single
   * row. The decided list still shows every decided row, bulk or not.
   */
  const [history, setHistory] = useState<Id<"entityReviewQueue">[]>([]);

  /**
   * The row whose decision is in flight, for rendering. The GUARD is
   * `decidingRef` — see the header note on why a state flag cannot stop a
   * double click.
   */
  const [decidingRowId, setDecidingRowId] = useState<Id<"entityReviewQueue"> | null>(
    null,
  );
  const decidingRef = useRef<Id<"entityReviewQueue"> | null>(null);
  /** A rejected per-row decide, shown inline under the row it belongs to. */
  const [rowError, setRowError] = useState<{
    rowId: Id<"entityReviewQueue">;
    message: string;
  } | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  /**
   * Which bulk action is in flight, if any. One piece of state rather than two
   * booleans so "Add All Remaining" and "Skip Remaining" cannot both be running
   * — they decide the same rows, and racing them would make the outcome depend
   * on which mutation landed second. `bulkRef` is its synchronous twin, for the
   * same reason `decidingRef` exists.
   */
  const [bulkPending, setBulkPending] = useState<null | "create" | "skip">(null);
  const bulkRef = useRef(false);
  // NEO-110: a rejected bulk decide used to be swallowed entirely, so a failed
  // bulk looked identical to a partial one — the button simply re-enabled and
  // the counter didn't move. Surface it instead.
  const [bulkError, setBulkError] = useState<string | null>(null);
  /**
   * NEO-221 — "keep adding as their lookups finish".
   *
   * The bulk create no longer decides rows that are still being looked up (a
   * name the operator has never seen is not a name they approved), which would
   * otherwise turn one click into a wait-and-click-again loop. Arming this
   * makes the wizard re-issue the bulk create as rows settle, and the footer
   * says so and offers a Stop.
   */
  const [autoAddPending, setAutoAddPending] = useState(false);
  /** Synchronous mirror of `autoAddPending`, read inside the debounce timer. */
  const autoAddRef = useRef(false);
  /** Automatic re-calls issued since the last arming, against AUTO_ADD_MAX_CALLS. */
  const autoAddCallsRef = useRef(0);
  const autoAddTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Overrides the >5 collapse of the decided list once the operator toggles it. */
  const [decidedListOpen, setDecidedListOpen] = useState<boolean | null>(null);

  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  /**
   * True once this batch has ever had rows, and true once the operator's own
   * cancel emptied it. Both feed the expired-session tell (D13) and both are
   * READ DURING RENDER, so they are state rather than refs.
   */
  const [hadRows, setHadRows] = useState(false);
  const [closing, setClosing] = useState(false);
  /**
   * NEO-212 (a11y): the id the career-team checkbox group points at. A bare
   * <ul> of checkboxes has no name, so a screen reader entering it announces
   * "Include career team X" with no clue what the list as a whole is for.
   */
  const careerTeamsLabelId = useId();

  const total = rows?.length ?? 0;
  const decided = useMemo(() => rows?.filter((r) => r.decision).length ?? 0, [rows]);
  const stillLookingUp = useMemo(
    () => rows?.filter((r) => r.status === "pending").length ?? 0,
    [rows],
  );
  const pendingUndecided = useMemo(
    () => countPendingUndecided(rows ?? []),
    [rows],
  );
  const outcome = useMemo(() => summarizeDecisions(rows ?? []), [rows]);
  const current = useMemo(
    () => (nav.rowId ? (rows?.find((r) => r._id === nav.rowId) ?? null) : null),
    [rows, nav.rowId],
  );
  /** The row is decided AND still on screen — the read-only review panel. */
  const reviewingDecided = current?.decision != null;
  const allDecided = total > 0 && decided === total;

  // ------------------------------------------------------------------------
  // Reads. All unconditional hooks, above the `isOpen` early return.
  // ------------------------------------------------------------------------

  /**
   * Soft "is this already one of these?" candidates for the current row.
   *
   * Two hooks with the inactive one "skip"ped rather than a ternary over the
   * two function references: `players.nearMatches` and `teams.nearMatches`
   * return differently-branded ids, so a union of the two references does not
   * survive `useQuery`'s argument inference. Skipped entirely while the row is
   * being reviewed read-only — there is no action to put them in front of.
   */
  const playerNearMatches = useQuery(
    api.players.nearMatches,
    current && !reviewingDecided && current.kind === "player"
      ? { name: current.name, sportId: current.sportId }
      : "skip",
  );
  const teamNearMatches = useQuery(
    api.teams.nearMatches,
    current && !reviewingDecided && current.kind === "team"
      ? { name: current.name, sportId: current.sportId }
      : "skip",
  );
  // Widened to a single array type on the way out. The two queries return
  // differently-branded ids, and a `Id<"players">[] | Id<"teams">[]`-shaped
  // union is not callable through `.find` — nor is it what NearMatchPanel
  // wants, which is deliberately structural.
  const nearMatches: NearMatch[] | undefined =
    current?.kind === "player" ? playerNearMatches : teamNearMatches;

  /** Rows already decided "link" — their TARGET's canonical name is what the
   *  batch will actually use, so both the staging list and the decided list
   *  need it, not the raw checklist string on the review row. */
  const linkedTeamIds = useMemo(() => {
    const ids: Id<"teams">[] = [];
    for (const row of rows ?? []) {
      if (row.decision?.action !== "link") continue;
      if (row.decision.linkedTeamId) ids.push(row.decision.linkedTeamId);
    }
    return ids;
  }, [rows]);
  const linkedPlayerIds = useMemo(() => {
    const ids: Id<"players">[] = [];
    for (const row of rows ?? []) {
      if (row.decision?.action !== "link") continue;
      if (row.decision.linkedPlayerId) ids.push(row.decision.linkedPlayerId);
    }
    return ids;
  }, [rows]);
  const linkedTeams = useQuery(
    api.teams.getManyByIds,
    linkedTeamIds.length > 0 ? { ids: linkedTeamIds } : "skip",
  );
  const linkedPlayers = useQuery(
    api.players.getManyByIds,
    linkedPlayerIds.length > 0 ? { ids: linkedPlayerIds } : "skip",
  );

  /** id → display name, for `describeDecision`'s "Linked to {name}". */
  const linkedNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of linkedTeams ?? []) map.set(t._id, t.name);
    for (const p of linkedPlayers ?? []) map.set(p._id, p.name);
    return map;
  }, [linkedTeams, linkedPlayers]);

  const excludedForCurrent = current
    ? (excludedCareerTeamsByRow[current._id] ?? [])
    : [];

  /** Every team name this batch already accounts for — fed to the career-team
   *  typeahead so it can suggest teams that exist only as pending decisions. */
  const stagedTeamNames = useMemo(
    () =>
      deriveStagedTeamNames({
        rows: rows ?? [],
        currentRowId: current?._id ?? null,
        localChips: stagedCareerTeams,
        linkedTeamNames: (linkedTeams ?? []).map((t) => t.name),
      }).map((s) => s.name),
    [rows, current?._id, stagedCareerTeams, linkedTeams],
  );

  /**
   * The team names an "Add as New Player" on THIS row would put through
   * commit's get-or-create: the Wikidata proposals still checked, plus the
   * hand-typed chips. Deduped by the same key the server writes, so the count
   * in the summary line is the count of rows commit will actually insert.
   */
  const proposedTeamNames = useMemo(() => {
    if (!current || current.decision || current.kind !== "player") return [];
    const excluded = new Set(
      (excludedCareerTeamsByRow[current._id] ?? []).map(normalizeEntityName),
    );
    const seen = new Set<string>();
    const names: string[] = [];
    const push = (raw: string) => {
      const key = normalizeEntityName(raw);
      if (!key || seen.has(key)) return;
      seen.add(key);
      names.push(raw);
    };
    for (const ct of current.enrichment?.careerTeams ?? []) {
      if (excluded.has(normalizeEntityName(ct.name))) continue;
      push(ct.name);
    }
    for (const chip of stagedCareerTeams) push(chip.name);
    return names;
  }, [current, excludedCareerTeamsByRow, stagedCareerTeams]);

  const resolvedTeamNames = useQuery(
    api.teams.resolveNames,
    current &&
      !reviewingDecided &&
      current.kind === "player" &&
      proposedTeamNames.length > 0 &&
      proposedTeamNames.length <= MAX_RESOLVE_NAMES
      ? { names: proposedTeamNames, sportId: current.sportId }
      : "skip",
  );

  /** "Will create 2 new teams: X, Y · 1 already exist" — either half is
   *  omitted when its count is zero, so the line never says "0 new teams". */
  const teamSummary = useMemo(() => {
    if (!resolvedTeamNames || resolvedTeamNames.length === 0) return null;
    const willCreate = resolvedTeamNames.filter((r) => !r.existingTeamId);
    const alreadyExist = resolvedTeamNames.length - willCreate.length;
    const parts: string[] = [];
    if (willCreate.length > 0) {
      parts.push(
        `Will create ${willCreate.length} new ${
          willCreate.length === 1 ? "team" : "teams"
        }: ${willCreate.map((r) => r.name).join(", ")}`,
      );
    }
    if (alreadyExist > 0) parts.push(`${alreadyExist} already exist`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [resolvedTeamNames]);

  // ------------------------------------------------------------------------
  // Effects
  // ------------------------------------------------------------------------

  useEffect(() => {
    navRef.current = nav;
  }, [nav]);

  /**
   * The ONLY thing that advances the presented row. `resolveNav` returns the
   * same object when nothing should move, so this cannot loop.
   */
  useEffect(() => {
    if (!rows) return;
    const next = resolveNav(rows, nav);
    if (next === nav) return;
    navRef.current = next;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the presented row follows the batch; the rule that decides when is pure and tested in entity-review-nav.test.tsx
    setNav(next);
  }, [rows, nav]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-way latch: a batch that has had rows can never un-have them
    if (rows && rows.length > 0 && !hadRows) setHadRows(true);
  }, [rows, hadRows]);

  // Closing the "Link to Existing" search whenever the presented row changes
  // so it doesn't stay open for the wrong row. Keyed on the row id, so it no
  // longer fires when a sibling row's lookup lands — staged career teams
  // survive everything except an actual row change (NEO-221).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closes the link-search when the wizard advances so it cannot stay open on the wrong row
    setLinkingOpen(false);
    setStagedCareerTeams([]);
  }, [current?._id]);

  // Focus the final Save button as soon as it appears so Enter immediately
  // works, mirroring the old dialog's keyboard contract. This is the ONLY
  // Enter-to-confirm path now — see the removed dialog-level handler.
  useEffect(() => {
    if (allDecided) confirmButtonRef.current?.focus();
  }, [allDecided]);

  /**
   * NEO-221 — keep issuing the bulk create as lookups settle, while armed.
   *
   * ## Why this is throttled rather than reactive
   *
   * The naive version — "a settled undecided row exists, so call the mutation"
   * — is a client-driven write loop keyed on a REACTIVE query. Every call
   * changes `rows`, which re-runs the effect, and a batch of 300 names draining
   * one at a time issues 300 mutations. The security review's objection is the
   * right one: an armed flag in a browser tab must not be able to hold a write
   * loop open against the backend. Four bounds, all of them cheap:
   *
   *  - **Debounce.** A settled row schedules a call `AUTO_ADD_DEBOUNCE_MS`
   *    later, and rows settling in that window join it. The pool drains five at
   *    a time, so this collapses a drain into a handful of calls.
   *  - **Threshold.** `AUTO_ADD_BATCH_THRESHOLD` settled rows fire immediately
   *    rather than waiting out the debounce, so a fast pool does not feel
   *    stalled.
   *  - **Cap.** `AUTO_ADD_MAX_CALLS` auto re-calls, then it disarms and says
   *    so. A bug that made the mutation a no-op would otherwise spin forever.
   *  - **Disarm on rejection.** One refusal (not an admin, batch gone) means
   *    every retry refuses too.
   *
   * Re-entrancy is held off by `bulkRef` (synchronous) rather than
   * `bulkPending` (a render value), so a burst of row updates cannot fire two
   * overlapping mutations. `autoAddRef` is the same trick for the armed flag,
   * read inside the timer callback where the render closure is already stale.
   */
  useEffect(() => {
    if (!autoAddPending || !rows) return;
    const undecided = rows.filter((r) => !r.decision);
    if (undecided.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the arming is over because there is nothing left to add
      setAutoAddPending(false);
      return;
    }
    const settled = undecided.filter((r) => r.status !== "pending").length;
    // Everything left is still being looked up. Wait for the pool, do not poll
    // it: the next `rows` update re-enters this effect on its own.
    if (settled === 0) return;
    if (bulkRef.current || saving) return;
    if (autoAddCallsRef.current >= AUTO_ADD_MAX_CALLS) {
      autoAddRef.current = false;
      setAutoAddPending(false);
      setBulkError(
        `Stopped adding automatically after ${AUTO_ADD_MAX_CALLS} rounds. ${undecided.length} names are still waiting — use "Add All Remaining as New" again.`,
      );
      return;
    }

    const fire = () => {
      if (!autoAddRef.current || bulkRef.current) return;
      autoAddCallsRef.current += 1;
      bulkRef.current = true;
      setBulkPending("create");
      void (async () => {
        try {
          await recordAllRemainingAsCreate({ selectorOptionId, batchId });
        } catch (e) {
          // One refusal means every retry refuses too.
          autoAddRef.current = false;
          setAutoAddPending(false);
          setBulkError(
            `${errorMessage(e, "Couldn't add the remaining names.")} Stopped adding automatically.`,
          );
        } finally {
          bulkRef.current = false;
          setBulkPending(null);
        }
      })();
    };

    if (settled >= AUTO_ADD_BATCH_THRESHOLD) {
      if (autoAddTimerRef.current !== null) {
        clearTimeout(autoAddTimerRef.current);
        autoAddTimerRef.current = null;
      }
      fire();
      return;
    }
    // A call is already scheduled — the rows that settled since will be swept
    // up by it. This is the "two rows 100ms apart make one call" case.
    if (autoAddTimerRef.current !== null) return;
    autoAddTimerRef.current = setTimeout(() => {
      autoAddTimerRef.current = null;
      fire();
    }, AUTO_ADD_DEBOUNCE_MS);
    // The mutation reference, `selectorOptionId` and `batchId` are deliberately
    // NOT deps. They are constant for the life of the dialog, and including a
    // `useMutation` result — whose identity stability is the hook's business,
    // not ours — would re-run this effect on every render, turning "issue one
    // more bulk create" into a loop the `bulkRef` guard only partly damps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAddPending, rows, saving]);

  useEffect(() => {
    autoAddRef.current = autoAddPending;
    if (autoAddPending) return;
    // Disarming (Stop, a rejection, the cap, or unmount) must also cancel a
    // scheduled call — otherwise "Stop" leaves one more write in flight.
    if (autoAddTimerRef.current !== null) {
      clearTimeout(autoAddTimerRef.current);
      autoAddTimerRef.current = null;
    }
  }, [autoAddPending]);

  useEffect(
    () => () => {
      if (autoAddTimerRef.current !== null) clearTimeout(autoAddTimerRef.current);
    },
    [],
  );

  // ------------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------------

  /**
   * The single seam every per-row write passes through — create, link, skip
   * and "change decision" alike.
   *
   * Two guards, both necessary and both about a click that arrives at the
   * wrong moment:
   *  - `decidingRef` is a REF. Two clicks inside one frame share a render
   *    closure, so a `decidingRowId !== null` state read would be null for
   *    both and issue two mutations. This is the double-click case.
   *  - `navRef` is the live presented row. A click handler closes over the row
   *    id from the render that drew it, so without this a decide issued as the
   *    presentation moves would record against a row nobody is looking at.
   *
   * A rejection lands in `rowError`, keyed to the row, and NOT in an unhandled
   * rejection: every call site is `void decide(...)`, and swallowing the error
   * there is how a failed link used to look exactly like a successful one.
   */
  const decide = async (
    rowId: Id<"entityReviewQueue">,
    fn: () => Promise<unknown>,
    historyMode: "push" | "drop" = "push",
  ) => {
    if (decidingRef.current !== null) return;
    if (rowId !== navRef.current.rowId) return;
    decidingRef.current = rowId;
    setDecidingRowId(rowId);
    setRowError(null);
    try {
      await fn();
      setHistory((prev) => {
        const without = prev.filter((id) => id !== rowId);
        return historyMode === "push" ? [...without, rowId] : without;
      });
    } catch (e) {
      setRowError({
        rowId,
        message: errorMessage(e, "That didn't save. Try again."),
      });
    } finally {
      decidingRef.current = null;
      setDecidingRowId(null);
    }
  };

  const handleCreate = async (
    reviewRowId: Id<"entityReviewQueue">,
    manualCareerTeams?: CareerTeamDraft[],
    excludedCareerTeamNames?: string[],
  ) =>
    decide(reviewRowId, () =>
      recordDecision({
        reviewRowId,
        action: "create",
        manualCareerTeams:
          manualCareerTeams && manualCareerTeams.length ? manualCareerTeams : undefined,
        excludedCareerTeamNames:
          excludedCareerTeamNames && excludedCareerTeamNames.length
            ? excludedCareerTeamNames
            : undefined,
      }),
    );
  const handleLink = async (
    reviewRowId: Id<"entityReviewQueue">,
    kind: "player" | "team",
    linkedId: Id<"players"> | Id<"teams">,
  ) =>
    decide(reviewRowId, () =>
      recordDecision({
        reviewRowId,
        action: "link",
        linkedPlayerId: kind === "player" ? (linkedId as Id<"players">) : undefined,
        linkedTeamId: kind === "team" ? (linkedId as Id<"teams">) : undefined,
      }),
    );
  const handleSkip = async (reviewRowId: Id<"entityReviewQueue">) =>
    decide(reviewRowId, () => recordDecision({ reviewRowId, action: "skip" }));

  /**
   * Present a row on purpose and clear whatever it was decided as.
   *
   * `navRef` is written synchronously alongside `setNav` because `decide`'s
   * "is this still the presented row?" guard reads the ref, and the state
   * update has not landed yet. This is the mirror doing its job, not a
   * workaround.
   */
  const handleChangeDecision = (rowId: Id<"entityReviewQueue">) => {
    const next: NavState = { rowId, explicit: true };
    navRef.current = next;
    setNav(next);
    void decide(rowId, () => clearDecision({ reviewRowId: rowId }), "drop");
  };

  /** Present a decided row read-only, without touching it. */
  const presentDecided = (rowId: Id<"entityReviewQueue">) => {
    const next: NavState = { rowId, explicit: true };
    navRef.current = next;
    setNav(next);
  };

  /** Hand the wizard back its own rule: walk to the next undecided row. */
  const resumeWalking = () => {
    const next: NavState = { rowId: null, explicit: false };
    navRef.current = next;
    setNav(next);
  };

  /**
   * Discard the review session. `onCancel` is called ONLY after `cancelBatch`
   * resolved: the parent treats it as "this batch is gone", and saying so while
   * the rows are still on the server strands them until the sweep.
   */
  const runCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelBatch({ selectorOptionId, batchId });
      // Set before `onCancel` so the now-empty batch does not flash "expired"
      // in the frame between the rows going and the parent closing the dialog.
      setClosing(true);
      setConfirming(false);
      onCancel();
    } catch (e) {
      setCancelError(
        `Couldn't discard this review: ${errorMessage(e, "the server refused")}. The batch is still here.`,
      );
    } finally {
      setCancelling(false);
    }
  };

  /**
   * Every dismissal route — Escape, the footer Cancel — comes through here.
   * Nothing decided yet means nothing to lose, so it closes straight away and
   * `checklist-fetch-cancel-dialog` is unchanged.
   */
  const requestClose = () => {
    if (cancelling || saving) return;
    setCancelError(null);
    if (decided === 0) {
      void runCancel();
      return;
    }
    setConfirming(true);
  };

  /**
   * The bulk fast paths. Both decide the same set of rows, so they share one
   * in-flight flag and one error slot — a failure in either has to be visible
   * for the same NEO-110 reason.
   */
  const runBulk = async (kind: "create" | "skip") => {
    if (bulkRef.current || saving) return;
    bulkRef.current = true;
    setBulkPending(kind);
    setBulkError(null);
    try {
      if (kind === "create") {
        await recordAllRemainingAsCreate({ selectorOptionId, batchId });
      } else {
        await recordAllRemainingAsSkip({ selectorOptionId, batchId });
      }
    } catch (e) {
      autoAddRef.current = false;
      setAutoAddPending(false);
      setBulkError(
        errorMessage(
          e,
          kind === "create"
            ? "Couldn't add the remaining names. Try again."
            : "Couldn't skip the remaining names. Try again.",
        ),
      );
    } finally {
      bulkRef.current = false;
      setBulkPending(null);
    }
  };

  const handleBulkCreate = () => {
    // Rows still being looked up are excluded server-side, so arm the follow-up
    // rather than leaving the operator to click again for each straggler. The
    // cap counts per arming, so re-clicking after it trips is a fresh budget —
    // which is the point: a deliberate click is not a runaway loop.
    if (pendingUndecided > 0) {
      autoAddCallsRef.current = 0;
      autoAddRef.current = true;
      setAutoAddPending(true);
    }
    void runBulk("create");
  };

  const handleBulkSkip = () => {
    // "Skip Remaining" is the explicit-exclusion branch: it means every name
    // left, lookups included, so it also cancels any armed auto-add.
    autoAddRef.current = false;
    setAutoAddPending(false);
    void runBulk("skip");
  };

  if (!isOpen || rows === undefined) return null;

  const kindLabel = (kind: "player" | "team") => (kind === "player" ? "Player" : "Team");
  /** "not a person" / "not a team" — the skip control says what it is denying. */
  const notAWhat = (kind: "player" | "team") => (kind === "player" ? "person" : "team");

  const toggleCareerTeam = (rowId: string, teamName: string) => {
    setExcludedCareerTeamsByRow((prev) => {
      const currentExclusions = prev[rowId] ?? [];
      const isExcluded = currentExclusions.includes(teamName);
      return {
        ...prev,
        [rowId]: isExcluded
          ? currentExclusions.filter((n) => n !== teamName)
          : [...currentExclusions, teamName],
      };
    });
  };

  // Chronological, with an open-ended tenure last within a shared start year —
  // "2011–present" is the one that is still running, so it reads as the end of
  // the list rather than something buried in the middle of it.
  const sortedCareerTeams = current?.enrichment?.careerTeams
    ? [...current.enrichment.careerTeams].sort((a, b) => {
        if (a.fromYear !== b.fromYear) return a.fromYear - b.fromYear;
        const aOpen = a.toYear === undefined ? 1 : 0;
        const bOpen = b.toYear === undefined ? 1 : 0;
        if (aOpen !== bOpen) return aOpen - bOpen;
        return (a.toYear ?? 0) - (b.toYear ?? 0);
      })
    : [];

  const exactMatch = (nearMatches ?? []).find((m) => m.confidence === "exact") ?? null;
  const showExactHierarchy = hasExact(nearMatches) && exactMatch !== null;
  const hasCloseOnly = !showExactHierarchy && (nearMatches?.length ?? 0) > 0;
  /**
   * What the panel is left to show once the primary action has been promoted.
   * The promoted row is filtered out by `_id`, so no two controls ever share
   * the accessible name `Link to {name}` — ambiguous to a screen reader and to
   * a Maestro `tapOn` alike. Any OTHER row is a genuinely different entity and
   * still belongs in the list, whatever its confidence.
   */
  const panelMatches =
    showExactHierarchy && nearMatches
      ? nearMatches.filter((m) => m._id !== exactMatch._id)
      : nearMatches;
  const remaining = total - decided;
  const busy = decidingRowId !== null;

  /** Decided rows, in batch order, for the history list. */
  const decidedRows = rows.filter((r) => r.decision);
  const decidedListExpanded =
    decidedListOpen ?? decidedRows.length <= DECIDED_LIST_INLINE_MAX;

  /** The most recent single-row decision still standing. */
  const backTargetId = (() => {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const id = history[i];
      if (id === nav.rowId) continue;
      const row = rows.find((r) => r._id === id);
      if (row?.decision) return id;
    }
    return null;
  })();

  const linkedNameFor = (decision: (typeof rows)[number]["decision"]) => {
    if (decision?.action !== "link") return null;
    const id = decision.linkedPlayerId ?? decision.linkedTeamId;
    return id ? (linkedNameById.get(id) ?? null) : null;
  };

  /**
   * NEO-221 (D13) — the batch is gone.
   *
   * `sweepAbandonedBatches` deletes a batch nobody has touched for a day, and a
   * wizard left open on it would otherwise sit on an empty list forever, its
   * Confirm & Save committing nothing. Guarded on `closingRef` and `saving` so
   * the deliberate emptyings — cancel, and the commit that consumes the rows —
   * do not flash this on the way out.
   */
  const expired = hadRows && total === 0 && !closing && !saving;

  const summaryRows: Array<[string, number]> = [
    ["Cards to save", summary.cardCount],
    ["Cards to delete", summary.deleteCount],
    ["Cards with field updates", summary.reviewDecisionCount],
    ["New players and teams", outcome.created],
    ["Linked to existing", outcome.linked],
    ["Skipped as not a name", outcome.skipped],
  ];

  return createPortal(
    // See BaseSetPicker.tsx / SetAttributesPanel.tsx for why createPortal
    // needs a nested <Theme> — it escapes the root Theme's CSS scope.
    <Theme>
      <div
        className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="entity-review-wizard-title"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // The discard confirm owns Escape while it is up (it cancels itself).
          if (confirming) return;
          // NEO-220: a keystroke aimed at a field is the field's to interpret.
          // Escape in the career-team combobox used to discard the whole review.
          if (isEditableTarget(e.target)) return;
          e.preventDefault();
          // Escape from anywhere in the link sub-panel closes the sub-panel
          // first — one level at a time, so it can never skip a level and
          // destroy the session behind it.
          if (linkingOpen) {
            setLinkingOpen(false);
            return;
          }
          requestClose();
        }}
      >
        {/*
          NEO-110 — THE FOOTER MUST NOT MOVE WHEN A LOOKUP LANDS.
          The dialog's height is FIXED. That, not the body's content, is what
          pins the footer: with a definite height on this box and `flex-1
          min-h-0` on the body, the footer's viewport y is invariant for the
          life of the dialog.

          `min(40rem, 100%)` — 100% resolves against the overlay's CONTENT box,
          which is `inset-0` minus its `p-4`, so on the 1024×629 CI viewport this
          is 629-32 = 597px and the dialog can never be clipped by the padding.
          40rem (640px) caps it on a tall desktop.
        */}
        <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl w-full max-w-2xl h-[min(40rem,100%)] flex flex-col">
          {/* Header: progress counter (satisfies "show N remaining"). */}
          <div className="px-6 py-4 border-b border-gray-700 shrink-0">
            <h2
              id="entity-review-wizard-title"
              className="text-lg font-semibold text-gray-100"
            >
              Confirm New Players &amp; Teams
            </h2>
            <p className="text-xs text-gray-400 mt-0.5" role="status" aria-live="polite">
              {decided} of {total} reviewed
              {stillLookingUp > 0 ? ` · ${stillLookingUp} still being looked up` : ""}
            </p>
          </div>

          {/*
            NEO-110 — THE BODY ABSORBS EVERY HEIGHT CHANGE. It is `flex-1
            min-h-0 overflow-y-auto` inside a FIXED-HEIGHT dialog, so it grows
            and shrinks entirely within its own box and the footer below it
            never moves. Do NOT put `min-h-*` / `max-h-*` back on this div: an
            elastic body is precisely the defect, twice over.

            WHY THIS MATTERS. This body swaps between wildly different heights:
            the "Looking up N more names…" line (~20px) while every row is still
            `pending`, the full item block once one resolves, and the "All
            reviewed" line. And within the item block the height keeps moving
            for SECONDS after the dialog opens, as the Wikidata description, the
            career-team checkboxes, the near-match panel and the "Will create N
            new teams…" line each arrive on their own query. Because the overlay
            centres the dialog (`flex items-center`), any content-height jump
            used to move the footer by HALF the delta.

            INCIDENT 1 (CI run 30505189226, ~108px). The bulk "Add All Remaining
            as New (N)" link sat at y=380-396; 333ms later the item block had
            rendered and the green "Add as New {kind}" button occupied y=383-414.
            A click aimed at the bulk link landed on "Add as New Player" instead
            — deciding ONE row rather than all of them, silently, for an entity
            the user never reviewed.

            INCIDENT 2 (CI run 33817648830, the seed job, 11px) collected that
            debt on a real 2024 Topps Chrome fetch: the row's async content
            pushed the body from its `min-h` floor to its `max-h` ceiling in the
            332ms between Maestro reading the link and clicking its centre, and
            the click hit footer padding. The link is `text-xs` — only 16px tall
            — so the "bounded" 13px was never a safe margin.

            The fix is structural: a dialog with a definite height. There is no
            longer a residual shift to bound, so there is no longer a number
            here to get wrong. Anything added to the FOOTER has the same
            obligation — see the auto-add status line, which replaces the bulk
            buttons in place rather than stacking above them.
          */}
          <div className="p-6 space-y-4 flex-1 min-h-0 overflow-y-auto">
            {bulkError && (
              <p role="alert" className="text-xs text-[#FF2EB3]">
                {bulkError}
              </p>
            )}
            {cancelError && !confirming && (
              <p role="alert" className="text-xs text-[#FF2EB3]">
                {cancelError}
              </p>
            )}
            {expired ? (
              /*
                The one state with nothing to decide and nothing to save. Says
                what happened and what to do next, in that order — an expiry the
                operator cannot act on is just a dead end.
              */
              <div className="space-y-2">
                <p className="text-sm text-gray-200">
                  This review session has expired — re-sync to start again.
                </p>
                <p className="text-sm text-gray-400">
                  Its names were cleared after a day with no activity. Nothing was
                  saved and nothing was lost: sync the set again and the same names
                  come back for review.
                </p>
              </div>
            ) : current ? (
              <>
                <div>
                  {/* NEO-212 (a11y): the CopyButton and the kind/sport tag sit
                      BESIDE the heading, not inside it. Inside, they became
                      part of the heading's accessible name — "Mike Trout Copy
                      name (Player · Baseball)" — which is what a screen
                      reader reads out when navigating by heading. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-200">
                      {current.name}
                    </h3>
                    {/* NEO-212 (audit G10): these names are copied out into
                        Wikidata, Google and the marketplaces constantly during
                        review, and a name inside a modal is fiddly to select by
                        hand without dismissing it. */}
                    <CopyButton
                      value={current.name}
                      label="name"
                      className="align-middle"
                    />
                    <span className="text-xs font-normal text-gray-400">
                      ({kindLabel(current.kind)} · {current.sportValue})
                    </span>
                  </div>

                  {/*
                    NEO-221 — a rejected decide, under the row it belongs to.
                    The mutation throws BEFORE it patches, so the row is still
                    undecided and the same buttons are still the way forward.
                  */}
                  {rowError && rowError.rowId === current._id && (
                    <p role="alert" className="mt-1 text-xs text-[#FF2EB3]">
                      {rowError.message} This name is still waiting on a decision.
                    </p>
                  )}

                  {/* NEO-212: the operator's escape hatch when the enrichment
                      below is not enough to tell two people apart — the source
                      record itself, one click away. */}
                  {current.enrichment &&
                    (current.enrichment.wikidataId || current.enrichment.enwikiTitle) && (
                      <p className="mt-1 flex flex-wrap items-center gap-3 text-xs">
                        {current.enrichment.wikidataId &&
                          (wikidataUrl(current.enrichment.wikidataId) ? (
                            <a
                              href={wikidataUrl(current.enrichment.wikidataId)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#00B7FF] underline decoration-dotted hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
                            >
                              Wikidata {current.enrichment.wikidataId}
                              <span className="sr-only"> (opens in new tab)</span>
                            </a>
                          ) : (
                            // Not a `Q<digits>` id, so there is no record to
                            // link to. The value is still SHOWN — the operator
                            // needs to see what the lookup stored in order to
                            // judge it — just not as a clickable destination.
                            <span className="text-gray-400">
                              Wikidata {current.enrichment.wikidataId}
                            </span>
                          ))}
                        {current.enrichment.enwikiTitle && (
                          <a
                            href={wikipediaUrl(current.enrichment.enwikiTitle)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#00B7FF] underline decoration-dotted hover:text-[#00D558] focus:text-[#00D558] focus:outline-none"
                          >
                            Wikipedia
                            <span className="sr-only"> (opens in new tab)</span>
                          </a>
                        )}
                      </p>
                    )}

                  {/* The one line that most often settles "is this the same
                      Mike Smith?": Wikidata's own short description and a birth
                      year. */}
                  {current.enrichment &&
                    (current.enrichment.description || current.enrichment.birthYear) && (
                      <p className="mt-1 text-sm text-gray-300">
                        {[
                          current.enrichment.description,
                          current.enrichment.birthYear
                            ? `b. ${current.enrichment.birthYear}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}

                  <div className="mt-2 text-sm text-gray-400 space-y-1">
                    {current.status === "error" || !current.enrichment ? (
                      <p className="italic">No Wikidata match found.</p>
                    ) : current.kind === "player" ? (
                      <>
                        {current.enrichment.isHallOfFame && (
                          <p className="text-[#00D558] font-semibold">Hall of Fame</p>
                        )}
                        {sortedCareerTeams.length > 0 ? (
                          <>
                            {/*
                              NEO-212: PROPOSALS, not facts. Wikidata's P54
                              memberships are frequently wrong for the hobby —
                              a minor-league affiliate, a national team, a
                              one-day roster move — and every one of them used
                              to become a real `teams` row at commit with no way
                              to say no short of cancelling the batch.
                            */}
                            <p id={careerTeamsLabelId} className="text-xs text-gray-400">
                              Career teams to create with this player:
                            </p>
                            {/* NEO-212 (a11y): role="group" + aria-labelledby
                                so the checkboxes are announced as one named
                                set. The <ul> keeps its list semantics inside
                                the group rather than being relabelled. */}
                            <div role="group" aria-labelledby={careerTeamsLabelId}>
                            <ul className="space-y-1">
                              {sortedCareerTeams.map((ct) => {
                                const label = `${ct.name} (${ct.fromYear}–${
                                  ct.toYear ?? "present"
                                })`;
                                return (
                                  <li key={`${ct.name}-${ct.fromYear}`}>
                                    <label className="flex items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!excludedForCurrent.includes(ct.name)}
                                        aria-label={`Include career team ${ct.name}`}
                                        disabled={reviewingDecided}
                                        onChange={() =>
                                          toggleCareerTeam(current._id, ct.name)
                                        }
                                        className="accent-[#00D558]"
                                      />
                                      <span>{label}</span>
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                            </div>
                          </>
                        ) : (
                          <p>No career-team history found.</p>
                        )}
                      </>
                    ) : (
                      <>
                        {current.enrichment.league && <p>League: {current.enrichment.league}</p>}
                        {current.enrichment.city && <p>City: {current.enrichment.city}</p>}
                        {current.enrichment.yearsActive && (
                          <p>
                            Active: {current.enrichment.yearsActive.from}
                            {current.enrichment.yearsActive.to
                              ? `–${current.enrichment.yearsActive.to}`
                              : "–present"}
                          </p>
                        )}
                        {current.enrichment.colors?.primary && (
                          <p className="flex items-center gap-1">
                            Colors:
                            <span
                              aria-hidden="true"
                              className="inline-block w-3 h-3 rounded-full border border-gray-600"
                              style={{ backgroundColor: current.enrichment.colors.primary }}
                            />
                            {current.enrichment.colors.secondary && (
                              <span
                                aria-hidden="true"
                                className="inline-block w-3 h-3 rounded-full border border-gray-600"
                                style={{ backgroundColor: current.enrichment.colors.secondary }}
                              />
                            )}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {reviewingDecided ? (
                  /*
                    NEO-221 — the read-only panel for a row the operator asked to
                    see again. It states the decision and offers the only two
                    things worth doing with it: change it, or move on. Nothing
                    here writes anything on its own.
                  */
                  <div
                    // Named so the panel is one announced region rather than a
                    // loose sentence and two buttons, and so a test can tell
                    // this row's decision from the same phrase in the history
                    // list below.
                    role="group"
                    aria-label={`Decision for ${current.name}`}
                    className="rounded-md border border-gray-700 bg-gray-900/60 p-3 space-y-2"
                  >
                    <p className="text-sm text-gray-400">
                      Already decided:{" "}
                      <span className="text-gray-100">
                        {describeDecision(current.decision, linkedNameFor(current.decision))}
                      </span>
                    </p>
                    <div className="flex items-center gap-3">
                      <NeonButton
                        secondary
                        style={{ color: "#000000" }}
                        aria-disabled={busy}
                        onClick={() => {
                          if (busy) return;
                          handleChangeDecision(current._id);
                        }}
                      >
                        Change decision
                      </NeonButton>
                      <button
                        type="button"
                        onClick={resumeWalking}
                        className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/*
                      Above the action row, and hidden while the link search is
                      open: both render a `Link to {name}` button per candidate,
                      and two lists of them on screen at once is an ambiguity for
                      a screen reader and for Maestro alike.
                    */}
                    {!linkingOpen && (
                      <NearMatchPanel
                        kind={current.kind}
                        matches={panelMatches}
                        onPick={(id) => {
                          if (busy) return;
                          void handleLink(
                            current._id,
                            current.kind,
                            id as Id<"players"> | Id<"teams">,
                          );
                        }}
                      />
                    )}

                    {linkingOpen ? (
                      <EntityLinkSearch
                        kind={current.kind}
                        sportId={current.sportId}
                        onSelect={(id) => {
                          void handleLink(current._id, current.kind, id);
                        }}
                        onCancel={() => setLinkingOpen(false)}
                      />
                    ) : (
                      <div className="flex flex-col gap-2" aria-busy={busy}>
                        {current.kind === "player" && (
                          <div className="space-y-1.5">
                            <p className="text-sm text-gray-400">
                              Add career team history manually
                              <span className="text-gray-500"> (optional)</span>:
                            </p>
                            {stagedCareerTeams.length > 0 && (
                              <ul className="flex flex-wrap gap-1.5" aria-label="Staged career teams">
                                {stagedCareerTeams.map((ct, idx) => (
                                  <li key={`${ct.name}-${ct.fromYear}-${idx}`}>
                                    <span className="inline-flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-xs text-gray-200">
                                      {ct.name} ({ct.fromYear}
                                      {ct.toYear ? `–${ct.toYear}` : "–present"})
                                      <button
                                        type="button"
                                        aria-label={`Remove ${ct.name}`}
                                        onClick={() =>
                                          setStagedCareerTeams((prev) =>
                                            prev.filter((_, i) => i !== idx),
                                          )
                                        }
                                        className="text-gray-500 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none"
                                      >
                                        ×
                                      </button>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            <CareerTeamEntry
                              sportId={current.sportId}
                              stagedNames={stagedTeamNames}
                              onAdd={(entry) =>
                                setStagedCareerTeams((prev) => [...prev, entry])
                              }
                            />
                            {/* What the create is actually about to write. Not a
                                role="status" — the header progress line already
                                owns that role, and a second one turns every
                                checkbox toggle into a competing announcement. */}
                            {teamSummary && (
                              <p className="text-xs text-gray-400" aria-live="polite">
                                {teamSummary}
                              </p>
                            )}
                          </div>
                        )}

                        {/*
                          ONE primary button element, one JSX slot, both states.

                          `nearMatches` resolves asynchronously while this row is
                          on screen, so `showExactHierarchy` can flip UNDER a
                          keyboard user who has already tabbed to the primary. A
                          ternary that swaps WHICH element renders here unmounts
                          the focused node and focus falls to <body> (WCAG 2.2 SC
                          3.2.2 / 2.4.3). Label, handler and variant are props on
                          a single element instead.

                          NEO-221: `aria-disabled`, never native `disabled`. A
                          disabled button leaves the tab order, so a keyboard
                          operator who tabbed here would be thrown out of the
                          action row for the length of a round-trip; NeonButton
                          already paints aria-disabled the same way.
                        */}
                        <NeonButton
                          // Close-but-not-exact matches keep the label and lose the
                          // green: still the primary action, no longer the one the
                          // eye lands on before it has read the panel above.
                          secondary={!showExactHierarchy && hasCloseOnly}
                          // NEO-212 (a11y): NeonButton's `secondary` paints white
                          // on #00C2FF — 2.07:1, well under SC 1.4.3's 4.5:1. That
                          // is a defect in the shared primitive and fixing it there
                          // would repaint every `secondary` button in the app, so
                          // this call site overrides only the foreground. Black on
                          // #00C2FF is 10.2:1, and the blue/green distinction that
                          // carries the demotion is untouched.
                          style={
                            !showExactHierarchy && hasCloseOnly
                              ? { color: "#000000" }
                              : undefined
                          }
                          aria-disabled={busy}
                          aria-label={
                            showExactHierarchy && exactMatch
                              ? `Link to ${exactMatch.name}`
                              : `Add as New ${kindLabel(current.kind)}`
                          }
                          onClick={() => {
                            if (busy) return;
                            if (showExactHierarchy && exactMatch) {
                              void handleLink(
                                current._id,
                                current.kind,
                                exactMatch._id as Id<"players"> | Id<"teams">,
                              );
                              return;
                            }
                            void handleCreate(
                              current._id,
                              current.kind === "player" ? stagedCareerTeams : undefined,
                              current.kind === "player" ? excludedForCurrent : undefined,
                            );
                          }}
                        >
                          {showExactHierarchy && exactMatch
                            ? `Link to ${exactMatch.name}`
                            : `Add as New ${kindLabel(current.kind)}`}
                        </NeonButton>
                        {/*
                          Demoted to a text link when an exact match exists — and
                          the visible text and the accessible name are THE SAME
                          STRING (WCAG 2.2 SC 2.5.3, label in name).

                          Safe for E2E: this branch renders ONLY when an exact
                          near match exists, and every Maestro flow that reaches
                          this wizard types a unique nonsense name that matches
                          nothing.
                        */}
                        {showExactHierarchy && (
                          <button
                            type="button"
                            aria-disabled={busy}
                            onClick={() => {
                              if (busy) return;
                              void handleCreate(
                                current._id,
                                current.kind === "player" ? stagedCareerTeams : undefined,
                                current.kind === "player" ? excludedForCurrent : undefined,
                              );
                            }}
                            className="self-start text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                          >
                            Add as New {kindLabel(current.kind)} anyway
                          </button>
                        )}

                        <div className="flex items-center gap-4">
                          <button
                            type="button"
                            aria-disabled={busy}
                            onClick={() => {
                              if (busy) return;
                              setLinkingOpen(true);
                            }}
                            aria-label="Link to existing instead"
                            className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                          >
                            Link to Existing…
                          </button>
                          {/*
                            NEO-212: the third way out. "Checklist", "Team Card"
                            and subset headers land in the player column
                            constantly, and before this the operator's only
                            options were to mint a junk player row or cancel the
                            whole batch.
                          */}
                          <button
                            type="button"
                            aria-disabled={busy}
                            onClick={() => {
                              if (busy) return;
                              void handleSkip(current._id);
                            }}
                            aria-label={`Skip ${current.name} — not a ${notAWhat(current.kind)}`}
                            className="text-xs text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none underline decoration-dotted aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                          >
                            Skip — not a {notAWhat(current.kind)}
                          </button>
                          {backTargetId && (
                            <button
                              type="button"
                              onClick={() => presentDecided(backTargetId)}
                              aria-label="Back to previous decision"
                              className="text-xs text-gray-400 hover:text-[#00B7FF] focus:text-[#00B7FF] focus:outline-none underline decoration-dotted"
                            >
                              Back
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : allDecided ? (
              <div className="space-y-3">
                {/* Heading text unchanged — "All reviewed" and the card count
                    are both Maestro matchers. */}
                <p className="text-sm text-gray-200">
                  All reviewed — save {summary.cardCount}{" "}
                  {summary.cardCount === 1 ? "card" : "cards"}?
                </p>
                {/*
                  NEO-220 — what Confirm & Save is about to do, itemised.
                  The card count alone never mentioned the deletes, the field
                  updates or the new player/team rows, so the one irreversible
                  step in the flow was also the least specific screen in it.
                  Zero-valued lines are omitted rather than printed as "0":
                  a list of noughts buries the two numbers that are not.
                */}
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
                  {summaryRows
                    .filter(([, value], idx) => idx === 0 || value > 0)
                    .map(([label, value]) => (
                      <div key={label} className="contents">
                        <dt className="text-gray-400">{label}</dt>
                        <dd className="text-gray-100 tabular-nums">{value}</dd>
                      </div>
                    ))}
                </dl>
                {commitError && (
                  /*
                    NEO-220 — a failed commit is recoverable, so say so and show
                    both ways out. The footer's Confirm & Save is hidden while
                    this is up: two controls for one action, differently
                    labelled, is how an operator ends up pressing neither.
                  */
                  <div
                    role="alert"
                    className="rounded-md border border-[#FF2EB3]/40 bg-[#FF2EB3]/10 p-3 space-y-2"
                  >
                    <p className="text-sm text-[#FF2EB3]">{commitError}</p>
                    <p className="text-xs text-gray-400">
                      Nothing was saved. Every decision you made is still here.
                    </p>
                    <div className="flex items-center gap-3">
                      <NeonButton onClick={onConfirm} disabled={saving}>
                        {saving ? "Saving..." : "Retry commit"}
                      </NeonButton>
                      {onDismissCommitError && (
                        <button
                          type="button"
                          onClick={() => {
                            onDismissCommitError();
                            if (backTargetId) presentDecided(backTargetId);
                          }}
                          className="text-xs text-gray-400 hover:text-[#00B7FF] focus:text-[#00B7FF] focus:outline-none underline decoration-dotted"
                        >
                          Back to review
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic">
                Looking up {stillLookingUp} more {stillLookingUp === 1 ? "name" : "names"}…
              </p>
            )}

            {/*
              NEO-221 — everything decided so far, and a way back into any of
              it. Below the current row rather than beside it: this is
              reference, not the task. Collapsed past five entries, because by
              then it is longer than the row it is meant to support.
            */}
            {!expired && decidedRows.length > 0 && (
              <details
                open={decidedListExpanded}
                onToggle={(e) => setDecidedListOpen(e.currentTarget.open)}
                className="border-t border-gray-800 pt-3"
              >
                <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300 focus:text-gray-300 focus:outline-none">
                  Decided ({decidedRows.length})
                </summary>
                <ul aria-label="Decided names" className="mt-2 space-y-1">
                  {decidedRows.map((row) => (
                    <li
                      key={row._id}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                    >
                      <span className="text-gray-200">{row.name}</span>
                      <span className="text-gray-500">
                        {describeDecision(row.decision, linkedNameFor(row.decision))}
                      </span>
                      <button
                        type="button"
                        aria-disabled={busy}
                        onClick={() => {
                          if (busy) return;
                          handleChangeDecision(row._id);
                        }}
                        aria-label={`Change decision for ${row.name}`}
                        className="text-gray-400 hover:text-[#00B7FF] focus:text-[#00B7FF] focus:outline-none underline decoration-dotted aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                      >
                        Change
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-700 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-4">
              {/*
                The auto-add status REPLACES the bulk buttons in the same row
                rather than stacking above them. Growing the footer would push
                its contents up by the height of the new line — the NEO-110
                failure mode, arriving from the other direction.
              */}
              {!expired && autoAddPending ? (
                <>
                  <span className="text-xs text-gray-400" role="status" aria-live="polite">
                    Adding {remaining} more as their lookups finish…
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      autoAddRef.current = false;
                      setAutoAddPending(false);
                    }}
                    className="text-xs text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none underline decoration-dotted"
                  >
                    Stop
                  </button>
                </>
              ) : (
                !expired &&
                !allDecided &&
                remaining > 0 && (
                  <>
                    {/*
                      No aria-label: the visible text IS the accessible name.
                      The pending clause changes the visible string, and a
                      shorter aria-label over it would be a label-in-name
                      violation (WCAG 2.2 SC 2.5.3) as well as a lie about what
                      the button is going to do. Maestro matches
                      `.*Add All Remaining as New.*`, which the prefix keeps.
                    */}
                    <button
                      type="button"
                      onClick={handleBulkCreate}
                      disabled={bulkPending !== null || saving}
                      className="text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted disabled:opacity-50"
                    >
                      {bulkPending === "create"
                        ? "Adding all remaining…"
                        : `Add All Remaining as New (${remaining})${
                            pendingUndecided > 0
                              ? ` — ${pendingUndecided} still looking up, wait or skip`
                              : ""
                          }`}
                    </button>
                    <button
                      type="button"
                      onClick={handleBulkSkip}
                      disabled={bulkPending !== null || saving}
                      className="text-xs text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none underline decoration-dotted disabled:opacity-50"
                    >
                      {bulkPending === "skip"
                        ? "Skipping remaining…"
                        : `Skip Remaining (${remaining})`}
                    </button>
                  </>
                )
              )}
            </div>
            <div className="flex items-center gap-3">
              {expired ? (
                // Nothing to discard — the rows are already gone, so this is a
                // plain acknowledgement, not a cancel.
                <NeonButton cancel onClick={onCancel}>
                  Close
                </NeonButton>
              ) : (
                <>
                  {/*
                    NEO-220 — leave review without discarding it. Present only
                    when there is a parked matching session to go back to.
                  */}
                  {onBack && (
                    <NeonButton
                      secondary
                      style={{ color: "#000000" }}
                      onClick={onBack}
                      disabled={cancelling || saving}
                    >
                      Back to matching
                    </NeonButton>
                  )}
                  <NeonButton
                    cancel
                    onClick={requestClose}
                    disabled={cancelling || saving}
                  >
                    Cancel (Esc)
                  </NeonButton>
                  {allDecided && !commitError && (
                    <NeonButton ref={confirmButtonRef} onClick={onConfirm} disabled={saving}>
                      {saving ? "Saving..." : "Confirm & Save (Enter)"}
                    </NeonButton>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      {/*
        A SIBLING of the overlay, inside the same portal. Nested inside it, the
        confirm's own overlay-click-to-cancel would bubble into the wizard
        overlay's handlers; outside the portal it would be behind the modal
        barrier. ConfirmDialog is not portalled and uses fixed ids, so only one
        may be open at a time — which is true here by construction.
      */}
      {confirming && (
        <ConfirmDialog
          title={`Discard ${decided} ${decided === 1 ? "decision" : "decisions"}?`}
          description="Your review decisions for this fetch are thrown away and no cards are saved. The same names come back the next time you sync this set."
          confirmLabel="Discard"
          busyLabel="Discarding…"
          busy={cancelling}
          error={cancelError}
          onConfirm={() => void runCancel()}
          onCancel={() => {
            if (cancelling) return;
            setConfirming(false);
            setCancelError(null);
          }}
        />
      )}
    </Theme>,
    document.body,
  );
}
