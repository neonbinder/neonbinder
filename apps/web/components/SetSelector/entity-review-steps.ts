/**
 * NEO-335 — "Step x of y" for the tidy-up wizard. Pure: no React, no Convex.
 *
 * Jason, 2026-10-10: ONE counter that sums every screen the operator should
 * expect, no per-type counts. The sitting is a list of steps:
 *
 *     y = review rows                  (one per name: New league / New team /
 *                                       New player / "Which player is this?",
 *                                       staged career New Team/League steps
 *                                       included — they are rows too)
 *       + 1 teams step                 (if any card would save teamless)
 *       + 1 autograph step             (NEO-345: a NEW card carries AU and the
 *                                       leaf has no autograph format yet)
 *       + 1 titles step                (if any card title needs a look)
 *       + 1 save step
 *
 * ## The rules y lives by (C6, D6, D9)
 *
 * - **It never shrinks during a sitting.** A step the operator was promised
 *   stays counted. Every input is a high-water mark: review rows by count,
 *   the teams and titles steps once present. A counted step that turns out to
 *   have nothing in it is passed over, so x jumps; it never goes backwards.
 * - **It grows only on an operator decision or a staged career step.** The
 *   teams step is judged OPTIMISTICALLY while names are still being reviewed
 *   (`cardsForTeamsStep`): an undecided team name is assumed to resolve, so
 *   the step appears up front for cards that print no team at all, and later
 *   only when the operator rules a team name out. New review rows only ever
 *   arrive by staging (a player's career teams, a typed league).
 * - **Growth is announced**, politely: "2 more steps: teams for Jim Thome".
 * - **Nothing is added while the operator is on Save.** The count freezes
 *   there; anything that turns up after is the post-save walker's to catch.
 */
import { isAmbiguousPlayerRow, type NavRow } from "./entity-review-nav";
import {
  AUTOGRAPH_FORMATS,
  carriesAutographToken,
  isAutographFormat,
  type AutographFormat,
} from "../../convex/features/deriveCardFeatures";
import {
  teamlessCardIndexes,
  type PreviewCardForTeams,
  type StoredPeople,
  type TeamsReviewRow,
} from "./teams-on-cards";

/** Every kind of screen the counter counts. */
export type WizardStepKind =
  | "league"
  | "team"
  | "player"
  | "pick"
  | "teams"
  | "autograph"
  | "titles"
  | "save";

/**
 * The subtitle under "Tidy up this set", per screen type. Jason-approved copy,
 * except `autograph` (NEO-345), which is a placeholder awaiting his wording.
 */
export const STEP_SUBTITLE: Readonly<Record<WizardStepKind, string>> = {
  league: "New league",
  team: "New team",
  player: "New player",
  pick: "Which player is this?",
  teams: "Cards with no team",
  autograph: "Autographed cards",
  titles: "Card titles",
  save: "Ready to save",
};

/**
 * The steps after the names, in the order the wizard walks them. The
 * autograph step sits before titles because a title reads `autographed`.
 */
export type PostReviewStep = "teams" | "autograph" | "titles" | "save";

/** Which post-review steps have anything in them right now. */
export type PostReviewLive = {
  teams: boolean;
  /** NEO-345 — absent reads as false (a host with no autograph step). */
  autograph?: boolean;
  titles: boolean;
};

const POST_REVIEW_ORDER: readonly PostReviewStep[] = ["teams", "autograph", "titles", "save"];

function isLive(step: PostReviewStep, live: PostReviewLive): boolean {
  return step === "save" || live[step] === true;
}

// ---------------------------------------------------------------------------
// NEO-345 — the autograph format question.
//
// An autograph's FORMAT (on the card, or on a sticker) is NB data the
// operator supplies once per synced leaf; no marketplace says which it is.
// The wizard asks for it when a card the save will CREATE carries the "AU"
// attribute and the leaf has no format yet, and the answer travels as the
// commit's batch-level `autographFormat`.
// ---------------------------------------------------------------------------

