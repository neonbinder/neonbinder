/**
 * NEO-339 part B — `setbuild oneshot-smoke`: the live proof of the one-shot
 * set build, run by e2e.yml's `setbuild-oneshot` job against the PR preview.
 *
 * Spawns the MCP server over stdio (as `mcp-smoke` does) and drives it the way
 * an agent builds a set for an operator:
 *
 *   1. tools/list has `nb_draft_set`;
 *   2. `nb_draft_set` on the fixture: drafted, and every open decision is the
 *      operator's own (a card conflict, a review name with NB candidates),
 *      answered by a `<…>` fill-in the committed spec answers. Nothing else
 *      may be open (a pending marketplace set is a `leave` proposal, never an
 *      open question);
 *   3. the draft MERGED with the committed answers (`mergeDraftAnswers`: each
 *      `<…>` fill-in taken from the answers file, everything else from the
 *      draft) matches the committed spec (`compareDraft`):
 *      - with every `leave` taken out of every `sync.pending` and every
 *        review's answers taken out, the two have the same digest: drift
 *        anywhere else is a visible failure;
 *      - every drafted review answer is in the committed spec, at the same
 *        checklist, with the same value. The committed spec may hold more
 *        (an answer the draft no longer shows because the name became known,
 *        a moot no-op at apply; or a lookup-staged career team or league the
 *        draft cannot preview). A drafted answer missing or different fails;
 *      - per variant type, the drafted `leave`s are a SUBSET of the
 *        committed ones. Another writer on the shared preview (the 2024
 *        Topps flagship's sole writer runs beside this job) can only take
 *        sets out of Pending, and a committed `leave` the draft no longer
 *        shows is a reported no-op at apply. A drafted `leave` the committed
 *        spec lacks is a NEW pending set: drift, and the check names it;
 *      - every checklist the draft lists in `autographFormats` (its cards
 *        carry AU) has an `autographFormat` in the committed spec: the
 *        operator's answer, which the draft never fills (NEO-345);
 *   4. `nb_plan` on the answers file: no open decision, and its confirmPhrase
 *      is exactly `--confirm` (computed offline by `confirm-phrase`);
 *   5. `nb_apply` with that phrase and `stopAt: "end"`: no stop, and every
 *      expected count matches (`reconciled`, `grouped`, `committed`, `built`);
 *   6. `nb_inspect`: an insert holds at least one built parallel, every row of
 *      the Parallel type built from Base holds cards, and every `after`
 *      expectation holds;
 *   7. `attention` (when the expect file has it): `nb_attention` on the set,
 *      polled (bounded by `lookupWaitMs`) until no card is still waiting on
 *      the BSC team lookup, must show exactly the measured `totals` (and,
 *      when the file gives it, exactly `autographRows` rows still asking
 *      "on card or sticker?"); then
 *      `nb_fix` with the committed `fix` answers (its phrase taken from the
 *      tool's own refusal, as an agent does) must apply every one, and a
 *      second `nb_attention` must show exactly those items gone. The apply's
 *      own `attentionLine` must agree with what the set holds.
 *
 * The fixture files are measured on a PR preview after the server previews
 * deploy. Until then they carry `"measured": false` and the smoke FAILS
 * ("fixture not measured yet"): it never passes vacuously. The `attention`
 * block has its own `"measured": false`: the smoke then lists the set, fails,
 * and prints what it measured (the totals and every item's address) so the
 * block can be filled in from the run.
 *
 * Output never names the deployment: the host is redacted with the secrets.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { CommandSpec } from "./cli";
import { scrub } from "./auth/token-source";
import { secretValues } from "./client/connect";
import { makeClient, type NbClient } from "./client/convex-client";
import { api } from "../../convex/_generated/api";
import { carriesAutographToken } from "../../convex/features/deriveCardFeatures";
import { countUnformattedAutographs } from "../../components/SetSelector/autograph-prompt";
import { readChecklist, resolveAttentionRow } from "./lib/attention";
import { queryOnlyClient } from "./runner/read-only-client";
import { resolveSetPath, type ResolvedSet } from "./spec/resolve";
import { canonicalJson, contentDigest } from "./client/target";
import { drillResolverOf, inspectLinkProblems, setLinkProblems, type DrillResolver } from "./link-checks";
import { APPLY_TIMEOUT_MS, connectToSpawnedServer, inspectExpectSchema, inspectMismatches } from "./mcp-smoke";
import { mergeDraftAnswers, placeholdersIn } from "./runner/draft";
import { getAt } from "./runner/engine";
import {
  countOpenDecisions,
  type ApplyReport,
  type AttentionReport,
  type AttentionSummary,
  type AutographAttentionItem,
  type CardAttentionItem,
  type DraftReport,
  type FixReport,
  type InspectReport,
  type NameSuggestionItem,
  type PlanReport,
  type SetPath,
} from "./service";
import { FixAnswersSchema } from "./lib/fix-answers";
import { parseSpec } from "./spec/schema";

/** A draft previews every checklist of the set: minutes, not seconds. */
export const DRAFT_TIMEOUT_MS = 20 * 60_000;
const READ_TIMEOUT_MS = 2 * 60_000;

export const NOT_MEASURED = "fixture not measured yet";

