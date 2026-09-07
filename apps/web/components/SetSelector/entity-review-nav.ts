/**
 * NEO-221 — which review row is on screen, and what the batch adds up to.
 *
 * ## Why this exists at all
 *
 * The wizard used to DERIVE the presented row: `rows.find(r => r.status !==
 * "pending" && !r.decision)`. Nothing pinned it, so the row on screen was a
 * function of the whole batch rather than of anything the operator had done —
 * and `getBatch` is reactive, so the batch changes underneath them. Three ways
 * that bit:
 *
 *  1. **A sibling row settling re-ordered the answer.** A lookup landing on a
 *     row EARLIER in the array made that row the new `find` hit, so the row the
 *     operator was reading swapped out mid-sentence, taking their staged career
 *     teams with it.
 *  2. **A decision could land on the wrong row.** The click handler closed over
 *     `current._id` from the render that drew the button, so a decide issued
 *     just as the presentation moved recorded against a row nobody was looking
 *     at.
 *  3. **There was no way back.** A derived "first undecided" cannot present a
 *     row that already has a decision, so a misclick was permanent for the life
 *     of the batch.
 *
 * The fix is to make the presented row a piece of STATE (`NavState`) that only
 * ever moves for a stated reason, and to put the rule for when it moves here,
 * where it is a pure function of `(rows, nav)` and can be tested without a
 * dialog, a Convex mock or a clock.
 *
 * `explicit` is the whole trick: it records that the OPERATOR chose this row
 * (Back, "Change" in the decided list, "Back to review" after a failed commit)
 * rather than the wizard walking to it. An explicit row stays put even once it
 * carries a decision — that is what makes reviewing your own decision possible
 * — while an implicit one advances the moment it is settled.
 *
 * Deliberately PURE: no React, no Convex, no ids. The row type is structural so
 * a test can hand it three-field literals.
 */

/** The three terminal decisions a review row can carry. */
import { normalizeEntityName } from "../../convex/lib/entityNearMatch";

export type NavDecision =
  | { action: "create" }
  | { action: "link"; linkedPlayerId?: string; linkedTeamId?: string }
  | { action: "skip" };

/**
 * The slice of an `entityReviewQueue` row this module reads. Structural rather
 * than the generated Doc type so the wizard can pass its rows straight through
 * and a test does not have to fabricate `_creationTime`, `sportValue` and the
 * rest to exercise a counting rule.
 */
export type NavRow = {
  _id: string;
  status: "pending" | "ready" | "error";
  decision?: NavDecision | null;
  /**
   * NEO-236 — both optional so a test can still hand this module three-field
   * literals, and so every existing caller compiles unchanged. Absent means the
   * blocking rule below simply does not apply to that row.
   */
  kind?: "player" | "team" | "league";
  source?:
    | { kind: "careerTeamOf"; playerRowId: string }
    // NEO-254 — a league staged for the team that needs it.
    | { kind: "leagueOf"; teamRowId: string }
    | null;
  /** A team row's own name, and a player row's career-team labels — the two
   *  sides the blocker rule matches on. Optional so a test may omit them. */
  name?: string;
  enrichment?: { careerTeams?: readonly { name: string }[] } | null;
};

/**
 * NEO-236 — is this player row still waiting on a team the batch has to create?
 *
 * Jason asked for the walk to read "New Team: Sydney Blue Sox, New Team: Oregon
 * State Beavers, then New Player: Travis Bazzana which can now use the 2 new
 * teams that were created." `getBatch` already emits the staged team rows ahead
 * of their player, and that is enough ONLY while those rows are settled — a
 * still-pending row is stepped over by the rule below, which would put the
 * player first and hand the operator a step they cannot complete (its chips
 * would read "needs a team decision" and Confirm would be blocked).
 *
 * So a player waits for its own staged teams. This cannot deadlock: a blocking
 * row is undecided, so it is either settled — in which case `nextUndecided`
 * reaches it FIRST, because it sorts ahead of the player — or still pending, in
 * which case the lookup pool or `sweepStalePendingRows` will settle it. With
 * every remaining row blocked, this returns null and the wizard says it is
 * still looking names up, which is exactly what is happening.
 *
 * A blocker the operator has ANSWERED — including "skip" — stops blocking. Skip
 * means "that is not a team", and the player's own step is where that is dealt
 * with (untick the chip, or change the team's decision); refusing to present
 * the player would leave nowhere to do either.
 */