/**
 * The two answers, as stored in the leaf's `features.autographFormat` — the
 * backend's own vocabulary and predicates (`deriveCardFeatures.ts`, a pure
 * module), so the step's on/off rule is the commit's.
 */
export { AUTOGRAPH_FORMATS, type AutographFormat };

/**
 * The two answers' display names, keyed by the stored value — the wizard's
 * tiles, the checklist prompt's buttons and Set details' select all say
 * these words (NEO-345 a11y: one name per answer everywhere).
 */
export const AUTOGRAPH_CHOICE_LABEL: Readonly<Record<AutographFormat, string>> = {
  "On Card": "On card",
  "Sticker/Label": "Sticker",
};

/** A stored value read back as one of the two answers (anything else is none). */
export function asAutographFormat(value: string | undefined | null): AutographFormat | undefined {
  return isAutographFormat(value) ? value : undefined;
}

/** Does this attribute list carry the autograph token? Case-folded, trimmed. */
export function carriesAutograph(attributes: readonly string[] | undefined): boolean {
  return carriesAutographToken(attributes);
}

/**
 * Positions in `cards` the autograph step is about: cards the save will
 * CREATE (not in `existingIndexes`, which re-sync a stored row) that carry
 * "AU". A re-synced row keeps its own features; the stored-leaf prompt in the
 * checklist header is where those are answered.
 */
export function autographCardIndexes(
  cards: readonly { attributes?: readonly string[] }[],
  existingIndexes: readonly number[] = [],
): number[] {
  const existing = new Set(existingIndexes);
  const out: number[] = [];
  cards.forEach((card, i) => {
    if (!existing.has(i) && carriesAutograph(card.attributes)) out.push(i);
  });
  return out;
}

/**
 * Where the operator is. `review.index` is 0-based among the review rows.
 */
export type StepPosition =
  | { kind: "review"; index: number }
  | { kind: PostReviewStep };

/** What the wizard can see right now. */
export interface StepPlanInput {
  /** Review rows in the batch (0 in a teams-only sitting). */
  reviewRows: number;
  /** Would any card save teamless? See `cardsForTeamsStep`. */
  teamsStep: boolean;
  /** NEO-345 — does the autograph format question apply? Absent = no. */
  autographStep?: boolean;
  /** Is any card title waiting for a look? */
  titlesStep: boolean;
}

/** The counted plan — every field a high-water mark. */
export interface StepCount {
  total: number;
  reviewRows: number;
  teamsStep: boolean;
  /** NEO-345 — the autograph step, once counted. */
  autographStep: boolean;
  titlesStep: boolean;
  /** On Save: nothing more is added. */
  frozen: boolean;
}

/** y for a plan, with no history. */
export function plannedTotal(input: StepPlanInput): number {
  return (
    Math.max(0, input.reviewRows) +
    (input.teamsStep ? 1 : 0) +
    (input.autographStep ? 1 : 0) +
    (input.titlesStep ? 1 : 0) +
    1
  );
}

/** The first count of a sitting. */
export function initialStepCount(input: StepPlanInput, onSave = false): StepCount {
  const reviewRows = Math.max(0, input.reviewRows);
  return {
    total: plannedTotal({ ...input, reviewRows }),
    reviewRows,
    teamsStep: input.teamsStep,
    autographStep: input.autographStep === true,
    titlesStep: input.titlesStep,
    frozen: onSave,
  };
}

/**
 * The next count: never smaller than `prev`, unchanged while on Save.
 * Returns `prev` itself (same object) when nothing moved, so a caller can
 * compare by identity. `added` is how many steps this call grew y by.
 */
