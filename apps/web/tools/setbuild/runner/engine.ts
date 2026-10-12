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
 * `stopAt` (apply only). `first` ends the run at the first open decision.
 * `end` collects: the step is recorded blocked, its open decisions and
 * fill-ins go into the report, every step that DEPENDS on it is recorded
 * blocked without running ("waits: …"), and every other step carries on. The
 * report then holds all the open decisions of the run and one template with
 * all their fill-ins. What depends on what (plan addendum §3.4):
 *
 * | open decision at            | waits                                                        |
 * |-----------------------------|--------------------------------------------------------------|
 * | a brand-year (path, SL review) | every later set step under that brand-year                 |
 * | the Base mapping            | the Base checklist, every variant type's sync (the matcher reads the Base's SportLots label) and every `buildFromBase` |
 * | the Base checklist          | every `buildFromBase` of the set                             |
 * | a variant type's sync       | that type's rows, grouping and parallels, and every LATER type's sync in the set (it reads the ids earlier types hold) |
 * | Group Parallels             | the type's rows' `parallels`                                 |
 * | a row's checklist           | that row's `parallels`                                       |
 * | a name that does not resolve | everything below it (the step cannot find its row)          |
 *
 * A failure that is not a decision (a refused build, a wrong expected count)
 * still ends the run in either mode.
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
  type StopAt,
} from "../service";
import type { BrandYearStep, InsertParallel, SetBuildSpec, SetStep, VariantTypeStep } from "../spec/schema";
import { resolveChild, resolveVariantRow, resolveVariantType, type RowId } from "../spec/resolve";
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
import { buildParallel, planParallelBuild, type BuildParallelInput } from "../lib/build-parallel";
import { groupParallels, planGrouping, type GroupOpen } from "../lib/group-parallels";
import { api } from "../../../convex/_generated/api";
import { PlanWouldWrite } from "./read-only-client";

/**
 * `plan`: read-only, collects every decision without dependency gating.
 * `apply`: writes; `stopAt` says whether it stops or collects.
 * `draft`: the walk `nb_draft_set` runs over the spec it drafted (runner/
 * draft.ts), on the draft client. Read-only like `plan` (every step takes its
 * plan branch), and it collects like `apply` with `stopAt: "end"`: each open
 * decision is recorded in `stops` and what depends on it is recorded as
 * waiting, so the drafted spec's step list reads the way the collecting apply
 * would run it.
 */
export type RunMode = "plan" | "apply" | "draft";

export function emptyOpenDecisions(): OpenDecisions {
  return {
    names: [],
    baseCandidates: [],
    reconcile: [],
    review: { players: [], teams: [], leagues: [] },
    slReview: [],
    conflicts: [],
    grouping: [],
  };
}

