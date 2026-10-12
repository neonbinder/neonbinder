/**
 * NEO-339 — the set-build service contract.
 *
 * One interface, three consumers: the CLI (`cli.ts`), the MCP server
 * (`mcp-tools.ts`) and the runner that implements it
 * (`runner/service.ts → createSetBuildService(client, target)`).
 *
 * The read/write split is structural, not a convention: `read` and `write` are
 * separate objects, and the MCP read tools are registered with `service.read`
 * alone, so a read tool has no reference through which it could write.
 *
 * Every `write` method MUST throw `ConfirmMismatch` (client/target.ts) before
 * any network call when `confirm` is not exactly the phrase below,
 * `BUILD <host> <scope> <digest>`, where `digest` binds the phrase to the
 * write's content (`contentDigest`: SHA-256 of canonical JSON, 8 hex chars):
 *
 * | method          | phrase helper                 | scope                    | digest over                  |
 * |-----------------|-------------------------------|--------------------------|------------------------------|
 * | apply           | `specConfirmPhrase`           | `spec.scope`             | the parsed spec              |
 * | decide          | `decideConfirmPhrase`         | `formatPath(path)` (set) | path + row + the answers     |
 * | buildParallel   | `buildParallelConfirmPhrase`  | `formatPath(path)` (set) | path + row name + rebuild    |
 * | slReviewApply   | `slReviewConfirmPhrase`       | `formatPath(path)` (b-y) | path + the decisions         |
 *
 * The MCP layer checks the same phrase itself before calling (so a wrong
 * phrase costs zero service calls); the service's own check is the second
 * lock, and the only one the CLI relies on.
 *
 * Kept to types, the error class and two pure helpers (`formatPath`, the scope
 * contract both sides must compute identically, and `countOpenDecisions`).
 */

import { confirmPhrase, contentDigest, type Target } from "./client/target";

// ---------------------------------------------------------------------------
// Spec placeholders
// ---------------------------------------------------------------------------

/**
 * The spec as it arrives: decoded JSON, not yet validated. The service parses
 * it with `parseSpec` (spec/schema.ts); the MCP layer only reads `scope` (via
 * `specScope`) to pre-check the phrase.
 */
export type SetBuildSpecInput = unknown;