export const oneshotExpectSchema = z
  .object({
    /** A measured file says so; `false` is the placeholder, refused before this schema. */
    measured: z.literal(true).optional(),
    path: z
      .object({
        sport: z.string().min(1),
        year: z.union([z.string().min(1), z.number().int()]).transform(String),
        manufacturer: z.string().min(1),
        set: z.string().min(1),
      })
      .strict(),
    draft: z
      .object({
        teamLookupBudget: z.number().int().min(0).optional(),
        /**
         * NEO-345: exactly the `at`s the draft's `autographFormats` must list
         * (the set's AU checklists), so an empty list can never pass.
         * Compared when given.
         */
        autographFormats: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .default({}),
    apply: z.object({ counts: z.record(z.string(), z.number()) }).strict(),
    /** The Parallel type's title whose rows are built from Base (all must hold cards). */
    builtFromBaseType: z.string().min(1).default("Parallel"),
    after: z.array(inspectExpectSchema).default([]),
    /**
     * What the built set still needs from a person, and the answers the
     * smoke gives. REQUIRED: a file without it would skip step 7 and still
     * pass. `{ "measured": false }` until measured on the PR preview: the
     * smoke then lists, fails, and prints what it found.
     */
    attention: z
      .union([
        z.object({ measured: z.literal(false) }).passthrough(),
        z
          .object({
            measured: z.literal(true),
            /** How long to wait for the BSC team lookup to finish before listing. */
            lookupWaitMs: z.number().int().min(0).max(30 * 60_000).default(10 * 60_000),
            totals: z
              .object({
                cards: z.number().int().min(0),
                byKind: z.record(z.string(), z.number().int().min(0)),
                namesToCheck: z.number().int().min(0),
                /** NEO-345: rows still asking "on card or sticker?". Compared when given. */
                autographRows: z.number().int().min(0).optional(),
              })
              .strict(),
            /** The answers nb_fix gives (nb_fix's own shape); each must apply, and its item must be gone after. */
            fix: FixAnswersSchema,
            /**
             * Jason, 2026-10-18 — rows still asking "on card or sticker?" in the
             * listing after nb_fix. Pins the reach live: answering an insert
             * alone must also clear its listed parallels. Compared when given.
             */
            afterAutographRows: z.number().int().min(0).optional(),
          })
          .strict(),
      ]),
  })
  .strict();
export type OneshotExpect = z.infer<typeof oneshotExpectSchema>;
type MeasuredAttention = Extract<NonNullable<OneshotExpect["attention"]>, { measured: true }>;

/** How often the smoke re-lists while the team lookup drains. */
const LOOKUP_POLL_MS = 15_000;

export interface OneshotCheck {
  ok: boolean;
  label: string;
  detail: string;
}

/** A placeholder file: `{"measured": false, …}`. */
export function isUnmeasured(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { measured?: unknown }).measured === false;
}

/** Up to `max` leaf paths where two JSON values differ. Pure. */
export function differingPaths(a: unknown, b: unknown, max = 10, at = ""): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (out.length >= max) return;
    if (x && y && typeof x === "object" && typeof y === "object" && Array.isArray(x) === Array.isArray(y)) {
      const keys = Array.isArray(x)
        ? Array.from({ length: Math.max(x.length, (y as unknown[]).length) }, (_, i) => i)
        : [...new Set([...Object.keys(x), ...Object.keys(y as object)])].sort();
      for (const k of keys) {
        const xv = (x as Record<string | number, unknown>)[k];
        const yv = (y as Record<string | number, unknown>)[k];
        walk(xv, yv, typeof k === "number" ? `${p}[${k}]` : p ? `${p}.${k}` : k);
      }
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(p || "(root)");
  };
  walk(a, b, at);
  return out;
}

/** Where the open decisions are, by kind and spec location (never adapter text). */
function openSummary(d: DraftedOpen): string {
  const at = [
    ...d.names.map((n) => `${n.kind} at ${n.at}`),
    ...d.baseCandidates.map((b) => `Base ${b.side} at ${b.at}`),
    ...d.reconcile.map((r) => `reconcile at ${r.at}`),
    ...d.review.players.map((p) => `player "${p.name}" at ${p.at}`),
    ...d.review.teams.map((t) => `team "${t.name}" at ${t.at}`),
    ...d.conflicts.map((c) => `card #${c.cardNumber} at ${c.at}`),
    ...(d.grouping ?? []).map((g) => `grouping at ${g.at}`),
  ];
  return at.slice(0, 5).join("; ") + (at.length > 5 ? `; +${at.length - 5} more` : "");
}
type DraftedOpen = Extract<DraftReport, { status: "drafted" }>["openDecisions"];

type AnyAnswer = { name: string; decision: unknown } & Record<string, unknown>;
type AnyReview = "none-expected" | { players?: AnyAnswer[]; teams?: AnyAnswer[]; leagues?: AnyAnswer[] };
type AnyChecklist = { review?: AnyReview } & Record<string, unknown>;
type AnySpec = {
  steps?: Array<{
    base?: { checklist?: AnyChecklist };
    variants?: Array<{
      type?: string;
      sync?: { pending?: Array<{ side: string; id: string; decision: string }> };
      rows?: Array<{ name?: string; checklist?: AnyChecklist }>;
    }>;
  }>;
};

/** Every checklist in a spec, by its spec path. */
function checklistsOf(spec: AnySpec): Array<{ at: string; checklist: AnyChecklist }> {
  const out: Array<{ at: string; checklist: AnyChecklist }> = [];
  (spec.steps ?? []).forEach((step, i) => {
    if (step.base?.checklist) out.push({ at: `steps[${i}].base.checklist`, checklist: step.base.checklist });
    (step.variants ?? []).forEach((v, j) =>
      (v.rows ?? []).forEach((r, k) => {
        if (r.checklist) out.push({ at: `steps[${i}].variants[${j}].rows[${k}].checklist`, checklist: r.checklist });
      }),
    );
  });
  return out;
}

/**
 * The spec with what another writer can legitimately change taken out: every
 * `leave` in every `sync.pending`, and every checklist's review answers
 * (each review reads "none-expected"; the answers are compared on their own).
 * Pure.
 */
export function withoutVolatile<T>(spec: T): T {
  const copy = structuredClone(spec) as AnySpec;
  for (const step of copy.steps ?? []) {
    for (const v of step.variants ?? []) {
      if (v.sync?.pending) v.sync.pending = v.sync.pending.filter((p) => p.decision !== "leave");
    }
  }
  for (const { checklist } of checklistsOf(copy)) if (checklist.review !== undefined) checklist.review = "none-expected";
  return copy as T;
}

export interface DraftComparison {
  /** The digests of both specs with their leaves and review answers taken out are equal. */
  restSame: boolean;
  restDigests: { drafted: string; committed: string };
  /** Where the rest differs (up to 10). */
  restDiffers: string[];
  /** Per variant type: drafted leaves must be a subset of the committed ones. */
  types: Array<{
    at: string;
    type: string;
    drafted: number;
    committed: number;
    /** Committed leaves the draft no longer shows (no-ops at apply). */
    moot: number;
    /** Drafted leaves the committed spec lacks (`side:id`): NEW pending sets. */
    added: string[];
  }>;
  /** Review answers: every drafted one must be in the committed spec with the same value. */
  answers: {
    drafted: number;
    committed: number;
    /** Committed answers the draft does not show (moot, or lookup-staged rows the draft cannot see). */
    committedOnly: number;
    /** Drafted answers the committed spec lacks, or answers differently (path + why). */
    problems: string[];
  };
}