export function emptyCounts(): ApplyCounts {
  return {
    built: 0,
    committed: 0,
    grouped: 0,
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
  /** Apply only; default `first`. See the module comment. */
  stopAt?: StopAt;
}

export interface RunResult extends PlanReport {
  /** The first stop (with `stopAt: "end"`, the first of `stops`). */
  stoppedAt?: { step: number; reason: string };
  /** `stopAt: "end"`: every stop, in walk order. */
  stops?: Array<{ step: number; reason: string }>;
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
  /** Only `apply` writes; `plan` and `draft` take every step's read-only branch. */
  const readOnly = mode !== "apply";
  /**
   * Apply with `stopAt: "end"`, and draft, carry on past an open decision,
   * gating its dependents. Plan collects too, but gates nothing: it reports
   * every step as it finds it.
   */
  const collecting = (mode === "apply" && opts.stopAt === "end") || mode === "draft";
  const stops: NonNullable<RunResult["stops"]> = [];
  /** Brand-years (`formatPath`, folded) whose step left something open. */
  const blockedBrandYears = new Map<string, string>();
  /**
   * Collecting: why each set's Base-dependent steps wait, by folded set path.
   * Run-level, like `blockedBrandYears`, so a second step naming the same set
   * still waits on what the first left open.
   */
  const setDeps = new Map<string, SetDeps>();

  const record = (s: PlanStep) => steps.push(s);

  /** Record an open decision: plan collects it, apply stops — or, collecting, records the stop and goes on. */
  const stop = (index: number, reason: string): void => {
    if (mode === "plan") return;
    if (!collecting) throw new StopRun(index, reason);
    stops.push({ step: index, reason });
  };

  /** A step that does not run because one it depends on is open (collecting only). */
  const waits = (index: number, kind: string, path: string, action: string, on: string): void => {
    record({ index, kind, path, action, status: "blocked", detail: `waits: ${on}` });
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

  /** Why the last `sub` came back without a value: a write it stopped before (read-only walks), or an open name. */
  let lastFailed: "todo" | "open" = "open";
  /**
   * `true` when `sub` came back with an open outcome, or without a value
   * because of an open name. A step a read-only walk stopped before its write
   * ("todo") is not open: its dependents are reported, not held.
   */
  const isOpen = (v: { outcome: string } | undefined): boolean =>
    v === undefined ? lastFailed === "open" : v.outcome === "open";

  /** `PlanWouldWrite` = todo; `ResolveError` = an open name (apply stops); anything else is thrown. */
  function failed(err: unknown, index: number, kind: string, path: string, action: string): undefined {
    if (err instanceof PlanWouldWrite) {
      lastFailed = "todo";
      record({ index, kind, path, action, status: "todo" });
      return undefined;
    }
    lastFailed = "open";
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
      if (readOnly) {
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
    if (stops.length > 0) stoppedAt = stops[0];
    return {
      target: { convexUrl: target.convexUrl, host: target.host },
      scope: spec.scope,
      confirmPhrase: phrase,
      steps,
      openDecisions: open,
      template: templateTouched ? template : null,
      ...(stoppedAt ? { stoppedAt } : {}),
      ...(stops.length > 0 ? { stops: [...stops] } : {}),
      counts,
      durationMs: now() - started,
      sessions,
    };
  }

  // ---------------------------------------------------------------------
  async function brandYear(i: number, step: BrandYearStep): Promise<void> {
    const path = formatPath(step.path);
    const at = `steps[${i}]`;
    const hold = (on: string) => {
      if (collecting && !blockedBrandYears.has(brandYearKey(step.path))) blockedBrandYears.set(brandYearKey(step.path), on);
    };
    const brand = await sub(i, "brand-year", path, "sync the path's columns", () =>
      ensureBrandYearPath(client, step.path, { paused, manufacturer: step.manufacturer, at: `${at}.path` }),
    (b) => {
      if (b.manufacturerCreated) counts.synced++;
      return { status: "done", detail: b.manufacturerCreated ? "manufacturer created" : undefined };
    });
    if (!brand) {
      hold(`${path} does not resolve (steps[${i}])`);
      return blocked(i, "brand-year", path, "sync Sets", "the path does not resolve yet");
    }

    await sub(i, "brand-year", path, "sync Sets", () => syncBrandSets(client, brand.manufacturerId, { paused }), (r) => {
      if (r.outcome === "synced") counts.synced++;
      else counts.skipped++;
      return { status: "done", detail: `${r.rows.length} sets${r.outcome === "skipped" ? " (already synced)" : ""}` };
    });

    if (step.slReview) {
      const decisions = step.slReview.decisions;
      const reviewed = await sub(i, "sl-review", path, "apply the SportLots set review", () =>
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
      if (isOpen(reviewed)) hold(`the SportLots set review of ${path} (steps[${i}])`);
    }
  }

  // ---------------------------------------------------------------------
  async function setStep(i: number, step: SetStep): Promise<void> {
    const path = formatPath(step.path);
    const at = `steps[${i}]`;
    const heldBy = blockedBrandYears.get(brandYearKey(step.path));
    if (heldBy) return waits(i, "set", path, "everything below the set", heldBy);
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
    /** Collecting: why the Base's dependents wait, when they do (shared by every step naming this set). */
    const key = setKey(step.path);
    const deps: SetDeps = setDeps.get(key) ?? {};
    setDeps.set(key, deps);

    if (step.base) {
      const base = step.base;
      const mapped = await sub(i, "base-map", path, `map Base to BSC ${base.map.bsc}${base.map.sportlots ? ` + SportLots ${base.map.sportlots}` : ""}`, () =>
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
      if (collecting && isOpen(mapped)) deps.baseMap = `the Base mapping (${at}.base.map)`;

      if (base.checklist) {
        const action = "fetch and commit the Base checklist";
        if (deps.baseMap) {
          waits(i, "checklist", path, action, deps.baseMap);
          deps.baseChecklist = deps.baseMap;
        } else {
          const baseRow = await findBaseVariantType(client, set.setId);
          const status = await checklist(i, path, `${at}.base.checklist`, baseRow._id, sportId, base.checklist, null, "Base");
          if (collecting && status === "blocked") deps.baseChecklist = `the Base checklist (${at}.base.checklist)`;
        }
      }
    }

    for (let j = 0; j < (step.variants ?? []).length; j++) {
      await variantType(i, j, path, set.setId, sportId, step.variants![j], deps);
    }
  }

  // ---------------------------------------------------------------------
  async function variantType(
    i: number,
    j: number,
    path: string,
    setId: RowId,
    sportId: RowId,
    vt: VariantTypeStep,
    deps: SetDeps,
  ): Promise<void> {
    const at = `steps[${i}].variants[${j}]`;
    const typeKey = vt.type.trim().toLowerCase();
    let syncTodo = false;
    let syncOpen = false;
    const heldSync = deps.typeSync?.get(typeKey);
    if (collecting && heldSync) {
      // An earlier step naming this set left this type's sync open: its sync
      // and rows wait here too, rather than asking the same question twice.
      waits(i, "row", path, `${vt.type} rows`, heldSync);
      return;
    }
    if (vt.sync && deps.baseMap) {
      waits(i, "reconcile", path, `sync ${vt.type} rows`, deps.baseMap);
      waits(i, "row", path, `${vt.type} rows`, deps.baseMap);
      return;
    }
    // A sync reads which marketplace sets the set's OTHER variant types hold
    // (NEO-312 `usedIds`): what this type's dialog offers depends on what an
    // earlier type's sync stored. So, collecting, a sync after an open one in
    // the same set waits for it, in spec order (the order a draft models).
    if (vt.sync && collecting && deps.syncOpen) {
      waits(i, "reconcile", path, `sync ${vt.type} rows`, deps.syncOpen);
      waits(i, "row", path, `${vt.type} rows`, deps.syncOpen);
      return;
    }
    if (vt.sync) {
      const sync = vt.sync;
      const synced = await sub(i, "reconcile", path, `sync ${vt.type} rows`, () =>
        reconcileVariants(client, setId, vt.type, sync, { paused, at, path }),
      (r) => {
        const moot = r.outcome !== "open" && r.leftMoot?.length ? `; ${mootText(r.leftMoot)}` : "";
        if (r.outcome === "saved") {
          counts.reconciled += r.stored;
          return { status: "done", detail: `${r.stored} stored (${r.mode})${r.specNotConsulted ? "; one marketplace returned rows, so no dialog — the spec's answers were not needed" : ""}${moot}` };
        }
        if (r.outcome === "skipped") {
          counts.skipped++;
          return { status: "done", detail: `${r.reason}${moot}` };
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
      syncOpen = isOpen(synced);
    }
    // Plan, or a draft walk that stopped before the sync's write: no rows to read yet.
    if (syncTodo && readOnly && (!collecting || !syncOpen)) {
      blocked(i, "row", path, `${vt.type} rows`, "checked once the sync has run");
      return;
    }
    if (syncTodo && collecting) {
      const on = `the ${vt.type} sync (${at}.sync)`;
      (deps.typeSync ??= new Map()).set(typeKey, on);
      if (syncOpen) deps.syncOpen ??= on;
      waits(i, "row", path, `${vt.type} rows`, on);
      return;
    }

    const type = await sub(i, "variant-type", path, `find ${vt.type}`, () => resolveVariantType(client, setId, vt.type, `${at}.type`), () => ({ status: "done" }));
    if (!type) return;

    if (vt.expectRows !== undefined) {
      // Top-level and grouped alike, so the count holds before and after `group`.
      const tree = await client.query(api.selectorOptions.getInsertTreeByVariantType, { variantTypeId: type._id });
      const n = tree.reduce((sum, t) => sum + 1 + t.parallels.length, 0);
      const ok = n === vt.expectRows;
      record({ index: i, kind: "expect-rows", path, action: `${vt.type} holds ${vt.expectRows} rows`, status: ok ? "done" : readOnly ? "todo" : "blocked", detail: `${n} now` });
      if (!ok && !readOnly) throw new Error(`${at}.expectRows: ${vt.type} holds ${n} rows; the spec expects ${vt.expectRows}.`);
    }

    /** Why this type's rows' `parallels` wait (collecting), or are not checked yet (plan). */
    let groupWaits: string | undefined;
    if (vt.group) groupWaits = await groupStep(i, at, path, vt, type._id);

    for (let k = 0; k < (vt.rows ?? []).length; k++) {
      const spec = vt.rows![k];
      const rowAt = `${at}.rows[${k}]`;
      const label = `${vt.type} › ${spec.name}`;
      const row = await sub(i, "row", path, `find ${label}`, () => resolveVariantRow(client, type._id, spec.name, `${rowAt}.name`), () => ({ status: "done" }));
      if (!row) continue;
      let checklistStatus: StepStatus | undefined;
      if (spec.checklist) {
        checklistStatus = await checklist(i, path, `${rowAt}.checklist`, row._id, sportId, spec.checklist, { type: vt.type, name: spec.name }, label);
      }
      if (spec.buildFromBase) {
        const action = `build ${label} from Base`;
        const on = deps.baseChecklist ?? deps.baseMap;
        if (on) {
          waits(i, "build-parallel", path, action, on);
        } else {
          const input = { sourceId: type._id, name: spec.name, rebuild: spec.buildFromBase.rebuild, expectCards: spec.expectCards, at: rowAt };
          await build(i, path, action, input);
        }
      } else if (!spec.checklist && spec.expectCards !== undefined) {
        await expectCards(i, path, label, row._id, spec.expectCards, `${rowAt}.expectCards`);
      }
      if (spec.parallels) {
        const on =
          groupWaits ?? (collecting && checklistStatus === "blocked" ? `the ${label} checklist (${rowAt}.checklist)` : undefined);
        for (let m = 0; m < spec.parallels.length; m++) {
          await insertParallel(i, path, `${rowAt}.parallels[${m}]`, label, row._id, spec.parallels[m], on);
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  /**
   * Group Parallels for one type. Returns why the type's insert parallels must
   * wait (collecting: an open decision; plan: the grouping has not run yet),
   * or undefined when they need not.
   */
  async function groupStep(i: number, at: string, path: string, vt: VariantTypeStep, typeId: RowId): Promise<string | undefined> {
    const group = vt.group!;
    const ctx = { at, path, type: vt.type };
    const action = `group ${vt.type} parallels (${group.parents.length} insert${group.parents.length === 1 ? "" : "s"})`;
    const openOf = (o: GroupOpen) => {
      open.names.push(...o.names);
      open.grouping.push(...o.grouping);
      for (const f of o.fills) patch(f.at, f.value);
      return `${vt.type}: ${o.names.length + o.grouping.length} Group Parallels decision(s) need an answer`;
    };
    /** `n` top-level rows holding no parallels: now, or (plan) once the moves land. */
    const expect = (n: number, projected: boolean) => {
      if (group.expectUngrouped === undefined) return;
      const ok = n === group.expectUngrouped;
      const what = `${vt.type} leaves ${group.expectUngrouped} rows ungrouped`;
      record({ index: i, kind: "expect-ungrouped", path, action: what, status: ok ? "done" : "blocked", detail: `${n} ${projected ? "after the grouping" : "now"}` });
      if (!ok && !readOnly) {
        throw new Error(`${at}.group.expectUngrouped: ${vt.type} leaves ${n} rows ungrouped; the spec expects ${group.expectUngrouped}.`);
      }
    };

    if (readOnly) {
      const p = await planGrouping(client, typeId, group, ctx);
      if (p.outcome === "open") {
        record({ index: i, kind: "group", path, action, status: "blocked", detail: "open decisions" });
        stop(i, openOf(p));
        return collecting ? `Group Parallels for ${vt.type} (${at}.group)` : "checked once Group Parallels has its answers";
      }
      if (p.outcome === "done") {
        record({ index: i, kind: "group", path, action, status: "done", detail: "already grouped" });
        expect(p.ungrouped, false);
        return undefined;
      }
      record({ index: i, kind: "group", path, action, status: "todo", detail: `${p.moves} move(s) in ${p.chunks.length} save(s)` });
      expect(p.ungrouped, true);
      return "checked once Group Parallels has run";
    }

    const r = await sub(i, "group", path, action, () => groupParallels(client, typeId, group, ctx), (r) => {
      if (r.outcome === "open") return { status: "blocked", detail: "open decisions", stopReason: openOf(r) };
      if (r.outcome === "skipped") {
        counts.skipped++;
        return { status: "done", detail: "already grouped" };
      }
      counts.grouped += r.moved;
      return { status: "done", detail: `moved ${r.moved} row(s) in ${r.saves} save(s)` };
    });
    if (r === undefined || r.outcome === "open") return collecting ? `Group Parallels for ${vt.type} (${at}.group)` : undefined;
    expect(r.ungrouped, false);
    return undefined;
  }

  // ---------------------------------------------------------------------
  /** One parallel under an insert row: build it from the insert, or check it exists (and its count). */
  async function insertParallel(
    i: number,
    path: string,
    at: string,
    rowLabel: string,
    insertId: RowId,
    p: InsertParallel,
    on: string | undefined,
  ): Promise<void> {
    const label = `${rowLabel} › ${p.name}`;
    const action = p.build ? `build ${label} from ${rowLabel}` : `find ${label}`;
    if (on) {
      if (!collecting) blocked(i, p.build ? "build-parallel" : "parallel", path, action, on);
      else waits(i, p.build ? "build-parallel" : "parallel", path, action, on);
      return;
    }
    if (p.build) {
      await build(i, path, action, { sourceId: insertId, name: p.name, rebuild: p.build.rebuild, expectCards: p.expectCards, at });
      return;
    }
    const par = await sub(i, "parallel", path, action, () => resolveChild(client, "parallel", insertId, p.name, `${at}.name`), () => ({ status: "done" }));
    if (par && p.expectCards !== undefined) await expectCards(i, path, label, par._id, p.expectCards, `${at}.expectCards`);
  }

  /** One parallel build, from Base or from an insert (`input.sourceId`). */
  async function build(i: number, path: string, action: string, input: BuildParallelInput): Promise<void> {
    if (readOnly) {
      const p = await planParallelBuild(client, input).catch((err) => {
        if (err instanceof ResolveError) return { status: "blocked" as const, detail: err.message };
        throw err;
      });
      record({ index: i, kind: "build-parallel", path, action, status: p.status, detail: p.detail });
      return;
    }
    let r: Awaited<ReturnType<typeof buildParallel>>;
    try {
      r = await buildParallel(client, input);
    } catch (err) {
      failed(err, i, "build-parallel", path, action);
      return;
    }
    if (r.outcome === "built") counts.built += r.built;
    else counts.skipped++;
    record({ index: i, kind: "build-parallel", path, action, status: "done", detail: r.outcome === "built" ? `built ${r.built}, holds ${r.cards}` : r.detail });
  }

  /** Assert a row's card count: plan reports, apply fails the run on a mismatch. */
  async function expectCards(i: number, path: string, label: string, rowId: RowId, want: number, at: string): Promise<void> {
    const n = await cardCount(client, rowId);
    const ok = n === want;
    record({ index: i, kind: "expect-cards", path, action: `${label} holds ${want} cards`, status: ok ? "done" : readOnly ? "todo" : "blocked", detail: `${n} now` });
    if (!ok && !readOnly) throw new Error(`${at}: ${label} holds ${n} cards; the spec expects ${want}.`);
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
  ): Promise<StepStatus> {
    const action = `fetch and commit the ${label} checklist`;
    if (readOnly) {
      const n = await cardCount(client, rowId);
      let done: boolean;
      try {
        done = checklistDone(n, spec.expectCards, at);
      } catch (err) {
        record({ index: i, kind: "checklist", path, action, status: "blocked", detail: err instanceof Error ? err.message : String(err) });
        return "blocked";
      }
      record({ index: i, kind: "checklist", path, action, status: done ? "done" : "todo", detail: done ? `holds ${n} cards` : "the review is only known once apply fetches it" });
      return done ? "done" : "todo";
    }
    let r: Awaited<ReturnType<typeof runChecklistStep>>;
    try {
      r = await runChecklistStep(client, { rowId, sportId, checklist: spec, at, row });
    } catch (err) {
      // A link target or a card ref that is not exactly one: an open name.
      failed(err, i, "checklist", path, action);
      return "blocked";
    }
    if (r.outcome === "skipped") {
      counts.skipped++;
      record({ index: i, kind: "checklist", path, action, status: "done", detail: r.detail });
      return "done";
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
      return "done";
    }
    open.conflicts.push(...r.open.conflicts);
    open.review.players.push(...r.open.review.players);
    open.review.teams.push(...r.open.review.teams);
    open.review.leagues.push(...r.open.review.leagues);
    patch(at, r.template);
    if (r.session) sessions.push({ ...r.session, path });
    record({ index: i, kind: "checklist", path, action, status: "blocked", detail: r.reason });
    stop(i, `${label}: ${r.reason}`);
    return "blocked";
  }
}

type StepStatus = PlanStep["status"];

/** Collecting: why a set's Base-dependent steps wait. */
interface SetDeps {
  /** The Base mapping is open. */
  baseMap?: string;
  /** The Base checklist is open (or waits on the mapping). */
  baseChecklist?: string;
  /** A variant type's sync is open, by folded type title: its rows wait in every step naming the set. */
  typeSync?: Map<string, string>;
  /** The first open sync in the set: every later type's sync waits on it (it changes their held ids). */
  syncOpen?: string;
}

/** How a step reports `leave` entries that had nothing to leave (no-ops, not decisions). */
function mootText(moot: ReadonlyArray<{ id: string; why: "held" | "not-listed" }>): string {
  const held = moot.filter((m) => m.why === "held").length;
  const gone = moot.length - held;
  return (
    `${moot.length} "leave" entr${moot.length === 1 ? "y" : "ies"} had nothing to leave (` +
    [held ? `${held} now held by another NB row` : "", gone ? `${gone} no longer listed` : ""].filter(Boolean).join(", ") +
    ")"
  );
}

/** A set path folded for comparison, as `brandYearKey` folds a brand-year. */
function setKey(p: { sport: string; year: string; manufacturer: string; set: string }): string {
  return [p.sport, p.year, p.manufacturer, p.set].map((s) => s.trim().toLowerCase()).join("/");
}

/** A brand-year path folded for comparison: the spec spells both steps' paths. */
function brandYearKey(p: { sport: string; year: string; manufacturer: string }): string {
  return [p.sport, p.year, p.manufacturer].map((s) => s.trim().toLowerCase()).join("/");
}