/**
 * NEO-254 — is this TEAM row still waiting on a league the batch has to create?
 *
 * The league twin of `waitingOnStagedTeams`, and the same argument: a team step
 * whose league does not exist yet cannot be answered — its league pill row
 * would offer `Create <name>`, which is the very thing the New League step
 * replaced. So the team waits for its own staged league, exactly as a player
 * waits for its staged teams.
 *
 * Cannot deadlock, for the same reason: a blocking row is undecided, so it is
 * either settled (and sorts ahead of the team in `walkOrder`, so
 * `nextUndecided` reaches it first) or still pending (and the pool or the
 * stale-row sweep will settle it).
 *
 * A blocker the operator ANSWERED — including "skip — no league" — stops
 * blocking. Skip means "this team has no league", which is an answer, and the
 * team's own step is where it takes effect.
 *
 * Matched on `source.teamRowId` alone, NOT on the league name as well. That is
 * the one place this differs from the team rule, and deliberately: staging
 * dedupes a league across the whole batch, so thirty NHL teams share ONE step,
 * and keying on the name would make that single step block all thirty until it
 * is answered — which is correct, but it is already achieved by the id link on
 * the one team that raised it plus the fact that the others read the answer
 * from `stagedLeagueIdByName` at commit. Blocking thirty steps on one answer
 * would stall the walk for no gain.
 */
function waitingOnStagedLeagues(
  row: NavRow,
  rows: readonly NavRow[],
): boolean {
  if (row.kind !== "team") return false;
  return rows.some(
    (other) =>
      other.kind === "league" &&
      !other.decision &&
      other.source?.kind === "leagueOf" &&
      other.source.teamRowId === row._id,
  );
}

function waitingOnStagedTeams(
  row: NavRow,
  rows: readonly NavRow[],
): boolean {
  if (row.kind !== "player") return false;

  /*
   * TWO ways a staged step can belong to this player, and the second is the
   * one Jason's 522-row hockey batch found.
   *
   * Staging dedupes a career team across the WHOLE batch, so in a set full of
   * NHL players the first one to name the Montreal Canadiens gets the step and
   * every later player sharing that club gets none. Keyed only on
   * `source.playerRowId`, this saw no blocker for Guy Lafleur and let him
   * through — while his chips, which key on the NAME across the batch,
   * correctly reported three teams as unanswered. He was handed a step that
   * said "needs a team decision" three times with nowhere to go: "There does
   * not appear to be anywhere that a decision is needed that I can see."
   *
   * So the answer is the TEAM, identified by its name. Whose lookup happened to
   * raise the step is not part of the question — it only decides which step
   * says "Needed by".
   *
   * `normalizeEntityName` is the same key the chips and the staging dedupe use,
   * so the three cannot disagree about whether a label is answered.
   */
  const careerKeys = new Set(
    (row.enrichment?.careerTeams ?? [])
      .map((ct) => normalizeEntityName(ct.name))
      .filter(Boolean),
  );

  return rows.some((other) => {
    // ANY team row, not just a staged one: a checklist team row named for one
    // of this player's clubs answers that chip exactly as a staged row does.
    // Where the row came from decides what its step says, never whether it
    // counts.
    if (other.kind !== "team") return false;
    if (other.decision) return false;
    if (
      other.source?.kind === "careerTeamOf" &&
      other.source.playerRowId === row._id
    ) {
      return true;
    }
    return (
      other.name !== undefined && careerKeys.has(normalizeEntityName(other.name))
    );
  });
}

