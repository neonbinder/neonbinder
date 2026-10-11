/**
 * NEO-339 — the one walk over a spec that both `plan` and `apply` run.
 *
 * `apply` runs it on the real client and stops at the first decision the spec
 * does not answer. `plan` runs the SAME step functions on `readOnlyClient`,
 * where every write is refused with `PlanWouldWrite`: a step that reaches its
 * write is "todo", one that never needed to is "done", and every open decision
 * on the way is collected rather than stopped at. Checklist and build steps are
 * judged from card counts in `plan` (fetching a checklist writes candidate
 * rows), which is why the wizard's template comes from `apply`'s stop point.
 *
 * Steps run in spec order, and each checks state before it writes, so a re-run
 * of a finished spec writes nothing and a run that stopped resumes where it
 * left off.
 *
 * Never writes to stdout: the MCP server's protocol runs over it.
 */

import type { NbClient } from "../client/convex-client";
import type { Target } from "../client/target";
import {
  formatPath,
  ResolveError,
  specConfirmPhrase,
  type ApplyCounts,
  type OpenDecisions,
  type PlanReport,
  type PlanStep,
} from "../service";
import type { BrandYearStep, SetBuildSpec, SetStep, VariantTypeStep } from "../spec/schema";
import { resolveVariantRow, resolveVariantType, childrenOf, type RowId } from "../spec/resolve";
import { ensureCredentials } from "../lib/credentials";
import {
  checkPausedPlatforms,
  ensureBrandYearPath,
  ensureColumn,
  ensureSetPath,
  syncBrandSets,
  type PausedContext,
} from "../lib/sync-column";
import { confirmMapping, findBaseVariantType } from "../lib/map-base";
import { reconcileVariants } from "../lib/reconcile-variants";
import { applySlReview } from "../lib/sl-review";
import { cardCount, checklistDone, runChecklistStep, type ReviewSession } from "../lib/commit";
import { buildParallelFromBase, planParallelBuild } from "../lib/build-parallel";
import { PlanWouldWrite } from "./read-only-client";

export type RunMode = "plan" | "apply";

export function emptyOpenDecisions(): OpenDecisions {
  return {
    names: [],
    baseCandidates: [],
    reconcile: [],
    review: { players: [], teams: [], leagues: [] },
    slReview: [],
    conflicts: [],
  };
}

export function emptyCounts(): ApplyCounts {
  return {
    built: 0,
    committed: 0,
    skipped: 0,
    synced: 0,
    mapped: 0,
    reconciled: 0,
    reviewed: 0,
    slReviewed: 0,
    credentials: 0,
  };
}

/** Apply stopped at an open decision; unwinds the walk. Internal. */
class StopRun extends Error {
  constructor(readonly step: number, readonly reason: string) {
    super(reason);
    this.name = "StopRun";
  }
}

/** A step that failed for a reason other than an open decision; carries the report so far. */
export class RunFailed extends Error {
  readonly report: PlanReport & { stoppedAt?: { step: number; reason: string }; counts?: ApplyCounts; durationMs?: number };
  readonly cause: unknown;
  constructor(message: string, report: RunFailed["report"], cause: unknown) {
    super(message);
    this.name = "RunFailed";
    this.report = report;
    this.cause = cause;
  }
}

export interface RunOptions {
  /** `PAUSED_PLATFORMS` as declared for this run (comma-separated site keys). */
  pausedPlatforms?: string;
  now?: () => number;
}

export interface RunResult extends PlanReport {
  stoppedAt?: { step: number; reason: string };
  counts: ApplyCounts;
  durationMs: number;
  /** Entity reviews left open at the stop, for `decide` / `reviewItems`. */
  sessions: Array<ReviewSession & { path: string }>;
}

// ---------------------------------------------------------------------------
// Template: the spec with every open answer as a fill-in
// ---------------------------------------------------------------------------

function parseAt(at: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const m of at.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    out.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  }
  return out;
}

