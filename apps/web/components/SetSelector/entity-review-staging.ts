import { normalizeEntityName } from "../../convex/lib/entityNearMatch";

/**
 * NEO-212 — "which team names does this batch already account for?"
 *
 * The wizard reviews one name at a time, but its decisions accumulate: by the
 * time an operator reaches the fifth player row, four earlier rows may already
 * have committed to creating "Toronto Blue Jays" — as a team row of their own,
 * as a Wikidata career team the operator left checked, or as a chip they typed
 * by hand. None of that is written to `teams` yet (nothing is, until Confirm &
 * Save), so `teams.search` cannot see it, and the career-team typeahead used to
 * offer nothing at all for a team this very batch was about to mint. The
 * operator retyped it, spelled it differently once, and the commit created two
 * franchises.
 *
 * This module answers the question the typeahead actually needs — "what team
 * names are in play right now, saved or not?" — from the batch's own rows plus
 * whatever the caller holds locally. It is deliberately PURE: no Convex, no
 * hooks, no I/O. Everything it cannot know (the canonical name behind a
 * `linkedTeamId`, the chips the current row is holding in React state) arrives
 * as an argument, so the whole thing is testable as a function of its inputs.
 *
 * ## Dedup key
 * `normalizeEntityName` — the SAME key `teams.nameNormalized` holds and
 * `findOrCreate` looks up at commit. Using anything softer here would suggest
 * two spellings that commit will collapse into one row; using anything stricter
 * would suggest a name the commit is about to dedupe away. First occurrence
 * wins and keeps its display casing, so the operator sees the name in the form
 * the batch will actually create it under.
 */

/**
 * Where a staged name came from. Carried through so a caller can present them
 * differently (the career-team typeahead tags all of them "this batch"), and so
 * a test can prove each source is actually read rather than inferring it from a
 * merged list.
 */
export type StagedTeamNameSource =
  /** A team-kind row in this batch that is undecided or decided "create". */
  | "batch-team"
  /** The canonical name of a team row the operator decided to LINK. */
  | "linked-team"
  /** A career team (hand-typed or a kept Wikidata proposal) of a created player. */
  | "career"
  /** A chip the operator has staged on the CURRENT row but not yet committed. */
  | "chip";

export interface StagedTeamName {
  name: string;
  source: StagedTeamNameSource;
}

/** A career-team entry, as both Wikidata enrichment and hand entry shape it. */
export interface StagingCareerTeam {
  name: string;
  fromYear: number;
  toYear?: number;
}

/**
 * The subset of an `entityReviewQueue.getBatch` row this module reads.
 *
 * Structural rather than the generated document type so the module stays
 * trivially constructible in tests and cannot acquire a Convex import through
 * its own type signature.
 */
export interface StagingRow {
  _id: string;
  kind: "player" | "team";
  name: string;
  enrichment?: { careerTeams?: StagingCareerTeam[] } | null;
  decision?:
    | {
        action: "create";
        manualCareerTeams?: StagingCareerTeam[];
        excludedCareerTeamNames?: string[];
      }
    | { action: "link"; linkedPlayerId?: string; linkedTeamId?: string }
    | { action: "skip" }
    | null;
}

export interface DeriveStagedTeamNamesArgs {
  /** Every row in the batch, in `getBatch` order. */
  rows: readonly StagingRow[];
  /** The row the wizard is presenting, or null. Its own name is never suggested. */
  currentRowId: string | null;
  /** Career-team chips the current row is holding in React state. */
  localChips: readonly { name: string }[];
  /**
   * Canonical `teams.name` values for the rows decided "link", resolved by the
   * caller with ONE `teams.getManyByIds` over the linked ids.
   *
   * The linked row's own `name` is the raw checklist string that prompted the
   * review ("NY Yankees"); the name the commit will actually use is the one on
   * the team row it was linked to ("New York Yankees"). Suggesting the raw
   * string would walk the operator straight back into the duplicate this whole
   * feature exists to prevent, which is why this is an argument and not a
   * convenience read off `rows`.
   */
  linkedTeamNames: readonly string[];
}

/**
 * Every team name this batch has already committed to, in a stable order:
 * team rows, then linked teams, then career teams, then the current row's
 * chips. Deduped by `normalizeEntityName`, first occurrence winning.
 *
 * A row decided "skip" contributes NOTHING — skip means "not a team", and a
 * name the operator has just rejected is the last thing to suggest back at
 * them. Rows decided "link" contribute their TARGET's name (see
 * `linkedTeamNames`), never their own.
 */
export function deriveStagedTeamNames({
  rows,
  currentRowId,
  localChips,
  linkedTeamNames,
}: DeriveStagedTeamNamesArgs): StagedTeamName[] {
  const currentRow = currentRowId
    ? (rows.find((r) => r._id === currentRowId) ?? null)
    : null;
  // Only a TEAM row names a team. A player row's own name is not a team name,
  // so there is nothing to exclude for it — and excluding it would be wrong the
  // moment a player and a team share a string.
  const currentTeamKey =
    currentRow && currentRow.kind === "team"
      ? normalizeEntityName(currentRow.name)
      : null;

  const ordered: StagedTeamName[] = [];

  // 1. Team rows this batch will create (or has not ruled on yet). An undecided
  //    row counts because the operator is about to reach it and the default
  //    action is "Add as New" — treating it as absent would mean the typeahead
  //    goes quiet exactly when it is most useful, on the row right before it.
  for (const row of rows) {
    if (row.kind !== "team") continue;
    if (row.decision && row.decision.action !== "create") continue;
    ordered.push({ name: row.name, source: "batch-team" });
  }

  // 2. Canonical names behind "link" decisions.
  for (const name of linkedTeamNames) {
    ordered.push({ name, source: "linked-team" });
  }

  // 3. Career teams of players this batch will create. Both halves of what
  //    `recordDecision` stores: the hand-typed entries and the Wikidata
  //    proposals the operator did NOT uncheck. An excluded proposal is a team
  //    the commit will not create, so it is not staged.
  for (const row of rows) {
    if (row.kind !== "player") continue;
    if (!row.decision || row.decision.action !== "create") continue;

    for (const entry of row.decision.manualCareerTeams ?? []) {
      ordered.push({ name: entry.name, source: "career" });
    }

    const excluded = new Set(
      (row.decision.excludedCareerTeamNames ?? []).map(normalizeEntityName),
    );
    for (const entry of row.enrichment?.careerTeams ?? []) {
      if (excluded.has(normalizeEntityName(entry.name))) continue;
      ordered.push({ name: entry.name, source: "career" });
    }
  }

  // 4. Chips on the current row — staged in React state, not yet in any
  //    decision, and the most recent thing the operator typed.
  for (const chip of localChips) {
    ordered.push({ name: chip.name, source: "chip" });
  }

  const seen = new Set<string>();
  const deduped: StagedTeamName[] = [];
  for (const candidate of ordered) {
    const key = normalizeEntityName(candidate.name);
    // A name that normalises to nothing (whitespace, punctuation only) can
    // never match a stored key and is not a suggestion worth making.
    if (!key) continue;
    if (currentTeamKey !== null && key === currentTeamKey) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}
