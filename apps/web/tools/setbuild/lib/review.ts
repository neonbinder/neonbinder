/**
 * NEO-339 — the entity review ("Confirm New Players & Teams"), answered from
 * the spec through the SAME public functions and the SAME decision builders the
 * wizard uses (`lib/set-build/review.ts`).
 *
 * What it mirrors, and why each matters:
 *
 *  - It waits for every row's lookup to land before reading anything. The
 *    lookups are what stage the Wikidata career teams and the New League steps
 *    (`applyLookupResult`), and the fixture's team and league rows have to be
 *    exactly the ones the UI seed created.
 *  - It stages career teams with `planStaging`, the wizard's own belt-and-braces
 *    rule (one idempotent `stageCareerTeamRows` per player row per session).
 *    It does it for every undecided player up front rather than as each one
 *    comes on screen: the calls are the ones the wizard would make, in the
 *    same order, and doing them first is what lets the runner see the whole
 *    batch — and every name the spec has to answer — before it decides
 *    anything.
 *  - It walks the rows in the wizard's own order (`nextUndecided`: leagues,
 *    then teams, then players, each held back while what it needs is open).
 *  - A team "create" with no `location`/`league` is exactly "Add as New Team"
 *    on the untouched step: `teamCreatePrefill`, league unanswered (the server
 *    falls back to the lookup's league). A league "create" is "Add as New
 *    League" on its untouched step (`newLeaguePrefill`). A player "create" is
 *    the bare create the bulk button records. A team link keeps the row's name
 *    as an alias, the checkbox's default.
 *
 * And what it never does: decide a row the spec does not name, decide by
 * position, pick the first of several matches, or untick/discard a career team.
 * A row with no spec entry, or an entry that matches zero or several rows, is
 * an open decision; `runReview` reports every one of them before it records
 * anything.
 */

import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { normalizeEntityName } from "../../../lib/entities/normalize-name";
import {
  buildCreateDecision,
  buildLinkDecision,
  planStaging,
  teamCreatePrefill,
  type CreateDecisionPayload,
  type RecordDecisionArgs,
} from "../../../lib/set-build/review";
import { splitTeamName } from "../../../lib/teams/team-name";
import { nextUndecided } from "../../../components/SetSelector/entity-review-nav";
import type { NbClient } from "../client/convex-client";
import { ResolveError, type OpenDecisions, type OpenReviewItem, type ResolveCandidate, type RowRef } from "../service";
import type { NamedDecision, ReviewAnswers, TeamDecision } from "../spec/schema";
import { ChecklistStepError } from "./fetch-checklist";

export type ReviewRow = FunctionReturnType<typeof api.entityReviewQueue.getBatch>[number];
export type ReviewKind = ReviewRow["kind"];
export type ReviewOpen = OpenDecisions["review"];

/** How long to wait for a batch's lookups (Wikidata/ESPN) to land. */
export const REVIEW_SETTLE_TIMEOUT_MS = 15 * 60_000;

export interface ReviewContext {
  selectorOptionId: Id<"selectorOptions">;
  batchId: string;
  /** Spec location of the answers, e.g. `steps[1].base.checklist.review`. */
  at: string;
  row: RowRef | null;
  settleTimeoutMs?: number;
}

export interface ReviewApplied {
  players: number;
  teams: number;
  leagues: number;
}

export type ReviewOutcome =
  | { status: "done"; applied: ReviewApplied; alreadyDecided: number; staged: number }
  | { status: "open"; open: ReviewOpen; applied: ReviewApplied; alreadyDecided: number; staged: number };

// ---------------------------------------------------------------------------
// Pure: matching spec entries to rows
// ---------------------------------------------------------------------------

/** The spec names rows by their exact name; only whitespace is folded. */
export function specNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

const KIND_KEY = { player: "players", team: "teams", league: "leagues" } as const;

type AnyDecision = NamedDecision | TeamDecision;

export interface ReviewMatch {
  /** Row id → its one spec entry. */
  answers: Map<string, AnyDecision>;
  open: ReviewOpen;
}

function emptyOpen(): ReviewOpen {
  return { players: [], teams: [], leagues: [] };
}