/** The `scope` a raw spec declares, or undefined when it has none. */
export function specScope(spec: SetBuildSpecInput): string | undefined {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return undefined;
  const scope = (spec as { scope?: unknown }).scope;
  return typeof scope === "string" && scope.trim() !== "" ? scope.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** A brand-year node: Sport › Year › Manufacturer. Names, resolved exactly-one. */
export interface BrandYearPath {
  sport: string;
  year: string;
  manufacturer: string;
}

/** A set node: Sport › Year › Manufacturer › Set. */
export interface SetPath extends BrandYearPath {
  set: string;
}

export type NodePath = BrandYearPath | SetPath;

export function isSetPath(p: NodePath): p is SetPath {
  return typeof (p as SetPath).set === "string";
}

/** `Baseball/2024/Topps/Topps Chrome` — the scope a set/brand-year write is confirmed with. */
export function formatPath(p: NodePath): string {
  const parts = [p.sport, p.year, p.manufacturer, ...(isSetPath(p) ? [p.set] : [])];
  return parts.map((s) => String(s).trim()).join("/");
}

// ---------------------------------------------------------------------------
// Confirm phrases
// ---------------------------------------------------------------------------
// One helper per write, used by both the MCP layer (its pre-check) and the
// runner (its own check), so the two can never compute different phrases.
// Each digest names the write it is for, so a phrase for one write never
// confirms another write with the same arguments.

/** `apply` / `nb_apply`: the spec's scope and the digest of the PARSED spec (`parseSpec`). */
export function specConfirmPhrase(t: Target, spec: { scope: string }): string {
  return confirmPhrase(t, spec.scope, contentDigest(spec));
}

/** `decide` / `nb_decide`. Absent answer lists count as empty. */
export function decideConfirmPhrase(t: Target, path: SetPath, d: ReviewDecisions): string {
  const scope = formatPath(path);
  return confirmPhrase(
    t,
    scope,
    contentDigest({
      write: "decide",
      path: scope,
      row: d.row ?? null,
      players: d.players ?? [],
      teams: d.teams ?? [],
      leagues: d.leagues ?? [],
    }),
  );
}

/** `buildParallel` / `nb_build_parallel`. */
export function buildParallelConfirmPhrase(t: Target, path: SetPath, name: string, o: { rebuild?: boolean }): string {
  const scope = formatPath(path);
  return confirmPhrase(t, scope, contentDigest({ write: "buildParallel", path: scope, name, rebuild: o.rebuild === true }));
}

/** `slReviewApply` / `nb_sl_review_apply`. */
export function slReviewConfirmPhrase(t: Target, path: BrandYearPath, decisions: SlDecision[]): string {
  const scope = formatPath(path);
  return confirmPhrase(t, scope, contentDigest({ write: "slReviewApply", path: scope, decisions }));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ResolveCandidate {
  /** The NB row id (or the marketplace id, for a base/reconcile id). */
  id: string;
  name: string;
  /** Anything that tells same-named candidates apart (team, era, league…). */
  detail?: string;
}

/**
 * A name (or marketplace id) that did not resolve to exactly one row. Zero
 * candidates = no match; two or more = ambiguous. Nothing is ever picked by
 * position: the caller names one of `candidates` and runs again.
 */
export class ResolveError extends Error {
  /** What was being resolved: "sport", "set", "player", "team", "league", "base-id", … */
  readonly kind: string;
  /** The name or id as the spec gave it. */
  readonly query: string;
  readonly candidates: ResolveCandidate[];
  /** Where in the spec it came from, e.g. `steps[2].variants[0]`. */
  readonly at: string | undefined;

  constructor(o: { kind: string; query: string; candidates: ResolveCandidate[]; at?: string; message?: string }) {
    super(
      o.message ??
        (o.candidates.length === 0
          ? `No ${o.kind} named "${o.query}".`
          : `"${o.query}" matches ${o.candidates.length} ${o.kind} rows; name exactly one.`),
    );
    this.name = "ResolveError";
    this.kind = o.kind;
    this.query = o.query;
    this.candidates = o.candidates;
    this.at = o.at;
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type Marketplace = "buysportscards" | "sportlots";

/** Marketplace ids attached to an NB row, by platform slot. */
export interface MarketplaceLinks {
  buysportscards: string[];
  sportlots: string[];
}

/** A row the spec addresses: variant type title + row name. */
export interface RowRef {
  type: string;
  name: string;
}

// The answer shapes are the spec's own (spec/schema.ts), so a `decide` call and
// a spec's review section cannot drift apart.
export type { NamedDecision, TeamDecision, SlDecision } from "./spec/schema";
import type { NamedDecision, TeamDecision, SlDecision } from "./spec/schema";

/** What `decide` takes: answers to one checklist's entity review (an apply stop). */
export interface ReviewDecisions {
  /** Which checklist the review belongs to. Omitted = the set's Base row. */
  row?: RowRef;
  players?: NamedDecision[];
  teams?: TeamDecision[];
  leagues?: NamedDecision[];
}

/** A spec name that resolved to zero or several NB rows. */
export interface OpenName {
  /** Where in the spec, e.g. `steps[1].path.manufacturer`. */
  at: string;
  kind: string;
  name: string;
  candidates: ResolveCandidate[];
}

export interface OpenBaseCandidates {
  at: string;
  path: string;
  side: Marketplace;
  candidates: Array<{ id: string; name: string; score?: number }>;
}

export interface OpenReconcile {
  at: string;
  path: string;
  type: string;
  proposedPairs: Array<{ name: string; buysportscards: string[]; sportlots: string[] }>;
  pending: Array<{ side: Marketplace; id: string; name: string }>;
}

export interface OpenReviewItem {
  at: string;
  row: RowRef | null;
  name: string;
  /** unanswered: no spec entry; ambiguous: the entry matches several rows; unmatched: the entry matches none. */
  reason: "unanswered" | "ambiguous" | "unmatched";
  candidates: ResolveCandidate[];
  /** e.g. a team's proposed location/league, a player's cards. */
  detail?: string;
}

export interface OpenSlReview {
  at: string;
  path: string;
  rows: Array<{ slId: string; name: string; suggestion?: string }>;
}

export interface OpenConflict {
  at: string;
  row: RowRef | null;
  cardNumber: string;
  detail: string;
}

/**
 * A Group Parallels entry the dialog would refuse or cannot settle by itself.
 *
 * - `parent-is-parallel`: the named insert is itself a parallel.
 * - `child-holds-parallels`: a named parallel holds parallels of its own.
 * - `chain`: a row named as an insert is also named as a parallel.
 * - `named-twice`: one row is named as a parallel more than once.
 * - `self`: a row is named as a parallel of itself.
 * - `refused`: the save was refused by the server; `detail` says what landed.
 */
export interface OpenGrouping {
  at: string;
  path: string;
  type: string;
  problem: "parent-is-parallel" | "child-holds-parallels" | "chain" | "named-twice" | "self" | "refused";
  /** The row's NB name (or, for `refused`, the variant type's). */
  name: string;
  detail: string;
}

export interface OpenDecisions {
  names: OpenName[];
  baseCandidates: OpenBaseCandidates[];
  reconcile: OpenReconcile[];
  review: { players: OpenReviewItem[]; teams: OpenReviewItem[]; leagues: OpenReviewItem[] };
  slReview: OpenSlReview[];
  conflicts: OpenConflict[];
  grouping: OpenGrouping[];
}

export function countOpenDecisions(d: OpenDecisions): number {
  return (
    d.names.length +
    d.baseCandidates.length +
    d.reconcile.reduce((n, r) => n + r.proposedPairs.length + r.pending.length, 0) +
    d.review.players.length +
    d.review.teams.length +
    d.review.leagues.length +
    d.slReview.reduce((n, s) => n + s.rows.length, 0) +
    d.conflicts.length +
    // A report written before NEO-339 part A has no `grouping` (decisions-template --from-report).
    (d.grouping?.length ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface PlanStep {
  /** Index into `spec.steps`. */
  index: number;
  kind: string;
  /** `formatPath` of the step's node. */
  path: string;
  /** What apply would do, in operator words: "map Base to BSC 1234", "build Gold Wave from Base". */
  action: string;
  status: "done" | "todo" | "blocked";
  detail?: string;
}

export interface PlanReport {
  target: Pick<Target, "convexUrl" | "host">;
  scope: string;
  /** The exact string `apply` must be confirmed with. */
  confirmPhrase: string;
  steps: PlanStep[];
  openDecisions: OpenDecisions;
  /** A spec fragment with every open decision as a fill-in field. */
  template: unknown;
}

/** Counts `apply` reports. Keys beyond these are allowed. */
export interface ApplyCounts {
  /** Cards written by build-from-base. */
  built: number;
  /** Cards committed from fetched checklists. */
  committed: number;
  /** Steps skipped because the state already matched. */
  skipped: number;
  [other: string]: number;
}

/**
 * Where `apply` stops at an open decision.
 *
 * - `first`: at the first one; the run ends there (the CLI's default).
 * - `end`: records it, marks the step and every step that depends on it
 *   blocked, carries on with the rest, and returns every open decision
 *   together (`nb_apply`'s default, CLI `apply --collect`).
 */
export type StopAt = "first" | "end";

export interface ApplyReport extends PlanReport {
  /**
   * Set when apply stopped at an open decision (the template carries it).
   * With `stopAt: "end"`, the first of `stops`.
   */
  stoppedAt?: { step: number; reason: string };
  /** `stopAt: "end"` only: every step that stopped at an open decision, in walk order. */
  stops?: Array<{ step: number; reason: string }>;
  counts: ApplyCounts;
  durationMs: number;
}

export interface InspectRow {
  name: string;
  cards: number;
  isBase: boolean;
  links: MarketplaceLinks;
  /** An insert row's parallels (the `parallel` level under it); absent when it has none. */
  parallels?: InspectRow[];
}

export interface InspectReport {
  target: Pick<Target, "convexUrl" | "host">;
  path: NodePath;
  /** `formatPath(path)`. */
  pathText: string;
  found: boolean;
  /** Brand-year path: the sets under it. */
  sets?: Array<{ name: string; links: MarketplaceLinks }>;
  /** Set path: the Base row (also listed under its variant type), null when none. */
  base?: InspectRow | null;
  /** Set path: every variant type and its rows. */
  variantTypes?: Array<{ type: string; rows: InspectRow[] }>;
}

export interface ReviewItemsReport {
  path: NodePath;
  pathText: string;
  review: OpenDecisions["review"];
  slReview: OpenSlReview[];
}

export interface BuildParallelReport {
  path: string;
  row: string;
  /** "built" | "skipped" (already had cards and rebuild was not asked). */
  outcome: "built" | "skipped";
  cards: number;
  durationMs: number;
}

export interface DecideReport {
  path: string;
  row: RowRef | null;
  applied: { players: number; teams: number; leagues: number };
  /** What the review still needs after these answers. */
  remaining: OpenDecisions["review"];
}

export interface SlReviewApplyReport {
  path: string;
  applied: number;
  remaining: number;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface SetBuildRead {
  inspect(path: NodePath): Promise<InspectReport>;
  /** Read-only on NB data. */
  plan(spec: SetBuildSpecInput): Promise<PlanReport>;
  reviewItems(path: NodePath): Promise<ReviewItemsReport>;
}

export interface ApplyOptions {
  /** Default `first`. Not covered by the confirm phrase: it changes how far one run goes, never what the spec allows it to write. */
  stopAt?: StopAt;
}

export interface SetBuildWrite {
  apply(spec: SetBuildSpecInput, confirm: string | undefined, opts?: ApplyOptions): Promise<ApplyReport>;
  decide(path: SetPath, decisions: ReviewDecisions, confirm: string | undefined): Promise<DecideReport>;
  buildParallel(
    path: SetPath,
    name: string,
    opts: { rebuild?: boolean },
    confirm: string | undefined,
  ): Promise<BuildParallelReport>;
  slReviewApply(path: BrandYearPath, decisions: SlDecision[], confirm: string | undefined): Promise<SlReviewApplyReport>;
}

export interface SetBuildService {
  read: SetBuildRead;
  write: SetBuildWrite;
  target: Target;
}
