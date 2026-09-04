/**
 * NEO-235 — one-shot repair for the four wrong `sportConfig.wikidata.hallOfFameQid`
 * values that shipped with NEO-96.
 *
 * ## Operator command
 *
 *   # 1. dry run first — reports what it WOULD change, patches nothing
 *   npx convex run repairSportHallOfFameQids:run '{"dryRun":true}'
 *
 *   # 2. then for real
 *   npx convex run repairSportHallOfFameQids:run '{}'
 *
 *   # production: same two steps, with --prod
 *   npx convex run repairSportHallOfFameQids:run '{"dryRun":true}' --prod
 *   npx convex run repairSportHallOfFameQids:run '{}' --prod
 *
 * No `--identity` flag: this is an `internalMutation`, unreachable from any
 * client, so it carries no `requireAdmin` that would need an identity to
 * satisfy. Reaching `--prod` requires prod deploy credentials, which is the
 * real gate — the same reasoning as `selectorOptions:resetSetBuilderDataFromCli`.
 *
 * ## What was wrong
 *
 * All four `hallOfFameQid` constants in `convex/sportConfig.ts` pointed at
 * unrelated Wikidata entities. Verified live on 2026-09-04:
 *
 *   baseball    Q1194380 → "Grochów", a village in Poland
 *   football    Q1382553 → "Leistus spinibarbis", a species of beetle
 *   basketball  Q635155  → "creator deity"
 *   hockey      Q579974  → "Dušan Marković", a Serbian footballer (1906-1974)
 *
 * So `isHallOfFame` could never be true for anybody, in any sport, however the
 * induction was recorded.
 *
 * ## Why correcting the constants is not enough
 *
 * `sportConfig` is COPIED onto a sport-level `selectorOptions` row when the
 * row is created, and `storeSelectorOptions`' backfill only fires for a row
 * with no `sportConfig` AT ALL (it never overwrites, so an operator edit
 * survives every sync). Enrichment reads the ROW via
 * `getSportEnrichmentContext`, never the constants. A deployment whose sport
 * rows predate the fix therefore keeps the wrong QID forever unless something
 * rewrites the row — which is this.
 *
 * ## This is a scripted admin task ON PURPOSE
 *
 * Per the standing rule from NEO-214, a config repair is something an operator
 * runs and reads the output of, not a silent overwrite bolted onto the sync
 * path. Widening the backfill's condition would have made it fix itself on the
 * next sync, at the cost of quietly overwriting a value on a row an operator
 * may have set deliberately. So: explicit, dry-runnable, and it reports every
 * row it declined to touch.
 *
 * ## AFTER RUNNING THIS, PLAYERS DO NOT RE-ENRICH ON THEIR OWN
 *
 * Enrichment is creation-only (NEO-203): `enrichPlayer` skips any player
 * already carrying an enrichment marker, and `isHallOfFame: false` is a
 * marker — it is a real answer ("we looked, they are not in the Hall"), which
 * is exactly what every player looked up under a wrong QID has stored. Those
 * rows keep their stored `false` until an admin presses **"Re-enrich from
 * Wikidata"** in Player Management, which is the `force: true` path and the
 * only sanctioned way to re-run a lookup for a known player. This repair fixes
 * the CONFIG; re-enriching the affected players is a separate, deliberate act.
 *
 * ## Idempotent
 *
 * A second run reports every row as `already_correct` and writes nothing.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { sportConfigDefaultsFor } from "./sportConfig";

/**
 * The four values NEO-96 shipped. A row holding one of these is known to be
 * wrong and is safe to overwrite: no operator would have typed a Polish
 * village into a Hall-of-Fame field, so any row carrying one got it from the
 * old defaults.
 *
 * Anything NOT in this list and not already correct is left alone and
 * REPORTED — it might be a deliberate operator choice (a sport-specific Hall
 * we do not ship a default for), and this task has no business guessing.
 */
const KNOWN_BAD_HALL_OF_FAME_QIDS: ReadonlySet<string> = new Set([
  "Q1194380", // baseball → "Grochów" (village of Poland)
  "Q1382553", // football → "Leistus spinibarbis" (species of insect)
  "Q635155", // basketball → "creator deity"
  "Q579974", // hockey → "Dušan Marković" (Serbian footballer)
]);