/**
 * `rowId` — the row the wizard is presenting, or null for "nothing to present"
 * (every row settled, or the batch is empty).
 *
 * `explicit` — true when the operator navigated here on purpose. See the header.
 */
export type NavState = { rowId: string | null; explicit: boolean };

/**
 * The first row that is ready to be reviewed: settled (its lookup finished, or
 * failed) and not yet decided.
 *
 * Array order, not sorted: `getBatch` returns insertion order, and NEO-99's
 * pool completes out of order, so "earliest inserted that is ready" is what
 * keeps the sequence stable while lookups stream in. A still-pending row is
 * stepped over rather than blocking on a straggler.
 */
export function nextUndecided<T extends NavRow>(rows: readonly T[]): T | null {
  const settled = (r: T) => r.status !== "pending" && !r.decision;

  /*
   * ── NEO-236: EVERY undecided team comes before ANY undecided player ──────
   *
   * Jason, 2026-09-06: "What if we just always pop new teams to the top of the
   * queue? … subsequent cards would always have all of the teams before it.
   * That would help with the look up info as there are a lot of these hockey
   * players that don't have years in the wikidata and then the teams need to be
   * mapped manually."
   *
   * The point is not tidiness, it is that answering teams first makes the
   * PLAYERS easier. Every team the operator creates early is one more row the
   * later players' career stints can resolve against by name — so a batch that
   * front-loads its teams turns a long tail of hand-mapping into a list of
   * links. It also means the operator does one KIND of work at a time instead
   * of alternating between two shapes of form.
   *
   * Array order is preserved WITHIN each pass, so `walkOrder`'s "a staged team
   * sits with the player who needed it" still decides the order teams are
   * asked in — this only decides that they are all asked first.
   *
   * A row with no `kind` (an older caller, or a test literal) falls through to
   * the second pass, which is the pre-NEO-236 behaviour unchanged.
   */
  const team = rows.find((r) => settled(r) && r.kind === "team");
  if (team) return team;

  return (
    rows.find(
      (r) =>
        settled(r) &&
        // A player whose staged career teams are still open is not ready to be
        // reviewed — see `waitingOnStagedTeams`. Still needed even with teams
        // sorted first, because a team whose own lookup has not landed is not
        // `settled` and so is not offered by the pass above.
        !waitingOnStagedTeams(r, rows) &&
        // NEO-254 — and a TEAM whose staged league is still open. Same rule,
        // one level up; see `waitingOnStagedLeagues`.
        !waitingOnStagedLeagues(r, rows),
    ) ?? null
  );
}

/**
 * Is any TEAM row settled, undecided, and therefore ready to be answered?
 *
 * The teams-first rule's precondition. Deliberately not "is any team row
 * undecided": a team whose own lookup has not landed cannot be answered yet, so
 * yielding to it would park the operator on nothing.
 */
function hasSettledUndecidedTeam(rows: readonly NavRow[]): boolean {
  return rows.some(
    (r) => r.kind === "team" && r.status !== "pending" && !r.decision,
  );
}

/** Rows carrying any decision — the wizard's progress numerator. */
export function countDecided(rows: readonly NavRow[]): number {
  return rows.reduce((n, r) => (r.decision ? n + 1 : n), 0);
}

/**
 * Undecided rows whose lookup has not finished.
 *
 * This is the count "Add All Remaining as New" cannot act on (NEO-221 stopped
 * the bulk create from deciding rows the operator has never seen), so it is the
 * number the button has to say out loud.
 */
export function countPendingUndecided(rows: readonly NavRow[]): number {
  return rows.reduce(
    (n, r) => (r.status === "pending" && !r.decision ? n + 1 : n),
    0,
  );
}

/**
 * The same, narrowed to the rows the bulk create can act on.
 *
 * The two are NOT interchangeable, and conflating them is a mistake worth
 * naming: the status line ("N still looking up — wait or skip") is about what
 * the OPERATOR is waiting on, which includes the New Team steps; the ARMING
 * decision is about what the bulk create will still have work to do for, which
 * is players only. Counting teams in the second makes the loop spin; leaving
 * them out of the first makes the wizard look idle while it is not.
 */