export function advanceStepCount(
  prev: StepCount,
  input: StepPlanInput,
  onSave: boolean,
): { count: StepCount; added: number } {
  // On Save — and the move ONTO Save — adds nothing. Steps that turn up now
  // are the walker's, after the save.
  if (onSave) {
    if (prev.frozen) return { count: prev, added: 0 };
    return { count: { ...prev, frozen: true }, added: 0 };
  }
  // Off Save (again): a thaw, then whatever turned up meanwhile counts as
  // growth like any other.
  const reviewRows = Math.max(prev.reviewRows, input.reviewRows);
  const teamsStep = prev.teamsStep || input.teamsStep;
  const autographStep = prev.autographStep || input.autographStep === true;
  const titlesStep = prev.titlesStep || input.titlesStep;
  const total = plannedTotal({ reviewRows, teamsStep, autographStep, titlesStep });
  if (
    reviewRows === prev.reviewRows &&
    teamsStep === prev.teamsStep &&
    autographStep === prev.autographStep &&
    titlesStep === prev.titlesStep
  ) {
    return prev.frozen
      ? { count: { ...prev, frozen: false }, added: 0 }
      : { count: prev, added: 0 };
  }
  return {
    count: { total, reviewRows, teamsStep, autographStep, titlesStep, frozen: false },
    added: Math.max(0, total - prev.total),
  };
}

/** The steps after the names that are counted. */
function postReviewSteps(count: StepCount): number {
  return (
    1 + (count.teamsStep ? 1 : 0) + (count.autographStep ? 1 : 0) + (count.titlesStep ? 1 : 0)
  );
}

/**
 * x for a position. Post-review steps are counted back from the END, so Save
 * is always "Step y of y" whatever the high-water marks did on the way.
 */
export function stepNumber(count: StepCount, position: StepPosition): number {
  switch (position.kind) {
    case "save":
      return count.total;
    case "titles":
      return count.total - 1;
    case "autograph":
      return count.total - 1 - (count.titlesStep ? 1 : 0);
    case "teams":
      return (
        count.total - 1 - (count.titlesStep ? 1 : 0) - (count.autographStep ? 1 : 0)
      );
    case "review": {
      const last = Math.max(1, count.total - postReviewSteps(count));
      return Math.min(last, Math.max(1, position.index + 1));
    }
  }
}

/**
 * The 0-based review step for the row on screen.
 *
 * An undecided row is the next one to do: every decided row is behind it, so
 * it is step `decided + 1` — which is what makes the counter tick forward one
 * at a time however the walk reorders (teams first, staged steps ahead of
 * their player). A decided row being read back sits at its place among the
 * decided rows, in batch order. With nothing on screen (names still being
 * looked up) the next step is still `decided + 1`.
 */
export function reviewStepIndex(
  rows: readonly Pick<NavRow, "_id" | "decision">[],
  currentRowId: string | null,
): number {
  const current = currentRowId ? rows.find((r) => r._id === currentRowId) : undefined;
  if (current?.decision) {
    let before = 0;
    for (const row of rows) {
      if (row._id === current._id) break;
      if (row.decision) before += 1;
    }
    return before;
  }
  const decided = rows.reduce((n, r) => n + (r.decision ? 1 : 0), 0);
  return Math.min(decided, Math.max(0, rows.length - 1));
}

/**
 * The screen type for a review row. `pick` — the row is on its NEO-332 pick
 * step ("Which player is this?"); the New Player step "Create new" opens is a
 * player step.
 */
export function reviewStepKind(
  row: Pick<NavRow, "kind">,
  opts: { pick?: boolean } = {},
): WizardStepKind {
  if (row.kind === "league") return "league";
  if (row.kind === "team") return "team";
  return opts.pick ? "pick" : "player";
}

/**
 * The step the walk reaches next while nothing is on screen (lookups still
 * landing): leagues, then teams, then players — `nextUndecided`'s order —
 * first undecided of the first kind present. Null when nothing is undecided.
 */
export function upcomingReviewStepKind(rows: readonly NavRow[]): WizardStepKind | null {
  for (const kind of ["league", "team", "player"] as const) {
    const row = rows.find((r) => !r.decision && r.kind === kind);
    if (row) return reviewStepKind(row, { pick: isAmbiguousPlayerRow(row) });
  }
  const untyped = rows.find((r) => !r.decision);
  return untyped ? reviewStepKind(untyped) : null;
}

