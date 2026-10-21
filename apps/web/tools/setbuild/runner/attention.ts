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
 *   brand-year path, the lines themselves), named for the brand-year;
 * - the rows whose checklist header asks "on card or sticker?" (NEO-345,
 *   the prompt's own rule, `autographs`);
 * - an entity review this process's apply left open (a pointer to nb_decide);
 * - the sync notices the node's columns still show (read-only).
 *
 * `fixAttention` checks the confirm phrase first (no network before it),
 * resolves every name and autograph answer, then answers the cards through
 * the fixers' own mutations (lib/attention-answers.ts), the autograph rows
 * through the header prompt's, and the names through the suggestions
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
  linksNoteFor,
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
import { resolveBrandYear, resolveSetPath, type ResolvedBrandYear, type ResolvedSet, type RowId, type SelectorLevel } from "../spec/resolve";
import { listCardAttention, type ListCardAttentionOptions } from "../lib/attention";
import {
  AutographFixAborted,
  CardFixAborted,
  applyAutographAnswers,
  applyCardAnswers,
  resolveAutographAnswers,
  type AutographFixOptions,
  type ResolvedAutographAnswer,
} from "../lib/attention-answers";
import { NameFixAborted, applyNameAnswers, listNameSuggestions, resolveNameAnswers } from "../lib/name-suggestions";
import { openSlRows, readSlReview } from "../lib/sl-review";
import { setBuilderUrlForPath } from "../lib/set-builder-link";
import { READ_CONCURRENCY, mapLimit, walkSet } from "../lib/set-walk";
import { parseFixAnswers } from "../lib/fix-answers";
import { DetachFixAborted, applyDetachAnswers, resolveDetachAnswers, type ResolvedDetachAnswer } from "../lib/detach-answers";
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

/**
 * "Topps 2024": the brand-year a SportLots review belongs to, in NB's names
 * off the rows the path resolved to (the path's own words if none were read).
 */
function brandName(path: NodePath, node?: ResolvedSet | ResolvedBrandYear): string {
  const rows = node?.rows;
  return rows ? `${rows.manufacturer.value} ${rows.year.value}` : `${path.manufacturer} ${path.year}`;
}

const resolvedOf = (r: Resolved): ResolvedSet | ResolvedBrandYear => (r.kind === "set" ? r.set : r.brand);

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The listing's one line. Everything at zero is the walker's own done line
 * (`walkDoneLine`, shared with the Set Builder so the words cannot drift).
 *
 * The SportLots count is the BRAND's review, not the set's, so it is named
 * for the brand-year (`brand`, e.g. "Topps 2024") and never "on" the set:
 * "3 SportLots sets to sort for Topps 2024".
 */
export function attentionSummaryLine(t: AttentionTotals, where: string, brand: string): string {
  const local: string[] = [];
  if (t.cards > 0) local.push(`${plural(t.cards, "card needs", "cards need")} you`);
  if (t.namesToCheck > 0) local.push(`${plural(t.namesToCheck, "name", "names")} to check`);
  if (t.autographRows > 0) local.push(`${plural(t.autographRows, "autograph row", "autograph rows")} to mark on-card or sticker`);
  const sl = t.slSetsToSort > 0 ? `${plural(t.slSetsToSort, "SportLots set", "SportLots sets")} to sort for ${brand}` : undefined;
  if (local.length === 0 && !sl) return walkDoneLine(t.awaitingTeamLookup);
  const lookups = t.awaitingTeamLookup > 0 ? `still looking up teams for ${plural(t.awaitingTeamLookup, "card", "cards")}` : undefined;
  if (local.length > 0) {
    local[0] += ` on ${where}`;
    if (lookups) local[0] += `, ${lookups}`;
  } else if (lookups) {
    local.push(`${lookups} on ${where}`);
  }
  const parts = sl ? [...local, sl] : local;
  const line = parts.join("; ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

const isClear = (t: AttentionTotals) => t.cards + t.namesToCheck + t.slSetsToSort + t.autographRows === 0;

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
  for (const { type: t, isBase, rows } of await walkSet(client, r.set.setId, { parallels: false })) {
    if (isBase) continue;
    out.push({ level: "insert", parentId: t._id, where: `${base} › ${t.value}`, ids: [...ids, t._id] });
    for (const { row } of rows) {
      out.push({ level: "parallel", parentId: row._id, where: `${base} › ${t.value} › ${row.value}`, ids: [...ids, t._id, row._id] });
    }
  }
  return out;
}

async function noticesOf(client: NbClient, r: Resolved): Promise<AttentionNotice[]> {
  const out: AttentionNotice[] = [];
  const columns = await noticeColumns(client, r);
  // One status per column, read concurrently; the notices keep the columns' order.
  const statuses = await mapLimit(columns, READ_CONCURRENCY, (c) =>
    client.query(api.selectorOptions.getSelectorSyncStatus, { level: c.level, parentId: c.parentId }),
  );
  for (const [i, c] of columns.entries()) {
    const s = statuses[i];
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
  autographs: Awaited<ReturnType<typeof listCardAttention>>["autographs"];
  names: Awaited<ReturnType<typeof listNameSuggestions>>;
  sl: Awaited<ReturnType<typeof slSummaryOf>>;
}> {
  // The three parts read nothing from each other, so they run at once.
  const [cardPart, names, sl] = await Promise.all([
    r.kind === "set"
      ? listCardAttention(client, r.set, { detail: detail ?? "summary" })
      : { cards: [], autographs: [], totals: { cards: 0, byKind: {}, awaitingTeamLookup: 0, autographRows: 0 }, enrichment: { enriched: 0, of: 0 } },
    listNameSuggestions(client, r.path, r.kind === "set" ? r.set : r.brand),
    slSummaryOf(client, r.kind === "set" ? r.set.manufacturerId : r.brand.manufacturerId),
  ]);
  return {
    totals: {
      cards: cardPart.totals.cards,
      byKind: { ...cardPart.totals.byKind },
      awaitingTeamLookup: cardPart.totals.awaitingTeamLookup,
      autographRows: cardPart.totals.autographRows,
      namesToCheck: nameSides(names),
      slSetsToSort: sl?.pending ?? 0,
    },
    cards: cardPart.cards,
    autographs: cardPart.autographs,
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
  // The notices read nothing the listing reads, so both run at once.
  const [{ totals, cards, autographs, enrichment, names, sl }, notices] = await Promise.all([
    totalsOf(client, r, opts.detail),
    noticesOf(client, r),
  ]);

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
    summary: attentionSummaryLine(totals, nodeName(path), brandName(path, resolvedOf(r))),
    cards,
    autographs,
    ...(r.kind === "set" ? { enrichment } : {}),
    names,
    slReview,
    review: openRows.length > 0 ? { rows: openRows, answerWith: "nb_decide" } : null,
    notices,
    ...linksNoteFor(target),
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
  return { ...totals, summary: attentionSummaryLine(totals, nodeName(path), brandName(path, resolvedOf(r))) };
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
 * `nb_fix` / `setbuild fix` stopped part-way by a failure that is not a
 * refusal (network, auth, a server fault) after it may have written: every
 * answer settled before it (`results`: cards, autographs, then names) and the name answers
 * whose save was sent but not read back (`unconfirmed`), so nothing written
 * is unreported. The MCP tool and the CLI print both, scrubbed.
 */
export class FixAborted extends Error {
  readonly results: FixResult[];
  readonly unconfirmed: string[];
  readonly cause: unknown;
  constructor(results: FixResult[], unconfirmed: string[], cause: unknown) {
    const why = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    super(`fix stopped part-way (${why}). The answers it settled are listed; list attention again before answering the rest.`);
    this.name = "FixAborted";
    this.results = results;
    this.unconfirmed = unconfirmed;
    this.cause =
      cause instanceof CardFixAborted || cause instanceof NameFixAborted || cause instanceof AutographFixAborted ? cause.cause : cause;
  }
}

/**
 * `nb_fix` / `setbuild fix`. The phrase is checked before anything touches
 * the network; every name and autograph answer resolves before anything is
 * written. `opts.autographWait` bounds the wait for the server to mark an
 * answered row's cards (tests shorten it).
 */
export async function fixAttention(
  client: NbClient,
  target: Target,
  path: NodePath,
  given: FixAnswers,
  confirm: string | undefined,
  opts: { autographWait?: AutographFixOptions } = {},
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
  const autographs = answers.autographs ?? [];
  const detach = answers.detach ?? [];
  if (cards.length === 0 && names.length === 0 && autographs.length === 0 && detach.length === 0) {
    throw new FixInputError("Nothing to fix: give cards, autographs, detach or names answers.");
  }
  if ((cards.length > 0 || autographs.length > 0 || detach.length > 0) && !isSetPath(path)) {
    throw new FixInputError(`${pathText} is a brand-year; card, autograph and detach answers go on the set's path (Sport/Year/Manufacturer/Set).`);
  }

  const r = await resolveNode(client, path);
  const node = r.kind === "set" ? r.set : r.brand;
  // Names and autograph rows resolve first (reads only), so a name or a row
  // that is not exactly one stops the batch before any card is written.
  await resolveNameAnswers(client, path, node, names);
  const autographRows: ResolvedAutographAnswer[] =
    r.kind === "set" && autographs.length > 0 ? await resolveAutographAnswers(client, r.set, autographs) : [];
  const detachRows: ResolvedDetachAnswer[] = r.kind === "set" && detach.length > 0 ? await resolveDetachAnswers(client, r.set, detach) : [];

  const results: FixResult[] = [];
  let appliedCards = 0;
  if (cards.length > 0 && r.kind === "set") {
    try {
      for (const c of await applyCardAnswers(client, r.set, cards)) {
        results.push(c);
        if (c.outcome === "applied") appliedCards++;
      }
    } catch (err) {
      if (err instanceof CardFixAborted) throw new FixAborted([...err.results], [], err);
      throw err;
    }
  }
  let appliedAutographs = 0;
  if (autographRows.length > 0 && r.kind === "set") {
    try {
      for (const a of await applyAutographAnswers(client, r.set, autographRows, opts.autographWait ?? {})) {
        results.push(a);
        if (a.outcome === "applied") appliedAutographs++;
      }
    } catch (err) {
      if (err instanceof AutographFixAborted) throw new FixAborted([...results, ...err.results], [], err);
      if (results.length > 0) throw new FixAborted(results, [], err);
      throw err;
    }
  }
  let appliedDetach = 0;
  if (detachRows.length > 0) {
    try {
      for (const d of await applyDetachAnswers(client, detachRows)) {
        results.push(d);
        if (d.outcome === "applied") appliedDetach++;
      }
    } catch (err) {
      if (err instanceof DetachFixAborted) throw new FixAborted([...results, ...err.results], [], err);
      if (results.length > 0) throw new FixAborted(results, [], err);
      throw err;
    }
  }
  // From here cards may be written: a failure never loses their results.
  let nameReport: Awaited<ReturnType<typeof applyNameAnswers>>;
  try {
    nameReport = await applyNameAnswers(client, path, node, names);
  } catch (err) {
    if (err instanceof NameFixAborted) throw new FixAborted([...results, ...err.results], err.unconfirmed, err);
    if (results.length > 0) throw new FixAborted(results, [], err);
    throw err;
  }
  results.push(...nameReport.results);

  let after: AttentionSummary;
  try {
    after = await attentionSummaryOf(client, path, node);
  } catch (err) {
    throw new FixAborted(results, [], err);
  }
  const { summary, ...remaining } = after;
  return {
    path: pathText,
    applied: {
      cards: appliedCards,
      names: nameReport.results.filter((x) => x.outcome === "applied").length,
      autographs: appliedAutographs,
      ...(detach.length > 0 ? { detach: appliedDetach } : {}),
    },
    results,
    nameCounts: nameReport.counts,
    remaining,
    summary,
  };
}
