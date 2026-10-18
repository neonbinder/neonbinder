/**
 * NEO-339 — `attention` and `fix`: everything a set (or brand-year) still
 * needs from a person, and the answers to it.
 *
 * `attentionOf` lists, read-only (queries only):
 * - the cards the checklist header's "N need you" pill counts, with the facts
 *   each fixer shows (lib/attention.ts, over `deriveCardAttention`);
 * - every "name to check" on the node's own row and every row under it
 *   (lib/name-suggestions.ts);
 * - the brand's "N SportLots sets to sort" (`getSlSetReviewSummary`; on a
 *   brand-year path, the lines themselves);
 * - an entity review this process's apply left open (a pointer to nb_decide);
 * - the sync notices the node's columns still show (read-only).
 *
 * `fixAttention` checks the confirm phrase first (no network before it),
 * resolves every name answer, then answers the cards through the fixers' own
 * mutations (lib/attention-answers.ts) and the names through the suggestions
 * dialog's (lib/name-suggestions.ts), and lists the node again for
 * `remaining`.
 *
 * `attentionSummaryOf` is the totals and one line, for the end of an apply and
 * for `inspect --attention`.
 */

import { api } from "../../../convex/_generated/api";
import { walkDoneLine } from "../../../components/SetSelector/card-attention";
import type { NbClient } from "../client/convex-client";
import { assertPhrase, type Target } from "../client/target";
import {
  fixConfirmPhrase,
  formatPath,
  isSetPath,
  type AttentionNotice,
  type AttentionOptions,
  type AttentionReport,
  type AttentionSummary,
  type AttentionTotals,
  type FixAnswers,
  type FixReport,
  type FixResult,
  type NodePath,
  type RowRef,
  type SetPath,
} from "../service";
import { childrenOf, resolveBrandYear, resolveSetPath, type ResolvedBrandYear, type ResolvedSet, type RowId, type SelectorLevel } from "../spec/resolve";
import { variantTypeKind } from "../../../convex/variantRole";
import { listCardAttention, type ListCardAttentionOptions } from "../lib/attention";
import { applyCardAnswers } from "../lib/attention-answers";
import { applyNameAnswers, listNameSuggestions, resolveNameAnswers } from "../lib/name-suggestions";
import { openSlRows, readSlReview } from "../lib/sl-review";
import { setBuilderUrlForPath } from "../lib/set-builder-link";
import { parseFixAnswers } from "../lib/fix-answers";
import { queryOnlyClient } from "./read-only-client";

/** What the service knows that the server cannot say: the entity reviews its own apply left open. */
export interface AttentionContext {
  /** Checklists of the set with a review open in this process (null = Base). */
  openReviews?: (pathText: string) => Array<RowRef | null>;
}

type Resolved = { kind: "set"; path: SetPath; set: ResolvedSet } | { kind: "brand-year"; path: NodePath; brand: ResolvedBrandYear };

async function resolveNode(client: NbClient, path: NodePath): Promise<Resolved> {
  return isSetPath(path)
    ? { kind: "set", path, set: await resolveSetPath(client, path) }
    : { kind: "brand-year", path, brand: await resolveBrandYear(client, path) };
}

const nodeIds = (r: Resolved): string[] =>
  r.kind === "set"
    ? [r.set.sportId, r.set.yearId, r.set.manufacturerId, r.set.setId]
    : [r.brand.sportId, r.brand.yearId, r.brand.manufacturerId];

/** The node's name as a person reads it in a summary: the set's, or the brand-year's. */
const nodeName = (path: NodePath): string => (isSetPath(path) ? path.set : formatPath(path));

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The listing's one line. Everything at zero is the walker's own done line
 * (`walkDoneLine`, shared with the Set Builder so the words cannot drift).
 */
export function attentionSummaryLine(t: AttentionTotals, where: string): string {
  const parts: string[] = [];
  if (t.cards > 0) parts.push(`${plural(t.cards, "card needs", "cards need")} you`);
  if (t.namesToCheck > 0) parts.push(`${plural(t.namesToCheck, "name", "names")} to check`);
  if (t.slSetsToSort > 0) parts.push(`${plural(t.slSetsToSort, "SportLots set", "SportLots sets")} to sort`);
  if (parts.length === 0) return walkDoneLine(t.awaitingTeamLookup);
  parts[0] += ` on ${where}`;
  if (t.awaitingTeamLookup > 0) parts[0] += `, still looking up teams for ${plural(t.awaitingTeamLookup, "card", "cards")}`;
  return `${parts.join("; ")}.`;
}

const isClear = (t: AttentionTotals) => t.cards + t.namesToCheck + t.slSetsToSort === 0;

/**
 * An apply's last line, from what each set it reached still needs. "Built
 * and all clear." only when nothing on any of them is waiting, lookups
 * included; a run that stopped at an open decision says that first.
 */