export function rowDetail(row: ReviewRow): string | undefined {
  const parts: string[] = [];
  const e = row.enrichment;
  if (row.kind === "team") {
    const prefill = teamCreatePrefill(row);
    if (prefill.location) parts.push(`location "${prefill.location}"`);
    if (e?.league) parts.push(`league "${e.league}"`);
  }
  if (row.kind === "player" && e?.careerTeams?.length) {
    parts.push(`career teams: ${e.careerTeams.map((c) => c.name).join(", ")}`);
  }
  if (row.kind === "player" && e?.existingCandidates?.length) {
    parts.push(`${e.existingCandidates.length} existing NB player(s) share this name`);
  }
  if (row.status === "error") parts.push("lookup failed");
  return parts.length ? parts.join("; ") : undefined;
}

/**
 * Pair every UNDECIDED row with exactly one spec entry, and every spec entry
 * with exactly one row. Rows already decided (by an earlier run or `decide`)
 * are left as they are and need no entry. Pure.
 *
 * `partial`: an undecided row with no entry is simply left (the `decide`
 * path answers only what it was given); an entry still needs exactly one row.
 */
export function matchReview(
  rows: readonly ReviewRow[],
  answers: ReviewAnswers,
  ctx: { at: string; row: RowRef | null; partial?: boolean },
): ReviewMatch {
  const open = emptyOpen();
  const matched = new Map<string, AnyDecision>();
  for (const kind of ["player", "team", "league"] as const) {
    const listKey = KIND_KEY[kind];
    const entries: AnyDecision[] = answers[listKey];
    const ofKind = rows.filter((r) => r.kind === kind);
    for (const r of ofKind) {
      if (r.decision) continue;
      const hits = entries.filter((e) => specNameKey(e.name) === specNameKey(r.name));
      if (hits.length === 1) {
        matched.set(r._id, hits[0]);
      } else if (hits.length > 1 || !ctx.partial) {
        open[listKey].push({
          at: `${ctx.at}.${listKey}`,
          row: ctx.row,
          name: r.name,
          reason: hits.length === 0 ? "unanswered" : "ambiguous",
          candidates: [],
          detail: hits.length > 1 ? `the spec answers "${r.name}" ${hits.length} times` : rowDetail(r),
        });
      }
    }
    entries.forEach((e, i) => {
      const rowsNamed = ofKind.filter((r) => specNameKey(r.name) === specNameKey(e.name));
      if (rowsNamed.length === 1) return;
      open[listKey].push({
        at: `${ctx.at}.${listKey}[${i}]`,
        row: ctx.row,
        name: e.name,
        reason: rowsNamed.length === 0 ? "unmatched" : "ambiguous",
        candidates: rowsNamed.map((r) => ({ id: r._id, name: r.name, detail: rowDetail(r) })),
        detail:
          rowsNamed.length === 0
            ? `no ${kind} row in this review is named "${e.name}"`
            : `${rowsNamed.length} ${kind} rows are named "${e.name}"`,
      });
    });
  }
  return { answers: matched, open };
}

export function reviewOpenCount(open: ReviewOpen): number {
  return open.players.length + open.teams.length + open.leagues.length;
}

/** The fill-in placeholder a template carries where the spec has no answer. */
export const DECISION_PLACEHOLDER = '<"create" | "skip" | {"link": "<existing NB name>"}>';

/**
 * The review in spec format: every row of the batch, with the spec's answer
 * where it has one and a fill-in placeholder where it does not. Already-decided
 * rows are omitted (they need no answer). Pure.
 */