/**
 * The preview cards the teams step would list.
 *
 * Once every name is decided this is exactly `teamlessCardIndexes` — what the
 * teams step shows. Before that it is OPTIMISTIC: a team name nobody has ruled
 * on yet is assumed to resolve, because most do (Add as New Team, Link). So
 * the step is counted from the start for cards that print no team at all, and
 * otherwise appears only when the operator SKIPS a team name — an operator
 * decision, which is the only kind of growth the counter allows.
 *
 * A team name an EARLIER save of this set skipped (`people.skippedTeamNames`)
 * is known before the sitting starts, so a card printing only such names is
 * counted from the start, like a card that prints no team at all.
 */
export function cardsForTeamsStep(
  cards: readonly PreviewCardForTeams[],
  rows: readonly TeamsReviewRow[],
  settledIndexes?: readonly number[],
  people?: StoredPeople,
): number[] {
  // An undecided team name is ASSUMED to resolve: stood in for by a link, so
  // its row still outranks a skip record for the same name (the gate queued
  // it, so this sitting is where it is being answered).
  const assumed = rows.map((r) =>
    r.kind === "team" && !r.decision ? { ...r, decision: { action: "link" as const } } : r,
  );
  const settled =
    settledIndexes && settledIndexes.length > 0 ? new Set(settledIndexes) : undefined;
  return teamlessCardIndexes(cards, assumed, settled, people);
}

/**
 * Which post-review step the operator is on.
 *
 * `requested` is where they asked to be (null = "the first one there is").
 * A step with nothing in it right now is passed over in the walking
 * direction — forward from teams to autograph to titles to save. Save
 * always exists.
 *
 * `unanswered` (NEO-345) names a live step whose answer is REQUIRED and not
 * yet given: no step after it can be reached until it is, whatever was
 * requested. The autograph step is the only one today.
 */
export function resolvePostReviewStep(
  requested: PostReviewStep | null,
  live: PostReviewLive,
  unanswered?: PostReviewStep,
): PostReviewStep {
  const start = requested ? POST_REVIEW_ORDER.indexOf(requested) : 0;
  let resolved: PostReviewStep = "save";
  for (let i = start; i < POST_REVIEW_ORDER.length; i++) {
    const step = POST_REVIEW_ORDER[i];
    if (isLive(step, live)) {
      resolved = step;
      break;
    }
  }
  if (
    unanswered &&
    unanswered !== "save" &&
    isLive(unanswered, live) &&
    POST_REVIEW_ORDER.indexOf(unanswered) < POST_REVIEW_ORDER.indexOf(resolved)
  ) {
    return unanswered;
  }
  return resolved;
}

/** The post-review step after `step`, or null past Save. */
export function nextPostReviewStep(
  step: PostReviewStep,
  live: PostReviewLive,
): PostReviewStep | null {
  if (step === "save") return null;
  return resolvePostReviewStep(POST_REVIEW_ORDER[POST_REVIEW_ORDER.indexOf(step) + 1], live);
}

