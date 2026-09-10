import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { normalizeEntityName } from "../../convex/lib/entityNearMatch";
// NEO-254: the server's scan cap, so the panel can say when it was hit.
import { PLAYER_AMBIGUITY_SCAN_LIMIT } from "../../lib/players/name-limits";
// NEO-212 security review: an enrichment `wikidataId` arrives from
// query.wikidata.org, so it is external input on its way into an `href`.
// `wikidataUrl` returns null unless it is really a `Q<digits>` id — see
// lib/players/wikidata-id.ts.
import { wikidataUrl, wikipediaUrl } from "../../lib/players/wikidata-id";
// NEO-236: the team name split. Pure, no Convex — see lib/teams/team-name.ts.
import { teamFullName } from "../../lib/teams/team-name";
import { isEditableTarget } from "../../lib/dom/is-editable-target";
import { useFieldTestClass } from "../../src/hooks/useFieldTestClass";
import NeonButton from "../modules/NeonButton";
import { ConfirmDialog } from "../modules/confirm-dialog";
import { Input } from "../primitives/Input";
import { CopyButton } from "../primitives/CopyButton";
// `hasExact` is deliberately no longer imported: NEO-254 needs to know
// whether there is EXACTLY ONE exact match, not whether there is at least one,
// and the boolean cannot answer that. The admin add form still uses it — the
// question it asks there ("is a duplicate possible at all?") is the one
// `hasExact` was written for.
import { NearMatchPanel, type NearMatch } from "../entities/NearMatchPanel";
import { teamOptionLabel } from "../../lib/teams/team-era";
import EntityLinkSearch from "./EntityLinkSearch";
import CareerTeamEntry, { type CareerTeamDraft } from "./CareerTeamEntry";
// NEO-236: the one form a team is created from, shared with NewTeamDialog.
import NewTeamForm, {
  draftFullName,
  newTeamPrefill,
  type NewTeamDraft,
} from "./NewTeamForm";
import type { LeagueLevel } from "../admin/AddLeagueForm";
import NewLeagueForm, {
  leagueDraftError,
  newLeaguePrefill,
  parseAliases,
  type NewLeagueDraft,
} from "./NewLeagueForm";
import SameNamePlayerPanel from "./SameNamePlayerPanel";
import UndatedCareerTeams from "./UndatedCareerTeams";
import { deriveStagedTeamNames } from "./entity-review-staging";
import {
  countBulkCreatable,
  countPendingBulkCreatable,
  countPendingUndecided,
  countUndecided,
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

/**
 * Mirrors MAX_TEAM_FULL_NAME_LENGTH in convex/entityReviewQueue.ts (and
 * MAX_TEAM_NAME_LENGTH in convex/teams.ts). Applied to the COMPOSED name,
 * because that is what gets stored and what the server measures.
 */
const MAX_TEAM_FULL_NAME_LENGTH = 120;

/**
 * NEO-236 (a11y + E2E): STABLE ids for the team Location + Name pair, not
 * `useId()`.
 *
 * Two reasons, and they point the same way. `Input` never emits an id of its
 * own precisely because maestro-web builds `resource-id = node.id ||
 * node.ariaLabel`, so an id it cannot predict would replace the label a flow
 * targets by — a generated `:r7:` is exactly that. And these fields want a
 * visible `<label htmlFor>` rather than an `aria-label`, because two adjacent
 * text inputs are the one case where a label earns its line, which needs an id
 * to point at.
 *
 * Safe as constants: the wizard is a portal-rendered modal that exists at most
 * once, the same premise `entity-review-wizard-title` already rests on.
 */
const TEAM_LOCATION_FIELD_ID = "entity-review-team-location";
const TEAM_NAME_FIELD_ID = "entity-review-team-name";
/** NEO-236 — the League pill group on the New Team step, same reasoning. */
const TEAM_LEAGUE_FIELD_ID = "entity-review-team-league";
// NEO-254 — the New League step's two addressable controls. Same reason the
// three above carry ids: maestro-web derives `resource-id` from `node.id ||
// node.ariaLabel`, and a stable id is what a flow can target without depending
// on the label copy.
const LEAGUE_NAME_FIELD_ID = "entity-review-league-name";
const LEAGUE_LEVEL_FIELD_ID = "entity-review-league-level";

/**
 * NEO-236 — what the Location + Name pair shows for a team row before the
 * operator touches it.
 *
 * Location is pre-filled ONLY from an ESPN location the lookup actually
 * returned, and only when `splitTeamName` finds it as a whole-word prefix of
 * the reviewed name: "San Diego" off "San Diego Padres" splits, "Anaheim" off
 * "Los Angeles Angels" does not, and neither does "Sa". Everything else starts
 * with a blank Location and the whole reviewed name in Name — byte-for-byte
 * how these rows were created before the split existed, and the operator's cue
 * to split it themselves. A blank Location is the FINAL answer only for a name
 * that carries no place at all ("Athletics", "Orix Buffaloes"); a college
 * side's location is its school ("San Diego State" / "Aztecs").
 *
 * There is no first-token heuristic here and there must never be one: NB has
 * no code path that guesses a location without a source. The operator is the
 * fallback.
 *
 * Mirrored server-side by `prefilledTeamCreate` in convex/entityReviewQueue.ts,
 * which is what "Add All Remaining as New" writes for a team row — so
 * confirming one row and confirming the batch mean the same thing.
 */
export function teamCreatePrefill(row: {
  name: string;
  enrichment?: { location?: string } | null;
}): NewTeamDraft {
  return newTeamPrefill({
    name: row.name,
    ...(row.enrichment?.location ? { location: row.enrichment.location } : {}),
  });
}
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
/**
 * Hard cap on automatic re-calls per arming — a runaway guard, not a budget.
 * Sized for the largest real fetch the seed exercises: a ~335-card base set
 * surfaces ~365 player + team rows, which the 5-wide lookup pool drains in
 * batches of roughly AUTO_ADD_BATCH_THRESHOLD, i.e. ~70 rounds. A cap that
 * trips below that disarms mid-drain and Confirm & Save never appears.
 */
const AUTO_ADD_MAX_CALLS = 400;

/**
 * A Convex rejection's message, or a written-for-the-operator fallback.
 *
 * NEO-236: `data` is read FIRST, and structurally rather than with
 * `instanceof ConvexError` — the same reasoning as `RenameEntityControl`'s
 * `refusalMessage`, so a mocked or rethrown error in a test, or a version skew
 * in the convex client, still surfaces what the server actually said.
 * `recordDecision` throws a `ConvexError` when the Location + Name it was
 * handed cannot compose into a team, and that string is written for the
 * operator to read; a plain `Error` arrives already redacted to "Server Error",
 * which is why the fallback exists.
 */
const errorMessage = (e: unknown, fallback: string) => {
  if (typeof e === "object" && e !== null) {
    const data = (e as { data?: unknown }).data;
    if (typeof data === "string" && data.length > 0) return data;
  }
  return e instanceof Error && e.message ? e.message : fallback;
};

/**
 * NEO-260 — accessible names for the footer's two commit-or-leave buttons.
 *
 * They sit side by side and are the pair a `pressKey: Enter` can confuse, so a
 * screen-reader user has to be able to tell which one they are on from the name
 * alone. Two rules held here on purpose, the same two `EntityColumn` holds:
 *
 *  - **Each label CONTAINS its visible text** (WCAG 2.5.3 Label in Name), so a
 *    voice-control user saying the words they can see still hits the control.
 *  - **Neither label is a substring of the other.** Maestro matches `id:` as an
 *    UNANCHORED regex, and `resource-id` is `node.id || node.ariaLabel`, so two
 *    overlapping names would make one selector find both buttons.
 *
 * The visible text is unchanged — every flow that targets these two does so by
 * `text:`, which reads the button's own words, not its accessible name.
 */
const CONFIRM_SAVE_LABEL = "Confirm & Save (Enter) — commit this review";
/** The same button once `saving` flips: its words change, so its name must too. */
const CONFIRM_SAVING_LABEL = "Saving... — committing this review";
const CANCEL_REVIEW_LABEL = "Cancel (Esc) — leave without committing";

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
  // NEO-236 — turn a player's career teams into their own New Team steps.
  const stageCareerTeams = useMutation(api.entityReviewQueue.stageCareerTeamRows);
  // NEO-254 — a league the operator TYPES on a team step gets a step of its
  // own, so it is asked the same questions a suggested league is. Without it
  // the commit fell back to a bare `findOrCreateLeague(name)`, which is the
  // name-only league this feature exists to stop.
  const stageLeagueRows = useMutation(api.entityReviewQueue.stageLeagueRows);
  // NEO-248 — removing a chip has to be as durable as adding one was.
  const clearCareerTeamStint = useMutation(
    api.entityReviewQueue.clearCareerTeamStint,
  );

  const [linkingOpen, setLinkingOpen] = useState(false);
  /**
   * NEO-236 — the career-team entry form has text in it.
   *
   * Reported up by `CareerTeamEntry` because the text lives there, and the
   * walk's "may I move you off this row?" test needs to know. Reset with the
   * rest of the per-row state when the presented row changes.
   */
  const [careerEntryDirty, setCareerEntryDirty] = useState(false);
  /**
   * Manual career-team entries the admin has staged, keyed by PLAYER review-row
   * id. Held here (not in CareerTeamEntry) so it can be passed through to
   * recordDecision on "Add as New Player".
   *
   * ## NEO-248 — why this is keyed rather than a bare array
   *
   * It used to be one array, wiped by the presented-row effect below. NEO-236
   * then made a hand-typed career team stage a New Team step of its own, and
   * staging that step MOVES the walk onto it (`waitingOnStagedTeams`). So the
   * ordinary path through this feature — type "Sydney Blue Sox", 2001, 2005,
   * press Add — navigated away and wiped the array on the way, and the operator
   * came back to a player row with no chip and no years anywhere. Typed input,
   * silently lost.
   *
   * Keyed by row it survives the round trip, for exactly the reason
   * `excludedCareerTeamsByRow` and `teamCreateByRow` beside it are keyed: a
   * thing the operator has already said must outlive NEO-221's navigation. The
   * years are ALSO persisted server-side on the staged step
   * (`source.manualStint`), which is what `persistedStagedCareerTeams` rebuilds
   * from when this map has never held an entry for the row — a reopened dialog,
   * a reload.
   */
  const [stagedCareerTeamsByRow, setStagedCareerTeamsByRow] = useState<
    Record<string, CareerTeamDraft[]>
  >({});
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
   * NEO-236 — the Location + Name the operator is creating a TEAM row from,
   * keyed by review-row id.
   *
   * Keyed rather than reset per row for the same reason
   * `excludedCareerTeamsByRow` is: a correction the operator has already typed
   * ("this is Golden State / Warriors, not Golden / State Warriors") must
   * survive NEO-221's back-navigation. Absent means "untouched", and an
   * untouched row shows `teamCreatePrefill` — so the pre-fill stays live while
   * a slow enrichment lookup lands, and stops the moment the operator types.
   */
  const [teamCreateByRow, setTeamCreateByRow] = useState<
    Record<string, NewTeamDraft>
  >({});
  /**
   * NEO-254 — the same, per LEAGUE row, and never reset per row for the same
   * reason: a typed correction must survive NEO-221 back-navigation. Absent
   * means "untouched", which renders the live prefill.
   */
  const [leagueCreateByRow, setLeagueCreateByRow] = useState<
    Record<string, NewLeagueDraft>
  >({});
  /*
   * NEO-236 — there is no per-career-team draft state any more.
   *
   * A career team the batch has to create is a review row of its own now (see
   * `entityReviewQueue.stageCareerTeamRows`), walked BEFORE the player and
   * answered on the same New Team step a checklist team gets — Location, Name
   * and, the part the inline pairs could never ask, League. The player's step
   * reads those rows rather than collecting a second copy of the answer.
   */

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
  /** NEO-236 — player rows this session has already asked the server to stage
   *  career-team steps for. A ref, not state: see the effect. */
  const stagedPlayersRef = useRef<Set<string>>(new Set());
  /**
   * NEO-236 — a career team the operator asked to decide that the batch holds
   * no step for.
   *
   * Staging normally covers every accepted career team, but not always: it caps
   * at 64 per player and skips a name too long to compose into a team. Those
   * chips said "needs a team decision" with no way out beside them.
   *
   * Pressing `Decide team` now STAGES the step and then pins it. The row does
   * not exist when the mutation returns, so the normalized label is parked here
   * and an effect claims the row when the reactive batch brings it in.
   */
  const awaitingStageRef = useRef<string | null>(null);
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
   * NEO-260 — per-button marker classes for the footer's action row.
   *
   * maestro-web's `pressKey` does not send the key to `document.activeElement`:
   * it runs `createXPathFromElement(activeElement)`, RE-FINDS by that XPath and
   * dispatches to the match. The generator falls back to `tag[@class="…"]` per
   * ancestor, and `Confirm & Save (Enter)` and `Cancel (Esc)` are sibling Radix
   * <Button>s with the IDENTICAL class string (the neon colour is a
   * `data-accent-color` attribute and an inline style, never a class) — so the
   * XPath matched BOTH, Selenium returned the first, and Enter aimed at Confirm
   * landed on Cancel while the app's own focus was perfectly correct.
   *
   * A unique CLASS per button makes each XPath name exactly one node. A class,
   * never a DOM `id`: Maestro's `resource-id` is `node.id || node.ariaLabel`,
   * so an id shadows the accessible name that flows and screen-reader users
   * both read — and a DOM id is invisible to every user, which is the reason
   * the house rule forbids it (see `useFieldTestClass` and `.maestro/README.md`).
   */
  const footerFieldClass = useFieldTestClass();
  /**
   * a11y (WCAG 2.4.3 / 4.1.2) — where to park focus while `cancelling` or
   * `saving` disables the footer button that was just clicked.
   *
   * Both flags flip true the instant Cancel (with nothing decided — no
   * `ConfirmDialog` involved) or Confirm & Save / Retry commit is pressed,
   * and both use NATIVE `disabled` on that button (unlike the per-row
   * decision controls, which use `aria-disabled` for exactly this reason —
   * see the header note on NEO-221's `busy` guard). The browser blurs a
   * disabled element to `<body>` the instant it disables, dropping focus
   * outside the still-open, still-`aria-modal` dialog. Mirrors
   * `ConfirmDialog`'s own `if (busy) dialogRef.current?.focus()`.
   */
  const dialogRootRef = useRef<HTMLDivElement>(null);
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
  /** Names the "you can't confirm yet" message so the primary action can point
   *  `aria-describedby` at it. */
  const createBlockedId = useId();
  /**
   * NEO-236 (a11y) — id prefix for the per-career-team status lines.
   *
   * Each chip's "-> <team>" / "needs a team decision" line sits inside the
   * checkbox's own `<label>`, but the checkbox carries an explicit `aria-label`
   * ("Include career team X") which WINS over the label's text — so the status
   * was on screen and absent from everything a screen reader announces.
   * `aria-describedby` says it without disturbing the accessible name every
   * `.maestro` flow targets.
   */
  const careerTeamStatusIdBase = useId();

  const total = rows?.length ?? 0;
  const decided = useMemo(() => rows?.filter((r) => r.decision).length ?? 0, [rows]);
  const stillLookingUp = useMemo(
    () => rows?.filter((r) => r.status === "pending").length ?? 0,
    [rows],
  );
  /** What the OPERATOR is waiting on — every kind of row. Drives the status
   *  line, which is why it must not be narrowed to players. */
  const pendingUndecided = useMemo(
    () => countPendingUndecided(rows ?? []),
    [rows],
  );
  /** What the BULK CREATE will still have work to do for once lookups land —
   *  players only, so arming it can actually converge. */
  const pendingBulkCreatable = useMemo(
    () => countPendingBulkCreatable(rows ?? []),
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
    // NEO-236: the composed full name. A split row's `name` is the nickname
    // alone ("Padres"), which does not identify the team it belongs to.
    for (const t of linkedTeams ?? []) map.set(t._id, teamFullName(t));
    for (const p of linkedPlayers ?? []) map.set(p._id, p.name);
    return map;
  }, [linkedTeams, linkedPlayers]);

  const excludedForCurrent = current
    ? (excludedCareerTeamsByRow[current._id] ?? [])
    : [];

  /**
   * NEO-248 — the hand-typed stints this player's own staged steps still carry.
   *
   * `stageCareerTeamRows` writes the operator's years onto the step it stages
   * (`source.manualStint`), and ONLY for a hand-typed entry — a Wikidata
   * proposal stages a step with no stint on it, because its years are already
   * on this row's `enrichment.careerTeams` and are rendered from there. So this
   * rebuilds exactly the chips the manual form produced and nothing else.
   *
   * Used only when the operator has not touched this row in this session (see
   * `stagedCareerTeams` below): within a session the keyed map is authoritative,
   * because a chip the operator REMOVED must stay removed even though its
   * staged step is still standing.
   */
  const persistedStagedCareerTeams = useMemo<CareerTeamDraft[]>(() => {
    if (!current || current.kind !== "player" || !rows) return [];
    const out: CareerTeamDraft[] = [];
    for (const row of rows) {
      const source = row.source;
      if (source?.kind !== "careerTeamOf") continue;
      if (source.playerRowId !== current._id) continue;
      const stint = source.manualStint;
      if (!stint) continue;
      out.push({
        name: row.name,
        fromYear: stint.fromYear,
        ...(stint.toYear !== undefined ? { toYear: stint.toYear } : {}),
      });
    }
    return out;
  }, [rows, current]);

  /** The chips for the row on screen: this session's edits if there are any,
   *  otherwise whatever the batch itself still remembers. Memoised because it
   *  is a dependency of two memos below, and a fresh `[]` every render would
   *  re-run both of them forever. */
  const stagedCareerTeams = useMemo<CareerTeamDraft[]>(
    () =>
      current
        ? (stagedCareerTeamsByRow[current._id] ?? persistedStagedCareerTeams)
        : [],
    [current, stagedCareerTeamsByRow, persistedStagedCareerTeams],
  );

  /**
   * Write the chip list for the row on screen.
   *
   * Takes an updater over the EFFECTIVE list rather than over the map's entry,
   * so removing a rehydrated chip works the same as removing one added a moment
   * ago. Both callers are user gestures, so the closed-over value is current.
   */
  const setStagedCareerTeams = (
    updater: (prev: CareerTeamDraft[]) => CareerTeamDraft[],
  ) => {
    const rowId = current?._id;
    if (!rowId) return;
    const next = updater(stagedCareerTeams);
    setStagedCareerTeamsByRow((prev) => ({ ...prev, [rowId]: next }));
  };

  /** Every team name this batch already accounts for — fed to the career-team
   *  typeahead so it can suggest teams that exist only as pending decisions. */
  const stagedTeamNames = useMemo(
    () =>
      deriveStagedTeamNames({
        rows: rows ?? [],
        currentRowId: current?._id ?? null,
        // NEO-236: a chip holds Location + Name; the staging list is full
        // names, because that is the key commit dedupes on.
        localChips: stagedCareerTeams.map((c) => ({ name: teamFullName(c) })),
        linkedTeamNames: (linkedTeams ?? []).map((t) => teamFullName(t)),
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
    for (const chip of stagedCareerTeams) push(teamFullName(chip));
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

  /**
   * ── NEO-236: what will happen to each career team on this player ──────────
   *
   * The wizard used to answer this with three inline inputs per unmatched
   * label. It now answers it by READING the batch: a career team the commit
   * would have to create is a review row of its own, staged ahead of the player
   * (`entityReviewQueue.stageCareerTeamRows`) and answered on a New Team step.
   * So the player's step reports rather than collects, and each chip says which
   * of four things is true of it.
   */
  const stagedTeamRowsForCurrent = useMemo(() => {
    const byName = new Map<string, NonNullable<typeof rows>[number]>();
    if (!current || current.kind !== "player" || !rows) return byName;
    for (const row of rows) {
      if (row.kind !== "team") continue;
      /*
       * ANY team row in the batch, keyed by NAME — not just the rows staged for
       * this player, and not just STAGED rows at all.
       *
       * Jason, on the Canadiens: the batch held a plain team row for "Montreal
       * Canadiens" (a name off the checklist, no `source`) and this player's
       * chip still read "needs a team decision" after it had been answered.
       * This opened with `source?.kind !== "careerTeamOf"`, so only a staged row
       * could answer a chip.
       *
       * The question a chip asks is "does the batch hold an answer for this
       * team?" — and a checklist team row is exactly that answer. Where a row
       * came from decides what its STEP says ("Needed by: …"), never whether it
       * counts.
       *
       * Staging dedupes a career team across the entire batch — the first
       * player to propose "Sydney Blue Sox" gets the step, and every later
       * player that shares that club gets none, because one step is all the
       * batch needs. Filtering by `source.playerRowId` therefore made every
       * player after the first report "needs a team decision" for a team the
       * batch was already creating, and blocked their Confirm on a question
       * that had already been answered.
       *
       * `playerRowId` still does real work — it names the step ("Needed by:
       * Travis Bazzana") and it is what the walk's blocking rule reads. It is
       * simply not what decides whether a LABEL has an answer; the answer is
       * the team, and the team is identified by its name.
       */
      const key = normalizeEntityName(row.name);
      if (!key) continue;
      // A decided row wins over an undecided one holding the same name. The two
      // can only coexist transiently (staging dedupes against the batch), and
      // when they do the ANSWER is the interesting one.
      const held = byName.get(key);
      if (held?.decision && !row.decision) continue;
      byName.set(key, row);
    }
    return byName;
  }, [rows, current]);

  /**
   * `resolved` — we already hold this team, so the stint links to it.
   * `creating` — a staged step in THIS batch is answered "add as new", and the
   *   label is the composed name the operator gave it.
   * `linked` — that step was answered by pointing at an existing row instead.
   * `waiting` — nobody has answered it yet, or it was skipped as "not a team".
   *   The stint cannot land, so Confirm is held until the operator answers the
   *   step or unticks the chip.
   */
  const careerTeamStatus = (
    label: string,
  ):
    | { kind: "resolved" | "creating" | "linked"; name: string }
    | { kind: "checking" }
    /**
     * NEO-254 — the sport holds SEVERAL teams under this name, one per era.
     *
     * `teams.resolveNames` answers `ambiguous` rather than picking, because a
     * name alone is not an answer: the 1972-1996 Winnipeg Jets and the 2011-
     * ones are different franchises. Nothing is resolved on the client — the
     * prelude resolves each stint by its OWN `fromYear`, which is the only
     * year that can settle it, and a chip that guessed here would disagree
     * with what the commit actually writes.
     *
     * So this reports the state and nothing else. The chip already carries its
     * years, so for the ordinary case the operator has nothing to do: the
     * commit will pick the right era on its own. It matters when the years are
     * wrong or missing, and the existing "Add years" / stint editing is how
     * that is fixed.
     */
    | { kind: "ambiguous" }
    // NEO-236 — `stagedRowId` is the step that answers this label, when the
    // batch holds one. Without it the chip said "needs a team decision" and
    // pointed nowhere, which is exactly what Jason hit: "There does not appear
    // to be anywhere that a decision is needed that I can see."
    | { kind: "waiting"; stagedRowId?: Id<"entityReviewQueue"> } => {
    const key = normalizeEntityName(label);
    const resolved = (resolvedTeamNames ?? []).find(
      (r) => normalizeEntityName(r.name) === key,
    );
    if (resolved?.existingTeamId) {
      return { kind: "resolved", name: resolved.existingName ?? label };
    }
    // NEO-254 — several eras answer to this name. Reported, never guessed at;
    // see the `ambiguous` case above. Checked BEFORE the staged-step branch,
    // because a name we already hold has no staged step by construction.
    if (resolved?.ambiguous) return { kind: "ambiguous" };
    const staged = stagedTeamRowsForCurrent.get(key);
    /*
     * The match query has not answered yet, and this chip has no staged step
     * of its own to answer from. `undefined` from `resolveNames` is "not
     * answered", NOT "no match" — and the difference matters here in a way it
     * did not before: every chip whose team ALREADY EXISTS has no staged step
     * by construction (staging skips a team we hold), so reading an unanswered
     * query as "unanswered by the operator" would paint a whole career pink
     * and block Confirm for as long as the round trip takes.
     *
     * `checking` says nothing on screen and blocks nothing. When the answer
     * lands it becomes `resolved` or, genuinely, `waiting`.
     */
    if (resolvedTeamNames === undefined && !staged?.decision) {
      return { kind: "checking" };
    }
    const decision = staged?.decision;
    if (decision?.action === "create" && decision.create) {
      return {
        kind: "creating",
        name: teamFullName({
          name: decision.create.name,
          ...(decision.create.location
            ? { location: decision.create.location }
            : {}),
        }),
      };
    }
    if (decision?.action === "link" && decision.linkedTeamId) {
      return {
        kind: "linked",
        name: linkedNameById.get(decision.linkedTeamId) ?? label,
      };
    }
    return staged ? { kind: "waiting", stagedRowId: staged._id } : { kind: "waiting" };
  };

  /** The first career team on this row that has a step waiting to be answered
   *  — what the footer's blocked line offers to jump to. */
  const firstBlockingStep = (): { name: string; rowId: Id<"entityReviewQueue"> } | null => {
    for (const label of unansweredCareerTeams) {
      const status = careerTeamStatus(label);
      if (status.kind === "waiting" && status.stagedRowId) {
        return { name: label, rowId: status.stagedRowId };
      }
    }
    return null;
  };

  /** "Will create 2 new teams: X, Y · 1 already exist" — either half is
   *  omitted when its count is zero, so the line never says "0 new teams". */
  /**
   * One line under the career list saying where this player's stints will land.
   *
   * NEO-236 reworded it, because "Will create N new teams" stopped being true
   * of THIS step. A team the batch does not hold gets a New Team step of its
   * own, and until that step is answered nothing is being created — so the line
   * reports three states rather than two, and only claims a creation once the
   * team's own step has actually said create.
   *
   * Built from `careerTeamStatus` rather than from `resolvedTeamNames` alone,
   * so it cannot drift from what the chips beside it say.
   */
  const teamSummary = useMemo(() => {
    if (!resolvedTeamNames || resolvedTeamNames.length === 0) return null;
    const creating: string[] = [];
    const waiting: string[] = [];
    let alreadyExist = 0;
    // The accepted labels, computed here rather than read off
    // `acceptedCareerTeams`: that one is declared below the `isOpen` early
    // return, and a hook may not reach past it.
    const accepted = (current?.enrichment?.careerTeams ?? [])
      .map((ct) => ct.name)
      .filter(
        (label, idx, all) =>
          all.indexOf(label) === idx && !excludedForCurrent.includes(label),
      );
    for (const label of accepted) {
      const status = careerTeamStatus(label);
      if (status.kind === "resolved" || status.kind === "linked") {
        alreadyExist += 1;
      } else if (status.kind === "creating") {
        creating.push(status.name);
      } else if (status.kind === "waiting") {
        waiting.push(label);
      }
      // "checking" says nothing until the match query answers.
    }
    const parts: string[] = [];
    if (creating.length > 0) {
      parts.push(
        `Will create ${creating.length} new ${
          creating.length === 1 ? "team" : "teams"
        }: ${creating.join(", ")}`,
      );
    }
    if (waiting.length > 0) {
      parts.push(
        `${waiting.length} ${
          waiting.length === 1 ? "team needs" : "teams need"
        } their own step: ${waiting.join(", ")}`,
      );
    }
    if (alreadyExist > 0) parts.push(`${alreadyExist} already exist`);
    return parts.length > 0 ? parts.join(" · ") : null;
    // `careerTeamStatus` closes over `resolvedTeamNames`, the staged rows and
    // the linked-name map, all of which are already deps here by way of the two
    // listed; adding the function itself would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTeamNames, stagedTeamRowsForCurrent, current, excludedForCurrent, linkedNameById]);

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
  /**
   * NEO-236 — has the operator started on the row that is on screen?
   *
   * Gates ONLY the teams-first yield (see `resolveNav`): the walk may revise
   * its own pick while the row is untouched, and must stop once there is work
   * on it to lose. Every item here is per-row state that a jump discards or
   * hides:
   *
   *  - `linkingOpen` — the link search is open, i.e. they are choosing a target;
   *  - a staged manual stint;
   *  - an unticked career-team chip (the list starts fully ticked, so anything
   *    in here is a deliberate exclusion);
   *  - text typed into the career-team entry, reported up by that component;
   *  - a New Team form the operator has edited (team rows never yield, so this
   *    is belt-and-braces rather than load-bearing).
   */
  const pinnedRowHasEdits =
    linkingOpen ||
    careerEntryDirty ||
    // NEO-248: presence of a KEY, not a non-empty list — the same test as
    // `teamCreateByRow` below. The list can now be rehydrated from the batch on
    // a row the operator has not touched this session, and a rehydrated chip is
    // not "work in progress on the row on screen"; only an edit made here is.
    (current ? stagedCareerTeamsByRow[current._id] !== undefined : false) ||
    (current ? (excludedCareerTeamsByRow[current._id]?.length ?? 0) > 0 : false) ||
    (current ? teamCreateByRow[current._id] !== undefined : false);

  /**
   * NEO-248 — `pinnedRowHasEdits`, readable from inside the auto-add timer.
   *
   * That timer fires 1.5s after a lookup lands, out of a render closure that is
   * already stale, and what it calls decides EVERY settled row in the batch.
   * The same ref trick `autoAddRef` uses, for the same reason.
   */
  const pinnedEditsRef = useRef(pinnedRowHasEdits);
  useEffect(() => {
    pinnedEditsRef.current = pinnedRowHasEdits;
  }, [pinnedRowHasEdits]);

  useEffect(() => {
    if (!rows) return;
    const next = resolveNav(rows, nav, { pinnedRowHasEdits });
    if (next === nav) return;
    navRef.current = next;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the presented row follows the batch; the rule that decides when is pure and tested in entity-review-nav.test.tsx
    setNav(next);
  }, [rows, nav, pinnedRowHasEdits]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-way latch: a batch that has had rows can never un-have them
    if (rows && rows.length > 0 && !hadRows) setHadRows(true);
  }, [rows, hadRows]);

  /**
   * NEO-236 — claim the step `Decide team` just asked to have staged.
   *
   * The insert happens server-side, so the row arrives on the next `getBatch`
   * push rather than in the mutation's return. Pinned EXPLICITLY: the operator
   * asked for this row by name, and the walk's teams-first rule would otherwise
   * be free to offer some other team first.
   */
  useEffect(() => {
    const waiting = awaitingStageRef.current;
    if (!waiting || !rows) return;
    const staged = rows.find(
      (r) => r.kind === "team" && normalizeEntityName(r.name) === waiting,
    );
    if (!staged) return;
    awaitingStageRef.current = null;
    const next: NavState = { rowId: staged._id, explicit: true };
    navRef.current = next;
    // No `set-state-in-effect` disable needed here, unlike the nav effect
    // above: this one is guarded by a ref that is cleared before the set, so
    // the lint rule can see it cannot re-enter.
    setNav(next);
  }, [rows]);

  /**
   * NEO-236 — the belt-and-braces staging pass.
   *
   * `applyLookupResult` stages a player's career teams the moment its
   * enrichment lands, which is what puts the New Team steps AHEAD of the player
   * in the walk. This covers what that cannot reach: a batch whose lookups
   * landed before this shipped, and a row whose enrichment arrived by some
   * other route. On every ordinary row it is one idempotent call that inserts
   * nothing.
   *
   * Guarded by a REF keyed on the row id, not by a piece of state: the effect
   * re-runs whenever `rows` updates (which is often, reactively), and a state
   * flag would be read from a stale render closure exactly when two updates
   * land in one frame. One call per row per session is the bound.
   *
   * When it DID add steps, the wizard hands navigation back to its own rule —
   * `nextUndecided` holds a player whose staged teams are unanswered, so the
   * walk moves to the first of those instead of sitting on a player whose chips
   * all read "needs a team decision".
   */
  useEffect(() => {
    if (!current || current.kind !== "player") return;
    if (current.decision) return;
    if ((current.enrichment?.careerTeams?.length ?? 0) === 0) return;
    if (stagedPlayersRef.current.has(current._id)) return;
    stagedPlayersRef.current.add(current._id);
    void stageCareerTeams({ reviewRowId: current._id })
      .then((added) => {
        if (added === 0) return;
        // The same two lines `resumeWalking` runs — written out because that
        // helper is declared below this effect, and reaching forward to it is
        // the shape the lint rule (rightly) rejects.
        const next: NavState = { rowId: null, explicit: false };
        navRef.current = next;
        setNav(next);
      })
      .catch(() => {
        // The steps are missing, so the player's chips will say so and Confirm
        // will hold. Retrying on a schedule would be a client-driven write
        // loop; the operator's own "Change decision" is the way back.
      });
    // `stageCareerTeams` is stable for the life of the dialog and is
    // deliberately not a dep — including a `useMutation` result,
    // whose identity stability is the hook's business, would re-run this on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Closing the "Link to Existing" search whenever the presented row changes
  // so it doesn't stay open for the wrong row. Keyed on the row id, so it no
  // longer fires when a sibling row's lookup lands (NEO-221).
  //
  // NEO-248: the staged career teams are NOT cleared here any more. They are
  // keyed by row now, so there is nothing to reset — and clearing them was the
  // bug: the New Team step a hand-typed team stages is itself a row change, so
  // the wipe fired on the way to the very step the operator had just asked for.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closes the link-search when the wizard advances so it cannot stay open on the wrong row
    setLinkingOpen(false);
    setCareerEntryDirty(false);
    // NEO-236's `decideError` is gone: NEO-221's `rowError` supersedes it and
    // is already per-row — cleared at the top of `decide` and rendered only
    // when `rowError.rowId` is the presented row — so a refusal cannot follow
    // the operator onto the next name.
  }, [current?._id]);

  // Focus the final Save button as soon as it appears so Enter immediately
  // works, mirroring the old dialog's keyboard contract. This is the ONLY
  // Enter-to-confirm path now — see the removed dialog-level handler.
  useEffect(() => {
    if (allDecided) confirmButtonRef.current?.focus();
  }, [allDecided]);

  // See `dialogRootRef`'s own doc comment: both flags disable the button
  // that triggered them, natively, which otherwise strands focus on
  // `<body>` for the length of the round-trip.
  //
  // `cancelling && !confirming` on purpose: when `decided > 0`, `cancelling`
  // flips true from INSIDE the already-open `ConfirmDialog` (its own
  // "Discard" button), which already parks focus on ITS OWN container via
  // the identical pattern. Parking here too would fire in the same commit
  // and steal focus back out of the confirm dialog that is still on screen.
  // This branch is for the one case ConfirmDialog is never involved in: the
  // `decided === 0` immediate-cancel fast path.
  useEffect(() => {
    if ((cancelling && !confirming) || saving) dialogRootRef.current?.focus();
  }, [cancelling, confirming, saving]);

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
   *
   * ## A bulk already in flight must RE-ARM, never drop the round
   *
   * An earlier version returned early when `bulkRef.current` was set. A row
   * settling DURING an in-flight call therefore hit a closed door and nothing
   * rescheduled it: the footer sat on "Adding N more as their lookups finish…"
   * with no timer pending and no further call, forever. Two halves to the fix,
   * and both are needed — `bulkPending` is in the deps so the effect re-enters
   * when a call finishes, and `fire` re-arms the debounce rather than
   * returning when it finds one running.
   */
  useEffect(() => {
    if (!autoAddPending || !rows) return;
    /*
     * NEO-236 — PLAYERS only, and this is a convergence requirement rather
     * than a nicety.
     *
     * The bulk create no longer decides team rows (Jason: "it should only
     * apply to players"), so an armed loop that watched every undecided row
     * would sit forever on the New Team steps it is not allowed to touch:
     * `settled > 0` would stay true, every call would decide 0, and the cap
     * would be the only thing that eventually stopped it — after 400 pointless
     * mutations and an error message blaming the operator.
     */
    const undecided = rows.filter((r) => !r.decision && r.kind !== "team");
    if (undecided.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the arming is over because there is nothing left to add
      setAutoAddPending(false);
      return;
    }
    const settled = undecided.filter((r) => r.status !== "pending").length;
    // Everything left is still being looked up. Wait for the pool, do not poll
    // it: the next `rows` update re-enters this effect on its own.
    if (settled === 0) return;
    // NOT `|| bulkRef.current` — see the header. An in-flight call re-arms
    // below rather than swallowing this round.
    if (saving) return;
    if (autoAddCallsRef.current >= AUTO_ADD_MAX_CALLS) {
      autoAddRef.current = false;
      setAutoAddPending(false);
      setBulkError(
        `Stopped adding automatically after ${AUTO_ADD_MAX_CALLS} rounds. ${undecided.length} names are still waiting — use "Add All Remaining as New" again.`,
      );
      return;
    }

    // Function declarations, so `fire` can call `schedule` and vice versa
    // without either being read before it is initialised.
    function schedule() {
      if (autoAddTimerRef.current !== null) return;
      autoAddTimerRef.current = setTimeout(() => {
        autoAddTimerRef.current = null;
        fire();
      }, AUTO_ADD_DEBOUNCE_MS);
    }

    function fire() {
      if (!autoAddRef.current) return;
      /*
       * NEO-248 — never decide a row the operator is in the middle of.
       *
       * This is a TIMER, not a button. The operator can be halfway through a
       * career-team entry — a name typed with no year yet, a chip staged, a
       * link search open — when it fires, and the mutation it calls writes a
       * create decision on the row in front of them. Deferred rather than
       * dropped, exactly as an in-flight call is: the next tick re-checks, and
       * the wait ends when they finish the row.
       *
       * `pinnedRowHasEdits` is the same predicate the walk uses to decide it
       * may not move them off a row, which is the point — one answer to "is
       * there work on this row to lose", not two that can disagree.
       */
      if (pinnedEditsRef.current) {
        schedule();
        return;
      }
      // A call is already running. Come back after the debounce instead of
      // dropping this round on the floor — that is the stall.
      if (bulkRef.current) {
        schedule();
        return;
      }
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
    }

    if (settled >= AUTO_ADD_BATCH_THRESHOLD && !bulkRef.current) {
      if (autoAddTimerRef.current !== null) {
        clearTimeout(autoAddTimerRef.current);
        autoAddTimerRef.current = null;
      }
      fire();
      return;
    }
    // Otherwise debounce. `schedule` is a no-op when a call is already
    // pending, which is the "two rows 100ms apart make one call" case.
    schedule();
    // The mutation reference, `selectorOptionId` and `batchId` are deliberately
    // NOT deps. They are constant for the life of the dialog, and including a
    // `useMutation` result — whose identity stability is the hook's business,
    // not ours — would re-run this effect on every render, turning "issue one
    // more bulk create" into a loop the `bulkRef` guard only partly damps.
    // `bulkPending` IS a dep, deliberately: it is the only signal that an
    // in-flight bulk finished, and without it a row that settled during one
    // never gets a second look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAddPending, rows, saving, bulkPending]);

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
      /*
       * A DECISION UNPINS THE ROW.
       *
       * `resolveNav` holds an explicitly-presented row still even once it
       * carries a decision — that is what makes the read-only panel possible.
       * But deciding a row the operator navigated to on purpose (Back →
       * "Change decision" → "Add as New") is them finishing with it, so
       * leaving it pinned re-rendered the same row as "Already decided… /
       * Next" and, on the LAST row, kept `current` non-null so the final
       * summary never appeared while Confirm & Save sat autofocused behind it.
       *
       * Only for a "push" (a real decision) and only when this row is the
       * pinned one: a "drop" is `clearDecision`, which is precisely the case
       * that must STAY pinned so the operator lands on the row they reopened.
       */
      if (historyMode === "push" && navRef.current.explicit && navRef.current.rowId === rowId) {
        resumeWalking();
      }
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

  /**
   * NEO-236 — one create decision, built from whatever the current row's kind
   * actually needs.
   *
   * A TEAM row carries `create`: the Location, Name and League the commit
   * prelude builds the row from, and the ONLY thing it will build one from.
   *
   * A PLAYER row carries only its stints and its exclusions. The `createTeams`
   * list it used to carry is gone — every career team that needs creating has
   * a review row of its own now, and recording the answer in two places is how
   * the two end up disagreeing.
   *
   * `manualCareerTeams` carries FULL names, because that is what the prelude
   * looks up against `teams`.
   */
  const handleCreate = async (
    reviewRowId: Id<"entityReviewQueue">,
    payload: {
      manualCareerTeams?: CareerTeamDraft[];
      excludedCareerTeamNames?: string[];
      create?: {
        location?: string;
        name: string;
        leagueId?: Id<"leagues"> | null;
        leagueName?: string;
        // NEO-254 — see `teamCreateValidator`.
        yearsActive?: { from: number; to?: number };
      };
      // NEO-254 — league-kind only. See `NewLeagueForm`.
      createLeague?: {
        name: string;
        abbreviation?: string;
        level?: LeagueLevel;
        yearsActive?: { from: number; to?: number };
        aliases?: string[];
        wikidataId?: string;
      };
    } = {},
  ) =>
    decide(reviewRowId, () =>
      recordDecision({
        reviewRowId,
        action: "create",
        manualCareerTeams: payload.manualCareerTeams?.length
          ? payload.manualCareerTeams.map((ct) => ({
              name: teamFullName(ct),
              fromYear: ct.fromYear,
              ...(ct.toYear !== undefined ? { toYear: ct.toYear } : {}),
            }))
          : undefined,
        excludedCareerTeamNames: payload.excludedCareerTeamNames?.length
          ? payload.excludedCareerTeamNames
          : undefined,
        create: payload.create,
        createLeague: payload.createLeague,
      }),
    );
  const handleLink = async (
    reviewRowId: Id<"entityReviewQueue">,
    kind: "player" | "team" | "league",
    linkedId: Id<"players"> | Id<"teams"> | Id<"leagues">,
  ) =>
    decide(reviewRowId, () =>
      recordDecision({
        reviewRowId,
        action: "link",
        linkedPlayerId: kind === "player" ? (linkedId as Id<"players">) : undefined,
        linkedTeamId: kind === "team" ? (linkedId as Id<"teams">) : undefined,
        // NEO-254 — every team in the batch that named this league then uses
        // the linked row rather than creating anything.
        linkedLeagueId: kind === "league" ? (linkedId as Id<"leagues">) : undefined,
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
    // `decide` refuses while another write is in flight, and it refuses AFTER
    // this function has already moved `nav`. Moving first would pin the row
    // showing the decision the clear was meant to remove, with no clear ever
    // issued and nothing on screen saying so. Check the same guard first.
    if (decidingRef.current !== null) return;
    const next: NavState = { rowId, explicit: true };
    navRef.current = next;
    setNav(next);
    void decide(rowId, () => clearDecision({ reviewRowId: rowId }), "drop");
  };

  /**
   * NEO-236 — go to the step that answers a blocked career-team chip, ready to
   * be answered.
   *
   * An UNDECIDED step is simply presented. A step that already carries a
   * decision is one the operator SKIPPED — "not a team" — and the chip beside
   * it still says the stint has nowhere to land, so landing them on a read-only
   * "Already decided: Skipped" panel would be a second dead end. Clearing it
   * first is what they asked for by pressing a control called "Decide team":
   * the step comes up live, with its Location, Name and League ready to fill
   * in. That is the same gesture as the decided list's "Change".
   */
  const goToTeamStep = (rowId: Id<"entityReviewQueue">) => {
    const row = rows?.find((r) => r._id === rowId);
    if (row?.decision) {
      handleChangeDecision(rowId);
      return;
    }
    presentDecided(rowId);
  };

  /**
   * NEO-236 — `Decide team` for a label the batch holds no step for.
   *
   * Stages one, then the effect above pins it when the server's insert lands.
   * Idempotent server-side, so a double press cannot mint two steps.
   */
  const stageThenGoToTeamStep = (
    playerRowId: Id<"entityReviewQueue">,
    label: string,
  ) => {
    awaitingStageRef.current = normalizeEntityName(label);
    void stageCareerTeams({
      reviewRowId: playerRowId,
      careerTeamNames: [label],
    }).catch(() => {
      // Nothing was staged, so there is nothing to go to. The chip still says
      // the team needs a decision, which remains true — and unticking it is
      // still the other way out.
      awaitingStageRef.current = null;
    });
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
    // Inert while the auto-add is armed, matching the `aria-disabled` the
    // button renders: it is already doing exactly this, and a click between
    // rounds would just issue a duplicate.
    if (autoAddPending) return;
    // Rows still being looked up are excluded server-side, so arm the follow-up
    // rather than leaving the operator to click again for each straggler. The
    // cap counts per arming, so re-clicking after it trips is a fresh budget —
    // which is the point: a deliberate click is not a runaway loop.
    if (pendingBulkCreatable > 0) {
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

  const kindLabel = (kind: "player" | "team" | "league") =>
    kind === "player" ? "Player" : kind === "league" ? "League" : "Team";
  /** "not a person" / "not a team" — the skip control says what it is denying. */
  /*
   * NEO-254 — a league's third way out is NOT "not a league".
   *
   * On a player or team step, Skip means "this string is not an entity" and is
   * remembered per set in `entityReviewSkips` so the name never comes back. A
   * league step is a different question: the string IS a league, and skipping
   * says this TEAM has no league. That is an answer about the team, not a
   * judgement about the name, so it is worded as one and the commit does not
   * record it as a suppressed name (see the prelude's skip loop).
   */
  const notAWhat = (kind: "player" | "team" | "league") =>
    kind === "player" ? "person" : kind === "league" ? "league" : "team";
  const skipLabel = (kind: "player" | "team" | "league") =>
    kind === "league" ? "Skip — no league" : `Skip — not a ${notAWhat(kind)}`;

  /**
   * NEO-236 — the Location + Name pair for the current TEAM row.
   *
   * Reads the operator's edit when there is one and `teamCreatePrefill`
   * otherwise, so the pre-fill keeps tracking a late-arriving enrichment
   * lookup right up until the first keystroke.
   */
  const teamCreate: NewTeamDraft =
    current && current.kind === "team"
      ? (teamCreateByRow[current._id] ?? teamCreatePrefill(current))
      : { location: "", name: "", leagueId: undefined, leagueName: undefined };

  const patchTeamCreate = (rowId: string, patch: Partial<NewTeamDraft>) => {
    setTeamCreateByRow((prev) => ({
      ...prev,
      [rowId]: { ...(prev[rowId] ?? teamCreate), ...patch },
    }));
  };

  // NEO-254 — the league step's draft, read and written the same way.
  const leagueCreate: NewLeagueDraft =
    current && current.kind === "league"
      ? (leagueCreateByRow[current._id] ?? newLeaguePrefill(current))
      : {
          name: "",
          abbreviation: "",
          level: null,
          fromYear: "",
          toYear: "",
          aliases: "",
          wikidataId: "",
        };

  /**
   * NEO-254 — the row this staged step was raised FOR, by name.
   *
   * One derivation for both staged kinds: a team staged for a player reads
   * `source.playerRowId`, a league staged for a team reads `source.teamRowId`.
   * Undefined on a row that came off the checklist — that name was asked for
   * directly, and saying who needs it would answer a question nobody asked.
   */
  const neededByName: string | undefined = (() => {
    const source = current?.source;
    if (!source) return undefined;
    const parentId =
      source.kind === "careerTeamOf" ? source.playerRowId : source.teamRowId;
    return rows.find((r) => r._id === parentId)?.name ?? undefined;
  })();

  /**
   * NEO-254 — the leagues this batch has ANSWERED, by the name a team row
   * would refer to them by.
   *
   * Nothing is written until commit, so `api.leagues.list` cannot see a league
   * the New League step just created. Without this the team step went on
   * offering `Create National Hockey League` for a league already answered —
   * the exact defect the step exists to remove.
   *
   * Both names are contributed: the label the STEP was raised for (which is
   * what the team's `enrichment.league` and `create.leagueName` carry) and the
   * name the operator actually typed, which they are free to change.
   */
  const stagedLeagueNames: string[] = rows.flatMap((r) => {
    if (r.kind !== "league" || !r.decision) return [];
    if (r.decision.action === "create") {
      const typed = r.decision.createLeague?.name?.trim();
      return typed && typed !== r.name ? [r.name, typed] : [r.name];
    }
    if (r.decision.action === "link") return [r.name];
    // A skipped league is NOT staged: nothing will be created for it, and the
    // team step should keep offering its own answer.
    return [];
  });

  const patchLeagueCreate = (rowId: string, patch: Partial<NewLeagueDraft>) => {
    setLeagueCreateByRow((prev) => ({
      ...prev,
      [rowId]: { ...(prev[rowId] ?? leagueCreate), ...patch },
    }));
  };

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

  // ── NEO-236: what a create on this row would actually write ─────────────

  /** Every still-checked Wikidata proposal, deduped, in display order. */
  const acceptedCareerTeams = sortedCareerTeams
    .map((ct) => ct.name)
    .filter(
      (label, idx, all) =>
        all.indexOf(label) === idx && !excludedForCurrent.includes(label),
    );

  /**
   * Accepted proposals with no answer yet — no existing team, and no staged
   * step that has been decided. These are what Confirm waits on.
   */
  const unansweredCareerTeams = acceptedCareerTeams.filter(
    (label) => careerTeamStatus(label).kind === "waiting",
  );

  /**
   * Why the create action cannot fire yet, or null.
   *
   * A TEAM row: a blank name, or a composed one over the length cap. Both are
   * things the operator can fix where they are standing, and the server refuses
   * them independently — a stale bundle must not be able to get the write
   * through.
   *
   * A PLAYER row: a career team nobody has answered. NEO-236 moved that answer
   * out of this step and onto the team's own New Team step, so the fix is
   * elsewhere — either answer that step, or untick the chip. The message says
   * both, because "blocked" with no way forward is the worst state a walker can
   * be in. It is normally unreachable: `nextUndecided` holds a player back
   * until its staged teams are answered, so this fires only for a team decided
   * "skip" (which creates nothing) or a step the operator reopened.
   */
  const createBlocked: string | null = (() => {
    if (!current) return null;
    if (current.kind === "league") {
      // NEO-254 — the same bounds `convex/leagues.ts` refuses, checked while
      // the field is still in front of the operator. The server re-validates;
      // this is the fast half of defence in depth.
      return leagueDraftError(leagueCreate, new Date().getFullYear() + 1);
    }
    if (current.kind === "team") {
      if (!teamCreate.name.trim()) return "Enter a team name before adding it.";
      // Mirrors MAX_TEAM_FULL_NAME_LENGTH in convex/entityReviewQueue.ts,
      // which refuses the same composed name.
      const composed = draftFullName(teamCreate);
      if (composed.length > MAX_TEAM_FULL_NAME_LENGTH) {
        return `That name is ${composed.length} characters; the limit is ${MAX_TEAM_FULL_NAME_LENGTH}.`;
      }
      return null;
    }
    if (unansweredCareerTeams.length > 0) {
      return unansweredCareerTeams.length === 1
        ? `${unansweredCareerTeams[0]} still needs a team decision, or untick it.`
        : `${unansweredCareerTeams.length} career teams still need a team decision, or untick them.`;
    }
    return null;
  })();

  /**
   * NEO-236 — the step the footer's blocked line offers to jump to.
   *
   * The message said N teams need a decision and pointed nowhere. This is the
   * first one that actually has a step waiting, so the line can offer to go
   * there instead of leaving the operator to find it.
   */
  const blockingStep = createBlocked ? firstBlockingStep() : null;

  /**
   * The create decision this row would record, built once for both the primary
   * button and the demoted "…anyway" link.
   *
   * NEO-236: a PLAYER decision no longer carries `createTeams`. Every career
   * team that needs creating has a review row of its own, answered on its own
   * step, and the prelude builds the `teams` row from THAT decision before it
   * resolves this player's stints by name. Two places recording the same answer
   * is how they end up disagreeing; the server validator still accepts the old
   * shape so a batch mid-review across a deploy still commits.
   */
  const buildCreatePayload = () => {
    if (!current) return {};
    if (current.kind === "league") {
      // NEO-254 — the whole record, trimmed and shaped exactly as
      // `entityReviewQueue.leagueCreateValidator` expects. An empty field is
      // OMITTED rather than sent as "": absent means "not answered", which is
      // what lets `findOrCreateLeague`'s gap-fill leave an existing league's
      // value alone instead of clearing it.
      const from = leagueCreate.fromYear.trim();
      const to = leagueCreate.toYear.trim();
      const aliases = parseAliases(leagueCreate.aliases);
      const abbreviation = leagueCreate.abbreviation.trim();
      const wikidataId = leagueCreate.wikidataId.trim();
      return {
        createLeague: {
          name: leagueCreate.name.trim(),
          ...(abbreviation ? { abbreviation } : {}),
          ...(leagueCreate.level ? { level: leagueCreate.level } : {}),
          ...(from
            ? {
                yearsActive: {
                  from: Number(from),
                  ...(to ? { to: Number(to) } : {}),
                },
              }
            : {}),
          ...(aliases.length ? { aliases } : {}),
          ...(wikidataId ? { wikidataId } : {}),
        },
      };
    }
    if (current.kind === "team") {
      const location = teamCreate.location.trim();
      return {
        create: {
          name: teamCreate.name.trim(),
          ...(location ? { location } : {}),
          // `leagueId` is sent VERBATIM including null — null is the operator
          // saying "no league", and the server tells it apart from an omitted
          // key, which still lets its own fallbacks apply.
          ...(teamCreate.leagueId !== undefined
            ? { leagueId: teamCreate.leagueId }
            : {}),
          ...(teamCreate.leagueName ? { leagueName: teamCreate.leagueName } : {}),
          // NEO-254 — the era the operator typed. It is what tells the
          // 1972-1996 Winnipeg Jets from the 2011- ones, so a create that
          // dropped it would adopt whichever row the name already found. See
          // `teamCreateValidator`.
          ...(teamCreate.yearsActive
            ? { yearsActive: teamCreate.yearsActive }
            : {}),
        },
      };
    }
    return {
      manualCareerTeams: stagedCareerTeams,
      excludedCareerTeamNames: excludedForCurrent,
    };
  };

  /**
  /**
   * NEO-254 — Wikidata teams with no years, minus the ones the operator has
   * already dated on this row.
   *
   * Filtered against the staged chips because dating a lead moves it: it
   * becomes an ordinary staged career team, and leaving the bare name in this
   * list as well would read as two different teams — one with years, one
   * without — for the same club.
   */
  const undatedCareerTeams = (() => {
    if (!current || reviewingDecided || current.kind !== "player") return [];
    const staged = new Set(stagedCareerTeams.map((ct) => normalizeEntityName(ct.name)));
    return (current.enrichment?.undatedCareerTeams ?? []).filter(
      (name) => !staged.has(normalizeEntityName(name)),
    );
  })();

  const exactRows = (nearMatches ?? []).filter((m) => m.confidence === "exact");
  const exactMatch = exactRows[0] ?? null;

  /**
   * NEO-254 — the NB rows already filed under this exact name.
   *
   * Normally the server's own list (`players.buildExistingPlayerCandidates`,
   * attached when the row is enqueued and refreshed when its lookup lands),
   * which carries the birth year and career line that make the choice
   * possible. Present only when there are TWO OR MORE, so this is empty for
   * every ordinary name and the panel never renders.
   *
   * Not shown on a decided row: the read-only panel states the outcome, and a
   * list of link buttons under it would offer to re-decide something that
   * already has a "Change decision" control.
   *
   * ## The fallback, and why it is not "no panel"
   *
   * The stored list is missing on a row the completion backstop or the
   * stale-row sweep settled without ever reading `players`, and on any row
   * queued before this shipped. `nearMatches` still sees the truth — it reads
   * the exact key live — so when it returns more than one exact row, those
   * rows ARE the candidates and are used as such, minus the detail the server
   * would have supplied.
   *
   * Falling back to nothing was the tempting option and it is wrong twice
   * over. `NearMatchPanel` would render the list instead, and it labels an
   * exact row `Link to {name} — same name` — so two rows sharing a name get
   * two controls with byte-identical accessible names, on the one screen where
   * telling them apart is the entire task. `SameNamePlayerPanel` already
   * solves that (it folds a position into the label when a row has no
   * distinguishing fact), so the degraded path gets the component built for
   * the job rather than the one that cannot express it.
   */
  const storedSameNameCandidates =
    current && !reviewingDecided && current.kind === "player"
      ? (current.enrichment?.existingCandidates ?? [])
      : [];
  const sameNameCandidates =
    storedSameNameCandidates.length > 0
      ? storedSameNameCandidates
      : current && !reviewingDecided && current.kind === "player" && exactRows.length > 1
        ? exactRows.map((m) => ({
            playerId: m._id,
            name: m.name,
            // No birth year and no career: this path has only what the
            // near-match query returns. The panel renders "Nothing on file
            // yet" for them, which is honest — it is what we can see from
            // here, not a claim about the row.
            careerSummary: "",
          }))
        : [];
  /**
   * NEO-254 — did the server stop counting?
   *
   * `buildExistingPlayerCandidates` reads at most `PLAYER_AMBIGUITY_SCAN_LIMIT`
   * rows, so a stored list exactly that long means "at least this many", not
   * "this many". Saying so matters: a panel that silently shows eight of
   * eleven "John Smith"s invites the operator to conclude none of them is
   * right and create a twelfth, which is the failure this whole panel exists
   * to stop.
   *
   * Only ever true of the STORED list. The fallback above is bounded by
   * `players.nearMatches`' own limit, which is a different number and a
   * different question, and claiming the scan cap for it would be a guess.
   */
  const sameNameScanCapped =
    storedSameNameCandidates.length >= PLAYER_AMBIGUITY_SCAN_LIMIT;
  /**
   * NEO-254 — never promote one of several same-name rows to the primary
   * action.
   *
   * `showExactHierarchy` turns the main button into "Link to {name}" for the
   * one exact match. With two people on file under that name there is no "the"
   * exact match, and promoting whichever the ranking returned first is a
   * one-tap path to the wrong man. When `sameNameCandidates` is populated the
   * panel above lists every one of them instead, and the primary action goes
   * back to being "Add as New Player" — which is the honest default: if the
   * operator wanted one of ours, they have just been shown all of ours.
   *
   * ## Two conditions, because the stored marker can be missing
   *
   * `sameNameCandidates` comes off `enrichment`, which is written when the row
   * is enqueued and refreshed when its lookup lands. Neither happens for a row
   * the completion backstop or the stale-row sweep settled to "error", nor for
   * one that was already queued when this shipped. So the marker's absence is
   * NOT proof the name is unambiguous.
   *
   * `exactRows.length === 1` is the independent check, and it needs no stored
   * state at all: `players.nearMatches` reads the exact key live, so two exact
   * rows in its answer means two people share this name whatever `enrichment`
   * does or does not say. Either condition alone is enough to demote the
   * primary; both have to pass to promote it.
   */
  const showExactHierarchy = sameNameCandidates.length === 0 && exactRows.length === 1;
  const hasCloseOnly = !showExactHierarchy && (nearMatches?.length ?? 0) > 0;
  /**
   * What the panel is left to show once the primary action has been promoted.
   * The promoted row is filtered out by `_id`, so no two controls ever share
   * the accessible name `Link to {name}` — ambiguous to a screen reader and to
   * a Maestro `tapOn` alike. Any OTHER row is a genuinely different entity and
   * still belongs in the list, whatever its confidence.
   */
  const panelMatches = (() => {
    const base =
      showExactHierarchy && nearMatches
        ? nearMatches.filter((m) => m._id !== exactMatch._id)
        : nearMatches;
    if (sameNameCandidates.length === 0 || !base) return base;
    /**
     * NEO-254 — the same-name rows belong to ONE list.
     *
     * `players.nearMatches` returns every row on the exact key now, so without
     * this both panels would render a `Link to {name}` control for each of the
     * two Bob Allens: four buttons, two accessible names, and the operator
     * with no way to tell which pair is which. The same-name panel wins them
     * because it is the only one that shows a birth year and a career line —
     * the two things that make the choice possible. What is left here is what
     * this panel is actually for: names that are CLOSE but not identical.
     */
    const owned = new Set(sameNameCandidates.map((c) => c.playerId as string));
    return base.filter((m) => !owned.has(m._id));
  })();
  const remaining = total - decided;
  /**
   * NEO-236 — the two bulk buttons act on DIFFERENT sets, so they count
   * different things and their labels say which.
   *
   * `remainingPlayers` is what "Add remaining players as new" will decide:
   * Jason narrowed it to players, because a team row's own step is the only
   * place its League gets a human answer. `remainingNames` is every undecided
   * row, which is what "Skip remaining" still rules on — a skip creates
   * nothing, so there is no league to get wrong.
   */
  const remainingPlayers = countBulkCreatable(rows);
  const remainingNames = countUndecided(rows);
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

  /**
   * The footer's second row. Exactly one message, or none — see the JSX.
   *
   * The pending clause used to live inside the bulk button's own label, which
   * made a control's width a function of a count that ticks down. Here it is
   * just text, and the row it sits in has its height reserved whether it says
   * anything or not.
   */
  const footerStatus: string | null = expired
    ? null
    : autoAddPending
      ? `Adding ${remainingPlayers} more as their lookups finish…`
      : pendingUndecided > 0
        ? `${pendingUndecided} still looking up — wait or skip`
        : null;

  const summaryRows: Array<[string, number]> = [
    ["Cards to save", summary.cardCount],
    ["Cards to delete", summary.deleteCount],
    ["Cards with field updates", summary.reviewDecisionCount],
    ["New players and teams", outcome.created],
    ["Linked to existing", outcome.linked],
    ["Skipped as not a name", outcome.skipped],
  ];

  /**
   * ── The decision for the row on screen, rendered in the FIXED FOOTER ──────
   *
   * CI run 8 caught these at y=620-652 on the 1024x629 CI viewport — below the
   * footer and below the dialog — because they were the last elements of a
   * scrolling body whose content had grown (the Wikidata lines, the
   * Location/Name pair, and a league picker rendering every league in the
   * sport). Maestro cannot scroll an inner overflow box, and an operator should
   * never have to hunt for the button they have just decided to press.
   *
   * So the decision lives where NEO-110 already proved things must live when
   * they may not move. The row's CONTENT still scrolls — that is what a body is
   * for — but the decision about it does not.
   *
   * Null in every state with no live row: nothing presented, a row being
   * reviewed read-only (its own panel carries "Change decision" / "Next"), the
   * link sub-panel open (it owns the screen and its own Cancel), and an expired
   * batch. That is also what makes this mutually exclusive with "Confirm &
   * Save" — a presented row means not every row is decided.
   *
   * Every accessible name is unchanged from when these sat in the body:
   * `Add as New {Player|Team}`, `Link to Existing…`, `Skip … — not a …` and
   * `Back` are each an E2E contract and a screen reader's only handle.
   */
  const decisionControls =
    !expired && current && !reviewingDecided && !linkingOpen ? (
      /*
        a11y (SC 2.4.3 / 2.4.6 / 4.1.2) — NAMED, because the decision no longer
        sits under the heading it is about.

        In the body these controls were the next thing after
        `<h3>New Team: Sydney Blue Sox</h3>`, so "Add as New Team" needed no
        further context: a screen reader had just read the name. From the footer
        they are separated from that heading by the whole scrolling body, and a
        keyboard operator arriving by Tab (or a virtual cursor arriving from the
        bottom) hears "Add as New Team, button" with nothing saying WHICH name.
        The accessible names themselves are an E2E contract and must not move,
        so the row identity goes on the group instead — announced on entry,
        exactly like the read-only `Decision for {name}` panel this replaces
        when a decided row is being read back. The two are mutually exclusive by
        construction, so the shared phrasing can never be ambiguous.
      */
      <div
        role="group"
        aria-label={`Decision for ${current.name}`}
        className="flex flex-wrap items-center gap-3"
        aria-busy={busy}
      >
        {/*
          ONE primary button element, one JSX slot, both states.

          `nearMatches` resolves asynchronously while this row is on screen, so
          `showExactHierarchy` can flip UNDER a keyboard user who has already
          tabbed to the primary. A ternary that swaps WHICH element renders here
          unmounts the focused node and focus falls to <body> (WCAG 2.2 SC
          3.2.2 / 2.4.3). Label, handler and variant are props on a single
          element instead.

          NEO-221: `aria-disabled`, never native `disabled`. A disabled button
          leaves the tab order, so a keyboard operator who tabbed here would be
          thrown out of the footer for the length of a round-trip; NeonButton
          already paints aria-disabled the same way.
        */}
        <NeonButton
          secondary={!showExactHierarchy && hasCloseOnly}
          style={
            !showExactHierarchy && hasCloseOnly ? { color: "#000000" } : undefined
          }
          aria-disabled={
            busy || (createBlocked !== null && !(showExactHierarchy && exactMatch))
              ? true
              : undefined
          }
          aria-describedby={createBlocked ? createBlockedId : undefined}
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
                exactMatch._id as Id<"players"> | Id<"teams"> | Id<"leagues">,
              );
              return;
            }
            if (createBlocked) return;
            void handleCreate(current._id, buildCreatePayload());
          }}
        >
          {showExactHierarchy && exactMatch
            ? `Link to ${exactMatch.name}`
            : `Add as New ${kindLabel(current.kind)}`}
        </NeonButton>

        {/*
          Demoted to a text link when an exact match exists — and the visible
          text and the accessible name are THE SAME STRING (WCAG 2.2 SC 2.5.3).

          a11y (SC 2.5.8 Target Size) — `py-2 -my-2` on this and on the two
          links after it. A `text-xs` link with no vertical padding is exactly
          its 16px line-height tall, under the 24x24 minimum, and these are the
          row's decision ALTERNATIVES, not decoration. The negative margin gives
          the padding back to the layout, so the flex line stays 16px and the
          footer's height does not move — the same convention `Back` and `Stop`
          already use here.
        */}
        {showExactHierarchy && (
          <button
            type="button"
            aria-disabled={busy || createBlocked !== null ? true : undefined}
            aria-describedby={createBlocked ? createBlockedId : undefined}
            onClick={() => {
              if (busy) return;
              if (createBlocked) return;
              void handleCreate(current._id, buildCreatePayload());
            }}
            className="py-2 -my-2 text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
          >
            Add as New {kindLabel(current.kind)} anyway
          </button>
        )}

        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            setLinkingOpen(true);
          }}
          aria-label="Link to existing instead"
          className="py-2 -my-2 text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
        >
          Link to Existing…
        </button>

        {/*
          NEO-212: the third way out. "Checklist", "Team Card" and subset
          headers land in the player column constantly, and before this the
          operator's only options were to mint a junk row or cancel the batch.
        */}
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            void handleSkip(current._id);
          }}
          aria-label={
            current.kind === "league"
              ? `Skip ${current.name} — this team has no league`
              : `Skip ${current.name} — not a ${notAWhat(current.kind)}`
          }
          className="py-2 -my-2 text-xs text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none underline decoration-dotted aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
        >
          {skipLabel(current.kind)}
        </button>

        {backTargetId && (
          // a11y (2.5.8): p-2 -m-2 grows the tap target without moving the
          // visible text or its siblings in this row.
          <button
            type="button"
            onClick={() => presentDecided(backTargetId)}
            aria-label="Back to previous decision"
            className="p-2 -m-2 text-xs text-gray-400 hover:text-[#00B7FF] focus:text-[#00B7FF] focus:outline-none underline decoration-dotted"
          >
            Back
          </button>
        )}
      </div>
    ) : null;

  return createPortal(
    // See BaseSetPicker.tsx / SetAttributesPanel.tsx for why createPortal
    // needs a nested <Theme> — it escapes the root Theme's CSS scope.
    <Theme>
      <div
        className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="entity-review-wizard-title"
        ref={dialogRootRef}
        // Focusable only programmatically — see `dialogRootRef`'s own doc
        // comment for what lands here and why.
        tabIndex={-1}
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
                      {/* NEO-236, Jason's own words for this step: "1. New
                          Team: Sydney Blue Sox". The raw name, because that is
                          the thing being answered — the composed result is on
                          the "Shows as" line below, where it belongs. Only
                          while the step is live: a decided row is being read
                          back, not created. */}
                      {/* NEO-254: and the same for a league, one level up. */}
                      {!reviewingDecided && current.kind === "team"
                        ? `New Team: ${current.name}`
                        : !reviewingDecided && current.kind === "league"
                          ? `New League: ${current.name}`
                          : current.name}
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

                  {/* NEO-254 — FIRST, above everything Wikidata said.

                      When two NB rows already carry this name, the operator's
                      question is "which of ours is this?", and no amount of
                      Wikidata detail answers it: both rows are ours, both are
                      real, and the lookup only ever describes one person. So
                      the choice between them leads, and the source record
                      below becomes the tiebreaker rather than the subject. */}
                  <SameNamePlayerPanel
                    candidates={sameNameCandidates}
                    scanCapped={sameNameScanCapped}
                    disabled={busy}
                    onPick={(playerId) => {
                      if (busy) return;
                      void handleLink(
                        current._id,
                        "player",
                        playerId as Id<"players">,
                      );
                    }}
                  />

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
                              {sortedCareerTeams.map((ct, ctIdx) => {
                                const label = `${ct.name} (${ct.fromYear}–${
                                  ct.toYear ?? "present"
                                })`;
                                const status = careerTeamStatus(ct.name);
                                const excluded = excludedForCurrent.includes(ct.name);
                                // NEO-236 (a11y): exactly the condition the
                                // status line renders under, so the checkbox
                                // never points `aria-describedby` at an id that
                                // is not in the document.
                                const showStatus =
                                  !excluded && status.kind !== "checking";
                                const statusId = `${careerTeamStatusIdBase}-${ctIdx}`;
                                return (
                                  <li key={`${ct.name}-${ct.fromYear}`}>
                                    <label className="flex flex-wrap items-center gap-2">
                                      <input
                                        type="checkbox"
                                        checked={!excluded}
                                        aria-label={`Include career team ${ct.name}`}
                                        // NEO-236 (a11y): where this stint will
                                        // land is beside the box for a sighted
                                        // operator; this is how a screen-reader
                                        // operator gets the same fact, since
                                        // the explicit aria-label above
                                        // suppresses the wrapping label's text.
                                        aria-describedby={
                                          showStatus ? statusId : undefined
                                        }
                                        disabled={reviewingDecided}
                                        onChange={() =>
                                          toggleCareerTeam(current._id, ct.name)
                                        }
                                        className="accent-[#00D558]"
                                      />
                                      <span>{label}</span>
                                      {/*
                                        NEO-236 — where this stint will LAND.
                                        The inline Location/Name pair that used
                                        to sit here is gone: the team it was
                                        about has its own New Team step now,
                                        walked before this player, so this line
                                        reports the answer rather than asking
                                        for it a second time.

                                        Nothing is announced live — the header's
                                        progress line already owns `role=status`
                                        — and an unticked chip says nothing at
                                        all, because excluding it is the answer.
                                      */}
                                    </label>
                                    {/*
                                      NEO-236 — OUTSIDE the <label>, and that
                                      is a correctness fix rather than a
                                      layout one. `Decide team` is a button,
                                      and a button inside a label has its
                                      activation redirected to the labelled
                                      control by the browser — so pressing it
                                      toggled the career-team checkbox and
                                      navigated nowhere. Nesting an
                                      interactive control inside a label is
                                      invalid HTML for exactly this reason.

                                      The checkbox still points at this line
                                      with `aria-describedby`, which resolves
                                      document-wide and does not care that the
                                      two are now siblings.
                                    */}
                                    {showStatus &&
                                      (status.kind === "ambiguous" ? (
                                        /* NEO-254 — the name is not enough, and
                                           saying so beats painting one of two
                                           franchises as if we had chosen it.
                                           Not the pink "needs a decision"
                                           treatment: nothing is blocked, the
                                           commit resolves this stint by its own
                                           years, and the operator only has to
                                           act if those years are wrong. */
                                        <span
                                          id={statusId}
                                          className="text-xs text-gray-400"
                                        >
                                          {ct.name} · which era?
                                        </span>
                                      ) : status.kind === "waiting" ? (
                                        /* Not colour alone (SC 1.4.1): this
                                           says something different IN WORDS
                                           from the resolved case beside it,
                                           and #FF2EB3 on the gray-900 panel
                                           is 5.32:1 (SC 1.4.3). */
                                        <span
                                          id={statusId}
                                          className="inline-flex items-center gap-2 text-xs text-[#FF2EB3]"
                                        >
                                          needs a team decision
                                          {/*
                                            NEO-236 — the way OUT of the dead
                                            end. The message named a problem
                                            and pointed nowhere: "There does
                                            not appear to be anywhere that a
                                            decision is needed that I can
                                            see." This goes to the step that
                                            answers it; answering that step
                                            hands navigation back, so the
                                            operator lands on the next one or
                                            back here.

                                            Rendered only when a step exists —
                                            a jump to nothing would be the
                                            same dead end with a button on it.

                                            SC 2.5.3: the accessible name
                                            CONTAINS the visible text, so a
                                            voice-control user saying "decide
                                            team" matches it.
                                          */}
                                          {/* Always offered now: when the
                                              batch holds no step for this
                                              label (staging caps at 64 per
                                              player, and skips a name too long
                                              to compose), pressing it stages
                                              one and then goes there. */}
                                          {(
                                            <button
                                              type="button"
                                              aria-label={`Decide team ${ct.name}`}
                                              onClick={() =>
                                                status.stagedRowId
                                                  ? goToTeamStep(status.stagedRowId)
                                                  : stageThenGoToTeamStep(
                                                      current._id,
                                                      ct.name,
                                                    )
                                              }
                                              className="py-2 -my-2 text-[#00B7FF] underline decoration-dotted hover:text-[#00D558] focus-visible:text-[#00D558] focus:outline-none"
                                            >
                                              Decide team
                                            </button>
                                          )}
                                        </span>
                                      ) : (
                                        <span
                                          id={statusId}
                                          className="text-xs text-gray-400"
                                        >
                                          {/*
                                            NEO-236 — the team, and nothing
                                            about its bookkeeping.

                                            This carried "(new team, not saved
                                            yet)" for a team the batch was
                                            creating. Jason: "'not saved yet'
                                            is equally confusing. Do we need
                                            anything there at all?" No — an
                                            ANSWERED stint reads the same
                                            whether the team already existed or
                                            this review will create it, because
                                            there is nothing for the operator to
                                            do about the difference. Only the
                                            states that still need an action
                                            keep their words: "needs a team
                                            decision" and its "Decide team".
                                          */}
                                          → {status.name}
                                        </span>
                                      ))}
                                  </li>
                                );
                              })}
                            </ul>
                            </div>
                          </>
                        ) : (
                          <p>No career-team history found.</p>
                        )}
                        {/* NEO-254 — under the dated list, because these are
                            not career data yet. See UndatedCareerTeams. */}
                        <UndatedCareerTeams
                          // NEO-254: keyed by the ROW, so stepping to another
                          // name remounts it. Its open form and half-typed
                          // years are state about one player; carried across a
                          // row change they would offer to date the previous
                          // player's team on this one's record.
                          key={current._id}
                          names={undatedCareerTeams}
                          disabled={busy}
                          onAdd={(entry) =>
                            setStagedCareerTeams((prev) => [...prev, entry])
                          }
                        />
                      </>
                    ) : (
                      <>
                        {current.enrichment.league && <p>League: {current.enrichment.league}</p>}
                        {current.enrichment.location && (
                          <p>Location: {current.enrichment.location}</p>
                        )}
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
                      {/* a11y (2.5.8): p-2 -m-2 grows the tap target to
                          ~24x24 without shifting the visible text — the same
                          convention as TrackingCode's Copy button. */}
                      <button
                        type="button"
                        onClick={resumeWalking}
                        className="p-2 -m-2 text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted"
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
                        /* NEO-254 — a team's era goes INTO its label.
                           
                           Team identity is now (name, sport, era), so this
                           panel can be handed two rows both called "Winnipeg
                           Jets". Without the era they render as two identical
                           buttons with two identical accessible names, and the
                           operator picks one at random — which is the defect
                           the era exists to fix, moved from the server to the
                           screen. Players get the same treatment through
                           `SameNamePlayerPanel`; leagues have no such
                           collision and keep the default. */
                        {...(current.kind === "team"
                          ? {
                              pickLabel: (name: string, match: NearMatch) =>
                                `Link to ${teamOptionLabel(name, match.yearsActive)}`,
                            }
                          : {})}
                        onPick={(id) => {
                          if (busy) return;
                          void handleLink(
                            current._id,
                            current.kind,
                            id as Id<"players"> | Id<"teams"> | Id<"leagues">,
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
                        {/*
                          ── NEO-236: the New Team step ────────────────────────

                          Jason, 2026-09-05: "How does this dialog know which
                          League the new team is in? I think we need to show a
                          new team dialog instead of that inline thing." So the
                          create action means "store what this form says" —
                          Location, Name and League — and the checklist string
                          ("SD PADRES", "Padres  ") is only ever the start.

                          The same `NewTeamForm` the pickers open in a modal, so
                          the two surfaces cannot disagree about what a team is
                          made of. Rendered for BOTH near-match states: when an
                          exact match exists the primary becomes "Link to …" and
                          creating survives as the "…anyway" link, which still
                          needs somewhere to read its fields from.
                        */}
                        {current.kind === "team" && (
                          <NewTeamForm
                            sportId={current.sportId}
                            draft={teamCreate}
                            onChange={(patch) => {
                              patchTeamCreate(current._id, patch);
                              /*
                               * A typed league is a commitment, so it raises
                               * its step the moment it is made rather than at
                               * Confirm. Fire-and-forget: staging is
                               * idempotent and never blocks the form, and a
                               * failure leaves the team's own answer intact —
                               * the commit still resolves the name, it just
                               * does not get the fuller record.
                               */
                              if (patch.leagueName?.trim()) {
                                void stageLeagueRows({
                                  reviewRowId: current._id,
                                  leagueName: patch.leagueName,
                                }).catch(() => {});
                              }
                            }}
                            leagueSuggestion={current.enrichment?.league}
                            stagedLeagueNames={stagedLeagueNames}
                            /* NEO-254 — a league the operator names here gets a
                               step of its own, walked next (leagues come before
                               teams), and this team comes back with the pill
                               reading "<name> (new)" and selected. */
                            onStageLeague={async (name) => {
                              const staged = await stageLeagueRows({
                                reviewRowId: current._id,
                                leagueName: name,
                              });
                              if (staged.outcome === "existing") {
                                return {
                                  kind: "existing" as const,
                                  leagueId: staged.leagueId!,
                                  name: staged.name,
                                };
                              }
                              if (staged.outcome === "over-cap") {
                                return { kind: "over-cap" as const };
                              }
                              return { kind: "staged" as const, name: staged.name };
                            }}
                            /* Reuses the per-row line NEO-221 already renders
                               under the step, so a league message lands where
                               every other per-row message does. */
                            onLeagueStatus={(status) =>
                              setRowError(
                                status.isError
                                  ? { rowId: current._id, message: status.text }
                                  : null,
                              )
                            }
                            /* Only on a row the batch staged for itself: a
                               checklist team was asked for directly, and saying
                               who needs it would be answering a question nobody
                               asked. */
                            neededBy={neededByName}
                            describedBy={
                              createBlocked ? createBlockedId : undefined
                            }
                            locationFieldId={TEAM_LOCATION_FIELD_ID}
                            nameFieldId={TEAM_NAME_FIELD_ID}
                            leagueGroupId={TEAM_LEAGUE_FIELD_ID}
                          />
                        )}

                        {current.kind === "league" && (
                          /* NEO-254 — the New League step, in exactly the place
                             the New Team step occupies, so the two read as one
                             family. Its own module explains the two-tier layout
                             (the dialog body cannot hold seven stacked fields on
                             CI's 1024x629 viewport) and why Level is toggle
                             buttons rather than a radiogroup. */
                          <NewLeagueForm
                            /* Keyed by row: `detailsOpen` is local state, and
                               without this the disclosure an operator opened on
                               one league would stay open on the next — whose
                               prefill may be complete and want it shut. */
                            key={current._id}
                            draft={leagueCreate}
                            onChange={(patch) =>
                              patchLeagueCreate(current._id, patch)
                            }
                            neededBy={neededByName}
                            describedBy={
                              createBlocked ? createBlockedId : undefined
                            }
                            nameFieldId={LEAGUE_NAME_FIELD_ID}
                            levelGroupId={LEAGUE_LEVEL_FIELD_ID}
                            disabled={busy}
                          />
                        )}

                        {current.kind === "player" && (
                          <div className="space-y-1.5">
                            <p className="text-sm text-gray-400">
                              Add career team history manually
                              {/* gray-400, not gray-500: 3.67:1 on the gray-900
                                  panel fails SC 1.4.3. */}
                              <span className="text-gray-400"> (optional)</span>:
                            </p>
                            {stagedCareerTeams.length > 0 && (
                              <ul className="flex flex-wrap gap-1.5" aria-label="Staged career teams">
                                {stagedCareerTeams.map((ct, idx) => (
                                  <li key={`${ct.name}-${ct.fromYear}-${idx}`}>
                                    <span className="inline-flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-xs text-gray-200">
                                      {/* NEO-236: the composed name, so the
                                          chip reads as the team that will be
                                          created rather than as its nickname. */}
                                      {teamFullName(ct)} ({ct.fromYear}
                                      {ct.toYear ? `–${ct.toYear}` : "–present"})
                                      <button
                                        type="button"
                                        aria-label={`Remove ${teamFullName(ct)}`}
                                        onClick={() => {
                                          setStagedCareerTeams((prev) =>
                                            prev.filter((_, i) => i !== idx),
                                          );
                                          /*
                                           * NEO-248 — and forget the years on
                                           * the server too.
                                           *
                                           * The keyed list dies with the
                                           * component (the wizard is rendered
                                           * conditionally), and the rebuild
                                           * reads the stint straight back off
                                           * the staged step — so a removal
                                           * that lived only here came undone
                                           * on the next open and carried the
                                           * stint into the player's timeline.
                                           *
                                           * Only the STINT is cleared; the New
                                           * Team step stays. Another player in
                                           * the batch may need that club, and
                                           * its lookup has already run.
                                           */
                                          const key = normalizeEntityName(
                                            teamFullName(ct),
                                          );
                                          const step = (rows ?? []).find(
                                            (r) =>
                                              r.source?.kind === "careerTeamOf" &&
                                              r.source.playerRowId === current._id &&
                                              r.source.manualStint !== undefined &&
                                              normalizeEntityName(r.name) === key,
                                          );
                                          if (!step) return;
                                          void clearCareerTeamStint({
                                            reviewRowId: current._id,
                                            teamRowId: step._id,
                                          }).catch(() => {
                                            // The chip is gone from this
                                            // session either way. A failure
                                            // means it can come back on the
                                            // next open — which is exactly the
                                            // state before this call existed,
                                            // and removing it again is the way
                                            // out. Nothing to say here that
                                            // the chip does not already say.
                                          });
                                        }}
                                        // gray-400, not gray-500 (SC 1.4.3: 3.04:1 on
                                        // the gray-800 chip), and a real focus
                                        // ring rather than a colour swap behind
                                        // `focus:outline-none` (SC 2.4.7).
                                        className="text-gray-400 hover:text-[#FF2EB3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-1 focus-visible:ring-offset-gray-800 rounded"
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
                              onDirtyChange={setCareerEntryDirty}
                              onAdd={(entry) => {
                                setStagedCareerTeams((prev) => [...prev, entry]);
                                // NEO-236 — a hand-typed team that matches
                                // nothing gets its own New Team step, exactly
                                // as a Wikidata proposal does. Idempotent
                                // server-side, and it inserts nothing at all
                                // when the name already resolves to a team, so
                                // typing an existing name is still a link.
                                //
                                // NEO-248 — the YEARS go with it. Staging this
                                // step is what moves the walk off this row, so
                                // the years have to be somewhere other than
                                // this component before that happens; the step
                                // carries them on `source.manualStint` and the
                                // chip is rebuilt from there.
                                void stageCareerTeams({
                                  reviewRowId: current._id,
                                  careerTeams: [
                                    {
                                      name: entry.name,
                                      fromYear: entry.fromYear,
                                      ...(entry.toYear !== undefined
                                        ? { toYear: entry.toYear }
                                        : {}),
                                    },
                                  ],
                                }).catch(() => {
                                  // The chip is already staged locally and the
                                  // stint will still be recorded; what is lost
                                  // is the step that would have created the
                                  // team, which `careerTeamStatus` then reports
                                  // as "needs a team decision". Nothing to say
                                  // here that the chip does not already say.
                                });
                              }}
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
                        // a11y (2.5.8): p-2 -m-2 grows the tap target without
                        // moving the visible text — same convention as
                        // TrackingCode's Copy button.
                        <button
                          type="button"
                          onClick={() => {
                            onDismissCommitError();
                            if (backTargetId) presentDecided(backTargetId);
                          }}
                          className="p-2 -m-2 text-xs text-gray-400 hover:text-[#00B7FF] focus:text-[#00B7FF] focus:outline-none underline decoration-dotted"
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
                {/* gray-400, not gray-500 (SC 1.4.3): gray-500 on this
                    dialog's gray-900 ground measures 3.67:1, under the 4.5:1
                    floor. gray-400 is 6.99:1. */}
                <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-300 focus:text-gray-300 focus:outline-none">
                  Decided ({decidedRows.length})
                </summary>
                <ul aria-label="Decided names" className="mt-2 space-y-1">
                  {decidedRows.map((row) => (
                    <li
                      key={row._id}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                    >
                      <span className="text-gray-200">{row.name}</span>
                      {/* Same 1.4.3 correction: this line states what the
                          batch will DO with the name beside it, so it is
                          content rather than decoration. */}
                      <span className="text-gray-400">
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
                        // a11y (2.5.8): py-1 gets this to 24px tall (16px
                        // text-xs line-height + 2×4px). Only horizontal
                        // margin is cancelled (-mx-1) — the vertical padding
                        // is left to grow the row itself rather than
                        // overlapping the list's `space-y-1` gap between
                        // adjacent "Decided" rows.
                        className="py-1 px-1 -mx-1 text-gray-400 hover:text-[#00B7FF] focus:text-[#00B7FF] focus:outline-none underline decoration-dotted aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                      >
                        Change
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {/*
            THE FOOTER IS TWO FIXED ROWS, and the split is the whole point.

            Row 1 is what the OPERATOR can do; row 2 is what the WIZARD is
            doing about it. They were one row, with the machine's sentence
            appended to the operator's button — "Add All Remaining as New (433)
            — 229 still looking up, wait or skip". On a real set (1990 Bowman:
            433 unknowns, 229 pending) that label wrapped to two centred lines,
            dragged "Skip Remaining (433)" onto a second line with it, and left
            both sitting crookedly beside the buttons.

            Wrapping is not just ugly here, it is the NEO-110 reflow class
            again at a smaller scale: a label whose length tracks a COUNT THAT
            CHANGES is a control whose height changes under the operator's
            cursor, and a Maestro tap read at one height and clicked at
            another. So the variable-length sentence moves to its own row,
            which is rendered ALWAYS — empty or not — with its height reserved,
            and row 1 is `whitespace-nowrap`. Neither row can push the other.
          */}
          <div className="px-6 py-4 border-t border-gray-700 shrink-0 space-y-2">
            {/*
              ROW 1 — actions. The right group never yields (`shrink-0`); the
              left group is `min-w-0 overflow-hidden` so a genuine overflow
              clips rather than wraps. The widest pair CAN coexist —
              "Back to matching" + "Cancel (Esc)" beside both bulk links — but
              "Confirm & Save" and the bulk links never do: the links render
              only while `!allDecided`, and the confirm only once `allDecided`.
            */}
            <div
              /*
               * NEO-110, audit finding — ROW 1 IS RESERVED FOR TWO LINES.
               *
               * Its left group wraps, and it wraps MID-SESSION: when
               * `nearMatches` resolves with an exact hit, the primary's label
               * grows from "Add as New Team" to "Link to {name}" AND the
               * "…anyway" link appears in the same commit, pushing the group to
               * a second line. A taller row 1 makes the footer taller and the
               * body shorter, which moves the very button this whole change
               * exists to pin down — the NEO-110 hazard, arriving from a new
               * direction.
               *
               * So the space is reserved whether it is used or not. It costs
               * ~32px of body height permanently, which is a trade worth making
               * twice over: the body just got ~226px BACK from bounding the
               * league picker, and a reserved gap cannot move under a cursor.
               */
              className="flex min-h-[4.25rem] items-center justify-between gap-4"
            >
            {/*
              ROW 1 LEFT — THE DECISION FOR THE ROW ON SCREEN.
              These used to be the last elements of the scrolling body, which is
              how CI run 8 caught them at y=620-652 on a 1024x629 viewport:
              below the footer and below the dialog itself. Maestro cannot
              scroll an inner overflow box, and an operator should never have to
              hunt for the button they have just decided to press.

              So the primary action lives where NEO-110 already proved things
              must live when they may not move — the fixed footer. The row's
              CONTENT still scrolls (that is what a body is for); the decision
              about it does not.

              Mutually exclusive with "Confirm & Save" on the right by
              construction: a presented row means not every row is decided.
            */}
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              {decisionControls}
            </div>
            {/* The buttons never yield: if row 1 is ever too narrow, the bulk
                links clip, not the way out of the dialog. */}
            <div className="flex shrink-0 items-center gap-3">
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
                    /* The sibling that used to win the XPath race against
                       Confirm & Save. Its own marker class is what stops the
                       two collapsing into one XPath — see `footerFieldClass`. */
                    className={footerFieldClass("btn-cancel-review")}
                    aria-label={CANCEL_REVIEW_LABEL}
                    onClick={requestClose}
                    disabled={cancelling || saving}
                  >
                    Cancel (Esc)
                  </NeonButton>
                  {allDecided && !commitError && (
                    <NeonButton
                      ref={confirmButtonRef}
                      /*
                       * A UNIQUE MARKER CLASS, and it is load-bearing for E2E.
                       *
                       * This button used to carry `id="entity-review-confirm-save"`
                       * for exactly this reason. NEO-260 retired it: a DOM id is
                       * invisible to a sighted user and to a screen reader
                       * alike, and Maestro's `resource-id` is
                       * `node.id || node.ariaLabel`, so an id also SHADOWS the
                       * accessible name. The class does the same job for the
                       * XPath re-find without either cost — the full mechanism
                       * is on `footerFieldClass` above. No flow ever selected
                       * on the id; they target `text: ".*Confirm & Save.*"`.
                       */
                      className={footerFieldClass("btn-confirm-save")}
                      aria-label={saving ? CONFIRM_SAVING_LABEL : CONFIRM_SAVE_LABEL}
                      onClick={onConfirm}
                      disabled={saving}
                      /*
                       * THE BUTTON HANDLES ITS OWN ENTER, and this is not
                       * belt-and-braces around native activation — it is the
                       * only thing that makes the label true for the driver
                       * that reads it.
                       *
                       * A focused <button> is activated by Enter through the
                       * browser's DEFAULT ACTION on the keydown. A SYNTHETIC
                       * KeyboardEvent has no default action: `dispatchEvent`
                       * runs the listeners and stops. maestro-web's
                       * `pressKey: Enter` is exactly that — a constructed
                       * KeyboardEvent dispatched at `document.activeElement`
                       * — so it fires React onKeyDown handlers and never
                       * clicks anything. Every other flow in the suite that
                       * presses Enter aims it at an input whose onKeyDown does
                       * the work; this button was the one control relying on
                       * activation the driver cannot produce. It only ever
                       * worked because the dialog ROOT used to commit on Enter
                       * from any non-input target — the same handler that made
                       * Enter on the focused Cancel button both save and
                       * cancel (NEO-220 D5), so it could not simply stay.
                       *
                       * Scoped to this element, so Enter still does only what
                       * the focused control does. `preventDefault` keeps a
                       * REAL keypress from also firing the native click and
                       * committing twice.
                       */
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || saving) return;
                        e.preventDefault();
                        onConfirm();
                      }}
                    >
                      {saving ? "Saving..." : "Confirm & Save (Enter)"}
                    </NeonButton>
                  )}
                </>
              )}
            </div>
            </div>

            {/*
              ROW 2 — reserved, always rendered, even with nothing to say.
              `min-h-4` is one `text-xs` line, so the footer's height is the
              same on the first paint as on the last and row 1 never moves.
              One live region, because these messages are alternatives rather
              than a stack: the operator is either waiting on lookups or
              watching them be added, never both.
            */}
            <div className="flex min-h-6 items-center gap-3">
              {/*
                The live region is its OWN element and holds only text. The bulk
                links sit beside it, deliberately outside it: a button inside a
                live region is re-announced every time the count next to it
                ticks, which turns a drain into a stream of interruptions.

                `flex-1 min-w-0 truncate` — this is the variable-length half, so
                it is the half that gives way. Row 2 has always been where
                length lives (NEO-110); the bulk links moved here from row 1 for
                exactly that reason, their labels carrying counts that change as
                the batch drains.
              */}
              {/*
                NEO-236 — why the create cannot fire, beside the control it is
                about. Deliberately NOT `role="alert"` and deliberately OUTSIDE
                the live region below: this is a standing precondition the
                operator can read at any time, not an event (a refusal that
                already HAPPENED lands in `rowError`, up in the body with the
                row it belongs to). The create controls point at it by id.
              */}
              {createBlocked && (
                <p
                  /* `text-xs` restored: the row-2 rewrite moved it off the
                     wrapper and it was never put back on the message. Without
                     it this inherits Radix's 16px body size, which is not the
                     `text-xs` line `min-h-6` reserves the footer's height
                     for. */
                  className="flex min-w-0 flex-1 items-center gap-2 text-xs text-[#FF2EB3]"
                >
                  {/*
                    The id sits on the TEXT, not on this flex wrapper: the
                    create controls point at it with `aria-describedby`, and a
                    description should be the reason alone — not the reason
                    plus the label of the button beside it. The message
                    truncates; the way out of it does not.
                  */}
                  <span id={createBlockedId} className="min-w-0 truncate">
                    {createBlocked}
                  </span>
                  {/* NEO-236 — the same route as the blocked chip's, for the
                      operator reading the footer rather than the list. Goes to
                      the FIRST step still waiting. */}
                  {blockingStep && (
                    <button
                      type="button"
                      aria-label={`Decide team ${blockingStep.name}`}
                      onClick={() => goToTeamStep(blockingStep.rowId)}
                      className="shrink-0 py-2 -my-2 text-[#00B7FF] underline decoration-dotted hover:text-[#00D558] focus-visible:text-[#00D558] focus:outline-none"
                    >
                      Decide team
                    </button>
                  )}
                </p>
              )}
              {/*
                Always mounted, even with nothing to say: a live region that
                unmounts between messages announces unreliably.
              */}
              <p
                /* `text-xs text-gray-400` restored — see the blocked-reason
                   note above. Inherited, this was Radix's `--gray-12` at 16px:
                   not a contrast failure, but not the muted status line the
                   footer's reserved height is measured against either. */
                className={`min-w-0 truncate text-xs text-gray-400 ${
                  createBlocked ? "shrink-0" : "flex-1"
                }`}
                role="status"
                aria-live="polite"
              >
                {footerStatus}
              </p>
              {footerStatus !== null && autoAddPending && (
                // a11y (2.5.8): p-2 -m-2 grows the target past 24px without
                // moving the text or the row's reserved height.
                <button
                  type="button"
                  onClick={() => {
                    autoAddRef.current = false;
                    setAutoAddPending(false);
                  }}
                  className="shrink-0 p-2 -m-2 text-xs text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none underline decoration-dotted"
                >
                  Stop
                </button>
              )}
              {/*
                The bulk links stay MOUNTED while the auto-add is armed rather
                than being swapped out — nothing here may vanish mid-session.
                `aria-disabled` and not `disabled`, for the same reason as the
                per-row decision controls: a keyboard operator who has tabbed
                here must not be ejected from the footer.

                Only the CREATE link goes inert. "Skip remaining names" stays
                live on purpose — the status beside it says "wait or skip", and
                taking the skip away while it says so would be advertising an
                exit and locking it.

                No aria-label on either: the visible text IS the accessible
                name, and Maestro matches `.*Add remaining players as new.*`.
              */}
              {!expired && !allDecided && remainingNames > 0 && (
                <div
                  /*
                   * a11y (SC 3.3.1), audit finding: the bulk links yield to the
                   * BLOCKED REASON, and only to that.
                   *
                   * They are `shrink-0 whitespace-nowrap` normally, and the
                   * status line beside them is what gives way — that is row 2's
                   * standing rule. But the two links measure ~384px of a 624px
                   * row, so with a reason showing as well the reason was
                   * squeezed to nothing: an inert primary button whose reason
                   * was invisible to a sighted operator while remaining
                   * perfectly correct for a screen reader.
                   *
                   * A reason is transient and rare; the links are permanent.
                   * So while one is up the links become truncatable and the
                   * reason takes the width. Nothing moves vertically either
                   * way, which is what row 1 is protected by.
                   */
                  className={`flex items-center gap-3 whitespace-nowrap ${
                    createBlocked ? "min-w-0 overflow-hidden" : "shrink-0"
                  }`}
                >
                  <button
                    type="button"
                    onClick={handleBulkCreate}
                    disabled={bulkPending !== null || saving}
                    aria-disabled={autoAddPending}
                    // a11y (SC 2.5.8): `py-2 -my-2`, the same convention as
                    // `Stop` beside them — a 32px hit area out of a 16px
                    // `text-xs` line, given back to the layout so row 2's
                    // height is the same whether these are mounted or not.
                    className="py-2 -my-2 text-xs text-gray-400 hover:text-[#00D558] focus:text-[#00D558] focus:outline-none underline decoration-dotted disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                  >
                    {bulkPending === "create"
                      ? "Adding players…"
                      : `Add remaining players as new (${remainingPlayers})`}
                  </button>
                  <button
                    type="button"
                    onClick={handleBulkSkip}
                    disabled={bulkPending !== null || saving}
                    className="py-2 -my-2 text-xs text-gray-400 hover:text-[#FF2EB3] focus:text-[#FF2EB3] focus:outline-none underline decoration-dotted disabled:opacity-50"
                  >
                    {bulkPending === "skip"
                      ? "Skipping names…"
                      : `Skip remaining names (${remainingNames})`}
                  </button>
                </div>
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