/** `players`/`teams`/`leagues` answers of a checklist, keyed `kind:name`. */
function answersOf(c: AnyChecklist | undefined): Map<string, AnyAnswer> {
  const out = new Map<string, AnyAnswer>();
  const review = c?.review;
  if (!review || review === "none-expected") return out;
  for (const kind of ["players", "teams", "leagues"] as const) {
    for (const a of review[kind] ?? []) out.set(`${kind}:${a.name.trim().replace(/\s+/g, " ")}`, a);
  }
  return out;
}

/**
 * Compare a merged draft with the committed spec (see the file comment).
 * Another writer on the shared preview can only take things away from what
 * the draft sees: sets out of Pending, names out of a review. So the draft's
 * leaves and review answers must each be a SUBSET of the committed spec's,
 * and everything else must match exactly. Pure.
 */
export function compareDraft(merged: unknown, committed: unknown): DraftComparison {
  const a = withoutVolatile(merged);
  const b = withoutVolatile(committed);
  const drafted = contentDigest(parseSpec(a));
  const want = contentDigest(parseSpec(b));
  const leavesOf = (spec: unknown, i: number, j: number) =>
    new Set(
      ((spec as AnySpec).steps?.[i]?.variants?.[j]?.sync?.pending ?? [])
        .filter((p) => p.decision === "leave")
        .map((p) => `${p.side}:${p.id}`),
    );
  const types: DraftComparison["types"] = [];
  ((merged as AnySpec).steps ?? []).forEach((step, i) =>
    (step.variants ?? []).forEach((v, j) => {
      const d = leavesOf(merged, i, j);
      const c = leavesOf(committed, i, j);
      if (d.size === 0 && c.size === 0) return;
      types.push({
        at: `steps[${i}].variants[${j}]`,
        type: v.type ?? "?",
        drafted: d.size,
        committed: c.size,
        moot: [...c].filter((x) => !d.has(x)).length,
        added: [...d].filter((x) => !c.has(x)),
      });
    }),
  );

  const committedByAt = new Map(checklistsOf(committed as AnySpec).map((x) => [x.at, x.checklist]));
  const answers: DraftComparison["answers"] = { drafted: 0, committed: 0, committedOnly: 0, problems: [] };
  for (const { checklist } of checklistsOf(committed as AnySpec)) answers.committed += answersOf(checklist).size;
  const seen = new Set<string>();
  for (const { at, checklist } of checklistsOf(merged as AnySpec)) {
    const mine = answersOf(checklist);
    const theirs = answersOf(committedByAt.get(at));
    answers.drafted += mine.size;
    for (const [key, ans] of mine) {
      seen.add(`${at}|${key}`);
      const other = theirs.get(key);
      const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      if (!other) answers.problems.push(`${at}.review.${kind} "${name}": drafted, not in the committed spec`);
      else if (canonicalJson(other) !== canonicalJson(ans)) {
        answers.problems.push(`${at}.review.${kind} "${name}": drafted ${canonicalJson(ans)}, committed ${canonicalJson(other)}`);
      }
    }
  }
  for (const { at, checklist } of checklistsOf(committed as AnySpec)) {
    for (const key of answersOf(checklist).keys()) if (!seen.has(`${at}|${key}`)) answers.committedOnly++;
  }

  return {
    restSame: drafted === want,
    restDigests: { drafted, committed: want },
    restDiffers: drafted === want ? [] : differingPaths(a, b),
    types,
    answers,
  };
}

/** An insert row holding at least one parallel with cards. */
export function insertWithBuiltParallel(report: InspectReport): string | undefined {
  for (const t of report.variantTypes ?? []) {
    for (const r of t.rows) {
      const built = (r.parallels ?? []).find((p) => p.cards > 0);
      if (built) return `${t.type} › ${r.name} › ${built.name} (${built.cards})`;
    }
  }
  return undefined;
}

class ToolCallFailed extends Error {}

type FixAnswerSet = MeasuredAttention["fix"];
const isBaseRef = (row: { type?: string; name?: string; parallel?: string } | undefined) =>
  !row || (row.type === undefined && row.name === undefined && row.parallel === undefined);

/** The listed card an answer addresses (row + number, `cardId` on a tie). Pure. */
export function cardsAnswered(listing: readonly CardAttentionItem[], answer: NonNullable<FixAnswerSet["cards"]>[number]): CardAttentionItem[] {
  return listing.filter((c) => {
    if (c.cardNumber !== answer.cardNumber) return false;
    if (answer.cardId !== undefined && c.cardId !== answer.cardId) return false;
    // Base is the one checklist listed by its type alone.
    if (isBaseRef(answer.row)) return c.row.name === undefined && c.row.parallel === undefined;
    return c.row.type === answer.row!.type && c.row.name === answer.row!.name && c.row.parallel === answer.row!.parallel;
  });
}

/** The listed autograph row an answer addresses (its row; omitted = Base). Pure. */
export function autographsAnswered(
  listing: readonly AutographAttentionItem[],
  answer: NonNullable<FixAnswerSet["autographs"]>[number],
): AutographAttentionItem[] {
  return listing.filter((a) =>
    isBaseRef(answer.row)
      ? a.row.name === undefined && a.row.parallel === undefined
      : a.row.type === answer.row!.type && a.row.name === answer.row!.name && a.row.parallel === answer.row!.parallel,
  );
}

/**
 * Jason, 2026-10-18 — the listed autograph rows `nb_fix`'s answers reached
 * (`results[].parallels.rowIds` of applied answers), each with the format of
 * the answer that reached it. A reached row the listing did not show (no AU
 * card waiting) is not one the after-check counts. Pure.
 */