/** Set `value` at `at` (`steps[1].base.checklist`) in a deep copy's tree, creating objects on the way. */
export function setAt(root: Record<string, unknown>, at: string, value: unknown): void {
  const parts = parseAt(at);
  let node: Record<string | number, unknown> = root;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) {
      node[p] = value;
      return;
    }
    if (node[p] === undefined || node[p] === null || typeof node[p] !== "object") {
      node[p] = typeof parts[i + 1] === "number" ? [] : {};
    }
    node = node[p] as Record<string | number, unknown>;
  });
}

const PICK = (ids: string[]) => `<one of: ${ids.join(" | ") || "(no candidates — check the name)"}>`;

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export async function runSpec(
  client: NbClient,
  target: Target,
  spec: SetBuildSpec,
  mode: RunMode,
  opts: RunOptions = {},
): Promise<RunResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  // Taken before the walk, from the spec exactly as parsed: the phrase binds
  // what the operator approved, whatever the run later does with it.
  const phrase = specConfirmPhrase(target, spec);
  const steps: PlanStep[] = [];
  const open = emptyOpenDecisions();
  const counts = emptyCounts();
  const sessions: RunResult["sessions"] = [];
  const template = structuredClone(spec) as unknown as Record<string, unknown>;
  let templateTouched = false;
  const patch = (at: string, value: unknown) => {
    setAt(template, at, value);
    templateTouched = true;
  };
  let stoppedAt: RunResult["stoppedAt"];

  const record = (s: PlanStep) => steps.push(s);

  /** Record an open decision: plan collects it, apply stops. */
  const stop = (index: number, reason: string): void => {
    if (mode === "apply") throw new StopRun(index, reason);
  };

  /** Run one sub-step; `PlanWouldWrite` = todo, `ResolveError` = open name. */
  async function sub<T>(
    index: number,
    kind: string,
    path: string,
    action: string,
    fn: () => Promise<T>,
    done: (value: T) => { status: PlanStep["status"]; detail?: string; stopReason?: string },
  ): Promise<T | undefined> {
    let value: T;
    try {
      value = await fn();
    } catch (err) {
      return failed(err, index, kind, path, action);
    }
    const { stopReason, ...result } = done(value);
    record({ index, kind, path, action, ...result });
    if (stopReason) stop(index, stopReason);
    return value;
  }

  /** `PlanWouldWrite` = todo; `ResolveError` = an open name (apply stops); anything else is thrown. */
  function failed(err: unknown, index: number, kind: string, path: string, action: string): undefined {
    if (err instanceof PlanWouldWrite) {
      record({ index, kind, path, action, status: "todo" });
      return undefined;
    }
    if (err instanceof ResolveError) {
      open.names.push({ at: err.at ?? `steps[${index}]`, kind: err.kind, name: err.query, candidates: err.candidates });
      if (err.at) patch(err.at, PICK(err.candidates.map((c) => c.name)));
      record({ index, kind, path, action, status: "blocked", detail: err.message });
      stop(index, err.message);
      return undefined;
    }
    throw err;
  }

  const blocked = (index: number, kind: string, path: string, action: string, detail: string): void => {
    record({ index, kind, path, action, status: "blocked", detail });
  };

  let paused: PausedContext;
  try {
    paused = await checkPausedPlatforms(client, opts.pausedPlatforms);

    if (spec.credentials) {
      const creds = spec.credentials;
      if (mode === "plan") {
        record({ index: -1, kind: "credentials", path: "", action: `seed ${creds.seed.join(", ") || "nothing"}${creds.warm ? " and warm" : ""}`, status: "todo" });
      } else {
        const out = await ensureCredentials(client, creds, paused);
        counts.credentials += out.seeded.filter((s) => s.outcome === "stored").length;
        record({
          index: -1,
          kind: "credentials",
          path: "",
          action: "seed test credentials",
          status: "done",
          detail: `${out.seeded.map((s) => `${s.site} ${s.outcome}`).join(", ") || "none"}${out.pausedSkipped.length ? `; paused: ${out.pausedSkipped.join(", ")}` : ""}`,
        });
      }
    }

    if (spec.rootSync) {
      await sub(-1, "root", "", "sync Sports", () => ensureColumn(client, "sport", undefined, { paused }), (r) => {
        if (r.outcome === "synced") counts.synced++;
        else counts.skipped++;
        return { status: "done", detail: `${r.rows.length} sports${r.outcome === "skipped" ? " (already synced)" : ""}` };
      });
    }

    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      if (step.kind === "brand-year") await brandYear(i, step);
      else await setStep(i, step);
    }
  } catch (err) {
    if (err instanceof StopRun) {
      stoppedAt = { step: err.step, reason: err.reason };
    } else {
      const partial = finish();
      throw new RunFailed(err instanceof Error ? err.message : String(err), partial, err);
    }
  }
  return finish();

  function finish(): RunResult {
    return {
      target: { convexUrl: target.convexUrl, host: target.host },
      scope: spec.scope,
      confirmPhrase: phrase,
      steps,
      openDecisions: open,
      template: templateTouched ? template : null,
      ...(stoppedAt ? { stoppedAt } : {}),
      counts,
      durationMs: now() - started,
      sessions,
    };
  }

  // ---------------------------------------------------------------------
  async function brandYear(i: number, step: BrandYearStep): Promise<void> {
    const path = formatPath(step.path);
    const at = `steps[${i}]`;
    const brand = await sub(i, "brand-year", path, "sync the path's columns", () =>
      ensureBrandYearPath(client, step.path, { paused, manufacturer: step.manufacturer, at: `${at}.path` }),
    (b) => {
      if (b.manufacturerCreated) counts.synced++;
      return { status: "done", detail: b.manufacturerCreated ? "manufacturer created" : undefined };
    });
    if (!brand) return blocked(i, "brand-year", path, "sync Sets", "the path does not resolve yet");

    await sub(i, "brand-year", path, "sync Sets", () => syncBrandSets(client, brand.manufacturerId, { paused }), (r) => {
      if (r.outcome === "synced") counts.synced++;
      else counts.skipped++;
      return { status: "done", detail: `${r.rows.length} sets${r.outcome === "skipped" ? " (already synced)" : ""}` };
    });

    if (step.slReview) {
      const decisions = step.slReview.decisions;
      await sub(i, "sl-review", path, "apply the SportLots set review", () =>
        applySlReview(client, brand.manufacturerId, decisions, { paused, at: `${at}.slReview`, path }),
      (r) => {
        if (r.outcome === "skipped") {
          counts.skipped++;
          return { status: "done", detail: "no review waiting" };
        }
        if (r.outcome === "open") {
          open.slReview.push(r.slReview);
          open.names.push(...r.names);
          const fill = [
            ...decisions,
            ...r.slReview.rows.map((row) => ({ slId: row.slId, placement: `<"own-set", or replace placement with set + variantType (+ name)> — ${row.name}${row.suggestion ? ` (suggested: ${row.suggestion})` : ""}` })),
          ];
          patch(`${at}.slReview.decisions`, fill);
          return { status: "blocked", detail: "open decisions", stopReason: `${r.slReview.rows.length + r.names.length} SportLots review line(s) need an answer` };
        }
        counts.slReviewed += r.applied;
        return {
          status: "done",
          detail: `${r.applied} filed, ${r.remaining} remaining${r.refused ? `, ${r.refused.rows.length} refused` : ""}`,
        };
      });
    }
  }

  // ---------------------------------------------------------------------
  async function setStep(i: number, step: SetStep): Promise<void> {
    const path = formatPath(step.path);
    const at = `steps[${i}]`;
    const set = await sub(i, "set", path, "sync the path's columns and variant types", () =>
      ensureSetPath(client, step.path, { paused, manufacturer: step.manufacturer, at: `${at}.path`, syncVariantTypes: true }),
    (s) => {
      const vt = s.columns[s.columns.length - 1];
      if (vt?.outcome === "synced") counts.synced++;
      else counts.skipped++;
      return { status: "done", detail: vt ? `${vt.rows.length} variant types${vt.outcome === "skipped" ? " (already synced)" : ""}` : undefined };
    });
    if (!set) {
      blocked(i, "set", path, "everything below the set", "the set path does not resolve yet");
      return;
    }
    const sportId = set.sportId;

    if (step.base) {
      const base = step.base;
      await sub(i, "base-map", path, `map Base to BSC ${base.map.bsc}${base.map.sportlots ? ` + SportLots ${base.map.sportlots}` : ""}`, () =>
        confirmMapping(client, set.setId, base.map, { paused, at: `${at}.base.map`, path }),
      (r) => {
        if (r.outcome === "mapped") {
          counts.mapped++;
          return { status: "done", detail: "mapped" };
        }
        if (r.outcome === "skipped") {
          counts.skipped++;
          return { status: "done", detail: r.reason === "paused" ? `skipped: ${r.pausedSides?.join(", ")} paused` : "already mapped" };
        }
        open.baseCandidates.push(...r.open);
        for (const o of r.open) patch(o.at, PICK(o.candidates.map((c) => `${c.id} (${c.name})`)));
        return { status: "blocked", detail: "open decisions", stopReason: `the Base ${r.open.map((o) => o.side).join(" and ")} id is not among the offered candidates` };
      });

      if (base.checklist) {
        const baseRow = await findBaseVariantType(client, set.setId);
        await checklist(i, path, `${at}.base.checklist`, baseRow._id, sportId, base.checklist, null, "Base");
      }
    }

    for (let j = 0; j < (step.variants ?? []).length; j++) {
      await variantType(i, j, path, set.setId, sportId, step.variants![j]);
    }
  }

  // ---------------------------------------------------------------------
  async function variantType(i: number, j: number, path: string, setId: RowId, sportId: RowId, vt: VariantTypeStep): Promise<void> {
    const at = `steps[${i}].variants[${j}]`;
    let syncTodo = false;
    if (vt.sync) {
      const sync = vt.sync;
      const synced = await sub(i, "reconcile", path, `sync ${vt.type} rows`, () =>
        reconcileVariants(client, setId, vt.type, sync, { paused, at, path }),
      (r) => {
        if (r.outcome === "saved") {
          counts.reconciled += r.stored;
          return { status: "done", detail: `${r.stored} stored (${r.mode})${r.specNotConsulted ? "; one marketplace returned rows, so no dialog — the spec's answers were not needed" : ""}` };
        }
        if (r.outcome === "skipped") {
          counts.skipped++;
          return { status: "done", detail: r.reason };
        }
        open.reconcile.push(r.reconcile);
        open.names.push(...r.names);
        patch(`${at}.sync`, {
          pairs: [
            ...sync.pairs,
            ...r.reconcile.proposedPairs.map((p) => ({ name: p.name, bsc: p.buysportscards, sportlots: p.sportlots })),
          ],
          pending: [
            ...sync.pending,
            ...r.reconcile.pending.map((p) => ({ side: p.side === "buysportscards" ? "bsc" : "sportlots", id: p.id, decision: `<"own-set" | "leave"> — ${p.name}` })),
          ],
        });
        return { status: "blocked", detail: "open decisions", stopReason: `${vt.type}: ${r.reconcile.proposedPairs.length + r.reconcile.pending.length + r.names.length} reconcile decision(s) need an answer` };
      });
      syncTodo = synced === undefined || synced.outcome === "open";
    }
    if (syncTodo && mode === "plan") {
      blocked(i, "row", path, `${vt.type} rows`, "checked once the sync has run");
      return;
    }

    const type = await sub(i, "variant-type", path, `find ${vt.type}`, () => resolveVariantType(client, setId, vt.type, `${at}.type`), () => ({ status: "done" }));
    if (!type) return;

    if (vt.expectRows !== undefined) {
      const rows = await childrenOf(client, "insert", type._id);
      const ok = rows.length === vt.expectRows;
      record({ index: i, kind: "expect-rows", path, action: `${vt.type} holds ${vt.expectRows} rows`, status: ok ? "done" : mode === "plan" ? "todo" : "blocked", detail: `${rows.length} now` });
      if (!ok && mode === "apply") throw new Error(`${at}.expectRows: ${vt.type} holds ${rows.length} rows; the spec expects ${vt.expectRows}.`);
    }

    for (let k = 0; k < (vt.rows ?? []).length; k++) {
      const spec = vt.rows![k];
      const rowAt = `${at}.rows[${k}]`;
      const label = `${vt.type} › ${spec.name}`;
      const row = await sub(i, "row", path, `find ${label}`, () => resolveVariantRow(client, type._id, spec.name, `${rowAt}.name`), () => ({ status: "done" }));
      if (!row) continue;
      if (spec.checklist) {
        await checklist(i, path, `${rowAt}.checklist`, row._id, sportId, spec.checklist, { type: vt.type, name: spec.name }, label);
      }
      if (spec.buildFromBase) {
        const input = { sourceId: type._id, name: spec.name, rebuild: spec.buildFromBase.rebuild, expectCards: spec.expectCards, at: rowAt };
        if (mode === "plan") {
          const p = await planParallelBuild(client, input).catch((err) => {
            if (err instanceof ResolveError) return { status: "blocked" as const, detail: err.message };
            throw err;
          });
          record({ index: i, kind: "build-parallel", path, action: `build ${label} from Base`, status: p.status, detail: p.detail });
        } else {
          let r: Awaited<ReturnType<typeof buildParallelFromBase>>;
          try {
            r = await buildParallelFromBase(client, input);
          } catch (err) {
            failed(err, i, "build-parallel", path, `build ${label} from Base`);
            continue;
          }
          if (r.outcome === "built") counts.built += r.built;
          else counts.skipped++;
          record({ index: i, kind: "build-parallel", path, action: `build ${label} from Base`, status: "done", detail: r.outcome === "built" ? `built ${r.built}, holds ${r.cards}` : r.detail });
        }
      } else if (!spec.checklist && spec.expectCards !== undefined) {
        const n = await cardCount(client, row._id);
        const ok = n === spec.expectCards;
        record({ index: i, kind: "expect-cards", path, action: `${label} holds ${spec.expectCards} cards`, status: ok ? "done" : mode === "plan" ? "todo" : "blocked", detail: `${n} now` });
        if (!ok && mode === "apply") throw new Error(`${rowAt}.expectCards: ${label} holds ${n} cards; the spec expects ${spec.expectCards}.`);
      }
    }
  }

  // ---------------------------------------------------------------------
  async function checklist(
    i: number,
    path: string,
    at: string,
    rowId: RowId,
    sportId: RowId,
    spec: NonNullable<NonNullable<SetStep["base"]>["checklist"]>,
    row: { type: string; name: string } | null,
    label: string,
  ): Promise<void> {
    const action = `fetch and commit the ${label} checklist`;
    if (mode === "plan") {
      const n = await cardCount(client, rowId);
      let done: boolean;
      try {
        done = checklistDone(n, spec.expectCards, at);
      } catch (err) {
        record({ index: i, kind: "checklist", path, action, status: "blocked", detail: err instanceof Error ? err.message : String(err) });
        return;
      }
      record({ index: i, kind: "checklist", path, action, status: done ? "done" : "todo", detail: done ? `holds ${n} cards` : "the review is only known once apply fetches it" });
      return;
    }
    let r: Awaited<ReturnType<typeof runChecklistStep>>;
    try {
      r = await runChecklistStep(client, { rowId, sportId, checklist: spec, at, row });
    } catch (err) {
      // A link target or a card ref that is not exactly one: an open name.
      failed(err, i, "checklist", path, action);
      return;
    }
    if (r.outcome === "skipped") {
      counts.skipped++;
      record({ index: i, kind: "checklist", path, action, status: "done", detail: r.detail });
      return;
    }
    if (r.outcome === "committed") {
      counts.committed += r.committed;
      counts.reviewed += r.review.players + r.review.teams + r.review.leagues;
      record({
        index: i,
        kind: "checklist",
        path,
        action,
        status: "done",
        detail: `saved ${r.committed} (holds ${r.cards}); ${r.pairing}; review: ${r.review.players} players, ${r.review.teams} teams, ${r.review.leagues} leagues${r.notes.length ? `; ${r.notes.join("; ")}` : ""}`,
      });
      return;
    }
    open.conflicts.push(...r.open.conflicts);
    open.review.players.push(...r.open.review.players);
    open.review.teams.push(...r.open.review.teams);
    open.review.leagues.push(...r.open.review.leagues);
    patch(at, r.template);
    if (r.session) sessions.push({ ...r.session, path });
    record({ index: i, kind: "checklist", path, action, status: "blocked", detail: r.reason });
    stop(i, `${label}: ${r.reason}`);
  }
}
