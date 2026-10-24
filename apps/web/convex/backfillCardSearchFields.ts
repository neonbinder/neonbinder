/**
 * NEO-358 — fill the two `cardChecklist` fields the collector's search reads,
 * on cards written before they were guaranteed:
 *
 *  - `listingTitle`, where it is ABSENT or BLANK. The search index is on it
 *    (`search_listing_title`), and a card with no title cannot be found by
 *    text. Filled with exactly the title Regenerate offers
 *    (`storedCardTitle.titleForStoredCard`), with `listingTitleTruncated`
 *    beside it when the generator had to cut the core, as at insert. A title
 *    that is already there is NEVER touched: it may be an operator's.
 *  - `sportId`, where it is absent: the search's sport filter. The root of the
 *    card's selector chain, walked once per `selectorOptionId` per page. A card
 *    whose chain reaches no sport is counted (`noSport`) and left alone.
 *
 * The next PR makes `listingTitle` required; this backfill is what lets it.
 *
 * ## Operator command
 *
 *   # 1. dry run: reports what an armed run would write, writes nothing
 *   npx convex run backfillCardSearchFields:backfillCardSearchFields '{}'
 *
 *   # 2. arm the deployment, run for real, disarm
 *   npx convex env set ALLOW_CARD_SEARCH_FIELDS_BACKFILL 1
 *   npx convex run backfillCardSearchFields:backfillCardSearchFields '{"confirm":"BACKFILL"}'
 *   npx convex env remove ALLOW_CARD_SEARCH_FIELDS_BACKFILL
 *
 *   # production: the same three steps with --prod. Re-run until the report
 *   # says "complete": true; pass the returned `cursor` back to resume.
 *
 * Two independent arms, the NEO-214 pair (`backfillCardPlayerLinks` is the
 * model): `confirm: "BACKFILL"` per invocation, the deployment flag per
 * deployment. An armed invocation on an unarmed deployment is REPORTED as
 * refused rather than thrown, so the dry-run numbers still come back. No
 * `--identity`: internal functions, the deploy credential is the gate.
 *
 * See docs/operations/neo358-backfill-card-search-fields.md.
 */

import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { findSportForSelectorOption } from "./cardChecklist";
import { titleForStoredCard } from "./storedCardTitle";

const CONFIRM_TOKEN = "BACKFILL";
const ENV_FLAG = "ALLOW_CARD_SEARCH_FIELDS_BACKFILL";

function deploymentIsArmed(): boolean {
  const value = process.env[ENV_FLAG];
  return value === "1" || value === "true";
}

/**
 * Cards per page. A card needing a title costs its player and team reads plus
 * the chain walk (~10); one needing only a sport costs a patch (the walk is
 * cached per selector row). 100 cards keeps the worst page near ~1,000 reads
 * and ~100 writes; a page of cards that need nothing costs one read.
 */
const CARDS_PER_PAGE = 100;

/** A call stops after the first page that lands past this; re-run to resume. */
const TIME_BUDGET_MS = 150_000;

const NOT_ARMED_MESSAGE =
  `Refused: this deployment is not armed for the backfill. ` +
  `Set ${ENV_FLAG}=1 on it (npx convex env set ${ENV_FLAG} 1), re-run, and ` +
  `remove the flag afterwards. Nothing was written; the counts below are what ` +
  `an armed run would have done.`;
const APPLIED_MESSAGE = "Applied. Re-run to confirm the steady state.";
const DRY_RUN_MESSAGE =
  `Dry run — nothing written. Arm with ${ENV_FLAG}=1 on the deployment and ` +
  `re-run with {"confirm":"${CONFIRM_TOKEN}"} to apply.`;

const pageResultValidator = v.object({
  scanned: v.number(),
  titlesFilled: v.number(),
  sportFilled: v.number(),
  noSport: v.number(),
  isDone: v.boolean(),
  continueCursor: v.string(),
});

/**
 * One page. `apply: false` computes the same answer and writes nothing.
 * Re-asserts the arming itself when applying.
 */
export const backfillCardSearchFieldsPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
    numItems: v.optional(v.number()),
  },
  returns: pageResultValidator,
  handler: async (ctx, args) => {
    if (args.apply && !deploymentIsArmed()) {
      throw new ConvexError(NOT_ARMED_MESSAGE);
    }
    const numItems = Math.max(1, Math.min(args.numItems ?? CARDS_PER_PAGE, CARDS_PER_PAGE));
    const page = await ctx.db
      .query("cardChecklist")
      .paginate({ cursor: args.cursor, numItems });

    const sportBySelector = new Map<string, Id<"selectorOptions"> | undefined>();
    let titlesFilled = 0;
    let sportFilled = 0;
    let noSport = 0;
    for (const card of page.page) {
      const needsTitle = (card.listingTitle ?? "").trim().length === 0;
      const needsSport = card.sportId === undefined;
      if (!needsTitle && !needsSport) continue;

      const patch: {
        listingTitle?: string;
        listingTitleTruncated?: boolean;
        sportId?: Id<"selectorOptions">;
      } = {};
      if (needsSport) {
        const key = card.selectorOptionId as string;
        if (!sportBySelector.has(key)) {
          sportBySelector.set(
            key,
            await findSportForSelectorOption(ctx, card.selectorOptionId),
          );
        }
        const sportId = sportBySelector.get(key);
        if (sportId) {
          patch.sportId = sportId;
          sportFilled++;
        } else {
          noSport++;
        }
      }
      if (needsTitle) {
        const generated = await titleForStoredCard(ctx, card);
        // An empty generated title (no number, no names, no set) would only
        // swap one blank for another; left for the operator.
        if (generated.title.trim().length > 0) {
          patch.listingTitle = generated.title;
          if (!generated.coreFits) patch.listingTitleTruncated = true;
          titlesFilled++;
        }
      }
      // No `lastUpdated`: nothing an operator wrote changed, and the commit
      // diff keys a reviewed decision on it (`baseVersion`).
      if (args.apply && Object.keys(patch).length > 0) {
        await ctx.db.patch(card._id, patch);
      }
    }
    return {
      scanned: page.page.length,
      titlesFilled,
      sportFilled,
      noSport,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * NEO-358 — the armed backfill. Dry run by default; see the header. Loops
 * pages until the table is walked or the time budget is spent, and returns the
 * cursor to resume from. Idempotent: a second run reports zeros (bar
 * `noSport`, which counts orphaned cards every time it meets them).
 */
export const backfillCardSearchFields = internalAction({
  args: {
    confirm: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    armed: v.boolean(),
    message: v.string(),
    complete: v.boolean(),
    cursor: v.optional(v.string()),
    scanned: v.number(),
    titlesFilled: v.number(),
    sportFilled: v.number(),
    noSport: v.number(),
  }),
  handler: async (ctx, args) => {
    const intendsToWrite = args.confirm === CONFIRM_TOKEN;
    const refusedForFlag = intendsToWrite && !deploymentIsArmed();
    const armed = intendsToWrite && !refusedForFlag;
    const startedAt = Date.now();

    const totals = { scanned: 0, titlesFilled: 0, sportFilled: 0, noSport: 0 };
    let cursor: string | null = args.cursor ?? null;
    let complete = false;
    for (;;) {
      const page: {
        scanned: number;
        titlesFilled: number;
        sportFilled: number;
        noSport: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(
        internal.backfillCardSearchFields.backfillCardSearchFieldsPage,
        { cursor, apply: armed },
      );
      totals.scanned += page.scanned;
      totals.titlesFilled += page.titlesFilled;
      totals.sportFilled += page.sportFilled;
      totals.noSport += page.noSport;
      cursor = page.continueCursor;
      if (page.isDone) {
        complete = true;
        break;
      }
      if (Date.now() - startedAt >= TIME_BUDGET_MS) break;
    }

    // One audit line: counts and flags only, never a title.
    console.log(
      JSON.stringify({
        msg: "backfill_card_search_fields",
        armed,
        refusedForFlag,
        complete,
        ...totals,
      }),
    );

    return {
      armed,
      message: refusedForFlag ? NOT_ARMED_MESSAGE : armed ? APPLIED_MESSAGE : DRY_RUN_MESSAGE,
      complete,
      ...(complete || cursor === null ? {} : { cursor }),
      ...totals,
    };
  },
});