export function reachedAutographRows(
  report: Pick<FixReport, "results">,
  listing: readonly AutographAttentionItem[],
): Map<string, { row: AutographAttentionItem["row"]; label: string; format: string }> {
  const listed = new Map(listing.map((a) => [a.rowId, a]));
  const out = new Map<string, { row: AutographAttentionItem["row"]; label: string; format: string }>();
  for (const r of report.results) {
    if (r.outcome !== "applied" || !("parallels" in r) || !r.parallels) continue;
    for (const rowId of r.parallels.rowIds ?? []) {
      const item = listed.get(rowId);
      if (item && !out.has(rowId)) out.set(rowId, { row: item.row, label: item.rowLabel, format: r.format });
    }
  }
  return out;
}

/** A listed row's ref as the read-back reader takes it (Base: no row). */
function readBackRefOf(row: AutographAttentionItem["row"]): { type?: string; name?: string; parallel?: string } | undefined {
  return row.name === undefined && row.parallel === undefined ? undefined : row;
}

/** One row as the read-back sees it: its stored format, and its own AU cards. */
export interface AutographRowState {
  format?: string;
  /** The row's own cards carrying "AU" (guests excluded). */
  autographed: number;
  /** Of those, the ones still marked not autographed. */
  unformatted: number;
}

/** Reads one row of the set straight from NB (queries only), for the positive read-back. */
export type AutographRowReader = (row: { type?: string; name?: string; parallel?: string } | undefined) => Promise<AutographRowState>;

/** The read-back's verdict for one row the run answered. Pure. */
export function autographReadBackProblem(label: string, want: string, got: AutographRowState): string | undefined {
  if (got.format !== want) return `${label} holds autographFormat ${got.format === undefined ? "none" : `"${got.format}"`}, expected "${want}"`;
  if (got.autographed === 0) return `${label} holds no AU card`;
  if (got.unformatted > 0) return `${label}: ${got.unformatted} of ${got.autographed} AU cards still marked None`;
  return undefined;
}

/** The read-back's reader, over the harness's own client (queries only). */
export function autographRowReaderOf(client: NbClient, path: SetPath): AutographRowReader {
  const reads = queryOnlyClient(client);
  let set: Promise<ResolvedSet> | undefined;
  return async (row) => {
    set ??= resolveSetPath(reads, path);
    const node = await resolveAttentionRow(reads, await set, row, "read-back");
    const leaf = await reads.query(api.selectorOptions.getSelectorOptionById, { id: node.rowId });
    const own = (await readChecklist(reads, node.rowId)).filter((c) => !c.isCrossListed);
    const au = own.filter((c) => carriesAutographToken(c.attributes));
    return {
      ...(leaf?.features?.autographFormat !== undefined ? { format: leaf.features.autographFormat } : {}),
      autographed: au.length,
      unformatted: countUnformattedAutographs(au),
    };
  };
}

/** The listed name side an answer addresses. Pure. */
export function namesAnswered(listing: readonly NameSuggestionItem[], answer: NonNullable<FixAnswerSet["names"]>[number]): string[] {
  const want = canonicalJson(answer.row ?? {});
  return listing
    .filter((n) => canonicalJson(n.row) === want && n.sides.some((x) => x.side === answer.side))
    .map((n) => `${n.rowId}:${answer.side}`);
}

/** Every item's address, for a person filling the fixture in from a run. */
function attentionInventory(r: AttentionReport): string {
  const cards = r.cards.map((c) => `${c.rowLabel} #${c.cardNumber} (${c.kinds.join("+")})`);
  const names = r.names.flatMap((n) => n.sides.map((x) => `${n.where} ${x.side} “${x.label}”`));
  const autographs = (r.autographs ?? []).map((a) => `${a.rowLabel} (${a.cards})`);
  const short = (xs: string[]) => (xs.length > 20 ? [...xs.slice(0, 20), `+${xs.length - 20} more`] : xs).join("; ");
  return `cards: ${short(cards) || "none"} | names: ${short(names) || "none"} | autograph rows: ${short(autographs) || "none"}`;
}

