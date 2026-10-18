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
 * | fix             | `fixConfirmPhrase`            | `formatPath(path)`       | path + card + name answers   |
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

/**
 * `fix` / `nb_fix`: the answers exactly as given (a title's text, a team's
 * name, a label accepted). Absent lists count as empty.
 */
export function fixConfirmPhrase(t: Target, path: NodePath, a: FixAnswers): string {
  const scope = formatPath(path);
  return confirmPhrase(t, scope, contentDigest({ write: "fix", path: scope, cards: a.cards ?? [], names: a.names ?? [] }));
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
export type { NamedDecision, PlayerDecision, TeamDecision, LeagueDecision, SlDecision } from "./spec/schema";
import type { PlayerDecision, TeamDecision, LeagueDecision, SlDecision } from "./spec/schema";

/** What `decide` takes: answers to one checklist's entity review (an apply stop). */
export interface ReviewDecisions {
  /** Which checklist the review belongs to. Omitted = the set's Base row. */
  row?: RowRef;
  /** A player link may carry `birthYear` to pick one of several same-name players. */
  players?: PlayerDecision[];
  teams?: TeamDecision[];
  /** NEO-331: a league "create" carries its `level`. */
  leagues?: LeagueDecision[];
}

/** A spec name that resolved to zero or several NB rows (or, from a draft, something it could not settle). */
export interface OpenName {
  /** Where in the spec, e.g. `steps[1].path.manufacturer`. */
  at: string;
  kind: string;
  name: string;
  candidates: ResolveCandidate[];
  /** Why, when the kind alone does not say (a draft's open conditions). Never adapter text. */
  detail?: string;
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
 * - `no-shared-numbers`: a parallel build linked none of the parallel's own
 *   marketplace cards to its source (built 0 while the listing returned
 *   cards): probably its own insert. `at` is the build's entry; `detail` says
 *   how to keep it its own set (`group.topLevel`).
 */
export interface OpenGrouping {
  at: string;
  path: string;
  type: string;
  problem: "parent-is-parallel" | "child-holds-parallels" | "chain" | "named-twice" | "self" | "refused" | "no-shared-numbers";
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

/** A set a run reached, and where to open it in the Set Builder. */
export interface SetLink {
  /** `formatPath` of the set. */
  path: string;
  /**
   * The Set Builder opened on the set: absolute on the app origin
   * (`--app-url` / `NB_SETBUILD_APP_URL`) when the tool has one, else
   * root-relative (`/admin/set-builder?sport=…&set=…`).
   */
  link: string;
  /**
   * Apply only: what the set still needs from a person once the run is over
   * (`nb_attention`'s totals and summary line). Absent on a plan, and when it
   * could not be read (`ApplyReport.attentionLine` says so).
   */
  attention?: AttentionSummary;
}

export interface PlanReport {
  target: Pick<Target, "convexUrl" | "host">;
  scope: string;
  /**
   * Every set the run resolved to an existing NB row (built, touched, or
   * skipped as already done), once each, in spec order. A set that never
   * resolved has no entry. Always present on plan and apply reports.
   */
  setLinks?: SetLink[];
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
  /**
   * The run's last word, from every set's `attention`: "Built and all
   * clear." only when nothing on any set it reached needs a person; otherwise
   * what is left and that `nb_attention` walks it. Absent when the run had no
   * set to read.
   */
  attentionLine?: string;
}

export interface InspectRow {
  name: string;
  cards: number;
  isBase: boolean;
  links: MarketplaceLinks;
  /** The Set Builder opened on this row (see `SetLink.link`). */
  link: string;
  /** An insert row's parallels (the `parallel` level under it); absent when it has none. */
  parallels?: InspectRow[];
}

export interface InspectReport {
  target: Pick<Target, "convexUrl" | "host">;
  path: NodePath;
  /** `formatPath(path)`. */
  pathText: string;
  found: boolean;
  /** The Set Builder opened on the node (the brand-year, or the set); absent when not found. */
  link?: string;
  /** Brand-year path: the sets under it. */
  sets?: Array<{ name: string; links: MarketplaceLinks; link: string }>;
  /** Set path: the Base row (also listed under its variant type), null when none. */
  base?: InspectRow | null;
  /** Set path: every variant type and its rows. */
  variantTypes?: Array<{ type: string; link: string; rows: InspectRow[] }>;
  /** Only with `attention: true`: what the node still needs from a person (`nb_attention`'s totals). */
  attention?: AttentionSummary;
}

export interface InspectOptions {
  /**
   * Add `attention`: reads every card of every row (one `getCardChecklist`
   * per row) plus each column's name suggestions, so it is opt-in.
   */
  attention?: boolean;
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
  /**
   * "built" | "skipped" (already had cards and rebuild was not asked) |
   * "no-shared-numbers" (built nothing: none of the row's marketplace cards
   * share a number with Base; `detail` says so).
   */
  outcome: "built" | "skipped" | "no-shared-numbers";
  cards: number;
  detail?: string;
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
// Attention (nb_attention / nb_fix / setbuild attention|fix)
// ---------------------------------------------------------------------------
// What a set still needs from a person once it is built: the cards the
// checklist header's "N need you" pill counts (lib/attention.ts, over
// `deriveCardAttention`), the "N names to check" rename suggestions on the
// set's rows (lib/name-suggestions.ts), the brand's "N SportLots sets to sort"
// count, the sync notices its columns still show, and any entity review this
// process left open. Derived from stored rows on every read: nothing is staged.

/** The counts `nb_attention` leads with, and every apply / inspect summary carries. */
export interface AttentionTotals {
  /** Cards the header pill counts (each once, whatever it is flagged for). */
  cards: number;
  /** Flags per kind (a card may carry more than one). */
  byKind: Record<string, number>;
  /** Cards with no team yet whose BSC team lookup has not finished: more may land as `missingTeam`. */
  awaitingTeamLookup: number;
  /** Sides with a marketplace name that differs from NB's (one row may have two). */
  namesToCheck: number;
  /** The brand's SportLots sets waiting to be sorted (answered with nb_sl_review_apply). */
  slSetsToSort: number;
}

export interface AttentionSummary extends AttentionTotals {
  /** One line for a person: "1 card needs you on Topps Chrome; 13 names to check." or the walker's all-clear. */
  summary: string;
}

/** A column's sync notice (read-only: the fix is a reconcile or attach in a spec, and dismissing is not a decision). */
export interface AttentionNotice {
  /** The column, in NB names: `Baseball/2024/Topps/Topps Chrome › Inserts`. */
  where: string;
  level: string;
  status: "syncing" | "error" | "done";
  /** The server's message, as the column shows it. */
  message?: string;
  /** Marketplace sets this sync left unlinked. */
  unlinked?: number;
  /** Names twinned on a marketplace that the sync left for the operator. */
  twinsLeft?: number;
  link: string;
}

export interface AttentionOptions {
  /**
   * "summary" (default): every item, with the per-card facts trimmed past the
   * first few (lib/attention.ts). "full": every fact on every card.
   */
  detail?: "summary" | "full";
}

export interface AttentionReport {
  target: Pick<Target, "convexUrl" | "host">;
  path: NodePath;
  pathText: string;
  /** The Set Builder opened on the node. */
  link: string;
  totals: AttentionTotals;
  /** `AttentionSummary.summary`: the line to give the operator first. */
  summary: string;
  /** Set path: every card that needs a person, in the walker's order. Empty on a brand-year. */
  cards: CardAttentionItem[];
  /** Set path: how many cards carry their fixer's facts (`detail: "summary"` reads the first few). */
  enrichment?: { enriched: number; of: number };
  /** Every name to check, on the node's own row and every row under it. */
  names: NameSuggestionItem[];
  /** The brand's SportLots review. On a brand-year path, `rows` lists each waiting line. */
  slReview: { pending: number; partial: boolean; moreNextSync: number; answerWith: "nb_sl_review_apply"; rows?: OpenSlReview } | null;
  /** An entity review this process's nb_apply left open on the set, by checklist (null = Base). */
  review: { rows: Array<RowRef | null>; answerWith: "nb_decide" } | null;
  notices: AttentionNotice[];
}

/** What `fix` takes. Every answer is explicit text or an explicit NB name; nothing is derived. */
export interface FixAnswers {
  /** Set path only. */
  cards?: CardFixAnswer[];
  names?: NameFixAnswer[];
}

/**
 * One answer's outcome: `cards[i]` (lib/attention-answers.ts, with the card,
 * the fixer it went through, any `warning`, any row `created`, and what the
 * card still needs) or `names[i]` (lib/name-suggestions.ts).
 */
export type FixResult = CardFixResult | NameFixResult;

export interface FixReport {
  path: string;
  applied: { cards: number; names: number };
  /** One per answer, in answer order: cards first, then names. */
  results: FixResult[];
  /** The rename mutation's own counts, summed over its calls. */
  nameCounts: { applied: number; declined: number; stale: number; clashed: number; skipped: number };
  /** What the node still needs after these answers. */
  remaining: AttentionTotals;
  summary: string;
}

// The card item and answer shapes are lib/attention.ts's; the name shapes are lib/name-suggestions.ts's.
import type { CardAttentionItem, CardFixAnswer } from "./lib/attention";
import type { CardFixResult } from "./lib/attention-answers";
import type { NameFixAnswer, NameFixResult, NameSuggestionItem } from "./lib/name-suggestions";
export type { CardFixResult } from "./lib/attention-answers";
export type { CardAttentionItem, CardFixAnswer } from "./lib/attention";
export type { NameFixAnswer, NameFixResult, NameRowRef, NameSuggestionItem } from "./lib/name-suggestions";

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface SetBuildRead {
  inspect(path: NodePath, opts?: InspectOptions): Promise<InspectReport>;
  /** Read-only on NB data. */
  plan(spec: SetBuildSpecInput): Promise<PlanReport>;
  reviewItems(path: NodePath): Promise<ReviewItemsReport>;
  /** Read-only on NB data: draft a whole set's spec from the server previews (runner/draft.ts). */
  draftSet(path: SetPath, opts?: DraftOptions): Promise<DraftReport>;
  /** Read-only: everything on a set or brand-year that is waiting on a person (runner/attention.ts). */
  attention(path: NodePath, opts?: AttentionOptions): Promise<AttentionReport>;
}

// ---------------------------------------------------------------------------
// Draft (nb_draft_set / setbuild draft-set)
// ---------------------------------------------------------------------------

/** How many cards one draft may send to BSC's per-card team lookup, by default. */
export const DEFAULT_TEAM_LOOKUP_BUDGET = 2000;
/** The most a caller may raise that budget to. */
export const MAX_TEAM_LOOKUP_BUDGET = 20000;

export interface DraftOptions {
  /** Preview every checklist (Base and each insert row). Default true. */
  checklists?: boolean;
  /** Add build entries: Parallel rows from Base, an insert's parallels from the insert. Default true. */
  builds?: boolean;
  /**
   * Cards the draft may send to BSC's per-card team lookup in total. Checked
   * before each checklist preview: once spent, later previews skip the lookup
   * (their teams are looked up when apply fetches). Default
   * `DEFAULT_TEAM_LOOKUP_BUDGET`; 0 turns the lookup off.
   */
  teamLookupBudget?: number;
}

/**
 * A value the drafter filled because the Set Builder UI would settle it
 * without asking (or Jason ruled it is pre-filled): a sole or pre-selected
 * Base candidate, the Reconcile dialog's own auto-matches, a Group Parallels
 * prefix suggestion, a `leave` for every pending marketplace set nobody
 * pairs, the Match Cards defaults, a `create` for a name with no NB
 * candidate, an observed count, a build entry. Listed beside the spec so
 * approving it is informed. The value itself is in the spec at `at`.
 */
export interface DraftProposal {
  at: string;
  kind:
    | "base-map"
    | "reconcile-pairs"
    /** Every pending marketplace set nobody pairs, left in Pending: one per type, with the counts (each set is in `sync.pending` with its name). */
    | "reconcile-leave"
    | "grouping"
    | "pairing"
    | "review-create"
    | "expect"
    | "build"
    | "already-built";
  detail: string;
}

export interface DraftedReport {
  status: "drafted";
  target: Pick<Target, "convexUrl" | "host">;
  path: SetPath;
  pathText: string;
  scope: string;
  /**
   * The drafted spec: every proposal, with each open decision LEFT OUT. With
   * open decisions it is not approvable as it stands (`confirmPhrase` is
   * null): fill in `template` instead.
   */
  spec: Record<string, unknown>;
  proposals: DraftProposal[];
  openDecisions: OpenDecisions;
  /** `countOpenDecisions(openDecisions)`. */
  openCount: number;
  /** The spec with every open decision as a `<…>` fill-in; null when nothing is open. */
  template: Record<string, unknown> | null;
  /**
   * `nb_apply`'s phrase for `spec`, only when nothing is open. Not an
   * approval: the operator still reads the draft and gives the phrase.
   */
  confirmPhrase: string | null;
  /** What apply would do with `spec` now (the engine's draft walk; read-only, no marketplace call). */
  steps: PlanStep[];
  /** What the draft could not see or chose not to do (budgets, previews skipped). */
  notes: string[];
  /**
   * Per variant type, the Pending sets the draft does not list and apply
   * leaves without asking (lib/reconcile-variants.ts): SportLots sets outside
   * the set's SportLots filter, which on SportLots' brand-year-wide list are
   * the brand-year's other products, and sets another variant type of the set
   * pairs. `outsideScopeSets` is every such SportLots set with
   * `detail: "full"`, a short sample otherwise.
   */
  leftUnasked: Array<{
    at: string;
    type: string;
    outsideScope: number;
    pairedElsewhere: number;
    outsideScopeSets: Array<{ id: string; name: string }>;
  }>;
  /** Marketplace requests the previews reported making. */
  marketplaceCalls: number;
  durationMs: number;
  /**
   * Present on a `detail: "summary"` result (the MCP default): what was cut
   * to keep the result small, and how to get all of it.
   */
  summary?: DraftSummary;
}

/** How a summary draft was cut (`compactDraftReport`). */
export interface DraftSummary {
  /** Proposals per kind; `proposals` keeps the first few of each. */
  proposalCounts: Record<string, number>;
  /** Steps per status; `steps` keeps the ones that are not done, up to a cap. */
  stepCounts: Record<string, number>;
  /** Entries left out of `proposals`, `steps`, `notes` and `leftUnasked[].outsideScopeSets`. */
  omitted: { proposals: number; steps: number; notes: number; outsideScopeSets: number };
  /** True when `spec` was left out because `template` carries it (with the fill-ins). */
  specInTemplate: boolean;
  hint: string;
}

export interface UnresolvedDraftReport {
  status: "unresolved";
  target: Pick<Target, "convexUrl" | "host">;
  path: SetPath;
  pathText: string;
  /** Which level did not resolve ("sport", "year", "manufacturer", "set"). */
  kind: string;
  message: string;
  /** Near names at that level. Nothing is created and nothing is picked. */
  candidates: ResolveCandidate[];
  /**
   * When the brand-year's Sets were never synced (or the brand-year itself
   * does not resolve): the one spec to apply first, then draft again.
   */
  prepare?: { reason: string; spec: Record<string, unknown> };
  marketplaceCalls: number;
  durationMs: number;
}

export type DraftReport = DraftedReport | UnresolvedDraftReport;

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
  /** Answer `attention` items: cards on a set, names on a set or brand-year. */
  fix(path: NodePath, answers: FixAnswers, confirm: string | undefined): Promise<FixReport>;
}

export interface SetBuildService {
  read: SetBuildRead;
  write: SetBuildWrite;
  target: Target;
}
