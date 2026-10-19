/**
 * NEO-339 part B — `draftSet`: draft a complete set-build spec for one set
 * from the server's read-only previews, so an operator approves a whole set
 * once (`nb_draft_set`, `setbuild draft-set` / `build-set`).
 *
 * Read-only on NB data. Everything runs on `draftClient` (queries, plus the
 * three marketplace reads `fetchRawOptions`, `previewSetStructure` and
 * `previewCardChecklist`; every mutation and every other action is refused
 * before it is sent). A marketplace adapter may refresh its session, as any
 * fetch does.
 *
 * ## What it fills, and what it leaves open
 *
 * The draft uses the same `lib/set-build` modules the UI runs; it adds no
 * matcher of its own. A PROPOSAL is a value the UI settles without asking (or
 * that Jason ruled is pre-filled, 2026-10-11); an OPEN DECISION is anything
 * else. Proposals are listed beside the spec; open decisions are left out of
 * `spec` and appear in `template` as `<…>` fill-ins.
 *
 * | what                    | proposal                                             | open decision                                  |
 * |-------------------------|------------------------------------------------------|------------------------------------------------|
 * | variant types           | the set's variant-type sync (always)                  | —                                              |
 * | Base mapping, per side  | the sole candidate, or the dialog's own pre-selection (a SOLE exact match; a tie pre-selects nothing) | several candidates, none pre-selected; an id two candidates carry |
 * | Insert/Parallel sync    | the Reconcile dialog's Ready sets (auto-matches and saved rows, by marketplace id); a one-marketplace fetch the form stores without asking; an explicit `leave`, with the marketplace's name, for every pending marketplace set nobody pairs (what Save does with Pending; `own-set` is never proposed); a SportLots set outside the dialog's prefix filter, or one another type pairs, is counted in `leftUnasked`, not listed | a title clash |
 * | Group Parallels         | `detectGroupings`' prefix suggestions (insert types)  | a suggested parent whose name another row shares |
 * | Match Cards             | keep every unmatched card on both sides (the dialog's defaults) | a name / players disagreement on a pair (answered with a side, or `pairing.unlink` when it is two cards) |
 * | entity review           | `create` for a name with ZERO NB candidates, on every checklist carrying it | a name with one or more candidates (never linked by name; a player's fill-in offers `{ link, birthYear }` and lists each candidate's birth year), on every checklist carrying it; a player only one side of an unanswered card conflict carries (`conflictDependentPlayers`), its fill-in naming that conflict |
 * | counts                  | `expectCards` / `expectRows` / `expectUngrouped` as observed | — |
 * | builds                  | Parallel rows from Base; an insert's grouped parallels from the insert | — |
 * | autograph format        | never (no marketplace says it)                         | — : listed in `autographFormats`, not blocking |
 *
 * A checklist whose previewed cards carry "AU" asks how they are signed (the
 * wizard's "Autographed cards" step, NEO-345). That answer is the operator's
 * alone, so the draft never fills it and never blocks on it: each such
 * checklist is listed in `autographFormats` with the spec location its
 * `autographFormat` goes at. A spec without it still applies; the rows are
 * then listed by nb_attention until answered.
 *
 * Checklists are previewed with `previewCardChecklist`: by row when the row
 * exists with the drafted ids, cold (by ids from THIS draft's
 * `previewSetStructure` result, never from anywhere else) otherwise. The cold
 * form cannot preview a Base mapped to a BSC set other than the set's own
 * listing (a NEO-189 extra), nor any row on a set with no BSC listing of its
 * own; those checklists are open decisions.
 *
 * Names are classified with `previewChecklistEntities`, one-shot queries of at
 * most 200 names. Every checklist whose cards carry a name answers it, even
 * when an earlier one does too: apply decides it at the first checklist that
 * reaches it (Base, then each type's rows in order), and the later answers
 * are moot there (a reported no-op), so an earlier checklist that stops open
 * never strands a later one (NEO-339 live measurement: George Brett).
 *
 * ## Budgets and sessions (security audit)
 *
 * BSC's per-card team lookup (`lookupTeams`) is bounded per draft by
 * `teamLookupBudget` cards, checked before each preview; once spent, later
 * previews skip it. Nothing is retried. Once a marketplace answer reads as a
 * refused session, no further preview needing that side is sent, and each
 * skipped checklist is an open decision. No adapter message is copied into
 * the result: failures are reported by platform and class.
 *
 * Unresolved set: `{ status: "unresolved", candidates }` and nothing else is
 * read; when the brand-year's Sets were never synced, the one-step prepare
 * spec comes with it.
 */

import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { slotIds } from "../../../convex/platformSlots";
import { variantTypeKind } from "../../../convex/variantRole";
import { normalizeEntityName } from "../../../lib/entities/normalize-name";
import { carriesAutographToken } from "../../../convex/features/deriveCardFeatures";
import {
  AUTOGRAPH_CHOICE_LABEL,
  AUTOGRAPH_FORMATS,
  autographPromptLine,
} from "../../../components/SetSelector/autograph-prompt";
import { listBaseCandidates } from "../../../lib/set-build/base-candidates";
import { buildInitialState } from "../../../lib/set-build/grouping";
import {
  applyExplicitPairs,
  seedReconciliationState,
  type ExplicitPair,
} from "../../../lib/set-build/reconcile";
import { normalizeName as groupingKey } from "../../../components/SetSelector/parallelDetection";
import {
  heldIdSets,
  heldRowsReturnedBy,
  parallelsInTree,
  type HeldRow,
} from "../../../components/SetSelector/held-elsewhere";
import {
  planSinglePlatformStore,
  skippedSidesOf,
  storeItemsHitTwins,
} from "../../../components/SetSelector/selector-sync-feedback";
import type { NbClient } from "../client/convex-client";
import type { Target } from "../client/target";
import { pairCandidates, type ReadyCandidates, type ServedSide } from "../lib/fetch-checklist";
import { currentBaseMapping, openBaseCandidates, pickCandidate } from "../lib/map-base";
import {
  baseSlLabelsOf,
  dialogOpenDecisions,
  existingRowsForSeed,
  slPrefixesForFetch,
  type PendingSet,
} from "../lib/reconcile-variants";
import { cardCount } from "../lib/commit";
import { DECISION_PLACEHOLDER, SAME_NAME_PLAYER_PLACEHOLDER } from "../lib/review";
import {
  countOpenDecisions,
  DEFAULT_TEAM_LOOKUP_BUDGET,
  formatPath,
  MAX_TEAM_LOOKUP_BUDGET,
  ResolveError,
  specConfirmPhrase,
  type DraftAutographQuestion,
  type DraftOptions,
  type DraftProposal,
  type DraftReport,
  type DraftedReport,
  type OpenDecisions,
  type OpenReviewItem,
  type PlanStep,
  type ResolveCandidate,
  type RowRef as ServiceRowRef,
  type SetPath,
  type UnresolvedDraftReport,
} from "../service";
import { parseSpec, type RowRef } from "../spec/schema";
import { childrenOf, resolveBrandYear, resolveChild, tryResolveSetPath, type RowId, type SelectorRow } from "../spec/resolve";
import { emptyOpenDecisions, filedByOtherTypes, RunFailed, runSpec, setAt } from "./engine";
import { draftClient, readOnlyClient } from "./read-only-client";

type Structure = FunctionReturnType<typeof api.setReconciliation.previewSetStructure>;
type StructureType = Structure["types"][number];
type RawOptions = NonNullable<StructureType["candidates"]>;
type CardPreview = FunctionReturnType<typeof api.selectorOptions.previewCardChecklist>;
type PreviewCard = CardPreview["bscOnly"][number];
type EntityPreview = FunctionReturnType<typeof api.selectorOptions.previewChecklistEntities>;
type Side = "bsc" | "sportlots";
type PreviewRequest =
  | { selectorOptionId: RowId }
  | { cold: NonNullable<FunctionArgs<typeof api.selectorOptions.previewCardChecklist>["cold"]> };

/** `previewChecklistEntities`' per-call cap (players + teams), mirrored. */
export const ENTITY_NAMES_PER_CALL = 200;
/** The cold form's per-list id cap, mirrored (`PREVIEW_MAX_IDS_PER_LIST`). */
export const COLD_IDS_PER_LIST = 10;
/** Rows the cold brand walk reads at most (`MAX_BRAND_HOLDER_ROWS`, mirrored). */
export const MAX_BRAND_WALK_ROWS = 2000;