export function reviewTemplate(
  rows: readonly ReviewRow[],
  answers: ReviewAnswers | "none-expected",
): Record<"players" | "teams" | "leagues", Array<Record<string, unknown>>> {
  const out = { players: [] as Array<Record<string, unknown>>, teams: [] as Array<Record<string, unknown>>, leagues: [] as Array<Record<string, unknown>> };
  for (const r of rows) {
    if (r.decision) continue;
    const listKey = KIND_KEY[r.kind];
    const given =
      answers === "none-expected"
        ? []
        : (answers[listKey] as AnyDecision[]).filter((e) => specNameKey(e.name) === specNameKey(r.name));
    if (given.length === 1) {
      out[listKey].push({ ...given[0] });
      continue;
    }
    // The hint rides inside the placeholder (the spec is strict, so a separate
    // hint key would have to be deleted by hand after filling).
    const hint = rowDetail(r);
    out[listKey].push({ name: r.name, decision: hint ? `${DECISION_PLACEHOLDER} — ${hint}` : DECISION_PLACEHOLDER });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure: payloads
// ---------------------------------------------------------------------------

/**
 * Keep in step with `newLeaguePrefill` + `parseAliases` (NewLeagueForm.tsx)
 * and the wizard's league branch of `buildCreatePayload`: an untouched New
 * League step, as "Add as New League" sends it. Copied because the Node tool
 * cannot load that component module.
 */
export function untouchedLeagueCreate(row: {
  name: string;
  enrichment?: { abbreviation?: string; wikidataId?: string; yearsActive?: { from: number; to?: number } } | null;
}): NonNullable<CreateDecisionPayload["createLeague"]> {
  const e = row.enrichment;
  const abbreviation = (e?.abbreviation ?? "").trim();
  const wikidataId = (e?.wikidataId ?? "").trim();
  return {
    name: row.name.trim(),
    ...(abbreviation ? { abbreviation } : {}),
    ...(e?.yearsActive?.from !== undefined
      ? {
          yearsActive: {
            from: e.yearsActive.from,
            ...(e.yearsActive.to !== undefined ? { to: e.yearsActive.to } : {}),
          },
        }
      : {}),
    ...(wikidataId ? { wikidataId } : {}),
  };
}

/**
 * The New Team step's Location + Name. Untouched = `teamCreatePrefill`. A spec
 * `location` must be a whole-word prefix of the row's name (the split the
 * operator would type), or `""` for "no location"; anything else is refused
 * rather than guessed.
 */
export function teamLocationAndName(
  row: ReviewRow,
  location: string | undefined,
  at: string,
): { location?: string; name: string } {
  if (location === undefined) {
    const draft = teamCreatePrefill(row);
    const loc = draft.location.trim();
    return { name: draft.name.trim(), ...(loc ? { location: loc } : {}) };
  }
  const split = splitTeamName(row.name, location);
  if (!split) {
    throw new ChecklistStepError(
      `${at}: location "${location}" is not the start of the team name "${row.name}"; ` +
        "give the place the name begins with, or leave location out to take the step's pre-fill.",
    );
  }
  return { location: split.location, name: split.name };
}

// ---------------------------------------------------------------------------
// Network: resolving link targets and leagues
// ---------------------------------------------------------------------------

async function exactOne<T extends { _id: string; name: string; confidence: "exact" | "close" }>(
  hits: T[],
  kind: string,
  query: string,
  at: string,
  detailOf: (h: T) => string | undefined,
): Promise<T> {
  const exact = hits.filter((h) => h.confidence === "exact");
  if (exact.length === 1) return exact[0];
  throw new ResolveError({
    kind,
    query,
    at,
    candidates: (exact.length > 1 ? exact : hits).map((h) => ({ id: String(h._id), name: h.name, detail: detailOf(h) })),
  });
}

/** The one existing NB player/team/league `link` names, in the row's sport. */
export async function resolveLinkTarget(
  client: NbClient,
  row: ReviewRow,
  link: string,
  at: string,
): Promise<Id<"players"> | Id<"teams"> | Id<"leagues">> {
  if (row.kind === "player") {
    const hits = await client.query(api.players.nearMatches, { name: link, sportId: row.sportId });
    return (await exactOne(hits, "player", link, at, (h) =>
      [h.birthYear ? `born ${h.birthYear}` : "", h.matchedAlias ? `alias "${h.matchedAlias}"` : ""].filter(Boolean).join(", ") || undefined,
    ))._id;
  }
  if (row.kind === "team") {
    const hits = await client.query(api.teams.nearMatches, { name: link, sportId: row.sportId });
    return (await exactOne(hits, "team", link, at, (h) =>
      h.yearsActive ? `${h.yearsActive.from}–${h.yearsActive.to ?? ""}` : undefined,
    ))._id;
  }
  const hits = await client.query(api.leagues.nearMatches, { name: link, sportId: row.sportId });
  return (await exactOne(hits, "league", link, at, () => undefined))._id;
}

/** Candidates for an unanswered row, for the operator filling the template. Read-only. */
export async function candidatesFor(client: NbClient, row: ReviewRow): Promise<ResolveCandidate[]> {
  try {
    if (row.kind === "player") {
      const hits = await client.query(api.players.nearMatches, { name: row.name, sportId: row.sportId });
      return hits.map((h) => ({ id: String(h._id), name: h.name, detail: `${h.confidence}${h.birthYear ? `, born ${h.birthYear}` : ""}` }));
    }
    if (row.kind === "team") {
      const hits = await client.query(api.teams.nearMatches, { name: row.name, sportId: row.sportId });
      return hits.map((h) => ({ id: String(h._id), name: h.name, detail: h.confidence }));
    }
    const hits = await client.query(api.leagues.nearMatches, { name: row.name, sportId: row.sportId });
    return hits.map((h) => ({ id: String(h._id), name: h.name, detail: h.confidence }));
  } catch {
    return [];
  }
}

/** Every `league` row this batch has answered, by the names a team step may use (the wizard's `stagedLeagueNames`). */
export function stagedLeagueNames(rows: readonly ReviewRow[]): string[] {
  return rows.flatMap((r) => {
    if (r.kind !== "league" || !r.decision) return [];
    if (r.decision.action === "create") {
      const typed = r.decision.createLeague?.name?.trim();
      return typed && typed !== r.name ? [r.name, typed] : [r.name];
    }
    if (r.decision.action === "link") return [r.name];
    return [];
  });
}

type TeamLeague =
  | { kind: "answer"; leagueId?: Id<"leagues">; leagueName?: string }
  | { kind: "staged" };

/**
 * The New Team step's League answer for a spec `league` name: an existing
 * league of the sport (exactly-one, by the league key or an alias), a league
 * this batch already answered, or — the wizard's "name a league we do not
 * hold" — a New League step staged now (`stageLeagueRows`), answered before
 * the team exactly as the wizard walks it.
 */
async function teamLeague(
  client: NbClient,
  row: ReviewRow,
  rows: readonly ReviewRow[],
  league: string,
  at: string,
): Promise<TeamLeague> {
  const key = normalizeEntityName(league);
  const leagues = await client.query(api.leagues.list, { sportId: row.sportId });
  const existing = leagues.filter(
    (l) => normalizeEntityName(l.name) === key || (l.aliases ?? []).some((a: string) => normalizeEntityName(a) === key),
  );
  if (existing.length === 1) return { kind: "answer", leagueId: existing[0]._id };
  if (existing.length > 1) {
    throw new ResolveError({
      kind: "league",
      query: league,
      at,
      candidates: existing.map((l) => ({ id: String(l._id), name: l.name })),
    });
  }
  const staged = stagedLeagueNames(rows).filter((n) => normalizeEntityName(n) === key);
  if (staged.length > 0) return { kind: "answer", leagueName: staged[0] };
  const pendingStep = rows.find(
    (r) => r.kind === "league" && !r.decision && normalizeEntityName(r.name) === key,
  );
  if (pendingStep) return { kind: "staged" };
  const res = await client.mutation(api.entityReviewQueue.stageLeagueRows, {
    reviewRowId: row._id,
    leagueName: league,
  });
  if (res.outcome === "existing" && res.leagueId) return { kind: "answer", leagueId: res.leagueId };
  if (res.outcome === "over-cap") {
    throw new ChecklistStepError(`${at}: the team "${row.name}" has raised as many New League steps as it may.`);
  }
  return { kind: "staged" };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

async function readBatch(client: NbClient, ctx: ReviewContext): Promise<ReviewRow[]> {
  return client.query(api.entityReviewQueue.getBatch, {
    selectorOptionId: ctx.selectorOptionId,
    batchId: ctx.batchId,
  });
}

async function waitSettled(client: NbClient, ctx: ReviewContext): Promise<ReviewRow[]> {
  return client.waitFor(
    api.entityReviewQueue.getBatch,
    { selectorOptionId: ctx.selectorOptionId, batchId: ctx.batchId },
    (rows) => rows.every((r) => r.status !== "pending"),
    { timeoutMs: ctx.settleTimeoutMs ?? REVIEW_SETTLE_TIMEOUT_MS, label: "the review lookups (players, teams, leagues)" },
  );
}

/**
 * Stage career teams for every undecided player the wizard would stage for
 * (`planStaging`, once per row per session), until nothing new appears.
 * Returns the settled rows and how many steps were added.
 */
async function stageAndSettle(
  client: NbClient,
  ctx: ReviewContext,
  alreadyStaged: Set<string>,
): Promise<{ rows: ReviewRow[]; added: number }> {
  let added = 0;
  for (;;) {
    const rows = await waitSettled(client, ctx);
    let addedThisPass = 0;
    for (const r of rows) {
      for (const call of planStaging(r, { alreadyStaged })) {
        if (call.mutation !== "stageCareerTeamRows") continue;
        alreadyStaged.add(r._id);
        addedThisPass += await client.mutation(api.entityReviewQueue.stageCareerTeamRows, call.args);
      }
    }
    added += addedThisPass;
    if (addedThisPass === 0) return { rows, added };
  }
}

async function withCandidates(client: NbClient, rows: readonly ReviewRow[], open: ReviewOpen): Promise<ReviewOpen> {
  const fill = async (items: OpenReviewItem[]) =>
    Promise.all(
      items.map(async (item) => {
        if (item.reason !== "unanswered") return item;
        const row = rows.find((r) => r.name === item.name);
        return row ? { ...item, candidates: await candidatesFor(client, row) } : item;
      }),
    );
  return { players: await fill(open.players), teams: await fill(open.teams), leagues: await fill(open.leagues) };
}

/**
 * Answer one review batch from the spec.
 *
 * Full mode (apply): every undecided row needs exactly one entry and every
 * entry exactly one row, checked on the whole settled batch BEFORE the first
 * decision; otherwise it returns `open` having recorded nothing. A row that
 * appears mid-walk (a league step a team's answer staged) is held to the same
 * rule, and stops the walk where it is (what was recorded stays: a re-run
 * resumes the same batch).
 *
 * Partial mode (`decide`): only the answered rows are recorded; the rest stay
 * open and are returned.
 *
 * `"none-expected"`: any row at all is an open decision.
 */
export async function runReview(
  client: NbClient,
  ctx: ReviewContext,
  answers: ReviewAnswers | "none-expected",
  opts: { partial?: boolean } = {},
): Promise<ReviewOutcome> {
  const applied: ReviewApplied = { players: 0, teams: 0, leagues: 0 };
  const alreadyStaged = new Set<string>();
  let { rows, added: staged } = await stageAndSettle(client, ctx, alreadyStaged);
  const alreadyDecided = rows.filter((r) => r.decision).length;

  if (answers === "none-expected") {
    const undecided = rows.filter((r) => !r.decision);
    if (undecided.length === 0) return { status: "done", applied, alreadyDecided, staged };
    const open = matchReview(rows, { players: [], teams: [], leagues: [] }, ctx).open;
    for (const k of ["players", "teams", "leagues"] as const) {
      open[k] = open[k].map((o) => ({ ...o, detail: `${o.detail ? `${o.detail}; ` : ""}the spec says no review is expected` }));
    }
    return { status: "open", open: await withCandidates(client, rows, open), applied, alreadyDecided, staged };
  }

  // In partial mode `open` holds only entries that matched zero or several
  // rows (an unanswered row is not a problem there); either way, nothing is
  // recorded while the answers themselves are in doubt.
  let match = matchReview(rows, answers, { ...ctx, partial: opts.partial });
  if (reviewOpenCount(match.open) > 0) {
    return { status: "open", open: await withCandidates(client, rows, match.open), applied, alreadyDecided, staged };
  }

  for (let guard = 0; guard < 10_000; guard++) {
    // Rows the answers do not cover (partial mode only) stand in as decided,
    // so the walk can pass them; the server never sees the stand-in.
    const view = rows.map((r) => (r.decision || match.answers.has(r._id) ? r : { ...r, decision: { action: "skip" as const } }));
    const current = nextUndecided(view);
    if (!current) {
      if (view.every((r) => r.decision)) break;
      if (rows.some((r) => r.status === "pending")) {
        ({ rows } = await stageAndSettle(client, ctx, alreadyStaged));
        continue;
      }
      const stuck = rows.filter((r) => !r.decision).map((r) => `${r.kind} "${r.name}"`);
      throw new ChecklistStepError(
        `${ctx.at}: the review cannot move on; still undecided: ${stuck.slice(0, 10).join(", ")}${stuck.length > 10 ? "…" : ""}.`,
      );
    }
    const row = rows.find((r) => r._id === current._id)!;

    // The wizard's per-row staging, for a row the up-front pass did not cover.
    let restaged = false;
    for (const call of planStaging(row, { alreadyStaged })) {
      if (call.mutation !== "stageCareerTeamRows") continue;
      alreadyStaged.add(row._id);
      if ((await client.mutation(api.entityReviewQueue.stageCareerTeamRows, call.args)) > 0) restaged = true;
    }
    if (restaged) {
      const next = await stageAndSettle(client, ctx, alreadyStaged);
      rows = next.rows;
      staged += next.added;
      match = matchReview(rows, answers, { ...ctx, partial: opts.partial });
      if (reviewOpenCount(match.open) > 0) {
        return { status: "open", open: await withCandidates(client, rows, match.open), applied, alreadyDecided, staged };
      }
      continue;
    }

    const entry = match.answers.get(row._id)!;
    const at = `${ctx.at}.${KIND_KEY[row.kind]}`;
    let decision: RecordDecisionArgs;
    if (entry.decision === "skip") {
      decision = { reviewRowId: row._id, action: "skip" };
    } else if (typeof entry.decision === "object") {
      const linked = await resolveLinkTarget(client, row, entry.decision.link, at);
      decision = buildLinkDecision(row._id, row.kind, linked, row.kind === "team" ? { saveAsAlias: true } : {});
    } else if (row.kind === "player") {
      decision = buildCreateDecision(row._id, {});
    } else if (row.kind === "league") {
      decision = buildCreateDecision(row._id, { createLeague: untouchedLeagueCreate(row) });
    } else {
      const team = entry as TeamDecision;
      const create: NonNullable<CreateDecisionPayload["create"]> = teamLocationAndName(row, team.location, at);
      if (team.league !== undefined) {
        const league = await teamLeague(client, row, rows, team.league, at);
        if (league.kind === "staged") {
          // A New League step now stands ahead of this team; answer it first,
          // as the wizard walks it.
          rows = await waitSettled(client, ctx);
          match = matchReview(rows, answers, { ...ctx, partial: opts.partial });
          if (reviewOpenCount(match.open) > 0) {
            return { status: "open", open: await withCandidates(client, rows, match.open), applied, alreadyDecided, staged };
          }
          if (!rows.some((r) => r.kind === "league" && !r.decision && match.answers.has(r._id))) {
            // Partial mode with the league unanswered: the team waits for it.
            match.answers.delete(row._id);
          }
          continue;
        }
        if (league.leagueId) create.leagueId = league.leagueId;
        if (league.leagueName) create.leagueName = league.leagueName;
      }
      decision = buildCreateDecision(row._id, { create });
    }

    await client.mutation(api.entityReviewQueue.recordDecision, decision);
    applied[KIND_KEY[row.kind]]++;
    // Local copy, so the walk need not re-read the whole batch per row.
    rows = rows.map((r) =>
      r._id === row._id ? ({ ...r, decision: stubDecision(decision) } as ReviewRow) : r,
    );
  }

  if (opts.partial) {
    const left = matchReview(rows, { players: [], teams: [], leagues: [] }, { ...ctx, partial: false }).open;
    if (reviewOpenCount(left) > 0) return { status: "open", open: left, applied, alreadyDecided, staged };
  }
  return { status: "done", applied, alreadyDecided, staged };
}

/** The decision as the batch will report it, close enough for the walk's own bookkeeping. */
function stubDecision(d: RecordDecisionArgs): ReviewRow["decision"] {
  if (d.action === "skip") return { action: "skip" };
  if (d.action === "link") {
    return {
      action: "link",
      ...(d.linkedPlayerId ? { linkedPlayerId: d.linkedPlayerId } : {}),
      ...(d.linkedTeamId ? { linkedTeamId: d.linkedTeamId } : {}),
      ...(d.linkedLeagueId ? { linkedLeagueId: d.linkedLeagueId } : {}),
    } as ReviewRow["decision"];
  }
  return {
    action: "create",
    ...(d.create ? { create: d.create } : {}),
    ...(d.createLeague ? { createLeague: d.createLeague } : {}),
  } as ReviewRow["decision"];
}

/** Read a batch's current rows (read-only), for `reviewItems` and reports. */
export async function readReviewRows(client: NbClient, ctx: Pick<ReviewContext, "selectorOptionId" | "batchId">): Promise<ReviewRow[]> {
  return readBatch(client, ctx as ReviewContext);
}

/** The batch's still-undecided rows as open items (read-only), with candidates. */
export async function openItemsOf(
  client: NbClient,
  rows: readonly ReviewRow[],
  ctx: { at: string; row: RowRef | null },
): Promise<ReviewOpen> {
  const open = matchReview(rows, { players: [], teams: [], leagues: [] }, ctx).open;
  return withCandidates(client, rows, open);
}