async function call<T>(client: Client, tool: string, args: Record<string, unknown>, timeout: number): Promise<T> {
  const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((c) => (c && c.type === "text" ? c.text : "")).join("");
  if (result.isError) throw new ToolCallFailed(`${tool} returned an error: ${text.slice(0, 600)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ToolCallFailed(`${tool} returned text that is not JSON.`);
  }
}

export async function runOneshotSequence(
  client: Client,
  o: {
    answersPath: string;
    answers: unknown;
    expect: OneshotExpect;
    confirm: string;
    onCheck?: (c: OneshotCheck) => void;
    /** Injectable for tests: how the attention step waits between listings. */
    sleep?: (ms: number) => Promise<void>;
    /** The app origin the run was given (`--app-url`); links must be absolute on it. Absent: root-relative. */
    appOrigin?: string;
    /** The page's read-only drill resolver, through the tool's client: a link must open the row. */
    resolveDrill: DrillResolver;
    /** NEO-345: reads a row's stored format and its AU cards straight from NB, for the positive read-back. */
    readAutographRow: AutographRowReader;
  },
): Promise<OneshotCheck[]> {
  const checks: OneshotCheck[] = [];
  const record = (ok: boolean, label: string, detail: string) => {
    const c = { ok, label, detail };
    checks.push(c);
    o.onCheck?.(c);
    return ok;
  };
  const attempt = async (label: string, fn: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await fn();
    } catch (err) {
      return record(false, label, err instanceof Error ? err.message : String(err));
    }
  };
  const path = o.expect.path as SetPath;
  /** NEO-345: rows the committed spec answers "on card or sticker?" for, read back after apply. */
  const specAutographs: Array<{ label: string; row: { type?: string; name?: string; parallel?: string } | undefined; format: string }> = [];
  const fixAutographs = o.expect.attention.measured === true ? (o.expect.attention.fix.autographs ?? []) : [];

  // 1. tools/list
  const listed = await attempt("tools/list", async () => {
    const { tools } = await client.listTools();
    const ok = tools.some((t) => t.name === "nb_draft_set");
    return record(ok, "tools/list", ok ? `${tools.length} tools, nb_draft_set among them` : "nb_draft_set is missing");
  });
  if (!listed) return checks;

  // 2–3. draft, then the merge against the committed answers
  const drafted = await attempt("nb_draft_set", async () => {
    const draft = await call<DraftReport>(
      client,
      "nb_draft_set",
      { path, ...(o.expect.draft.teamLookupBudget !== undefined ? { teamLookupBudget: o.expect.draft.teamLookupBudget } : {}) },
      DRAFT_TIMEOUT_MS,
    );
    if (draft.status !== "drafted") return record(false, "nb_draft_set", `the set did not resolve (${draft.kind})`);
    const open = countOpenDecisions(draft.openDecisions);
    // The only open decisions a proof may carry are the operator's own: card
    // conflicts and review names with NB candidates. Each comes back as a
    // `<…>` fill-in the committed spec answers (checked just below). Anything
    // else (a Base pick, a title clash, a checklist the draft could not see)
    // means the draft did not settle the set: fail.
    const operatorOnly = { ...draft.openDecisions, conflicts: [], review: { players: [], teams: [], leagues: [] } };
    const unsettled = countOpenDecisions(operatorOnly);
    const okOpen = unsettled === 0;
    record(
      okOpen,
      "nb_draft_set",
      `${open} open decision(s), ${open - unsettled} of them card conflicts / review names for the committed spec to answer` +
        `${okOpen ? "" : `; ${unsettled} the draft should have settled (${openSummary(operatorOnly)})`}; ${draft.proposals.length} proposals; ${draft.marketplaceCalls} marketplace requests in ${Math.round(draft.durationMs / 1000)}s`,
    );
    const merged = mergeDraftAnswers(draft.template ?? draft.spec, o.answers);
    const left = placeholdersIn(merged);
    if (left.length > 0) return record(false, "draft + answers", `the answers file leaves ${left.length} fill-in(s): ${left.slice(0, 5).join(", ")}`);
    const cmp = compareDraft(merged, o.answers);
    record(
      cmp.restSame,
      "draft + answers",
      cmp.restSame
        ? `digest ${cmp.restDigests.drafted} (leaves and review answers aside) = the committed spec's`
        : `digest ${cmp.restDigests.drafted} (leaves and review answers aside) ≠ the committed spec's ${cmp.restDigests.committed}; differs at ${cmp.restDiffers.join(", ")}`,
    );
    const added = cmp.types.filter((t) => t.added.length > 0);
    const leavesOk = added.length === 0;
    const perType = cmp.types.map((t) => `${t.type} drafted ${t.drafted} / committed ${t.committed}, ${t.moot} moot`).join("; ") || "no leaves";
    record(
      leavesOk,
      "leave lists",
      leavesOk
        ? perType
        : `new pending set(s) the committed spec does not leave: ${added
            .map((t) => `${t.type} (${t.at}) ${t.added.slice(0, 10).join(", ")}${t.added.length > 10 ? ` +${t.added.length - 10} more` : ""}`)
            .join("; ")}; ${perType}`,
    );
    // NEO-345: the operator's "on card or sticker?" for every AU checklist:
    // the draft must list exactly the pinned checklists (an empty list never
    // passes), and each is answered by the committed spec or by the fix answers.
    const asked = draft.autographFormats ?? [];
    const pinned = o.expect.draft.autographFormats;
    const askedAts = asked.map((q) => q.at).sort();
    const pinOk = pinned === undefined || canonicalJson(askedAts) === canonicalJson([...pinned].sort());
    const byFix = (q: (typeof asked)[number]) =>
      fixAutographs.some((a) => autographsAnswered([{ row: q.row ?? {} } as AutographAttentionItem], a).length === 1);
    const unanswered = asked.filter((q) => typeof getAt(o.answers, q.at) !== "string" && !byFix(q));
    for (const q of asked) {
      const format = getAt(o.answers, q.at);
      if (typeof format === "string") specAutographs.push({ label: q.label, row: q.row ?? undefined, format });
    }
    const fixed = asked.filter(byFix).length;
    record(
      pinOk && unanswered.length === 0,
      "autograph formats",
      [
        !pinOk && `the draft lists ${askedAts.length} AU checklist(s) (${askedAts.join(", ") || "none"}), expected ${pinned!.length} (${[...pinned!].sort().join(", ")})`,
        unanswered.length > 0 && `neither the committed spec nor the fix answers say how these are signed: ${unanswered.map((q) => `${q.label} (${q.at})`).join("; ")}`,
      ]
        .filter(Boolean)
        .join("; ") || `${asked.length} AU checklist(s): ${specAutographs.length} answered in the spec, ${fixed} by the fix answers`,
    );
    const answersOk = cmp.answers.problems.length === 0;
    const answerLine = `drafted ${cmp.answers.drafted} / committed ${cmp.answers.committed}, ${cmp.answers.committedOnly} committed-only (moot or lookup-staged)`;
    record(
      answersOk,
      "review answers",
      answersOk
        ? answerLine
        : `${cmp.answers.problems.slice(0, 8).join("; ")}${cmp.answers.problems.length > 8 ? `; +${cmp.answers.problems.length - 8} more` : ""}; ${answerLine}`,
    );
    return okOpen && cmp.restSame && leavesOk && answersOk && pinOk && unanswered.length === 0;
  });
  if (!drafted) return checks;

  // 4. plan the committed spec
  let phrase: string | undefined;
  const planned = await attempt("nb_plan", async () => {
    const plan = await call<PlanReport>(client, "nb_plan", { specPath: o.answersPath }, READ_TIMEOUT_MS);
    const open = countOpenDecisions(plan.openDecisions);
    phrase = plan.confirmPhrase;
    const okPhrase = plan.confirmPhrase === o.confirm;
    return record(
      open === 0 && okPhrase,
      "nb_plan",
      [open !== 0 && `${open} open decision(s)`, !okPhrase && "its confirmPhrase is not --confirm"].filter(Boolean).join("; ") ||
        `${plan.steps.length} steps, no open decision`,
    );
  });
  if (!planned || !phrase) return checks;

  // 5. apply, collecting
  let applyLine: string | undefined;
  let applyAttention: AttentionSummary | undefined;
  let applyLinks: ApplyReport["setLinks"];
  const applied = await attempt("nb_apply", async () => {
    const report = await call<ApplyReport>(client, "nb_apply", { specPath: o.answersPath, confirm: phrase, stopAt: "end" }, APPLY_TIMEOUT_MS);
    const problems: string[] = [];
    for (const s of report.stops ?? (report.stoppedAt ? [report.stoppedAt] : [])) problems.push(`stopped at step ${s.step}: ${s.reason}`);
    // Name what the review asked, so a red run says which spec answers are missing.
    const review = report.openDecisions?.review;
    for (const kind of ["players", "teams", "leagues"] as const) {
      for (const r of review?.[kind] ?? []) problems.push(`${kind.slice(0, -1)} "${r.name}" ${r.reason} at ${r.at}`);
    }
    for (const [key, want] of Object.entries(o.expect.apply.counts)) {
      const got = report.counts?.[key];
      if (got !== want) problems.push(`counts.${key} is ${got ?? "missing"}, expected ${want}`);
    }
    const shown = Object.keys(o.expect.apply.counts).map((k) => `${k} ${report.counts?.[k]}`).join(", ");
    applyLine = report.attentionLine;
    applyAttention = report.setLinks?.find((l) => l.attention)?.attention;
    applyLinks = report.setLinks;
    return record(problems.length === 0, "nb_apply", problems.length === 0 ? `${shown} in ${Math.round((report.durationMs ?? 0) / 1000)}s` : problems.join("; "));
  });
  if (!applied) return checks;
  record(
    !!applyLine && !!applyAttention,
    "nb_apply attention",
    applyLine ? `${applyLine}${applyAttention ? "" : " (no set carried attention)"}` : "the report has no attentionLine",
  );

  await attempt("nb_apply links", async () => {
    const problems = await setLinkProblems(applyLinks, { appOrigin: o.appOrigin, resolve: o.resolveDrill });
    return record(problems.length === 0, "nb_apply links", problems.length === 0 ? `${applyLinks!.length} set link(s), each opens its set` : problems.join("; "));
  });

  // 6. inspect
  await attempt("nb_inspect", async () => {
    const report = await call<InspectReport>(client, "nb_inspect", { path }, READ_TIMEOUT_MS);
    if (!report.found) return record(false, "nb_inspect", "the set was not found after the build");
    const linkBad = await inspectLinkProblems(report, { appOrigin: o.appOrigin, resolve: o.resolveDrill });
    record(linkBad.length === 0, "nb_inspect links", linkBad.length === 0 ? "every link is a Set Builder link that opens its row" : linkBad.join("; "));
    const insert = insertWithBuiltParallel(report);
    record(!!insert, "insert with a built parallel", insert ?? "no insert holds a parallel with cards");
    const parallels = (report.variantTypes ?? []).filter((t) => t.type === o.expect.builtFromBaseType).flatMap((t) => t.rows);
    const empty = parallels.filter((r) => r.cards === 0).map((r) => r.name);
    record(
      parallels.length > 0 && empty.length === 0,
      `${o.expect.builtFromBaseType} rows built from Base`,
      parallels.length === 0 ? "no such rows" : empty.length === 0 ? `${parallels.length} rows, all with cards` : `${empty.length} without cards: ${empty.slice(0, 5).join(", ")}`,
    );
    for (const exp of o.expect.after) {
      const bad = inspectMismatches(report, exp);
      record(bad.length === 0, "after", bad.length === 0 ? "as expected" : bad.join("; "));
    }
    return true;
  });

  // 6b. NEO-345: each row the spec answered holds the format, and its AU cards took it.
  await attempt("autograph read-back (spec)", async () => {
    const problems: string[] = [];
    for (const a of specAutographs) {
      const p = autographReadBackProblem(a.label, a.format, await o.readAutographRow(a.row));
      if (p) problems.push(p);
    }
    return record(
      problems.length === 0,
      "autograph read-back (spec)",
      problems.length === 0 ? `${specAutographs.length} row(s) hold their format, every AU card marked` : problems.join("; "),
    );
  });

  // 7. attention
  await attentionSequence(client, path, o.expect.attention, record, attempt, o.sleep, o.readAutographRow);
  return checks;
}