export function countPendingBulkCreatable(rows: readonly NavRow[]): number {
  return rows.reduce(
    (n, r) =>
      r.status === "pending" && !r.decision && isBulkCreatable(r) ? n + 1 : n,
    0,
  );
}

/**
 * NEO-236 — is this a row "Add remaining players as new" would actually decide?
 *
 * Jason: "add all remaining as new should still process teams, it should only
 * apply to players." So a TEAM row — a checklist name or a career team this
 * batch staged — is never decided by that button, and every count attached to
 * it has to agree, or the wizard lies twice over:
 *
 *  - the label would promise to add rows it will not touch, and
 *  - the armed "keep adding as lookups finish" loop would never converge,
 *    because it waits on a count that can no longer reach zero.
 *
 * A row with no `kind` (an older caller, or a test literal) counts as bulk
 * creatable, which preserves every pre-NEO-236 caller's arithmetic.
 */
function isBulkCreatable(row: NavRow): boolean {
  /*
   * NEO-254 — a LEAGUE row is excluded for the same reason a team row is, and
   * it matters more.
   *
   * Jason, 2026-09-05: "add all remaining as new should still process teams,
   * it should only apply to players." The reason a team is exempt is that its
   * step is the only place its League gets a human answer; a league's step is
   * the only place its abbreviation, level, years and aliases get one — and a
   * league created without them is exactly the defect this feature exists to
   * remove. Bulk-creating leagues would reintroduce it through the one door
   * still open.
   *
   * Written as two exclusions rather than `=== "player"` so a row with NO
   * `kind` (an older caller, or a test literal) still counts as bulk
   * creatable, preserving every pre-NEO-236 caller's arithmetic.
   */
  return row.kind !== "team" && row.kind !== "league";
}

/** Undecided rows the bulk create will act on — the number its label shows. */
export function countBulkCreatable(rows: readonly NavRow[]): number {
  return rows.reduce(
    (n, r) => (!r.decision && isBulkCreatable(r) ? n + 1 : n),
    0,
  );
}

/** Undecided rows of ANY kind — what "Skip remaining" acts on, unchanged. */
export function countUndecided(rows: readonly NavRow[]): number {
  return rows.reduce((n, r) => (r.decision ? n : n + 1), 0);
}

/** What the batch will actually do, for the final step's summary. */
export function summarizeDecisions(rows: readonly NavRow[]): {
  created: number;
  linked: number;
  skipped: number;
} {
  let created = 0;
  let linked = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row.decision) continue;
    if (row.decision.action === "create") created += 1;
    else if (row.decision.action === "link") linked += 1;
    else skipped += 1;
  }
  return { created, linked, skipped };
}

/**
 * The ONE rule that moves the presented row.
 *
 * Returns the SAME object when nothing should move, so the caller's effect can
 * bail on identity (`if (next === nav) return`) and never loop.
 *
 * It advances in exactly three situations:
 *  - nothing is presented yet (`rowId === null`);
 *  - the presented row is gone from the batch (cancelled, swept, or reconciled
 *    away by a resume);
 *  - the wizard walked here (`explicit === false`) and the row has since been
 *    decided — by this operator, or by a bulk action.
 *
 * An explicitly-presented row is never moved off by a decision landing on it.
 * That is the read-only "Decided: …" panel: the operator asked to see this row,
 * so they keep seeing it until they ask for something else.
 */
