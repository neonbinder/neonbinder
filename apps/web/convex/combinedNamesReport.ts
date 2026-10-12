/**
 * NEO-333 — read-only report: stored names that are really several names.
 *
 * Before NEO-333, BSC's per-card endpoint returned one team string for a
 * pairings card ("Chicago Cubs, Texas Rangers"), and that whole string went
 * into the pairing dialog, the review queue and the background team lookup as
 * if it were one team. SportLots' subject parse did not split on a comma
 * either. The adapters split now (`splitMarketplaceNames`); this report finds
 * what the old path already stored, so an operator can fix it by hand
 * (Jason's call on cleanup is pending — there is deliberately no cleanup
 * code here).
 *
 * ## What it flags
 *
 *  - `separator`: a raw value containing the separator the adapters split
 *    that kind of name on (`./adapters/marketplaceNames`), checked as stored,
 *    untrimmed:
 *    - TEAM values — `teams.name`, `teams.aliases[]`, team- and league-kind
 *      `entityReviewQueue` / `entityReviewSkips` rows,
 *      `cardChecklist.bscTeamName` and `cardChecklist.pendingTeamNames[]` —
 *      on a COMMA only (`TEAM_NAME_SEPARATOR`). Real team names carry `/`
 *      ("Bodø/Glimt", Negro League "Browns/Stogies"), so flagging a slash
 *      would bury the real hits under correct rows. A league is an
 *      organisation name like a team and gets the same rule.
 *    - PLAYER values — `players.name`, player-kind queue / skip rows and
 *      `cardChecklist.pendingPlayerNames[]` — on `,`, `/` or `|`
 *      (`PLAYER_NAME_SEPARATOR`); no player name carries any of them.
 *  - `suffixOnly`: a PLAYER name that is only a generational suffix ("Jr.",
 *    "Sr", "II"–"IV") — what "Ken Griffey, Jr." becomes when split without
 *    the suffix guard. Checked on `players.name`, player-kind
 *    `entityReviewQueue` / `entityReviewSkips` rows and
 *    `cardChecklist.pendingPlayerNames[]`.
 *
 * A hit is a lead, not a verdict: a real team name can carry a comma
 * ("Korea, South"). And from NEO-333 on, `cardChecklist.bscTeamName` holds
 * BSC's raw, unsplit value for an UNMATCHED card ON PURPOSE
 * (`applyBscTeamResolution`) — a hint for the missing-team lane, not bad
 * data. Those hits are expected.
 *
 * ## Shape
 *
 * Run from the CLI as an internal action (no `--identity`; internal
 * functions are not reachable with one):
 *
 *   npx convex run combinedNamesReport:run '{}'
 *
 * The action walks the five tables in a fixed order, one `scanPage` call per
 * page. Each call is ONE `.paginate()` over one table (Convex allows one per
 * function execution) with a page size sized to that table's documents, and
 * returns only the ids that hit — never a name. The run stops by itself after
 * `REPORT_TIME_BUDGET_MS` and returns `resume`; pass it back to continue at
 * exactly the next page.
 *
 * WRITES NOTHING. No arming flag, because there is nothing to arm. The log
 * line and the return value carry counts and ids only — never a name.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
// NEO-333 — the same separators and suffix rule the adapters split with, so
// this report flags exactly what the splitter would have cut.
import {
  GENERATIONAL_SUFFIX_ONLY,
  PLAYER_NAME_SEPARATOR,
  TEAM_NAME_SEPARATOR,
} from "./adapters/marketplaceNames";

/** The tables walked, in walk order. */
export const REPORT_SOURCES = [
  "teams",
  "players",
  "entityReviewQueue",
  "entityReviewSkips",
  "cardChecklist",
] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

/**
 * Documents per `scanPage` call, per table. `cardChecklist` rows are several
 * KB each (platform data, attributes, links), so its page is the smallest;
 * the others are a few hundred bytes. Every page stays a few MB at most,
 * well inside a query's read limits.
 */
