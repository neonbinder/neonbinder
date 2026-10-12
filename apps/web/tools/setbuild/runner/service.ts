/**
 * NEO-339 — `createSetBuildService(client, target)`: the runner behind the
 * contract in `../service.ts`, for the CLI and the MCP server.
 *
 * - `read` only reads, by construction: `inspect` and `reviewItems` run on
 *   `queryOnlyClient` (a mutation or action throws before it is sent), `plan`
 *   on `readOnlyClient` (which lets through only the marketplace candidate
 *   read).
 * - Every `write` method checks the confirm phrase FIRST, before any network
 *   call (the per-write phrase helpers in `../service.ts`).
 * - `decide` and `reviewItems` reach an entity review this service's own
 *   `apply` stopped at. There is no public way to find someone's open review
 *   batch except by re-running the checklist, so the batch is remembered here
 *   for the life of the process (the MCP server); a later `apply` resumes the
 *   same batch with every decision already recorded.
 * - The client belongs to the caller (`mcp.ts` closes it).
 * - Nothing here writes to stdout.
 */

import type { NbClient } from "../client/convex-client";
import { assertPhrase, type Target } from "../client/target";
import {
  buildParallelConfirmPhrase,
  decideConfirmPhrase,
  formatPath,
  isSetPath,
  ResolveError,
  type BrandYearPath,
  type BuildParallelReport,
  type DecideReport,
  type OpenDecisions,
  type ReviewDecisions,
  type ReviewItemsReport,
  type RowRef,
  type SetBuildService,
  type SetPath,
  type SlDecision,
  type SlReviewApplyReport,
  slReviewConfirmPhrase,
} from "../service";
import { childrenOf, resolveBrandYear, resolveSetPath } from "../spec/resolve";
import { variantTypeRole } from "../../../convex/variantRole";
import type { ReviewSession } from "../lib/commit";
import { buildParallel } from "../lib/build-parallel";
import { openItemsOf, readReviewRows, runReview } from "../lib/review";
import { applySlReview, openSlRows, readSlReview } from "../lib/sl-review";
import { checkPausedPlatforms } from "../lib/sync-column";
import { applySpec, publicApplyReport } from "./apply";
import { emptyOpenDecisions, type RunOptions } from "./engine";
import { inspectPath } from "./inspect";
import { planSpec } from "./plan";
import { draftSet } from "./draft";
import { queryOnlyClient } from "./read-only-client";

/** A write that could not go on because it needs answers it was not given. */
export class OpenDecisionsError extends Error {
  readonly openDecisions: OpenDecisions;
  constructor(message: string, open: OpenDecisions) {
    super(message);
    this.name = "OpenDecisionsError";
    this.openDecisions = open;
  }
}

export interface ServiceOptions {
  /** `PAUSED_PLATFORMS` for this process; defaults to the environment's. */
  pausedPlatforms?: string;
  now?: () => number;
}

const rowKey = (row: RowRef | null | undefined) => (row ? `${row.type}\u0000${row.name}` : "\u0000Base");
const sessionKey = (path: string, row: RowRef | null | undefined) => `${path}\u0001${rowKey(row)}`;