export interface DraftRunOptions extends DraftOptions {
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A `<…>` fill-in: what an answers file replaces. */
export function isPlaceholder(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("<");
}

/**
 * The draft's `template` with every `<…>` fill-in replaced by the value at
 * the same place in `answers` (a complete spec, e.g. `playwright/seed/
 * oneshot.spec.json`). Everything else comes from the template, so the
 * result equals `answers` exactly when the draft drafted everything the
 * answers hold besides those fill-ins. `credentials` is the one key taken
 * from `answers` wholesale: it sets up the run's account, not the set. A
 * checklist's `autographFormat` is taken from `answers` too (the draft never
 * drafts one: it is the operator's answer, listed in `autographFormats`).
 * A `pairing.unlink` in the answers is the other answer to a card conflict:
 * it is taken, and the template's conflict fill-ins for the pairs it names
 * are dropped (the answers file deletes them too).
 * Pure; a fill-in the answers do not reach stays a fill-in.
 */
export function mergeDraftAnswers(template: unknown, answers: unknown): unknown {
  const walk = (t: unknown, a: unknown, key?: string): unknown => {
    if (isPlaceholder(t)) return a === undefined ? t : structuredClone(a);
    if (Array.isArray(t)) return t.map((v, i) => walk(v, Array.isArray(a) ? a[i] : undefined));
    if (t && typeof t === "object") {
      const ao = a && typeof a === "object" && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
      let to = key === "pairing" ? withUnlinkAnswers(t as Record<string, unknown>, ao) : (t as Record<string, unknown>);
      if (key === "checklist" && ao.autographFormat !== undefined && !("autographFormat" in to)) {
        to = { ...to, autographFormat: structuredClone(ao.autographFormat) };
      }
      return Object.fromEntries(Object.entries(to).map(([k, v]) => [k, walk(v, ao[k], k)]));
    }
    return t;
  };
  const merged = walk(template, answers) as Record<string, unknown>;
  const creds = answers && typeof answers === "object" ? (answers as Record<string, unknown>).credentials : undefined;
  if (creds !== undefined && merged && typeof merged === "object") return { ...merged, credentials: structuredClone(creds) };
  return merged;
}

/**
 * A template `pairing` with the answers' `unlink` taken in: the list itself,
 * less every conflict fill-in (an unanswered `choose`) on a pair it names.
 */
function withUnlinkAnswers(t: Record<string, unknown>, a: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(a.unlink) || a.unlink.length === 0) return t;
  const unlink = a.unlink as Array<{ bsc?: unknown; sportlots?: unknown }>;
  const out: Record<string, unknown> = { ...t, unlink: structuredClone(a.unlink) };
  if (Array.isArray(t.conflicts)) {
    const kept = (t.conflicts as Array<Record<string, unknown>>).filter(
      (c) => !(isPlaceholder(c.choose) && unlink.some((u) => u.bsc === c.bsc && u.sportlots === c.sportlots)),
    );
    if (kept.length > 0 || Array.isArray(a.conflicts)) out.conflicts = kept;
    else delete out.conflicts;
  }
  return out;
}