export function resolveNav<T extends NavRow>(
  rows: readonly T[],
  nav: NavState,
  /**
   * NEO-236 — has the operator started work on the row that is on screen?
   *
   * The teams-first rule lets the walk revise its OWN pick (an implicit pin),
   * which is what stopped the wizard stranding an operator on a player while
   * answerable teams piled up behind it. But "the walk may change its mind"
   * has to stop being true the moment the operator has begun: half-typed text
   * in the career-team entry, a staged stint, an unticked chip or an open link
   * search is work, and most of it is per-row state that a jump discards.
   *
   * Only gates the teams-first clause. A decided row, a vanished row, and a
   * player waiting on its own staged teams all still move the walk on — those
   * are not "the walk changing its mind", they are the row being finished or
   * unanswerable.
   *
   * Defaults to false, so every existing caller keeps today's behaviour.
   */
  opts: { pinnedRowHasEdits?: boolean } = {},
): NavState {
  const presented =
    nav.rowId === null ? null : (rows.find((r) => r._id === nav.rowId) ?? null);

  const stale =
    nav.rowId === null ||
    presented === null ||
    (!nav.explicit &&
      (!!presented.decision ||
        /*
         * NEO-236 — a player the WALK chose yields while any team waits.
         *
         * Jason's 118-row batch: 13 settled undecided teams, and the wizard
         * sitting on a player. `nextUndecided` was already teams-first, so a
         * FRESH resolve picked a team correctly — the hole was that
         * `resolveNav` only consults it when the pin goes STALE, and an
         * implicitly-pinned undecided player never is.
         *
         * That matters because of how a batch actually drains: everything
         * starts `pending`, the pool resolves 5-wide over a real Wikidata round
         * trip, and with 105 of 118 rows being players the first row to settle
         * is almost always a player. The walk pins it, the 13 teams settle a
         * moment later, and nothing ever re-asks. The operator gets exactly
         * what Jason got — a player whose chips say "needs a team decision"
         * while every team it needs is sitting there answered by nobody.
         *
         * Only an IMPLICIT pin yields. An explicit one is the operator's own
         * navigation (Back, "Change decision", "Decide team") and outranks
         * this — that is the NEO-221 promise about not losing your place, and
         * it is what keeps this from undoing a deliberate move.
         */
        (presented.kind === "player" &&
          !opts.pinnedRowHasEdits &&
          hasSettledUndecidedTeam(rows)) ||
        // NEO-236 — an implicit pin YIELDS to steps staged under it.
        //
        // This is the defect Jason hit on CI run 5: on the first player of a
        // fresh batch he was shown the New Player step and never saw a New Team
        // step at all. The player's own lookup is what stages its career teams,
        // and the wizard is already presenting that player when the lookup
        // lands — so the rows appear ahead of it, `nextUndecided` correctly
        // refuses to offer the player, and none of that mattered, because a
        // present + undecided + implicitly-presented row was not "stale" and
        // the rule was never consulted.
        //
        // An implicit pin is the WIZARD'S OWN WALK, not something the operator
        // chose, so it has no claim to stay put once the walk's own rule says
        // this row is not ready. An EXPLICIT pin still wins (see below): the
        // operator asked for that row, and its step is where an unanswerable
        // career team gets unticked.
        (waitingOnStagedTeams(presented, rows) ||
          waitingOnStagedLeagues(presented, rows))));
  if (!stale) return nav;

  const nextId = nextUndecided(rows)?._id ?? null;
  // Already sitting on the right answer implicitly — returning a fresh object
  // here would re-render forever for no change.
  if (nextId === nav.rowId && !nav.explicit) return nav;
  return { rowId: nextId, explicit: false };
}

/**
 * How a settled decision reads in the decided list and the read-only panel.
 *
 * Past tense, and "Linked to {name}" rather than "Link to {name}": the live
 * controls own the imperative `Link to {name}` accessible name (it is an E2E
 * matcher and a screen reader's only way to tell two of them apart), so a
 * static history line must not collide with it.
 */
export function describeDecision(
  decision: NavDecision | null | undefined,
  linkedName?: string | null,
): string {
  if (!decision) return "Not yet decided";
  if (decision.action === "create") return "Added as new";
  if (decision.action === "skip") return "Skipped";
  return linkedName ? `Linked to ${linkedName}` : "Linked to an existing record";
}