export function createSetBuildService(client: NbClient, target: Target, opts: ServiceOptions = {}): SetBuildService {
  const runOpts = (): RunOptions => ({
    pausedPlatforms: opts.pausedPlatforms ?? process.env.PAUSED_PLATFORMS,
    ...(opts.now ? { now: opts.now } : {}),
  });
  /** What the read methods run on: queries only. */
  const reads = queryOnlyClient(client);
  /** Open entity reviews this process's `apply` stopped at. */
  const sessions = new Map<string, ReviewSession & { path: string }>();

  const remember = (list: Array<ReviewSession & { path: string }>) => {
    for (const s of list) sessions.set(sessionKey(s.path, s.row), s);
  };

  return {
    target,
    read: {
      inspect: (path) => inspectPath(reads, target, path),
      plan: (spec) => planSpec(client, target, spec, runOpts()),
      // Read-only on NB data: drafts on `draftClient` (runner/draft.ts).
      draftSet: (path, o) => draftSet(client, target, path, { ...(o ?? {}), ...(opts.now ? { now: opts.now } : {}) }),
      async reviewItems(path): Promise<ReviewItemsReport> {
        const pathText = formatPath(path);
        const review: ReviewItemsReport["review"] = { players: [], teams: [], leagues: [] };
        const slReview: ReviewItemsReport["slReview"] = [];
        if (isSetPath(path)) {
          for (const s of sessions.values()) {
            if (s.path !== pathText) continue;
            const rows = await readReviewRows(reads, s);
            if (rows.length === 0) {
              sessions.delete(sessionKey(s.path, s.row));
              continue;
            }
            const open = await openItemsOf(reads, rows, { at: s.at, row: s.row });
            review.players.push(...open.players);
            review.teams.push(...open.teams);
            review.leagues.push(...open.leagues);
          }
        } else {
          const brand = await resolveBrandYear(reads, path);
          const sl = await readSlReview(reads, brand.manufacturerId);
          if (sl) slReview.push(openSlRows(sl, sl.entries, "slReview", pathText));
        }
        return { path, pathText, review, slReview };
      },
    },
    write: {
      async apply(spec, confirm, o) {
        const result = await applySpec(client, target, spec, confirm, { ...runOpts(), ...(o?.stopAt ? { stopAt: o.stopAt } : {}) });
        remember(result.sessions);
        return publicApplyReport(result);
      },

      async decide(path: SetPath, decisions: ReviewDecisions, confirm): Promise<DecideReport> {
        const pathText = formatPath(path);
        assertPhrase(decideConfirmPhrase(target, path, decisions), confirm);
        const row = decisions.row ?? null;
        const session = sessions.get(sessionKey(pathText, row));
        if (!session) {
          throw new Error(
            `No entity review is open for ${pathText}${row ? ` › ${row.type} › ${row.name}` : " (Base)"} in this session. ` +
              "Run apply with the spec: it stops at the review and keeps it open here for decide.",
          );
        }
        const outcome = await runReview(
          client,
          { selectorOptionId: session.selectorOptionId, batchId: session.batchId, at: session.at, row },
          { players: decisions.players ?? [], teams: decisions.teams ?? [], leagues: decisions.leagues ?? [] },
          { partial: true },
        );
        return {
          path: pathText,
          row,
          applied: outcome.applied,
          remaining: outcome.status === "open" ? outcome.open : { players: [], teams: [], leagues: [] },
        };
      },

      async buildParallel(path: SetPath, name: string, o: { rebuild?: boolean }, confirm): Promise<BuildParallelReport> {
        const pathText = formatPath(path);
        assertPhrase(buildParallelConfirmPhrase(target, path, name, o), confirm);
        const started = (opts.now ?? Date.now)();
        const set = await resolveSetPath(client, path);
        const types = (await childrenOf(client, "variantType", set.setId)).filter(
          (t) => variantTypeRole(t) === "parallel",
        );
        if (types.length !== 1) {
          throw new ResolveError({
            kind: "parallel variant type",
            query: pathText,
            candidates: types.map((t) => ({ id: String(t._id), name: t.value })),
            message: `${pathText} has ${types.length} variant types with the Parallel role; build-from-Base needs exactly one.`,
          });
        }
        const r = await buildParallel(client, {
          sourceId: types[0]._id,
          name,
          rebuild: o.rebuild,
          at: `${pathText} › ${types[0].value} › ${name}`,
        });
        return {
          path: pathText,
          row: name,
          outcome: r.outcome,
          cards: r.cards,
          durationMs: (opts.now ?? Date.now)() - started,
        };
      },

      async slReviewApply(path: BrandYearPath, decisions: SlDecision[], confirm): Promise<SlReviewApplyReport> {
        const pathText = formatPath(path);
        assertPhrase(slReviewConfirmPhrase(target, path, decisions), confirm);
        const paused = await checkPausedPlatforms(client, runOpts().pausedPlatforms);
        const brand = await resolveBrandYear(client, path);
        const r = await applySlReview(client, brand.manufacturerId, decisions, { paused, at: "decisions", path: pathText });
        if (r.outcome === "skipped") return { path: pathText, applied: 0, remaining: 0 };
        if (r.outcome === "open") {
          const open = emptyOpenDecisions();
          open.slReview.push(r.slReview);
          open.names.push(...r.names);
          throw new OpenDecisionsError(
            `Nothing was saved: ${r.slReview.rows.length} review line(s) have no answer and ${r.names.length} answer(s) do not resolve. ` +
              "Every line needs an answer before the review saves.",
            open,
          );
        }
        return { path: pathText, applied: r.applied, remaining: r.remaining };
      },
    },
  };
}