export function applyEndLine(
  sets: ReadonlyArray<{ path: string; attention?: AttentionSummary; error?: string }>,
  stopped: number,
): string | undefined {
  if (sets.length === 0) return undefined;
  const lines: string[] = [];
  for (const s of sets) {
    if (s.error !== undefined) lines.push(`could not read what still needs you on ${s.path} (${s.error})`);
    else if (s.attention && !(isClear(s.attention) && s.attention.awaitingTeamLookup === 0)) {
      lines.push(
        isClear(s.attention)
          ? `nothing needs you on ${s.path} yet, but teams are still being looked up for ${plural(s.attention.awaitingTeamLookup, "card", "cards")}`
          : s.attention.summary.replace(/\.$/, ""),
      );
    }
  }
  const head =
    stopped > 0 ? `Stopped at ${plural(stopped, "open decision", "open decisions")}: answer ${stopped === 1 ? "it" : "them"} and apply again.` : "";
  if (lines.length === 0) return stopped > 0 ? head : "Built and all clear.";
  const tail = `${lines.join(". ")}. Run nb_attention to walk them.`;
  return stopped > 0 ? `${head} Also: ${tail}` : `Built, but not done: ${tail}`;
}

// ---------------------------------------------------------------------------
// Columns (for the notices)
// ---------------------------------------------------------------------------

interface NoticeColumn {
  level: SelectorLevel;
  parentId: RowId;
  where: string;
  ids: string[];
}

async function noticeColumns(client: NbClient, r: Resolved): Promise<NoticeColumn[]> {
  const ids = nodeIds(r);
  if (r.kind === "brand-year") {
    return [{ level: "setName", parentId: r.brand.manufacturerId, where: `${formatPath(r.path)} › Sets`, ids }];
  }
  const base = formatPath(r.path);
  const out: NoticeColumn[] = [{ level: "variantType", parentId: r.set.setId, where: `${base} › Variant types`, ids }];
  for (const t of await childrenOf(client, "variantType", r.set.setId)) {
    if (variantTypeKind(t) === "base") continue;
    out.push({ level: "insert", parentId: t._id, where: `${base} › ${t.value}`, ids: [...ids, t._id] });
    for (const row of await childrenOf(client, "insert", t._id)) {
      out.push({ level: "parallel", parentId: row._id, where: `${base} › ${t.value} › ${row.value}`, ids: [...ids, t._id, row._id] });
    }
  }
  return out;
}