/** The post-review step before `step`, or null when Back leaves for the names. */
export function previousPostReviewStep(
  step: PostReviewStep,
  live: PostReviewLive,
): PostReviewStep | null {
  for (let i = POST_REVIEW_ORDER.indexOf(step) - 1; i >= 0; i--) {
    const candidate = POST_REVIEW_ORDER[i];
    if (candidate !== "save" && isLive(candidate, live)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Growth: what the polite live region says when y grows.
// ---------------------------------------------------------------------------

/** The slice of a review row the growth line reads. */
export type StepRow = Pick<NavRow, "_id" | "kind" | "name" | "source">;

/** "A", "A and B", "A, B and C". */
function listJoin(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Why y grew, in words, for the steps added since the last look.
 *
 * - staged career New Team steps → "teams for {player}" (Jason-approved)
 * - a league staged for a team   → "league for {team}"
 * - the teams step               → "cards with no team"
 * - the autograph step           → "autographed cards" (NEO-345, placeholder)
 * - the titles step              → "card titles"
 * - any other new row            → "more names" (Jason)
 */
export function growthReasons(input: {
  addedRows: readonly StepRow[];
  allRows: readonly StepRow[];
  teamsStepAdded: boolean;
  /** NEO-345 — absent reads as false. */
  autographStepAdded?: boolean;
  titlesStepAdded: boolean;
}): string[] {
  const nameById = new Map(input.allRows.map((r) => [r._id, r.name ?? ""]));
  const players: string[] = [];
  const teams: string[] = [];
  let other = false;
  for (const row of input.addedRows) {
    const source = row.source;
    if (source?.kind === "careerTeamOf") {
      const who = nameById.get(source.playerRowId);
      if (who && !players.includes(who)) players.push(who);
      else if (!who) other = true;
    } else if (source?.kind === "leagueOf") {
      const team = nameById.get(source.teamRowId);
      if (team && !teams.includes(team)) teams.push(team);
      else if (!team) other = true;
    } else {
      other = true;
    }
  }
  const reasons: string[] = [];
  if (players.length > 0) reasons.push(`teams for ${listJoin(players)}`);
  if (teams.length > 0) reasons.push(`league for ${listJoin(teams)}`);
  if (other) reasons.push("more names");
  if (input.teamsStepAdded) reasons.push("cards with no team");
  if (input.autographStepAdded) reasons.push(AUTOGRAPH_GROWTH_REASON);
  if (input.titlesStepAdded) reasons.push("card titles");
  return reasons;
}

/** NEO-345 — the growth line's words for the autograph step. */
export const AUTOGRAPH_GROWTH_REASON = "autographed cards";

/** "2 more steps: teams for Jim Thome" / "1 more step: …". */
export function growthLine(added: number, reasons: readonly string[]): string {
  const head = `${added} more ${added === 1 ? "step" : "steps"}`;
  return reasons.length > 0 ? `${head}: ${reasons.join(", ")}` : head;
}

/**
 * Everything the counter remembers across renders of one sitting. Feed it
 * every render through `trackSteps`; it hands back the SAME object while
 * nothing moved.
 */
export interface StepTracker {
  count: StepCount;
  /** Review row ids already counted — so a growth can say which are new. */
  knownRowIds: ReadonlySet<string>;
  /** The latest growth. `seq` ticks per growth so a host can tell two apart. */
  growth: { seq: number; text: string } | null;
}

export interface TrackStepsInput {
  rows: readonly StepRow[];
  teamsStep: boolean;
  /** NEO-345 — absent reads as false. */
  autographStep?: boolean;
  titlesStep: boolean;
  onSave: boolean;
}

export function trackSteps(prev: StepTracker | null, input: TrackStepsInput): StepTracker {
  const plan: StepPlanInput = {
    reviewRows: input.rows.length,
    teamsStep: input.teamsStep,
    autographStep: input.autographStep === true,
    titlesStep: input.titlesStep,
  };
  if (prev === null) {
    return {
      count: initialStepCount(plan, input.onSave),
      knownRowIds: new Set(input.rows.map((r) => r._id)),
      growth: null,
    };
  }
  const { count, added } = advanceStepCount(prev.count, plan, input.onSave);
  if (count === prev.count) return prev;
  if (added === 0) {
    // Frozen/unfrozen only; nothing new to remember or announce.
    return { ...prev, count };
  }
  const addedRows = count.frozen
    ? []
    : input.rows.filter((r) => !prev.knownRowIds.has(r._id));
  const reasons = growthReasons({
    addedRows,
    allRows: input.rows,
    teamsStepAdded: count.teamsStep && !prev.count.teamsStep,
    autographStepAdded: count.autographStep && !prev.count.autographStep,
    titlesStepAdded: count.titlesStep && !prev.count.titlesStep,
  });
  const knownRowIds = new Set(prev.knownRowIds);
  for (const row of input.rows) knownRowIds.add(row._id);
  return {
    count,
    knownRowIds,
    growth: { seq: (prev.growth?.seq ?? 0) + 1, text: growthLine(added, reasons) },
  };
}