/** Every `<…>` fill-in left in a value, by path. */
export function placeholdersIn(value: unknown, at = ""): string[] {
  if (isPlaceholder(value)) return [at || "(root)"];
  if (Array.isArray(value)) return value.flatMap((v, i) => placeholdersIn(v, `${at}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => placeholdersIn(v, at ? `${at}.${k}` : k));
  }
  return [];
}

const AUTH_CLASS = /\b(401|403)\b|sign(ed)?[ -]?(in|out)|log ?in|re-?auth|credential|session|unauthori[sz]ed/i;

/** A failure's class, read off adapter text that is never repeated: "session" or "failed". */
export function failureClass(message: string | undefined): "session" | "failed" {
  return message && AUTH_CLASS.test(message) ? "session" : "failed";
}

/** The marketplace side(s) a failure text names; both when it names neither. */
export function sidesNamed(message: string | undefined): Side[] {
  const text = message ?? "";
  const bsc = /\bbsc\b|buysportscards/i.test(text);
  const sl = /\bsl\b|sportlots/i.test(text);
  if (bsc === sl) return ["bsc", "sportlots"];
  return bsc ? ["bsc"] : ["sportlots"];
}

/** A preview's cards in `getReadyCandidates`' shape, so `pairCandidates` reads them as the dialog would. */
export function previewAsCandidates(p: Pick<CardPreview, "matched" | "bscOnly" | "slOnly">): ReadyCandidates {
  const cards: Array<Record<string, unknown>> = [];
  let n = 0;
  const push = (card: PreviewCard, bucket: "matched" | "bscOnly" | "slOnly", confidence?: number) =>
    cards.push({
      ...card,
      _id: `preview-${n++}`,
      bucket,
      ...(confidence !== undefined ? { confidence } : {}),
      stem: card.cardNumber,
      teamResolved: true,
    });
  for (const m of p.matched) push(m.card, "matched", m.confidence);
  for (const c of p.bscOnly) push(c, "bscOnly");
  for (const c of p.slOnly) push(c, "slOnly");
  return { batchId: "preview", total: cards.length, ready: cards.length, cards } as unknown as ReadyCandidates;
}

/**
 * Keep in step with `cardTeamNames` in convex/selectorOptions.ts (a private
 * helper of a server module): `teams[]`, else the legacy `team`, trimmed and
 * deduped.
 */
function cardTeams(card: { team?: string; teams?: string[] }): string[] {
  const named = (card.teams ?? []).map((t) => t.trim()).filter(Boolean);
  if (named.length === 0 && card.team?.trim()) named.push(card.team.trim());
  return [...new Set(named)];
}

/** Player and team names on previewed cards (both sides of a players disagreement), first spelling per normalized name. */
export function namesOnCards(cards: ReadonlyArray<PreviewCard>): {
  players: string[];
  teams: string[];
  playerCardTeams: Map<string, string[]>;
} {
  const players = new Map<string, string>();
  const teams = new Map<string, string>();
  const playerCardTeams = new Map<string, string[]>();
  for (const c of cards) {
    const onCard = cardTeams(c as { team?: string; teams?: string[] });
    const names = [...(c.players ?? []), ...(c.playersConflict?.bsc ?? []), ...(c.playersConflict?.sportlots ?? [])];
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      const key = normalizeEntityName(name);
      if (!players.has(key)) players.set(key, name);
      const list = playerCardTeams.get(players.get(key)!) ?? [];
      for (const t of onCard) if (!list.includes(t) && list.length < 8) list.push(t);
      playerCardTeams.set(players.get(key)!, list);
    }
    for (const t of onCard) {
      const key = normalizeEntityName(t);
      if (!teams.has(key)) teams.set(key, t);
    }
  }
  return { players: [...players.values()], teams: [...teams.values()], playerCardTeams };
}

/** A players disagreement a name depends on: the side whose roster carries it. */
export interface ConflictDependency {
  cardNumber: string;
  side: "bsc" | "sportlots";
}

/**
 * Player names the review asks about only once a card's players conflict is
 * answered: each name that appears on ONE side of an unanswered disagreement
 * and on no other card of the checklist (nor on both sides of a
 * disagreement). Keyed by normalized name, with every conflict it rides on.
 * Pure.
 *
 * A conflicted card carries BSC's roster in `players` until the operator
 * chooses (the merge default, convex/selectorOptions.ts), so its `players` is
 * read as the BSC side, never as settled.
 */
export function conflictDependentPlayers(cards: ReadonlyArray<PreviewCard>): Map<string, ConflictDependency[]> {
  const settled = new Set<string>();
  const keyOf = (name: string) => normalizeEntityName(name.trim());
  for (const c of cards) {
    const conflict = c.playersConflict;
    if (!conflict) {
      for (const n of c.players ?? []) if (n.trim()) settled.add(keyOf(n));
      continue;
    }
    const sl = new Set(conflict.sportlots.map(keyOf));
    for (const n of conflict.bsc) if (sl.has(keyOf(n))) settled.add(keyOf(n));
  }
  const out = new Map<string, ConflictDependency[]>();
  for (const c of cards) {
    const conflict = c.playersConflict;
    if (!conflict) continue;
    for (const side of ["bsc", "sportlots"] as const) {
      const other = new Set(conflict[side === "bsc" ? "sportlots" : "bsc"].map(keyOf));
      for (const n of conflict[side]) {
        const key = keyOf(n);
        if (!n.trim() || settled.has(key) || other.has(key)) continue;
        const list = out.get(key) ?? [];
        if (!list.some((d) => d.cardNumber === c.cardNumber && d.side === side)) list.push({ cardNumber: c.cardNumber, side });
        out.set(key, list);
      }
    }
  }
  return out;
}

const sideName = (side: "bsc" | "sportlots") => (side === "bsc" ? "BSC" : "SportLots");

/** "card #21's players conflict is answered "sportlots"", for every conflict a name rides on. */
export function dependencyText(deps: readonly ConflictDependency[]): string {
  return deps.map((d) => `card #${d.cardNumber}'s players conflict is answered "${d.side}" (the ${sideName(d.side)} roster)`).join(", or ");
}

/** Slice players then teams into calls of at most `per` names together. */
export function entitySlices(players: readonly string[], teams: readonly string[], per = ENTITY_NAMES_PER_CALL) {
  const all = [...players.map((name) => ({ kind: "player" as const, name })), ...teams.map((name) => ({ kind: "team" as const, name }))];
  const out: Array<{ players: string[]; teams: string[] }> = [];
  for (let i = 0; i < all.length; i += per) {
    const chunk = all.slice(i, i + per);
    out.push({ players: chunk.filter((c) => c.kind === "player").map((c) => c.name), teams: chunk.filter((c) => c.kind === "team").map((c) => c.name) });
  }
  return out;
}

const pick = (cands: ReadonlyArray<{ id: string; name: string }>) =>
  `<one of: ${cands.map((c) => `${c.id} (${c.name})`).join(" | ") || "(none offered)"}>`;

// ---------------------------------------------------------------------------
// The summary a result carries by default
// ---------------------------------------------------------------------------

/** How much detail a draft result carries: `summary` (the default) or `full`. */
export type DraftDetail = "summary" | "full";

/** Proposals kept per kind in a summary. */
export const SUMMARY_PROPOSALS_PER_KIND = 5;
/** Steps kept in a summary: the ones not done yet, in order. */
export const SUMMARY_STEPS = 40;
/** Notes kept in a summary. */
export const SUMMARY_NOTES = 20;
/** SportLots sets outside the set's filter kept per variant type in a summary. */
export const SUMMARY_OUTSIDE_SCOPE = 5;

export const DRAFT_SUMMARY_HINT =
  'Lists are cut to the first few; every count is complete. Draft again with detail "full" (CLI: --detail full) ' +
  "for every entry. The template, or the spec when nothing is open, is always complete: fill it in and plan it.";

export type CompactDraftReport = Omit<DraftedReport, "spec"> & { spec?: DraftedReport["spec"] };

/**
 * A draft cut to stay readable (NEO-339 live: 641,833 characters on 2014
 * Topps Chrome). What a run needs stays whole: the template (or, with nothing
 * open, the spec), every open decision, the confirm phrase. `spec` is left
 * out while `template` carries it with the fill-ins. Proposals keep the first
 * few of each kind, steps the ones not done yet up to a cap, notes and the
 * out-of-scope SportLots lists a short sample; `summary` says what was cut.
 * Pure; an unresolved report is returned as it is.
 */
export function compactDraftReport(r: DraftReport, detail: DraftDetail = "summary"): DraftReport | CompactDraftReport {
  if (r.status !== "drafted" || detail === "full") return r;
  // Each list read defensively: a stub service (the MCP tests) returns a partial report.
  const allProposals = r.proposals ?? [];
  const allSteps = r.steps ?? [];
  const allNotes = r.notes ?? [];
  const proposalCounts: Record<string, number> = {};
  const proposals = allProposals.filter((p) => {
    proposalCounts[p.kind] = (proposalCounts[p.kind] ?? 0) + 1;
    return proposalCounts[p.kind] <= SUMMARY_PROPOSALS_PER_KIND;
  });
  const stepCounts: Record<string, number> = {};
  for (const s of allSteps) stepCounts[s.status] = (stepCounts[s.status] ?? 0) + 1;
  // What apply still has to do, in order; the done steps are counted only.
  const steps = allSteps.filter((s) => s.status !== "done").slice(0, SUMMARY_STEPS);
  let outsideCut = 0;
  const leftUnasked = (r.leftUnasked ?? []).map((l) => {
    outsideCut += Math.max(0, l.outsideScopeSets.length - SUMMARY_OUTSIDE_SCOPE);
    return { ...l, outsideScopeSets: l.outsideScopeSets.slice(0, SUMMARY_OUTSIDE_SCOPE) };
  });
  const { spec, ...rest } = r;
  const specInTemplate = r.template !== null && r.template !== undefined;
  return {
    ...rest,
    ...(specInTemplate ? {} : { spec }),
    proposals,
    steps,
    notes: allNotes.slice(0, SUMMARY_NOTES),
    leftUnasked,
    summary: {
      proposalCounts,
      stepCounts,
      omitted: {
        proposals: allProposals.length - proposals.length,
        steps: allSteps.length - steps.length,
        notes: Math.max(0, allNotes.length - SUMMARY_NOTES),
        outsideScopeSets: outsideCut,
      },
      specInTemplate,
      hint: DRAFT_SUMMARY_HINT,
    },
  };
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

interface DraftRow {
  /** NB name the row has (or will have once the sync saves it). */
  name: string;
  bsc: string[];
  sportlots: string[];
  existingId?: RowId;
}

export async function draftSet(
  inner: NbClient,
  target: Target,
  path: SetPath,
  opts: DraftRunOptions = {},
): Promise<DraftReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const client = draftClient(inner);
  const pathText = formatPath(path);
  const head = { target: { convexUrl: target.convexUrl, host: target.host }, path, pathText };
  const wantChecklists = opts.checklists !== false;
  const wantBuilds = opts.builds !== false;
  let teamBudget = Math.max(0, Math.min(MAX_TEAM_LOOKUP_BUDGET, Math.floor(opts.teamLookupBudget ?? DEFAULT_TEAM_LOOKUP_BUDGET)));
  let marketplaceCalls = 0;

  // ── Resolve the set, or report and stop ──────────────────────────────────
  const resolved = await tryResolveSetPath(client, path);
  if (!resolved.ok) return unresolved(resolved.error);
  const set = resolved.value;
  const setRow = set.rows.set;
  const manufacturer = set.rows.manufacturer.value;

  const proposals: DraftProposal[] = [];
  const open = emptyOpenDecisions();
  const notes: string[] = [];
  const leftUnasked: DraftedReport["leftUnasked"] = [];
  /** NEO-345: drafted checklists whose cards carry "AU": the operator says how they are signed. */
  const autographFormats: DraftAutographQuestion[] = [];
  const fills: Array<{ at: string; value: unknown }> = [];
  const propose = (at: string, kind: DraftProposal["kind"], detail: string) => proposals.push({ at, kind, detail });
  const openCondition = (at: string, kind: string, name: string, detail: string, value?: unknown) => {
    open.names.push({ at, kind, name, candidates: [], detail });
    if (value !== undefined) fills.push({ at, value });
  };
  /** Sides whose session a preview reported refused: no further preview needing them is sent. */
  const refusedSides = new Set<Side>();
  const refuse = (sides: Side[], where: string) => {
    for (const s of sides) {
      if (!refusedSides.has(s)) notes.push(`${s === "bsc" ? "BSC" : "SportLots"} refused the session at ${where}; no further preview needing it was sent.`);
      refusedSides.add(s);
    }
  };

  const step: Record<string, unknown> = { kind: "set", path: { ...path }, variantTypes: { sync: true } };
  const spec: Record<string, unknown> = { version: 1, scope: pathText, steps: [step] };
  const at0 = "steps[0]";

  // ── Structure ────────────────────────────────────────────────────────────
  let structure = await client.action(api.setReconciliation.previewSetStructure, { setId: set.setId });
  marketplaceCalls += structure.marketplaceCalls;
  if (structure.types.length === 0) {
    const errs = structure.variantTypes.errors;
    openCondition(`${at0}.variantTypes`, "set-structure", pathText,
      `the set's variant types could not be read (${errs.map((e) => `${e.platform} ${failureClass(e.message)}`).join(", ") || "none listed"}); nothing below the set could be drafted`);
    for (const e of errs) if (failureClass(e.message) === "session") refuse(e.platform === "bsc" ? ["bsc"] : ["sportlots"], "the variant-type read");
    return finish();
  }
  const existingTypes = await childrenOf(client, "variantType", set.setId);
  const typeRowFor = (t: StructureType) => existingTypes.find((r) => slotIds(r, "bsc").includes(t.bscVariantId));

  // ── Base mapping ─────────────────────────────────────────────────────────
  const baseType = structure.types.find((t) => t.role === "base");
  const baseRow = existingTypes.find((r) => variantTypeKind(r) === "base");
  let baseMap: { bsc: string; sportlots?: string } | undefined;
  let baseOpen = false;
  const mapAt = `${at0}.base.map`;
  const setListing = slotIds(setRow, "bsc")[0];
  if (baseRow && currentBaseMapping(baseRow).bsc) {
    const mapped = currentBaseMapping(baseRow);
    baseMap = { bsc: mapped.bsc!, ...(mapped.sportlots ? { sportlots: mapped.sportlots } : {}) };
    propose(mapAt, "base-map", "the Base is already mapped; the draft keeps its ids");
  } else if (!baseType?.candidates) {
    baseOpen = true;
    openCondition(mapAt, "base-candidates", "Base",
      baseType ? "the Base candidates were not fetched" : "BSC lists no Base variant for this set",
      { bsc: "<the Base's BSC set id>", whenPaused: "bsc-only" });
  } else {
    const list = listBaseCandidates(baseType.candidates, setRow, manufacturer);
    const decideSide = (side: "bsc" | "sportlots"): string | null | undefined => {
      const ids = side === "bsc" ? list.bsc.map((c) => c.item.platformValue) : list.sl.map((c) => c.platformValue);
      if (ids.length === 0) return undefined;
      const pre =
        side === "bsc"
          ? list.bsc.find((c) => c.key === list.preselected.bsc)?.item.platformValue
          : list.preselected.sl ?? undefined;
      const sole = new Set(ids).size === 1;
      const chosen = sole ? ids[0] : pre;
      if (chosen && pickCandidate(list, side, chosen).ok) {
        why.push(`${side === "bsc" ? "BSC" : "SportLots"}: ${sole ? "the sole candidate" : "the candidate the dialog pre-selects (its sole exact match)"}`);
        return chosen;
      }
      return null;
    };
    const why: string[] = [];
    const bsc = decideSide("bsc");
    const sl = decideSide("sportlots");
    if (bsc === null || bsc === undefined) {
      baseOpen = true;
      open.baseCandidates.push(openBaseCandidates(list, "buysportscards", `${mapAt}.bsc`, pathText));
      fills.push({ at: `${mapAt}.bsc`, value: pick(openBaseCandidates(list, "buysportscards", "", "").candidates) });
    }
    if (sl === null) {
      baseOpen = true;
      open.baseCandidates.push(openBaseCandidates(list, "sportlots", `${mapAt}.sportlots`, pathText));
      fills.push({ at: `${mapAt}.sportlots`, value: pick(openBaseCandidates(list, "sportlots", "", "").candidates) });
    }
    if (!baseOpen) {
      baseMap = { bsc: bsc!, ...(sl ? { sportlots: sl } : {}) };
      propose(mapAt, "base-map", `${why.join("; ")}${sl ? "" : "; SportLots offers no candidate"}`);
    } else {
      fills.push({ at: `${mapAt}.whenPaused`, value: "bsc-only" });
      if (bsc) fills.push({ at: `${mapAt}.bsc`, value: bsc });
      if (sl) fills.push({ at: `${mapAt}.sportlots`, value: sl });
      notes.push("The Base mapping is open: the Insert/Parallel candidates were read against the set's current Base, so re-draft once it is answered.");
    }
  }
  if (baseMap) {
    step.base = { map: { ...baseMap, whenPaused: "bsc-only" } };
    // The insert-level lists drop the Base's own SportLots set and match
    // against its label: re-read them against THIS draft's pick when the
    // first read used another one (or none).
    if (baseMap.sportlots && structure.baseSportlots?.id !== baseMap.sportlots) {
      structure = await client.action(api.setReconciliation.previewSetStructure, { setId: set.setId, baseSportlotsId: baseMap.sportlots });
      marketplaceCalls += structure.marketplaceCalls;
    }
  }
  for (const t of structure.types) {
    for (const e of t.candidates?.errors ?? []) {
      if (failureClass(e.message) === "session") refuse(e.platform === "bsc" ? ["bsc"] : ["sportlots"], `the ${t.label} candidates`);
    }
  }

  // ── Name bookkeeping across checklists (apply order) ─────────────────────
  /** The Base's card count as drafted; undefined when not previewed. */
  let baseCardsDrafted: number | undefined;

  // ── Base checklist ──────────────────────────────────────────────────────
  if (!wantChecklists && baseRow) baseCardsDrafted = await cardCount(client, baseRow._id);
  if (wantChecklists) {
    const at = `${at0}.base.checklist`;
    if (baseOpen || !baseType) {
      openCondition(at, "checklist-preview", "Base", "the Base checklist is previewed once the Base mapping is answered; re-draft then",
        { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, review: "<re-draft once the Base mapping is answered>" });
    } else {
      const baseCards = baseRow ? await cardCount(client, baseRow._id) : 0;
      if (baseRow && baseCards > 0) {
        (step.base as Record<string, unknown>).checklist = doneChecklist(baseCards);
        baseCardsDrafted = baseCards;
        propose(at, "already-built", `the Base already holds ${baseCards} cards`);
      } else {
        const sameAsDrafted = baseRow && currentBaseMapping(baseRow).bsc === baseMap!.bsc && currentBaseMapping(baseRow).sportlots === baseMap!.sportlots;
        let request: PreviewRequest | string;
        if (sameAsDrafted) request = { selectorOptionId: baseRow!._id };
        else if (!setListing) request = "the set has no BSC listing of its own, which the cold preview reads";
        else if (baseMap!.bsc !== setListing) request = "the Base maps a BSC set other than the set's own listing (a NEO-189 extra), which the cold preview cannot read";
        else {
          request = {
            cold: {
              setId: set.setId,
              variantType: { bscVariantId: baseType.bscVariantId, ...(baseMap!.sportlots ? { sportlotsIds: [baseMap!.sportlots] } : {}) },
            },
          };
        }
        const sides: Side[] = baseMap!.sportlots ? ["bsc", "sportlots"] : ["bsc"];
        const c = await draftChecklist(at, "Base", null, request, sides, baseRow?._id ?? set.setId);
        if (c) {
          (step.base as Record<string, unknown>).checklist = c;
          baseCardsDrafted = c.expectCards as number;
        }
      }
    }
  }

  // ── Variant types ────────────────────────────────────────────────────────
  const variants: Array<Record<string, unknown>> = [];
  const usedSoFar = { bsc: new Set<string>(), sportlots: new Set<string>() };
  let brandHolders: HeldRow[] | null = null;
  const typed = structure.types.filter((t) => t.role === "insert" || t.role === "parallel");
  // The dialog's SportLots prefix filter reads the Base's SportLots labels:
  // the mapped Base's slots, or the label of the set this draft maps it to.
  const baseSlLabels =
    baseRow && baseMap && currentBaseMapping(baseRow).sportlots === baseMap.sportlots
      ? baseSlLabelsOf(baseRow as never)
      : baseMap?.sportlots && structure.baseSportlots?.id === baseMap.sportlots
        ? [structure.baseSportlots.label]
        : [];
  /** Per type, the sets the dialog leaves in Pending: settled once every type's pairs are known. */
  const pendingByType: Array<{ j: number; at: string; title: string; leave: PendingSet[]; outsideScope: PendingSet[] }> = [];
  for (const t of structure.types) {
    if (t.role === null) notes.push(`BSC lists a "${t.label}" variant whose title is not Base, Insert or Parallel; the variant-type sync creates it, the draft has no rows for it.`);
  }
  for (let j = 0; j < typed.length; j++) {
    const t = typed[j];
    const at = `${at0}.variants[${j}]`;
    const typeRow = typeRowFor(t);
    const title = typeRow?.value ?? t.label;
    const entry: Record<string, unknown> = { type: title };
    variants.push(entry);
    const result = t.candidates;
    if (!result) {
      openCondition(`${at}.sync`, "variant-candidates", title, "its candidates were not fetched (past the preview's type cap)");
      continue;
    }
    if (!result.success || (result.bscOptions.length === 0 && result.slOptions.length === 0 && result.errors.length > 0)) {
      openCondition(`${at}.sync`, "variant-candidates", title,
        `its candidates could not be read (${result.errors.map((e) => `${e.platform} ${failureClass(e.message)}`).join(", ") || "no detail"})`);
      continue;
    }

    // What the form loads before it fetches (reconcile-variants'
    // `loadReconcileContext`), or its cold equivalent.
    let existingRows: SelectorRow[] = [];
    let grouped: HeldRow[] = [];
    let tree: Awaited<ReturnType<typeof insertTree>> = [];
    if (typeRow) {
      existingRows = await childrenOf(client, "insert", typeRow._id);
      tree = await insertTree(typeRow._id);
      grouped = parallelsInTree(tree);
    }
    if (brandHolders === null) brandHolders = await brandSlHolders(existingTypes[0]?._id);
    const used = await client.query(api.selectorOptions.getUsedInsertIdentifiersBySet, {
      setId: set.setId,
      ...(typeRow ? { excludeVariantTypeId: typeRow._id } : {}),
    });
    const usedIds = {
      bsc: [...used.bscPlatformValues, ...usedSoFar.bsc],
      sportlots: [...used.slPlatformValues, ...usedSoFar.sportlots],
    };
    const groupedHeld = heldRowsReturnedBy(grouped, result);
    const brandHeld = heldRowsReturnedBy(brandHolders, result);

    let rows: DraftRow[];
    const bothSides = result.bscOptions.length > 0 && result.slOptions.length > 0;
    const single = bothSides ? null : singlePlatform(result, [...groupedHeld, ...brandHeld], usedIds);
    if (single && single.kind === "blocked") {
      openCondition(`${at}.sync`, "variant-candidates", title, `a marketplace failed (${single.labels.join(", ")})`);
      continue;
    }
    if (single && single.kind === "store") {
      rows = single.items;
      entry.sync = { pairs: rows.map(pairOf), pending: [] };
      propose(`${at}.sync`, "reconcile-pairs", `one marketplace returned ${title} sets, so the form stores all ${rows.length} without asking`);
    } else {
      const seed = seedReconciliationState({
        fetch: { autoMatched: result.autoMatched, unmatchedBsc: result.unmatchedBsc, unmatchedSl: result.unmatchedSl },
        existingRows: existingRowsForSeed(existingRows),
        heldElsewhere: { rows: groupedHeld },
        heldInBrand: { rows: brandHeld },
        usedIds,
      });
      const pairs: Array<ExplicitPair & { bsc?: string[]; sportlots?: string[] }> = seed.state.ready.map((s) => ({
        name: s.title,
        ...(s.bsc.length ? { bsc: s.bsc.map((i) => i.platformValue) } : {}),
        ...(s.sl.length ? { sportlots: s.sl.map((i) => i.platformValue) } : {}),
      }));
      const fetched = {
        bsc: [...result.bscOptions, ...result.unmatchedBsc, ...result.autoMatched.map((m) => m.bsc)].map((o) => o.platformValue),
        sportlots: [...result.slOptions, ...result.unmatchedSl, ...result.autoMatched.map((m) => m.sl)].map((o) => o.platformValue),
      };
      const outcome = applyExplicitPairs(seed.state, pairs, [], { fetched });
      const decisions = dialogOpenDecisions({
        outcome,
        pairs,
        pending: [],
        savedSiblings: seed.savedSiblings,
        at,
        path: pathText,
        type: title,
        slPrefixes: slPrefixesForFetch({ setName: setRow.value, manufacturer, baseSlLabels }, result),
      });
      open.names.push(...decisions.names);
      const clashed = new Set(decisions.names.filter((n) => n.kind === "reconcile-title").map((n) => n.name));
      const syncPairs = pairs.map((p) => ({ name: p.name, ...(p.bsc ? { bsc: [...p.bsc] } : {}), ...(p.sportlots ? { sportlots: [...p.sportlots] } : {}) }));
      // Every marketplace set nobody pairs: an explicit `leave`, one line per
      // id with the marketplace's name for it (Jason, 2026-10-11). It is what
      // Save does with a set left in Pending; `own-set` is never proposed.
      // Settled after the loop: a set another type pairs is not listed here.
      // A SportLots set outside the dialog's prefix filter (another product
      // of the brand-year) is not listed at all, only counted.
      entry.sync = { pairs: syncPairs, pending: [] };
      pendingByType.push({
        j,
        at,
        title,
        leave: decisions.reconcile.pending.map((p) => ({
          side: p.side === "buysportscards" ? ("bsc" as const) : ("sportlots" as const),
          id: p.id,
          name: p.name,
        })),
        outsideScope: decisions.left.outsideScope,
      });
      syncPairs.forEach((p, k) => {
        if (clashed.has(p.name)) fills.push({ at: `${at}.sync.pairs[${k}].name`, value: `<rename: two sets would save as "${p.name}">` });
      });
      // An auto-match the dialog would offer as a pair is never left silently
      // (the draft names every Ready set, so this stays empty; kept open if not).
      if (decisions.reconcile.proposedPairs.length > 0) {
        open.reconcile.push({ ...decisions.reconcile, pending: [] });
      }
      if (pairs.length > 0) propose(`${at}.sync.pairs`, "reconcile-pairs", `the Reconcile dialog's ${pairs.length} Ready set(s) (its auto-matches and saved rows, by marketplace id)`);
      rows = seed.state.ready.map((s) => ({
        name: s.title,
        bsc: s.bsc.map((i) => i.platformValue),
        sportlots: s.sl.map((i) => i.platformValue),
        ...(s.existingId ? { existingId: s.existingId } : {}),
      }));
    }
    for (const r of rows) {
      for (const id of r.bsc) usedSoFar.bsc.add(id);
      for (const id of r.sportlots) usedSoFar.sportlots.add(id);
    }

    // Rows the type will hold after the sync: these, the saved rows the seed
    // did not carry (no marketplace id), and the parallels already grouped.
    const listed = new Set(rows.map((r) => r.existingId).filter(Boolean));
    const unseeded = existingRows.filter((r) => !listed.has(r._id));
    const expectRows = rows.length + unseeded.length + grouped.length;
    entry.expectRows = expectRows;
    propose(`${at}.expectRows`, "expect", `${expectRows} rows after the sync, as drafted`);

    // Group Parallels (insert types only: a Parallel row grouped under
    // another would stop being a row Build from Base can reach).
    const children = new Map<string, string[]>();
    const childNames = new Set<string>();
    if (t.role === "insert") {
      const grouping = draftGrouping(rows, unseeded, tree, `${at}.group`, title);
      if (grouping.parents.length > 0) {
        entry.group = { parents: grouping.parents, expectUngrouped: grouping.ungrouped };
        propose(`${at}.group`, "grouping", `${grouping.moves} prefix suggestion(s) from Group Parallels (detectGroupings), under ${grouping.parents.length} insert(s)`);
      }
      for (const [parent, kids] of grouping.children) children.set(parent, kids);
      for (const n of grouping.groupedRowNames) childNames.add(n);
    }

    // Rows: Parallel rows built from Base; insert rows' checklists and parallels.
    const rowSpecs: Array<Record<string, unknown>> = [];
    let k = 0;
    for (const r of rows) {
      if (childNames.has(r.name)) continue;
      const rowAt = `${at}.rows[${k}]`;
      const spec: Record<string, unknown> = { name: r.name };
      if (t.role === "parallel") {
        if (!wantBuilds) continue;
        // Built only from a Base that will hold cards: one the draft saw
        // cards for, or one whose open checklist apply waits on.
        if (!(baseCardsDrafted !== undefined ? baseCardsDrafted > 0 : wantChecklists)) {
          notes.push(`${title} › ${r.name}: not built from Base, which ${baseCardsDrafted === 0 ? "previewed no cards" : "holds no cards and has no checklist in this draft"}.`);
          continue;
        }
        spec.buildFromBase = {};
        propose(`${rowAt}.buildFromBase`, "build", `build ${title} › ${r.name} from Base`);
      } else {
        // Every insert row is listed (at least as "find it"), so a fill-in
        // recorded at this row's index lands on this row.
        let rowCards: number | undefined;
        if (wantChecklists) {
          const c = await rowChecklist(`${rowAt}.checklist`, { type: title, name: r.name }, r, t);
          if (c) {
            spec.checklist = c;
            rowCards = c.expectCards as number | undefined;
          }
        }
        const kids = children.get(r.name) ?? [];
        if (kids.length > 0) {
          // Same rule as Build from Base: the insert must be going to hold cards.
          const build = wantBuilds && (rowCards !== undefined ? rowCards > 0 : wantChecklists);
          if (wantBuilds && !build) notes.push(`${title} › ${r.name}: its parallels are not built, since ${rowCards === 0 ? "its checklist previewed no cards" : "this draft has no checklist for it"}.`);
          spec.parallels = kids.map((kid) => ({ name: kid, ...(build ? { build: {} } : {}) }));
          if (build) propose(`${rowAt}.parallels`, "build", `build ${kids.length} parallel(s) of ${r.name} from its checklist`);
        }
      }
      rowSpecs.push(spec);
      k++;
    }
    if (rowSpecs.length > 0) entry.rows = rowSpecs;
  }
  settlePending();
  if (variants.length > 0) step.variants = variants;
  return finish();

  // ── helpers (closures over the draft's state) ────────────────────────────

  /**
   * Each type's `leave` list, now that every type's pairs are known: a set
   * another type of the set pairs (or makes its own set) is that type's to
   * file, so it is not left here (apply leaves it unasked:
   * `filedByOtherTypes`). One `reconcile-leave` proposal per type.
   */
  function settlePending() {
    const asSteps = variants as unknown as Parameters<typeof filedByOtherTypes>[0];
    for (const p of pendingByType) {
      const elsewhere = filedByOtherTypes(asSteps, p.j);
      const filed = { bsc: new Set(elsewhere.bsc), sportlots: new Set(elsewhere.sportlots) };
      const leave = p.leave.filter((l) => !filed[l.side].has(l.id));
      const pairedElsewhere = p.leave.length - leave.length;
      (variants[p.j].sync as { pending: unknown[] }).pending = leave.map((l) => ({ side: l.side, id: l.id, name: l.name, decision: "leave" }));
      if (p.outsideScope.length + pairedElsewhere > 0) {
        leftUnasked.push({
          at: `${p.at}.sync.pending`,
          type: p.title,
          outsideScope: p.outsideScope.length,
          pairedElsewhere,
          outsideScopeSets: p.outsideScope.map((o) => ({ id: o.id, name: o.name })),
        });
      }
      if (leave.length + p.outsideScope.length + pairedElsewhere === 0) continue;
      const count = (side: Side) => leave.filter((l) => l.side === side).length;
      const sides = [count("bsc") ? `BSC ${count("bsc")}` : "", count("sportlots") ? `SportLots ${count("sportlots")}` : ""].filter(Boolean).join(", ");
      const unasked = [
        p.outsideScope.length ? `${p.outsideScope.length} SportLots set(s) outside this set's SportLots filter (other products of the brand-year)` : "",
        pairedElsewhere ? `${pairedElsewhere} set(s) another variant type pairs` : "",
      ].filter(Boolean);
      propose(
        `${p.at}.sync.pending`,
        "reconcile-leave",
        (leave.length
          ? `${leave.length} ${p.title} set(s) not paired (${sides}); Save leaves them in Pending. Each is listed with its name: pair any that belong together.`
          : `No ${p.title} set is left unpaired.`) +
          (unasked.length ? ` Not asked about: ${unasked.join("; ")}.` : ""),
      );
    }
  }

  function unresolved(err: ResolveError): Promise<UnresolvedDraftReport> {
    return (async () => {
      const report: UnresolvedDraftReport = {
        status: "unresolved",
        ...head,
        kind: err.kind,
        message: err.message,
        candidates: err.candidates,
        marketplaceCalls: 0,
        durationMs: 0,
      };
      const brandYear = { sport: path.sport, year: path.year, manufacturer: path.manufacturer };
      const brandYearText = formatPath(brandYear);
      const prepare = (reason: string) => ({
        reason,
        spec: { version: 1, scope: brandYearText, steps: [{ kind: "brand-year", path: brandYear, syncSets: true }] },
      });
      if (err.kind === "set") {
        const brand = await resolveBrandYear(client, brandYear);
        const sets = await childrenOf(client, "setName", brand.manufacturerId);
        if (sets.length === 0) {
          report.message = unsyncedMessage(brandYearText, "Sets");
          report.prepare = prepare(`${brandYearText}'s Sets have never been synced; apply this, then draft again.`);
        }
      } else if (err.candidates.length === 0) {
        // The name matched nothing. When the column it sits in holds no rows
        // at all, that column was never synced: the name is not unknown, the
        // brand's year just is not in NeonBinder yet.
        if (await columnEmpty(err.kind)) report.message = unsyncedMessage(brandYearText);
        report.prepare = prepare(`${brandYearText} does not resolve yet; this syncs its columns and Sets (nothing is created by name).`);
      }
      report.durationMs = now() - started;
      return report;
    })();
  }

  /** Whether the column `kind` sits in (under the path's resolved parent) holds no rows. */
  async function columnEmpty(kind: string): Promise<boolean> {
    try {
      if (kind === "sport") return (await childrenOf(client, "sport", undefined)).length === 0;
      const sport = await resolveChild(client, "sport", undefined, path.sport);
      if (kind === "year") return (await childrenOf(client, "year", sport._id)).length === 0;
      const year = await resolveChild(client, "year", sport._id, path.year);
      if (kind === "manufacturer") return (await childrenOf(client, "manufacturer", year._id)).length === 0;
      return false;
    } catch (e) {
      if (e instanceof ResolveError) return false;
      throw e;
    }
  }

  async function insertTree(variantTypeId: RowId) {
    return client.query(api.selectorOptions.getInsertTreeByVariantType, { variantTypeId });
  }

  /**
   * SportLots ids other sets of the brand hold (NEO-305): the server's
   * `getBrandSlHolders` when the set has a variant type to ask it with; on a
   * cold set, the same walk through public reads. Keep in step with
   * `getBrandSlHolders` (convex/setParallelConversion.ts).
   */
  async function brandSlHolders(anyTypeId: RowId | undefined): Promise<HeldRow[]> {
    if (anyTypeId) {
      const r = await client.query(api.setParallelConversion.getBrandSlHolders, { variantTypeId: anyTypeId });
      if (r.truncated) notes.push("The brand holds more rows than the held-id read covers; some SportLots sets held elsewhere may show as pending.");
      return r.rows.map((h) => ({ key: h.key, name: h.name, bsc: [], sportlots: h.sportlots }));
    }
    const out: HeldRow[] = [];
    let read = 0;
    const add = (row: SelectorRow, name: string) => {
      read++;
      const ids = slotIds(row, "sportlots");
      if (ids.length > 0) out.push({ key: String(row._id), name, bsc: [], sportlots: ids });
    };
    const sets = await childrenOf(client, "setName", set.manufacturerId);
    for (const s of sets) {
      if (read >= MAX_BRAND_WALK_ROWS) break;
      if (s._id === set.setId) continue;
      add(s, s.value);
      for (const vt of await childrenOf(client, "variantType", s._id)) {
        add(vt, variantTypeKind(vt) === "base" ? s.value : `${s.value} ${vt.value}`);
        for (const node of await insertTree(vt._id)) {
          add(node.insert as SelectorRow, `${s.value} ${node.insert.value}`);
          for (const p of node.parallels) add(p as SelectorRow, `${s.value} ${p.value}`);
        }
      }
    }
    if (read >= MAX_BRAND_WALK_ROWS) notes.push("The brand walk stopped at its row cap; some SportLots sets held elsewhere may show as pending.");
    return out;
  }

  /** The form's no-dialog path (one marketplace returned rows), exactly as reconcile-variants takes it. */
  function singlePlatform(result: RawOptions, held: HeldRow[], used: { bsc: string[]; sportlots: string[] }):
    | { kind: "store"; items: DraftRow[] }
    | { kind: "blocked"; labels: string[] }
    | { kind: "dialog" } {
    const plan = planSinglePlatformStore(result.errors, skippedSidesOf(result));
    if (plan.kind === "blocked") return { kind: "blocked", labels: plan.failedLabels };
    const ids = heldIdSets(held);
    for (const id of used.bsc) ids.bsc.add(id);
    for (const id of used.sportlots) ids.sportlots.add(id);
    const items = [
      ...result.bscOptions.filter((o) => !ids.bsc.has(o.platformValue)).map((o) => ({ value: o.value, platformData: { bsc: o.platformValue } })),
      ...result.slOptions.filter((o) => !ids.sportlots.has(o.platformValue)).map((o) => ({ value: o.value, platformData: { sportlots: o.platformValue } })),
    ];
    if (storeItemsHitTwins(items, result.twinIds)) return { kind: "dialog" };
    return {
      kind: "store",
      items: items.map((i) => ({
        name: i.value,
        bsc: "bsc" in i.platformData ? [i.platformData.bsc as string] : [],
        sportlots: "sportlots" in i.platformData ? [(i.platformData as { sportlots: string }).sportlots] : [],
      })),
    };
  }

  function pairOf(r: DraftRow) {
    return { name: r.name, ...(r.bsc.length ? { bsc: r.bsc } : {}), ...(r.sportlots.length ? { sportlots: r.sportlots } : {}) };
  }

  /**
   * Group Parallels' own suggestions over the type's rows as they will stand
   * after the sync, as `group` entries. A row is named by a marketplace id
   * that only it holds among the type's rows (it survives a rename), else by
   * its name. A suggested parent whose grouping name another row shares is a
   * tie: never taken, an open decision.
   */
  function draftGrouping(
    rows: DraftRow[],
    unseeded: SelectorRow[],
    tree: Awaited<ReturnType<typeof insertTree>>,
    at: string,
    title: string,
  ) {
    const nodes: Array<{ insert: { _id: Id<"selectorOptions">; value: string }; parallels: Array<{ _id: Id<"selectorOptions">; value: string }> }> = [];
    rows.forEach((r, i) => {
      const id = (r.existingId ?? `draft:${i}`) as Id<"selectorOptions">;
      const existing = tree.find((n) => n.insert._id === r.existingId);
      nodes.push({ insert: { _id: id, value: r.name }, parallels: (existing?.parallels ?? []).map((p) => ({ _id: p._id, value: p.value })) });
    });
    for (const u of unseeded) {
      const existing = tree.find((n) => n.insert._id === u._id);
      nodes.push({ insert: { _id: u._id, value: u.value }, parallels: (existing?.parallels ?? []).map((p) => ({ _id: p._id, value: p.value })) });
    }
    const allRows: Array<{ _id: string; value: string; bsc: string[]; sportlots: string[] }> = [
      ...rows.map((r, i) => ({ _id: String(r.existingId ?? `draft:${i}`), value: r.name, bsc: r.bsc, sportlots: r.sportlots })),
      ...unseeded.map((u) => ({ _id: String(u._id), value: u.value, bsc: slotIds(u, "bsc"), sportlots: slotIds(u, "sportlots") })),
      ...tree.flatMap((n) => n.parallels.map((p) => ({ _id: String(p._id), value: p.value, bsc: slotIds(p, "bsc"), sportlots: slotIds(p, "sportlots") }))),
    ];
    const holders = (side: Side, id: string) => allRows.filter((r) => r[side].includes(id)).length;
    const refOf = (row: { value: string; bsc: string[]; sportlots: string[] }): RowRef => {
      if (row.bsc.length === 1 && holders("bsc", row.bsc[0]) === 1) return { bsc: row.bsc[0] };
      if (row.sportlots.length === 1 && holders("sportlots", row.sportlots[0]) === 1) return { sportlots: row.sportlots[0] };
      return row.value;
    };
    const keyCount = new Map<string, number>();
    for (const r of allRows) keyCount.set(groupingKey(r.value), (keyCount.get(groupingKey(r.value)) ?? 0) + 1);

    const init = buildInitialState(nodes);
    const kids = new Map<string, string[]>();
    for (const [id, placement] of init.placement) {
      if (placement.kind !== "child") continue;
      const list = kids.get(placement.parentId) ?? [];
      list.push(id);
      kids.set(placement.parentId, list);
    }
    const parents: Array<{ insert: RowRef; parallels: RowRef[] }> = [];
    /** Parent row name → its parallels' names (suggested and already grouped). */
    const children = new Map<string, string[]>();
    const parentIds = new Set<string>();
    const childIds = new Set<string>();
    let moves = 0;
    const nameOf = (id: string) => allRows.find((r) => r._id === id)!.value;
    for (const [parentId, kidIds] of kids) {
      const parent = allRows.find((r) => r._id === parentId)!;
      const suggested = kidIds.filter((c) => init.suggested.has(c as Id<"selectorOptions">));
      if (suggested.length > 0 && (keyCount.get(groupingKey(parent.value)) ?? 0) > 1) {
        open.names.push({
          at: `${at}.parents`,
          kind: "group-parent",
          name: parent.value,
          candidates: allRows.filter((r) => groupingKey(r.value) === groupingKey(parent.value)).map((r) => ({ id: r._id, name: r.value })),
          detail: `${suggested.length} row(s) would group under "${parent.value}", and another ${title} row shares its name`,
        });
        // Only what is already grouped stays grouped.
        const already = kidIds.filter((c) => !init.suggested.has(c as Id<"selectorOptions">));
        if (already.length > 0) {
          parentIds.add(parentId);
          for (const c of already) childIds.add(c);
        }
        continue;
      }
      parents.push({ insert: refOf(parent), parallels: kidIds.map((c) => refOf(allRows.find((r) => r._id === c)!)) });
      children.set(parent.value, kidIds.map(nameOf));
      parentIds.add(parentId);
      for (const c of kidIds) childIds.add(c);
      moves += suggested.length;
    }
    const ungrouped = nodes.filter((n) => !parentIds.has(n.insert._id) && !childIds.has(n.insert._id)).length;
    const groupedRowNames = new Set(rows.filter((r, i) => childIds.has(String(r.existingId ?? `draft:${i}`))).map((r) => r.name));
    return { parents, children, groupedRowNames, moves, ungrouped };
  }

  /** A row the draft found already holding cards: apply skips its fetch. */
  function doneChecklist(n: number) {
    return { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, review: "none-expected", expectCards: n };
  }

  /** One insert row's checklist: done, by row, cold, or open. */
  async function rowChecklist(at: string, row: ServiceRowRef, r: DraftRow, t: StructureType) {
    if (r.existingId) {
      const n = await cardCount(client, r.existingId);
      if (n > 0) {
        propose(at, "already-built", `${row.type} › ${row.name} already holds ${n} cards`);
        return doneChecklist(n);
      }
    }
    const sides: Side[] = [...(r.bsc.length ? ["bsc" as const] : []), ...(r.sportlots.length ? ["sportlots" as const] : [])];
    let request: PreviewRequest | string;
    if (r.existingId) request = { selectorOptionId: r.existingId };
    else if (!setListing) request = "the set has no BSC listing of its own, which the cold preview reads";
    else if (r.bsc.length > COLD_IDS_PER_LIST || r.sportlots.length > COLD_IDS_PER_LIST) request = `the row carries more than ${COLD_IDS_PER_LIST} ids on one side`;
    else {
      request = {
        cold: {
          setId: set.setId,
          variantType: { bscVariantId: t.bscVariantId },
          insert: { ...(r.bsc.length ? { bscVariantNameIds: r.bsc } : {}), ...(r.sportlots.length ? { sportlotsIds: r.sportlots } : {}) },
        },
      };
    }
    return draftChecklist(at, `${row.type} › ${row.name}`, row, request, sides, r.existingId ?? set.setId);
  }

  /**
   * Preview one checklist and draft its answers: Match Cards keep/keep, the
   * conflicts open, the review's creates and open names, the observed count.
   * Returns the checklist for the spec, or undefined when it is open as a
   * whole (its template fill-in is recorded).
   */
  async function draftChecklist(
    at: string,
    label: string,
    row: ServiceRowRef | null,
    request: PreviewRequest | string,
    sides: Side[],
    scopeId: RowId,
  ): Promise<Record<string, unknown> | undefined> {
    const openWhole = (detail: string) => {
      openCondition(at, "checklist-preview", label, detail, {
        pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" },
        review: `<the ${label} checklist could not be previewed: answer its review after apply --collect fetches it>`,
      });
      return undefined;
    };
    if (typeof request === "string") return openWhole(request);
    const refused = sides.filter((s) => refusedSides.has(s));
    if (refused.length > 0) return openWhole(`${refused.map((s) => (s === "bsc" ? "BSC" : "SportLots")).join(" and ")} refused the session earlier in this draft`);

    const lookupTeams = teamBudget > 0;
    const preview = await client.action(api.selectorOptions.previewCardChecklist, { ...request, lookupTeams });
    marketplaceCalls += preview.marketplaceCalls;
    if (!preview.success) {
      const cls = failureClass(preview.message);
      if (cls === "session") refuse(sidesNamed(preview.message), label);
      return openWhole(`the preview failed (${cls === "session" ? "a marketplace refused the session" : "fetch failed"})`);
    }
    if (preview.teamLookup.performed) teamBudget = Math.max(0, teamBudget - preview.teamLookup.needed);
    else if (preview.teamLookup.needed > 0) {
      notes.push(`${label}: ${preview.teamLookup.needed} card(s) had no team looked up (the draft's team-lookup budget is spent); their teams are looked up when apply fetches the checklist.`);
    }

    const paused = new Set(preview.pausedSides);
    const servedSides = preview.attachedSides.filter((s) => !paused.has(s)) as ServedSide[];
    const live = previewAsCandidates(preview);
    const pairing = { unmatchedBsc: "keep" as const, unmatchedSportlots: "keep" as const };
    const total = preview.matched.length + preview.bscOnly.length + preview.slOnly.length;
    const checklist: Record<string, unknown> = { pairing: { ...pairing }, review: "none-expected", expectCards: total };
    propose(`${at}.pairing`, "pairing", `${label}: keep every unmatched card on both sides (the dialog's defaults)`);
    propose(`${at}.expectCards`, "expect", `${label}: ${total} cards previewed`);
    if (total > 0) {
      const paired = pairCandidates(live, pairing, { servedSides, attachedSides: preview.attachedSides, at, row });
      if (!paired.ok) {
        open.conflicts.push(...paired.conflicts);
        fills.push({ at: `${at}.pairing.conflicts`, value: paired.template });
      }
    }

    // The review: every name on this row's cards gets its answer HERE, even
    // when an earlier checklist answers it too. Apply decides it at whichever
    // checklist reaches it first; the later answer is then moot (a reported
    // no-op), and an earlier checklist that stops open cannot strand it.
    const cards = [...preview.matched.map((m) => m.card), ...preview.bscOnly, ...preview.slOnly];
    // NEO-345: the wizard's "Autographed cards" question, asked of the
    // operator, never answered here (no marketplace says which it is).
    const autographed = cards.filter((c) => carriesAutographToken(c.attributes)).length;
    if (autographed > 0) {
      autographFormats.push({
        at: `${at}.autographFormat`,
        row,
        label,
        cards: autographed,
        question: autographPromptLine(autographed),
        answers: AUTOGRAPH_FORMATS.map((format) => ({ format, label: AUTOGRAPH_CHOICE_LABEL[format] })),
      });
    }
    const names = namesOnCards(cards);
    // A name only one side of an unanswered players conflict carries is asked
    // about only if that side is chosen: never pre-filled, and its fill-in
    // says which answer it rides on (the conflicts are open decisions here).
    const dependent = conflictDependentPlayers(cards);
    const players = names.players;
    const teams = names.teams;
    const creates = { players: [] as Array<Record<string, unknown>>, teams: [] as Array<Record<string, unknown>> };
    const opens = { players: [] as Array<Record<string, unknown>>, teams: [] as Array<Record<string, unknown>> };
    const sportId = set.sportId;
    for (const slice of entitySlices(players, teams)) {
      const cardTeamsOf = slice.players
        .map((p) => ({ player: p, teams: names.playerCardTeams.get(p) ?? [] }))
        .filter((e) => e.teams.length > 0);
      // One-shot query (never a subscription), at most 200 names.
      const verdict: EntityPreview = await client.query(api.selectorOptions.previewChecklistEntities, {
        sportId,
        selectorOptionId: scopeId,
        players: slice.players,
        teams: slice.teams,
        ...(cardTeamsOf.length ? { playerCardTeams: cardTeamsOf } : {}),
      });
      for (const p of verdict.players) {
        if (p.status !== "unknown") continue;
        const deps = dependent.get(normalizeEntityName(p.name.trim()));
        if (deps) {
          const candidates: ResolveCandidate[] = p.candidates.map((c) => ({
            id: String(c.playerId),
            name: c.name,
            ...(c.birthYear !== undefined ? { detail: `born ${c.birthYear}` } : {}),
          }));
          const none = p.candidates.length === 0 && p.matchCount === 0;
          const known = none ? "no NB player has this name, so create is the usual answer" : candidateText(candidates, p.matchCount);
          const when = `asked only if ${dependencyText(deps)} at ${at}.pairing.conflicts, or that pair is unlinked (pairing.unlink); otherwise it is not asked and any answer here is ignored`;
          const item = reviewItem(`${at}.review.players`, row, p.name, candidates, p.matchCount);
          open.review.players.push({ ...item, detail: `${when}; ${known}` });
          opens.players.push({
            name: p.name,
            decision: `${none ? DECISION_PLACEHOLDER : SAME_NAME_PLAYER_PLACEHOLDER} — ${when}; ${known}`,
          });
          continue;
        }
        if (p.candidates.length === 0 && p.matchCount === 0) creates.players.push({ name: p.name, decision: "create" });
        else {
          // A same-name pick: the birth year is what a `{ link, birthYear }` answer names.
          const candidates: ResolveCandidate[] = p.candidates.map((c) => ({
            id: String(c.playerId),
            name: c.name,
            ...(c.birthYear !== undefined ? { detail: `born ${c.birthYear}` } : {}),
          }));
          open.review.players.push(reviewItem(`${at}.review.players`, row, p.name, candidates, p.matchCount));
          opens.players.push({ name: p.name, decision: `${SAME_NAME_PLAYER_PLACEHOLDER} — ${candidateText(candidates, p.matchCount)}` });
        }
      }
      for (const tm of verdict.teams) {
        if (tm.status !== "unknown") continue;
        if (tm.candidates.length === 0) creates.teams.push({ name: tm.name, decision: "create" });
        else {
          const candidates: ResolveCandidate[] = tm.candidates.map((c) => ({
            id: String(c.teamId),
            name: c.name,
            ...(c.fromYear !== undefined ? { detail: `${c.fromYear}–${c.toYear ?? ""}` } : {}),
          }));
          open.review.teams.push(reviewItem(`${at}.review.teams`, row, tm.name, candidates, tm.candidates.length));
          opens.teams.push({ name: tm.name, decision: `${DECISION_PLACEHOLDER} — ${candidateText(candidates, candidates.length)}` });
        }
      }
    }
    if (creates.players.length + creates.teams.length > 0) {
      checklist.review = { players: creates.players, teams: creates.teams, leagues: [] };
      propose(`${at}.review`, "review-create",
        `${label}: create ${creates.players.length} player(s) and ${creates.teams.length} team(s) no NB row is named like`);
    }
    if (opens.players.length + opens.teams.length > 0) {
      fills.push({
        at: `${at}.review`,
        value: { players: [...creates.players, ...opens.players], teams: [...creates.teams, ...opens.teams], leagues: [] },
      });
    }
    return checklist;
  }

  function finish(): Promise<DraftedReport> {
    return (async () => {
      const openCount = countOpenDecisions(open);
      let template: Record<string, unknown> | null = null;
      if (fills.length > 0) {
        template = structuredClone(spec);
        for (const f of fills) setAt(template, f.at, f.value);
      }
      // The drafted spec must be a spec: a bug here is the drafter's, never the operator's.
      const parsed = parseSpec(spec);
      let steps: PlanStep[] = [];
      try {
        // The engine's own walk over the drafted spec, on a client that runs
        // NO action: what apply would do now, at zero marketplace cost.
        const paused = await client.query(api.marketplacePause.getPausedPlatforms, {});
        const walk = await runSpec(readOnlyClient(inner, new Set()), target, parsed, "draft", { pausedPlatforms: paused.join(","), now });
        steps = walk.steps;
      } catch (err) {
        if (err instanceof RunFailed) steps = err.report.steps;
        else notes.push("The step walk over the drafted spec could not run; plan it to see the steps.");
      }
      return {
        status: "drafted",
        ...head,
        scope: pathText,
        spec,
        proposals,
        openDecisions: open,
        openCount,
        template,
        confirmPhrase: openCount === 0 ? specConfirmPhrase(target, parsed) : null,
        steps,
        notes,
        leftUnasked,
        autographFormats,
        marketplaceCalls,
        durationMs: now() - started,
      };
    })();
  }
}

/**
 * The unresolved message when the brand's year (or its Sets) was never
 * synced: the name is not unknown, NeonBinder just has not read that column
 * yet. A name that matches nothing in a synced column keeps ResolveError's
 * "No manufacturer named …".
 */
export function unsyncedMessage(brandYear: string, what?: "Sets"): string {
  return what === "Sets"
    ? `${brandYear}'s Sets have not been synced yet. Apply the prepare spec, then draft this set again.`
    : `${brandYear} has not been synced yet. Apply the prepare spec, then draft this set again.`;
}

function reviewItem(at: string, row: ServiceRowRef | null, name: string, candidates: ResolveCandidate[], matchCount: number): OpenReviewItem {
  return {
    at,
    row,
    name,
    reason: "unanswered",
    candidates,
    detail: candidateText(candidates, matchCount),
  };
}

function candidateText(candidates: ResolveCandidate[], matchCount: number): string {
  if (candidates.length === 0) return `${matchCount} NB row(s) share this name; link one or create`;
  return `existing NB rows: ${candidates.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""} [${c.id}]`).join(", ")}`;
}

/** Re-exported for the tests: the open decisions a draft collects. */
export type { OpenDecisions };
