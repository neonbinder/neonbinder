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
 * any network call when `confirm` is not exactly
 * `confirmPhrase(target, scope)`, where `scope` is:
 *
 * | method          | scope                                   |
 * |-----------------|-----------------------------------------|
 * | apply           | `spec.scope`                            |
 * | decide          | `formatPath(path)` (a set path)         |
 * | buildParallel   | `formatPath(path)` (a set path)         |
 * | slReviewApply   | `formatPath(path)` (a brand-year path)  |
 *
 * The MCP layer checks the same phrase itself before calling (so a wrong
 * phrase costs zero service calls); the service's own check is the second
 * lock, and the only one the CLI relies on.
 *
 * Kept to types, the error class and two pure helpers (`formatPath`, the scope
 * contract both sides must compute identically, and `countOpenDecisions`).
 */

import type { Target } from "./client/target";

// ---------------------------------------------------------------------------
// Spec placeholders
// ---------------------------------------------------------------------------

/**
 * TODO(NEO-339 B1/B2): replace with `import type { SetBuildSpec } from
 * "./spec/schema"` once spec/schema.ts lands. Until then the service receives
 * the spec as parsed JSON and validates it itself with the zod schema; the
 * MCP layer only reads `scope` (via `specScope`) to pre-check the phrase.
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

/** `{ name, decision }` — mirrors spec `Named`. Keep in step with spec/schema.ts. */
export interface NamedDecision {
  name: string;
  decision: "create" | "skip" | { link: string };
}

/** Mirrors spec `TeamDecision`. */
export interface TeamDecision extends NamedDecision {
  location?: string;
  league?: string;
}

/** Mirrors spec `SlDecision`. */
export type SlDecision =
  | { slId: string; placement: "own-set" }
  | { slId: string; set: string; variantType: string; name?: string };

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

export interface OpenDecisions {
  names: OpenName[];
  baseCandidates: OpenBaseCandidates[];
  reconcile: OpenReconcile[];
  review: { players: OpenReviewItem[]; teams: OpenReviewItem[]; leagues: OpenReviewItem[] };
  slReview: OpenSlReview[];
  conflicts: OpenConflict[];
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
    d.conflicts.length
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

export interface ApplyReport extends PlanReport {
  /** Set when apply stopped at an open decision (the template carries it). */
  stoppedAt?: { step: number; reason: string };
  counts: ApplyCounts;
  durationMs: number;
}

export interface InspectRow {
  name: string;
  cards: number;
  isBase: boolean;
  links: MarketplaceLinks;
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

export interface SetBuildWrite {
  apply(spec: SetBuildSpecInput, confirm: string | undefined): Promise<ApplyReport>;
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