/** Step 7 (see the file comment). */
async function attentionSequence(
  client: Client,
  path: SetPath,
  expect: NonNullable<OneshotExpect["attention"]>,
  record: (ok: boolean, label: string, detail: string) => boolean,
  attempt: (label: string, fn: () => Promise<boolean>) => Promise<boolean>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  readAutographRow?: AutographRowReader,
): Promise<void> {
  const waitMs = expect.measured === true ? expect.lookupWaitMs : 10 * 60_000;
  let before: AttentionReport | undefined;
  const listed = await attempt("nb_attention", async () => {
    const started = Date.now();
    for (;;) {
      before = await call<AttentionReport>(client, "nb_attention", { path }, READ_TIMEOUT_MS);
      if (before.totals.awaitingTeamLookup === 0 || Date.now() - started >= waitMs) break;
      await sleep(LOOKUP_POLL_MS);
    }
    const t = before.totals;
    const seen = `cards ${t.cards}, byKind ${canonicalJson(t.byKind)}, namesToCheck ${t.namesToCheck}, autographRows ${t.autographRows}, awaitingTeamLookup ${t.awaitingTeamLookup}`;
    if (t.awaitingTeamLookup > 0) return record(false, "nb_attention", `the team lookup did not finish in ${Math.round(waitMs / 1000)}s: ${seen}`);
    if (expect.measured !== true) {
      return record(false, "nb_attention", `attention ${NOT_MEASURED}; measured ${seen}. ${attentionInventory(before)}`);
    }
    const want = expect.totals;
    const nonzero = (m: Record<string, number>) => canonicalJson(Object.fromEntries(Object.entries(m).filter(([, n]) => n > 0)));
    const ok =
      t.cards === want.cards &&
      t.namesToCheck === want.namesToCheck &&
      nonzero(t.byKind) === nonzero(want.byKind) &&
      (want.autographRows === undefined || t.autographRows === want.autographRows);
    const wanted = `expected cards ${want.cards}, byKind ${canonicalJson(want.byKind)}, namesToCheck ${want.namesToCheck}${want.autographRows === undefined ? "" : `, autographRows ${want.autographRows}`}`;
    return record(ok, "nb_attention", ok ? `${seen}: ${before.summary}` : `${seen}; ${wanted}. ${attentionInventory(before)}`);
  });
  if (!listed || !before || expect.measured !== true) return;
  const fix = expect.fix;
  const afterAutographRows = expect.afterAutographRows;

  // What each answer addresses, before: it must be listed, once.
  const goneCards = new Set<string>();
  const goneNames = new Set<string>();
  /** NEO-345: the autograph rows the fix answers, by NB row id. */
  const goneAutographs = new Set<string>();
  /**
   * Jason, 2026-10-18 — listed autograph rows an answer REACHED: parallels of
   * an answered insert (or the Base) that had no format of their own, which
   * the server answered with it (`nb_fix`'s `results[].parallels.rowIds`).
   * They leave the listing too, and the read-back checks each one, with the
   * answer that reached it.
   */
  const reachedAutographs = new Map<string, { row: AutographAttentionItem["row"]; label: string; format: string }>();
  const addressed = await attempt("nb_fix answers", async () => {
    const problems: string[] = [];
    (fix.autographs ?? []).forEach((a, i) => {
      const hit = autographsAnswered(before!.autographs ?? [], a);
      if (hit.length !== 1) problems.push(`autographs[${i}] addresses ${hit.length} listed autograph rows`);
      else goneAutographs.add(hit[0].rowId);
    });
    (fix.cards ?? []).forEach((a, i) => {
      const hit = cardsAnswered(before!.cards, a);
      if (hit.length !== 1) problems.push(`cards[${i}] #${a.cardNumber} addresses ${hit.length} listed cards`);
      else goneCards.add(hit[0].cardId);
    });
    (fix.names ?? []).forEach((a, i) => {
      const hit = namesAnswered(before!.names, a);
      if (hit.length !== 1) problems.push(`names[${i}] addresses ${hit.length} listed names`);
      else goneNames.add(hit[0]);
    });
    return record(
      problems.length === 0,
      "nb_fix answers",
      problems.length === 0 ? `${goneCards.size} cards, ${goneNames.size} names, ${goneAutographs.size} autograph rows, each listed once` : problems.join("; "),
    );
  });
  if (!addressed) return;

  const fixed = await attempt("nb_fix", async () => {
    const args = { path, ...fix };
    // The phrase comes from the tool's own refusal, as an agent gets it.
    const refusal = await client.callTool({ name: "nb_fix", arguments: args }, undefined, { timeout: READ_TIMEOUT_MS });
    const text = (Array.isArray(refusal.content) ? refusal.content : []).map((c) => (c && c.type === "text" ? c.text : "")).join("");
    const expected = refusal.isError ? (JSON.parse(text) as { expected?: string }).expected : undefined;
    if (!expected) return record(false, "nb_fix", "a call without confirm did not return the phrase");
    const report = await call<FixReport>(client, "nb_fix", { ...args, confirm: expected }, APPLY_TIMEOUT_MS);
    const notApplied = report.results.filter((r) => r.outcome !== "applied");
    for (const [rowId, reached] of reachedAutographRows(report, before!.autographs ?? [])) {
      if (!goneAutographs.has(rowId)) reachedAutographs.set(rowId, reached);
    }
    const reachedNote = reachedAutographs.size > 0 ? ` (${reachedAutographs.size} listed parallel row(s) reached)` : "";
    return record(
      notApplied.length === 0,
      "nb_fix",
      notApplied.length === 0
        ? `${report.results.length} answers applied${reachedNote}; ${report.summary}`
        : notApplied.map((r) => `${r.at} ${r.outcome}: ${r.detail}`).join("; "),
    );
  });
  if (!fixed) return;

  await attempt("nb_attention after nb_fix", async () => {
    const after = await call<AttentionReport>(client, "nb_attention", { path }, READ_TIMEOUT_MS);
    const cardIds = new Set(after.cards.map((c) => c.cardId));
    const nameKeys = new Set(after.names.flatMap((n) => n.sides.map((x) => `${n.rowId}:${x.side}`)));
    const stillThere = [...goneCards].filter((id) => cardIds.has(id)).length + [...goneNames].filter((k) => nameKeys.has(k)).length;
    const beforeCards = new Set(before!.cards.map((c) => c.cardId));
    const beforeNames = new Set(before!.names.flatMap((n) => n.sides.map((x) => `${n.rowId}:${x.side}`)));
    const appeared = after.cards.filter((c) => !beforeCards.has(c.cardId)).length + [...nameKeys].filter((k) => !beforeNames.has(k)).length;
    // NEO-345: the answered autograph rows, and the listed parallels the
    // answers reached, are gone, and none appeared.
    const afterRows = new Set((after.autographs ?? []).map((a) => a.rowId));
    const beforeRows = new Set((before!.autographs ?? []).map((a) => a.rowId));
    const gone = new Set([...goneAutographs, ...reachedAutographs.keys()]);
    const autographsLeft = [...gone].filter((id) => afterRows.has(id)).length;
    const autographsNew = [...afterRows].filter((id) => !beforeRows.has(id)).length;
    const ok =
      stillThere + autographsLeft === 0 &&
      appeared + autographsNew === 0 &&
      after.totals.cards === before!.totals.cards - goneCards.size &&
      after.totals.namesToCheck === before!.totals.namesToCheck - goneNames.size &&
      after.totals.autographRows === before!.totals.autographRows - gone.size &&
      (afterAutographRows === undefined || after.totals.autographRows === afterAutographRows);
    return record(
      ok,
      "nb_attention after nb_fix",
      ok
        ? after.summary
        : `${stillThere + autographsLeft} answered item(s) still listed, ${appeared + autographsNew} new; cards ${before!.totals.cards} → ${after.totals.cards}, names ${before!.totals.namesToCheck} → ${after.totals.namesToCheck}, autograph rows ${before!.totals.autographRows} → ${after.totals.autographRows}${afterAutographRows === undefined ? "" : ` (expected ${afterAutographRows} after)`}`,
    );
  });

  // NEO-345: each row nb_fix answered holds the format, and its AU cards took it (the fix waited for the walk).
  if ((fix.autographs ?? []).length === 0) return;
  await attempt("autograph read-back (nb_fix)", async () => {
    if (!readAutographRow) return record(false, "autograph read-back (nb_fix)", "the run has no read-back reader");
    const problems: string[] = [];
    for (const a of fix.autographs ?? []) {
      const label = [a.row?.type, a.row?.name, a.row?.parallel].filter(Boolean).join(" › ") || "Base";
      const p = autographReadBackProblem(label, a.format, await readAutographRow(a.row));
      if (p) problems.push(p);
    }
    // The parallels an answer reached hold that answer, and their AU cards took it.
    for (const reached of reachedAutographs.values()) {
      const p = autographReadBackProblem(reached.label, reached.format, await readAutographRow(readBackRefOf(reached.row)));
      if (p) problems.push(p);
    }
    const rows = fix.autographs!.length + reachedAutographs.size;
    return record(
      problems.length === 0,
      "autograph read-back (nb_fix)",
      problems.length === 0 ? `${rows} row(s) hold their format, every AU card marked` : problems.join("; "),
    );
  });
}