export const REPORT_PAGE_SIZE: Record<ReportSource, number> = {
  teams: 500,
  players: 500,
  entityReviewQueue: 500,
  entityReviewSkips: 500,
  cardChecklist: 150,
};
/**
 * Security review S2: the byte bound on one `scanPage` read. The row counts
 * above assume ordinary documents; a page of unusually large ones (a card's
 * platform data can grow) would otherwise read past a query's limit and fail
 * the same page on every resume. `paginate` stops at this many bytes and
 * still returns the row that crossed it, so every page makes progress.
 */
export const REPORT_PAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Ids returned per kind (the count is always the full count). */
export const REPORT_MAX_IDS_PER_KIND = 500;
/**
 * Wall-clock budget per run, inside Convex's 10-minute action timeout. Also the
 * CEILING on a caller's `timeBudgetMs` (security review S2): a larger value
 * would only let the action run into the platform timeout and lose its
 * partial result.
 */
export const REPORT_TIME_BUDGET_MS = 8 * 60 * 1000;

/** Every kind of hit, one per (field, check). */
export const REPORT_KINDS = [
  "teamNameSeparator",
  "teamAliasSeparator",
  "playerNameSeparator",
  "playerNameSuffixOnly",
  "reviewQueueNameSeparator",
  "reviewQueuePlayerSuffixOnly",
  "reviewSkipNameSeparator",
  "reviewSkipPlayerSuffixOnly",
  "cardBscTeamNameSeparator",
  "cardPendingTeamNameSeparator",
  "cardPendingPlayerNameSeparator",
  "cardPendingPlayerSuffixOnly",
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const sourceValidator = v.union(
  v.literal("teams"),
  v.literal("players"),
  v.literal("entityReviewQueue"),
  v.literal("entityReviewSkips"),
  v.literal("cardChecklist"),
);

const kindValidator = v.union(
  v.literal("teamNameSeparator"),
  v.literal("teamAliasSeparator"),
  v.literal("playerNameSeparator"),
  v.literal("playerNameSuffixOnly"),
  v.literal("reviewQueueNameSeparator"),
  v.literal("reviewQueuePlayerSuffixOnly"),
  v.literal("reviewSkipNameSeparator"),
  v.literal("reviewSkipPlayerSuffixOnly"),
  v.literal("cardBscTeamNameSeparator"),
  v.literal("cardPendingTeamNameSeparator"),
  v.literal("cardPendingPlayerNameSeparator"),
  v.literal("cardPendingPlayerSuffixOnly"),
);

/**
 * Pure: does this raw PLAYER value look like several names joined (`,`, `/`
 * or `|`)? Exported for the test.
 */
export function hasNameSeparator(raw: string): boolean {
  return PLAYER_NAME_SEPARATOR.test(raw);
}

/**
 * Pure: does this raw TEAM (or league) value look like several names joined?
 * A comma only — see the header. Exported for the test.
 */
export function hasTeamNameSeparator(raw: string): boolean {
  return TEAM_NAME_SEPARATOR.test(raw);
}

/** Pure: is this player name only a generational suffix? Exported for the test. */
export function isSuffixOnlyName(raw: string): boolean {
  return GENERATIONAL_SUFFIX_ONLY.test(raw.trim());
}

/** The separator rule for a review row's kind: players broad, others comma. */
function reviewRowHasSeparator(kind: "player" | "team" | "league", name: string) {
  return kind === "player" ? hasNameSeparator(name) : hasTeamNameSeparator(name);
}

type Hit = { kind: ReportKind; id: string };

/**
 * One page of one table: the ids whose names hit, and how many documents were
 * read. Ids only — the names never leave this query.
 */
export const scanPage = internalQuery({
  args: {
    source: sourceValidator,
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    hits: v.array(v.object({ kind: kindValidator, id: v.string() })),
    scanned: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const opts = {
      cursor: args.cursor,
      numItems: REPORT_PAGE_SIZE[args.source],
      // S2 — see `REPORT_PAGE_MAX_BYTES`.
      maximumBytesRead: REPORT_PAGE_MAX_BYTES,
    };
    const hits: Hit[] = [];
    const flag = (kind: ReportKind, id: string) => hits.push({ kind, id });

    switch (args.source) {
      case "teams": {
        const page = await ctx.db.query("teams").paginate(opts);
        for (const team of page.page) {
          if (hasTeamNameSeparator(team.name)) flag("teamNameSeparator", team._id);
          if ((team.aliases ?? []).some(hasTeamNameSeparator)) {
            flag("teamAliasSeparator", team._id);
          }
        }
        return { hits, scanned: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
      }
      case "players": {
        const page = await ctx.db.query("players").paginate(opts);
        for (const player of page.page) {
          if (hasNameSeparator(player.name)) flag("playerNameSeparator", player._id);
          if (isSuffixOnlyName(player.name)) flag("playerNameSuffixOnly", player._id);
        }
        return { hits, scanned: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
      }
      case "entityReviewQueue": {
        const page = await ctx.db.query("entityReviewQueue").paginate(opts);
        for (const row of page.page) {
          if (reviewRowHasSeparator(row.kind, row.name)) {
            flag("reviewQueueNameSeparator", row._id);
          }
          if (row.kind === "player" && isSuffixOnlyName(row.name)) {
            flag("reviewQueuePlayerSuffixOnly", row._id);
          }
        }
        return { hits, scanned: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
      }
      case "entityReviewSkips": {
        const page = await ctx.db.query("entityReviewSkips").paginate(opts);
        for (const row of page.page) {
          if (reviewRowHasSeparator(row.kind, row.name)) {
            flag("reviewSkipNameSeparator", row._id);
          }
          if (row.kind === "player" && isSuffixOnlyName(row.name)) {
            flag("reviewSkipPlayerSuffixOnly", row._id);
          }
        }
        return { hits, scanned: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
      }
      case "cardChecklist": {
        const page = await ctx.db.query("cardChecklist").paginate(opts);
        for (const card of page.page) {
          if (card.bscTeamName !== undefined && hasTeamNameSeparator(card.bscTeamName)) {
            flag("cardBscTeamNameSeparator", card._id);
          }
          if ((card.pendingTeamNames ?? []).some(hasTeamNameSeparator)) {
            flag("cardPendingTeamNameSeparator", card._id);
          }
          const pendingPlayers = card.pendingPlayerNames ?? [];
          if (pendingPlayers.some(hasNameSeparator)) {
            flag("cardPendingPlayerNameSeparator", card._id);
          }
          if (pendingPlayers.some(isSuffixOnlyName)) {
            flag("cardPendingPlayerSuffixOnly", card._id);
          }
        }
        return { hits, scanned: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
      }
    }
  },
});

const resumeValidator = v.object({
  source: sourceValidator,
  cursor: v.union(v.string(), v.null()),
});

export const run = internalAction({
  args: {
    /** A previous run's `resume`: continue at exactly the next page. */
    resume: v.optional(resumeValidator),
    /**
     * Wall-clock budget in ms (default `REPORT_TIME_BUDGET_MS`). Clamped to
     * `[0, REPORT_TIME_BUDGET_MS]`.
     */
    timeBudgetMs: v.optional(v.number()),
  },
  returns: v.object({
    message: v.string(),
    /** Documents read per table, this run. */
    scanned: v.object({
      teams: v.number(),
      players: v.number(),
      entityReviewQueue: v.number(),
      entityReviewSkips: v.number(),
      cardChecklist: v.number(),
    }),
    /** The run stopped before the last page of the last table. */
    truncated: v.boolean(),
    /** The run stopped on its wall-clock budget. */
    timedOut: v.boolean(),
    /**
     * Security review S2: pages that failed to read. The run stops at the
     * first one (0 or 1), returns what it had, and `resume` points AT the
     * failed page so a rerun retries exactly it.
     */
    errors: v.number(),
    /** Pass back as `resume` to continue; absent once every table is read. */
    resume: v.optional(resumeValidator),
    /** Every kind, in `REPORT_KINDS` order, including the zero ones. */
    kinds: v.array(
      v.object({
        kind: kindValidator,
        count: v.number(),
        /** The first `REPORT_MAX_IDS_PER_KIND` ids; `count` is the full count. */
        ids: v.array(v.string()),
        idsTruncated: v.boolean(),
      }),
    ),
    totalHits: v.number(),
  }),
  handler: async (ctx, args) => {
    const started = Date.now();
    // S2 — clamped both ways: never negative, never past the default, which
    // is already sized to finish inside the action timeout.
    const budgetMs = Math.min(
      Math.max(0, args.timeBudgetMs ?? REPORT_TIME_BUDGET_MS),
      REPORT_TIME_BUDGET_MS,
    );
    const overBudget = () => Date.now() - started >= budgetMs;

    const scanned: Record<ReportSource, number> = {
      teams: 0,
      players: 0,
      entityReviewQueue: 0,
      entityReviewSkips: 0,
      cardChecklist: 0,
    };
    const counts = new Map<ReportKind, number>();
    const ids = new Map<ReportKind, string[]>();

    let sourceIndex = args.resume ? REPORT_SOURCES.indexOf(args.resume.source) : 0;
    let cursor: string | null = args.resume ? args.resume.cursor : null;
    let pagesRead = 0;
    let timedOut = false;
    let errors = 0;

    while (sourceIndex < REPORT_SOURCES.length) {
      // At least one page per run, so a resumed run always advances.
      if (pagesRead > 0 && overBudget()) {
        timedOut = true;
        break;
      }
      const source = REPORT_SOURCES[sourceIndex];
      let page: {
        hits: Hit[];
        scanned: number;
        isDone: boolean;
        continueCursor: string;
      };
      try {
        page = await ctx.runQuery(internal.combinedNamesReport.scanPage, {
          source,
          cursor,
        });
      } catch (error) {
        // S2 — a failed page ends the run with everything gathered so far.
        // `sourceIndex` and `cursor` still name the failed page, so the
        // `resume` below retries exactly it. The error's class only: a
        // message from a failed read may quote document content.
        errors++;
        console.warn(
          JSON.stringify({
            msg: "report_combined_names_page_failed",
            source,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
        break;
      }
      pagesRead++;
      scanned[source] += page.scanned;
      for (const hit of page.hits) {
        counts.set(hit.kind, (counts.get(hit.kind) ?? 0) + 1);
        const list = ids.get(hit.kind) ?? [];
        if (list.length < REPORT_MAX_IDS_PER_KIND) list.push(hit.id);
        ids.set(hit.kind, list);
      }
      if (page.isDone) {
        sourceIndex++;
        cursor = null;
      } else {
        cursor = page.continueCursor;
      }
    }

    const truncated = sourceIndex < REPORT_SOURCES.length;
    const kinds = REPORT_KINDS.map((kind) => {
      const count = counts.get(kind) ?? 0;
      const kindIds = ids.get(kind) ?? [];
      return { kind, count, ids: kindIds, idsTruncated: count > kindIds.length };
    });
    const totalHits = kinds.reduce((sum, k) => sum + k.count, 0);

    // Counts only — never a name, never an id.
    console.log(
      JSON.stringify({
        msg: "report_combined_names",
        scanned,
        counts: Object.fromEntries(kinds.map((k) => [k.kind, k.count])),
        totalHits,
        truncated,
        timedOut,
        errors,
        durationMs: Date.now() - started,
      }),
    );

    return {
      message:
        "Report only — nothing written. Each id is a row whose stored name " +
        "looks like several names joined, or a player name that is only a " +
        "suffix; fixing it is the operator's decision. cardBscTeamNameSeparator " +
        "hits written after NEO-333 are the intended hint for an unmatched " +
        "multi-team card." +
        (errors > 0
          ? " A page failed to read; the counts are partial. Pass resume to retry it."
          : truncated
            ? " The run stopped before the end: pass resume to continue."
            : ""),
      scanned,
      truncated,
      timedOut,
      errors,
      ...(truncated ? { resume: { source: REPORT_SOURCES[sourceIndex], cursor } } : {}),
      kinds,
      totalHits,
    };
  },
});