/** Why a row was left untouched. Each maps to a `skipped_*` log line. */
type SkipReason =
  /** Already holds the value we would write. The steady state after a run. */
  | "already_correct"
  /**
   * Holds a QID that is neither known-bad nor the correct one. NOT repaired —
   * an operator should look at it. This is the reason the task reports rather
   * than silently converging.
   */
  | "unknown_value"
  /** No `sportConfig` on the row at all — `storeSelectorOptions`' backfill owns that case. */
  | "no_sport_config"
  /** Has `sportConfig` but no `wikidata` block: enrichment is off for this sport. */
  | "no_wikidata_config"
  /** A custom/unmapped sport — we ship no default to repair toward. */
  | "no_default_for_sport"
  /**
   * The row's `sportQid` disagrees with the default for its display value, so
   * the row is configured for a different sport than its name suggests.
   * Writing that sport's Hall onto it would make a wrong row wronger.
   */
  | "sport_qid_mismatch";

export const run = internalMutation({
  args: {
    /** Report what would change without writing anything. */
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    repaired: v.array(
      v.object({
        sport: v.string(),
        // Absent when the row simply had no `hallOfFameQid` — the
        // "absent while the sport is one we know" case.
        from: v.optional(v.string()),
        to: v.string(),
      }),
    ),
    skipped: v.array(
      v.object({
        sport: v.string(),
        reason: v.string(),
        /** The value we declined to overwrite, when there was one. */
        value: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;

    // `.collect()` rather than paginating: this is one row per sport — four in
    // a seeded deployment, and bounded by however many sports the marketplaces
    // expose. It cannot approach the document budget.
    const sportRows = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level", (q) => q.eq("level", "sport"))
      .collect();

    const repaired: Array<{ sport: string; from?: string; to: string }> = [];
    const skipped: Array<{ sport: string; reason: SkipReason; value?: string }> = [];

    const skip = (sport: string, reason: SkipReason, value?: string) => {
      skipped.push({ sport, reason, ...(value !== undefined ? { value } : {}) });
      console.log(
        JSON.stringify({
          msg: `repair_sport_hof_qid_skipped_${reason}`,
          sport,
          ...(value !== undefined ? { value } : {}),
        }),
      );
    };

    for (const row of sportRows) {
      const sportConfig = row.sportConfig;
      if (!sportConfig) {
        skip(row.value, "no_sport_config");
        continue;
      }
      const wikidata = sportConfig.wikidata;
      if (!wikidata) {
        skip(row.value, "no_wikidata_config");
        continue;
      }

      // Keyed EXACTLY the way `storeSelectorOptions`' backfill keys it — on
      // the row's display value, case-insensitively (see
      // `sportConfigDefaultsFor`). Same key, same answer, so this task can
      // never disagree with what a fresh row would have been given.
      const correct = sportConfigDefaultsFor(row.value)?.wikidata;
      if (!correct?.hallOfFameQid) {
        skip(row.value, "no_default_for_sport", wikidata.hallOfFameQid);
        continue;
      }

      // The row says it is a different sport than its name does. Repairing it
      // toward the name's Hall would be a guess about which of the two is
      // right, and this task does not guess.
      if (wikidata.sportQid !== correct.sportQid) {
        skip(row.value, "sport_qid_mismatch", wikidata.hallOfFameQid);
        continue;
      }

      const current = wikidata.hallOfFameQid;
      if (current === correct.hallOfFameQid) {
        skip(row.value, "already_correct", current);
        continue;
      }
      // Repairable in exactly two cases: a value we KNOW we shipped wrong, or
      // no value at all on a sport we ship a default for. Everything else is
      // somebody's decision.
      if (current !== undefined && !KNOWN_BAD_HALL_OF_FAME_QIDS.has(current)) {
        skip(row.value, "unknown_value", current);
        continue;
      }

      repaired.push({
        sport: row.value,
        ...(current !== undefined ? { from: current } : {}),
        to: correct.hallOfFameQid,
      });
      console.log(
        JSON.stringify({
          msg: "repair_sport_hof_qid_repaired",
          sport: row.value,
          from: current ?? null,
          to: correct.hallOfFameQid,
          dryRun,
        }),
      );

      if (!dryRun) {
        // Spread rather than replace: `skuCode`, `league` and `espn` are on
        // this object too, and an operator may have edited any of them.
        await ctx.db.patch(row._id, {
          sportConfig: {
            ...sportConfig,
            wikidata: { ...wikidata, hallOfFameQid: correct.hallOfFameQid },
          },
        });
      }
    }

    console.log(
      JSON.stringify({
        msg: "repair_sport_hof_qid_complete",
        dryRun,
        sportRows: sportRows.length,
        repaired: repaired.length,
        skipped: skipped.length,
      }),
    );

    return { dryRun, repaired, skipped };
  },
});