// ---------------------------------------------------------------------------
// The CLI command
// ---------------------------------------------------------------------------

function abs(p: string): string {
  return isAbsolute(p) ? p : resolvePath(process.cwd(), p);
}

async function readJson(p: string): Promise<unknown> {
  return JSON.parse(await readFile(abs(p), "utf8")) as unknown;
}

export const oneshotSmokeCommand: CommandSpec = {
  summary: "Spawn the MCP server and prove the one-shot build: draft → merge with the committed answers → plan → apply → inspect.",
  usage:
    'setbuild oneshot-smoke --answers <oneshot.spec.json> --expect <oneshot.expect.json> --confirm "BUILD <host> <scope> <digest>" [--paused-platforms <keys>] [--json] [connection flags]',
  options: {
    answers: { type: "string" },
    expect: { type: "string" },
    confirm: { type: "string" },
    "paused-platforms": { type: "string" },
  },
  async run(ctx) {
    const answersArg = typeof ctx.values.answers === "string" ? ctx.values.answers : undefined;
    const expectArg = typeof ctx.values.expect === "string" ? ctx.values.expect : undefined;
    const confirm = typeof ctx.values.confirm === "string" ? ctx.values.confirm : undefined;
    if (!answersArg || !expectArg) {
      ctx.io.stderr(`setbuild oneshot-smoke: --answers and --expect are required.\n\n${oneshotSmokeCommand.usage}`);
      return 2;
    }
    let answers: unknown;
    let rawExpect: unknown;
    try {
      [answers, rawExpect] = await Promise.all([readJson(answersArg), readJson(expectArg)]);
    } catch {
      ctx.io.stderr("setbuild oneshot-smoke: could not read --answers / --expect as JSON.");
      return 2;
    }
    // Placeholders fail loudly: an unmeasured fixture never passes.
    if (isUnmeasured(answers) || isUnmeasured(rawExpect)) {
      ctx.io.stderr(`setbuild oneshot-smoke: ${NOT_MEASURED} — measure it on the PR preview (docs/operations/neo339-setbuild.md §2.4).`);
      return 1;
    }
    const parsed = oneshotExpectSchema.safeParse(rawExpect);
    if (!parsed.success) {
      ctx.io.stderr(
        `setbuild oneshot-smoke: --expect is not a valid expectations file: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
      );
      return 2;
    }
    try {
      parseSpec(answers);
    } catch (err) {
      ctx.io.stderr(`setbuild oneshot-smoke: --answers is not a spec: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    if (!confirm) {
      ctx.io.stderr("setbuild oneshot-smoke: --confirm is required (setbuild confirm-phrase prints it).");
      return 2;
    }

    const conn = ctx.connect();
    const flag = (k: string) => (typeof ctx.values[k] === "string" ? (ctx.values[k] as string) : undefined);
    const flagEnv: Record<string, string | undefined> = {
      NB_SETBUILD_CONVEX_URL: conn.target.convexUrl,
      NB_SETBUILD_CONVEX_SITE_URL: flag("convex-site-url"),
      NB_SETBUILD_AUTH: conn.auth,
      NB_SETBUILD_TRANSPORT: conn.transport,
      NB_SETBUILD_APP_URL: flag("app-url"),
      NB_SETBUILD_WORKER: typeof ctx.values.worker === "string" ? ctx.values.worker : undefined,
      VITE_CLERK_PUBLISHABLE_KEY: flag("publishable-key"),
      PAUSED_PLATFORMS: flag("paused-platforms"),
    };
    const env: NodeJS.ProcessEnv = { ...ctx.io.env };
    for (const [k, v] of Object.entries(flagEnv)) if (v !== undefined) env[k] = v;
    // The deployment is never printed: its host is redacted with the secrets.
    const redact = [...secretValues(env), conn.target.host, conn.target.convexUrl];
    const say = (line: string) => ctx.io.stdout(scrub(line, redact));

    const server = await connectToSpawnedServer(env);
    // The page's resolver, through this process's own client (the server mints its own).
    const nb = makeClient(conn.target, conn.tokens, { transport: conn.transport });
    let checks: OneshotCheck[];
    try {
      checks = await runOneshotSequence(server.client, {
        appOrigin: conn.target.appOrigin,
        resolveDrill: drillResolverOf(nb),
        readAutographRow: autographRowReaderOf(nb, parsed.data.path as SetPath),
        answersPath: abs(answersArg),
        answers,
        expect: parsed.data,
        confirm,
        onCheck: ctx.json ? undefined : (c) => say(`${c.ok ? "ok  " : "FAIL"}  ${c.label}: ${c.detail}`),
      });
    } finally {
      await nb.close().catch(() => {});
      await server.close().catch(() => {});
    }
    const ok = checks.length > 0 && checks.every((c) => c.ok);
    if (ctx.json) say(JSON.stringify({ ok, checks }, null, 2));
    else {
      say(ok ? `oneshot-smoke passed (${checks.length} checks).` : "oneshot-smoke FAILED.");
      if (!ok && server.stderrTail().length > 0) ctx.io.stderr(scrub(["server stderr (last lines):", ...server.stderrTail()].join("\n"), redact));
    }
    return ok ? 0 : 1;
  },
};