async function noticesOf(client: NbClient, r: Resolved): Promise<AttentionNotice[]> {
  const out: AttentionNotice[] = [];
  for (const c of await noticeColumns(client, r)) {
    const s = await client.query(api.selectorOptions.getSelectorSyncStatus, { level: c.level, parentId: c.parentId });
    if (!s) continue;
    const unlinked = s.unlinkedTotal ?? s.unlinked?.length;
    const twinsLeft = s.twinsLeftTotal ?? s.twinsLeft?.length;
    // A finished sync with nothing left over is not a notice anyone acts on.
    if (s.status === "done" && !unlinked && !twinsLeft && !s.message) continue;
    out.push({
      where: c.where,
      level: c.level,
      status: s.status,
      ...(s.message ? { message: s.message } : {}),
      ...(unlinked ? { unlinked } : {}),
      ...(twinsLeft ? { twinsLeft } : {}),
      link: setBuilderUrlForPath(c.ids, client.target.appOrigin),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

/** Counts every name side the listing carries (a row with both sides differing is two). */
const nameSides = (names: ReadonlyArray<{ sides: readonly unknown[] }>) => names.reduce((n, x) => n + x.sides.length, 0);

async function totalsOf(
  client: NbClient,
  r: Resolved,
  detail: ListCardAttentionOptions["detail"],
): Promise<{
  totals: AttentionTotals;
  cards: Awaited<ReturnType<typeof listCardAttention>>["cards"];
  enrichment: Awaited<ReturnType<typeof listCardAttention>>["enrichment"];
  names: Awaited<ReturnType<typeof listNameSuggestions>>;
  sl: Awaited<ReturnType<typeof slSummaryOf>>;
}> {
  const cardPart =
    r.kind === "set"
      ? await listCardAttention(client, r.set, { detail: detail ?? "summary" })
      : { cards: [], totals: { cards: 0, byKind: {}, awaitingTeamLookup: 0 }, enrichment: { enriched: 0, of: 0 } };
  const names = await listNameSuggestions(client, r.path, r.kind === "set" ? r.set : r.brand);
  const sl = await slSummaryOf(client, r.kind === "set" ? r.set.manufacturerId : r.brand.manufacturerId);
  return {
    totals: {
      cards: cardPart.totals.cards,
      byKind: { ...cardPart.totals.byKind },
      awaitingTeamLookup: cardPart.totals.awaitingTeamLookup,
      namesToCheck: nameSides(names),
      slSetsToSort: sl?.pending ?? 0,
    },
    cards: cardPart.cards,
    enrichment: cardPart.enrichment,
    names,
    sl,
  };
}

async function slSummaryOf(client: NbClient, manufacturerId: RowId) {
  return client.query(api.slSetReview.getSlSetReviewSummary, { manufacturerId });
}

/** `nb_attention` / `setbuild attention`. Read-only: runs on `queryOnlyClient`. */
export async function attentionOf(
  inner: NbClient,
  target: Pick<Target, "convexUrl" | "host" | "appOrigin">,
  path: NodePath,
  opts: AttentionOptions & AttentionContext = {},
): Promise<AttentionReport> {
  const client = queryOnlyClient(inner);
  const pathText = formatPath(path);
  const r = await resolveNode(client, path);
  const { totals, cards, enrichment, names, sl } = await totalsOf(client, r, opts.detail);

  let slReview: AttentionReport["slReview"] = null;
  if (sl) {
    slReview = { pending: sl.pending, partial: sl.partial, moreNextSync: sl.moreNextSync, answerWith: "nb_sl_review_apply" };
    if (r.kind === "brand-year") {
      const review = await readSlReview(client, r.brand.manufacturerId);
      if (review) slReview.rows = openSlRows(review, review.entries, "slReview", pathText);
    }
  }
  const openRows = r.kind === "set" ? (opts.openReviews?.(pathText) ?? []) : [];

  return {
    target: { convexUrl: target.convexUrl, host: target.host },
    path,
    pathText,
    link: setBuilderUrlForPath(nodeIds(r), target.appOrigin),
    totals,
    summary: attentionSummaryLine(totals, nodeName(path)),
    cards,
    ...(r.kind === "set" ? { enrichment } : {}),
    names,
    slReview,
    review: openRows.length > 0 ? { rows: openRows, answerWith: "nb_decide" } : null,
    notices: await noticesOf(client, r),
  };
}

/**
 * The totals and the line, for the end of an apply and `inspect --attention`.
 * Read-only. Takes the resolved node when the caller already has it.
 */
export async function attentionSummaryOf(
  inner: NbClient,
  path: NodePath,
  resolved?: ResolvedSet | ResolvedBrandYear,
): Promise<AttentionSummary> {
  const client = queryOnlyClient(inner);
  const r: Resolved = resolved
    ? isSetPath(path) && "setId" in resolved
      ? { kind: "set", path, set: resolved }
      : { kind: "brand-year", path, brand: resolved }
    : await resolveNode(client, path);
  // "totals": the checklist walk and the rule only. No per-card fixer read, so
  // the end of every apply (the CI seed, mcp-smoke on a big set) pays nothing
  // per flagged card.
  const { totals } = await totalsOf(client, r, "totals");
  return { ...totals, summary: attentionSummaryLine(totals, nodeName(path)) };
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/** Refused before anything is sent: a fix that cannot be what the operator meant. */
export class FixInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixInputError";
  }
}

/**
 * `nb_fix` / `setbuild fix`. The phrase is checked before anything touches
 * the network; every name answer resolves before anything is written.
 */
export async function fixAttention(
  client: NbClient,
  target: Target,
  path: NodePath,
  given: FixAnswers,
  confirm: string | undefined,
): Promise<FixReport> {
  let parsed: FixAnswers;
  try {
    parsed = parseFixAnswers(given);
  } catch (err) {
    throw new FixInputError(err instanceof Error ? err.message : String(err));
  }
  const answers = parsed;
  assertPhrase(fixConfirmPhrase(target, path, answers), confirm);
  const pathText = formatPath(path);
  const cards = answers.cards ?? [];
  const names = answers.names ?? [];
  if (cards.length === 0 && names.length === 0) throw new FixInputError("Nothing to fix: give cards or names answers.");
  if (cards.length > 0 && !isSetPath(path)) {
    throw new FixInputError(`${pathText} is a brand-year; card answers go on the set's path (Sport/Year/Manufacturer/Set).`);
  }

  const r = await resolveNode(client, path);
  const node = r.kind === "set" ? r.set : r.brand;
  // Names resolve first (reads only), so a name that is not exactly one row
  // stops the batch before any card is written.
  await resolveNameAnswers(client, path, node, names);

  const results: FixResult[] = [];
  let appliedCards = 0;
  if (cards.length > 0 && r.kind === "set") {
    for (const c of await applyCardAnswers(client, r.set, cards)) {
      results.push(c);
      if (c.outcome === "applied") appliedCards++;
    }
  }
  const nameReport = await applyNameAnswers(client, path, node, names);
  results.push(...nameReport.results);

  const after = await attentionSummaryOf(client, path, node);
  const { summary, ...remaining } = after;
  return {
    path: pathText,
    applied: { cards: appliedCards, names: nameReport.results.filter((x) => x.outcome === "applied").length },
    results,
    nameCounts: nameReport.counts,
    remaining,
    summary,
  };
}
